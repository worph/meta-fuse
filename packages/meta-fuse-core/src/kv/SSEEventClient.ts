/**
 * SSEEventClient — HTTP Server-Sent Events client for meta-core event streams.
 *
 * Replaces direct Redis Streams consumption. See the same-named module in
 * meta-sort for the design rationale (meta-core docs/api-mediated-access.md).
 */
import { promises as fs } from 'fs';
import { dirname } from 'path';

export interface SSEEvent {
    id: string;
    event: string;
    data: any;
}

export interface SSEClientOptions {
    url: string;
    cursorPath: string | null;
    onEvent: (e: SSEEvent) => Promise<void> | void;
    onGap?: (payload: { requested: string; resumeFrom: string; reason: string }) => Promise<void> | void;
    logTag?: string;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
    flushIntervalMs?: number;
    /** When set, sent as Last-Event-ID on the *first* connect (e.g. to
     *  force replay from a specific point). After the first event the
     *  persisted cursor takes over. */
    initialCursor?: string;
}

export class SSEEventClient {
    private readonly opts: Required<Omit<SSEClientOptions, 'onGap' | 'initialCursor'>> & Pick<SSEClientOptions, 'onGap' | 'initialCursor'>;
    private cursor: string = '';
    private cursorDirty = false;
    private abort: AbortController | null = null;
    private flushTimer: NodeJS.Timeout | null = null;
    private stopped = false;
    private backoff = 0;
    private firstConnect = true;

    constructor(options: SSEClientOptions) {
        this.opts = {
            url: options.url,
            cursorPath: options.cursorPath,
            onEvent: options.onEvent,
            onGap: options.onGap,
            logTag: options.logTag ?? '[SSE]',
            reconnectBaseMs: options.reconnectBaseMs ?? 500,
            reconnectMaxMs: options.reconnectMaxMs ?? 30_000,
            flushIntervalMs: options.flushIntervalMs ?? 2000,
            initialCursor: options.initialCursor,
        };
        this.backoff = this.opts.reconnectBaseMs;
    }

    async start(): Promise<void> {
        await this.loadCursor();
        if (!this.cursor && this.opts.initialCursor) {
            this.cursor = this.opts.initialCursor;
        }
        this.startFlushTimer();
        await this.runLoop();
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.abort) {
            this.abort.abort();
            this.abort = null;
        }
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flushCursor();
    }

    getCursor(): string {
        return this.cursor;
    }

    private async loadCursor(): Promise<void> {
        if (!this.opts.cursorPath) return;
        try {
            const data = await fs.readFile(this.opts.cursorPath, 'utf-8');
            const trimmed = data.trim();
            if (trimmed) {
                this.cursor = trimmed;
                console.log(`${this.opts.logTag} Resuming from cursor ${this.cursor}`);
            }
        } catch (err: any) {
            if (err.code !== 'ENOENT') {
                console.warn(`${this.opts.logTag} Could not read cursor file ${this.opts.cursorPath}: ${err.message}`);
            }
        }
    }

    private startFlushTimer(): void {
        this.flushTimer = setInterval(() => {
            if (this.cursorDirty) {
                this.flushCursor().catch(err =>
                    console.warn(`${this.opts.logTag} Cursor flush failed: ${err.message}`)
                );
            }
        }, this.opts.flushIntervalMs);
    }

    private async flushCursor(): Promise<void> {
        if (!this.opts.cursorPath || !this.cursorDirty) return;
        this.cursorDirty = false;
        try {
            await fs.mkdir(dirname(this.opts.cursorPath), { recursive: true });
            await fs.writeFile(this.opts.cursorPath, this.cursor, 'utf-8');
        } catch (err: any) {
            this.cursorDirty = true;
            throw err;
        }
    }

    private async runLoop(): Promise<void> {
        while (!this.stopped) {
            try {
                await this.connect();
                this.backoff = this.opts.reconnectBaseMs;
            } catch (err: any) {
                if (this.stopped) return;
                console.warn(`${this.opts.logTag} Stream error, reconnecting in ${this.backoff}ms: ${err?.message ?? err}`);
                await this.sleep(this.backoff);
                this.backoff = Math.min(this.backoff * 2, this.opts.reconnectMaxMs);
            }
        }
    }

    private async connect(): Promise<void> {
        this.abort = new AbortController();
        const headers: Record<string, string> = {
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
        };
        if (this.cursor) {
            headers['Last-Event-ID'] = this.cursor;
        }
        this.firstConnect = false;

        const response = await fetch(this.opts.url, {
            method: 'GET',
            headers,
            signal: this.abort.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
        if (!response.body) throw new Error('Response has no body');

        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        try {
            while (!this.stopped) {
                const { value, done } = await reader.read();
                if (done) return;
                buffer += decoder.decode(value, { stream: true });
                let idx: number;
                while ((idx = buffer.indexOf('\n\n')) !== -1) {
                    const rawChunk = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    await this.handleChunk(rawChunk);
                }
            }
        } finally {
            try { reader.releaseLock(); } catch { /* nothing useful */ }
        }
    }

    private async handleChunk(chunk: string): Promise<void> {
        let id = '';
        let event = '';
        const dataLines: string[] = [];
        for (const rawLine of chunk.split('\n')) {
            if (!rawLine || rawLine.startsWith(':')) continue;
            const colon = rawLine.indexOf(':');
            if (colon === -1) continue;
            const field = rawLine.slice(0, colon);
            let value = rawLine.slice(colon + 1);
            if (value.startsWith(' ')) value = value.slice(1);
            switch (field) {
                case 'id': id = value; break;
                case 'event': event = value; break;
                case 'data': dataLines.push(value); break;
            }
        }
        if (dataLines.length === 0) return;

        let data: any;
        try {
            data = JSON.parse(dataLines.join('\n'));
        } catch (err: any) {
            console.warn(`${this.opts.logTag} Skipping unparseable event ${id || '(no id)'}: ${err.message}`);
            return;
        }

        const ev: SSEEvent = { id, event: event || 'message', data };
        if (ev.event === 'gap') {
            if (this.opts.onGap) {
                await this.opts.onGap(ev.data);
            } else {
                console.warn(`${this.opts.logTag} Gap event (cursor ${ev.data?.requested} trimmed): resumed from ${ev.data?.resumeFrom}`);
            }
            if (typeof ev.data?.resumeFrom === 'string' && ev.data.resumeFrom) {
                this.cursor = ev.data.resumeFrom;
                this.cursorDirty = true;
            }
            return;
        }

        try {
            await this.opts.onEvent(ev);
        } catch (err: any) {
            console.error(`${this.opts.logTag} onEvent handler failed for ${ev.id}: ${err?.stack ?? err}`);
        }
        if (ev.id) {
            this.cursor = ev.id;
            this.cursorDirty = true;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
