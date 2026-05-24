/**
 * MetaCoreApiClient — HTTP read client against meta-core for meta-fuse.
 *
 * meta-fuse needs to read file metadata (property GETs, full-record fetch,
 * hashId enumeration) as it builds the VFS. After the api-mediated-access
 * lockdown lands these go through meta-core's /meta/{hash} family instead
 * of direct Redis reads.
 *
 * Only the methods meta-fuse actually calls are implemented. See
 * meta-core docs/api-mediated-access.md for the full surface.
 */

export interface MetaCoreApiClientConfig {
    apiUrl: string;
    timeoutMs?: number;
}

export class MetaCoreApiClient {
    private apiUrl: string;
    private timeoutMs: number;

    constructor(config: MetaCoreApiClientConfig) {
        this.apiUrl = config.apiUrl.replace(/\/+$/, '');
        this.timeoutMs = config.timeoutMs ?? 30000;
    }

    /**
     * GET /meta/{hash}/{prop}. Returns the raw string value or null on 404.
     * meta-core sends text/plain for property reads.
     */
    async getProperty(hashId: string, property: string): Promise<string | null> {
        const path = `/meta/${encodeURIComponent(hashId)}/${this.encodePropertyPath(property)}`;
        const url = `${this.apiUrl}${path}`;
        const response = await fetch(url, {
            method: 'GET',
            signal: AbortSignal.timeout(this.timeoutMs),
            headers: { Accept: 'text/plain' },
        });
        if (response.status === 404) return null;
        if (!response.ok) {
            throw new Error(`[MetaCoreApiClient] GET ${path} → ${response.status} ${response.statusText}`);
        }
        const text = await response.text();
        return text === '' ? null : text;
    }

    /**
     * GET /meta/{hash}. Returns the flat property map or null on 404.
     */
    async getMetadataFlat(hashId: string): Promise<Record<string, string> | null> {
        const path = `/meta/${encodeURIComponent(hashId)}`;
        const body = await this.fetchJsonAllowing404('GET', path);
        if (body === null) return null;
        const flat = (body as any)?.metadata;
        if (!flat || typeof flat !== 'object') return null;
        return flat as Record<string, string>;
    }

    /**
     * GET /meta. Enumerates every known hashId.
     */
    async getAllHashIds(): Promise<string[]> {
        const body = await this.fetchJson('GET', '/meta');
        const ids = (body as any)?.hashIds;
        return Array.isArray(ids) ? ids : [];
    }

    /**
     * GET /health on meta-core. Used as the connectivity probe.
     */
    async health(): Promise<boolean> {
        try {
            const response = await fetch(`${this.apiUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
                headers: { Accept: 'application/json' },
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    private encodePropertyPath(property: string): string {
        return property
            .split('/')
            .map(segment => encodeURIComponent(segment))
            .join('/');
    }

    private async fetchJson(method: string, path: string): Promise<unknown> {
        const url = `${this.apiUrl}${path}`;
        const response = await fetch(url, {
            method,
            signal: AbortSignal.timeout(this.timeoutMs),
            headers: { Accept: 'application/json' },
        });
        if (!response.ok) {
            throw new Error(`[MetaCoreApiClient] ${method} ${path} → ${response.status} ${response.statusText}`);
        }
        const text = await response.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
    }

    private async fetchJsonAllowing404(method: string, path: string): Promise<unknown> {
        const url = `${this.apiUrl}${path}`;
        const response = await fetch(url, {
            method,
            signal: AbortSignal.timeout(this.timeoutMs),
            headers: { Accept: 'application/json' },
        });
        if (response.status === 404) return null;
        if (!response.ok) {
            throw new Error(`[MetaCoreApiClient] ${method} ${path} → ${response.status} ${response.statusText}`);
        }
        const text = await response.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
    }
}
