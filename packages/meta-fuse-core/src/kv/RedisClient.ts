/**
 * Redis Client for meta-fuse
 * Reads metadata from Redis (written by meta-sort)
 *
 * Key features:
 * - FILES_VOLUME path resolution (prepends /files/ to relative paths)
 * - Parses meta-sort hash format into structured metadata
 * - Redis pub/sub support for real-time updates
 */

import { Redis } from 'ioredis';
import { Logger } from 'tslog';
import * as os from 'os';
import type { IKVClient, KeyValuePair } from './IKVClient.js';

const logger = new Logger({ name: 'RedisClient' });

/**
 * Stream message from Redis Streams
 *
 * New meta:events format (from meta-core flat key architecture):
 * - type: 'set' | 'del' - keyspace notification type
 * - key: 'file:abc123/property' - the Redis key that changed
 * - ts: timestamp
 *
 * Legacy file:events format (deprecated):
 * - type: add, change, delete, rename, batch, reset, plugin:complete
 * - path, size, midhash256, oldPath, payload fields
 */
export interface StreamMessage {
    id: string;
    type: 'set' | 'del' | 'add' | 'change' | 'delete' | 'rename' | 'batch' | 'reset' | 'plugin:complete';
    // New meta:events fields (flat key architecture)
    key?: string;         // Redis key that changed: file:abc123/property
    ts?: string;          // Timestamp
    // Legacy file:events fields (for backward compatibility)
    path?: string;
    size?: string;
    midhash256?: string;  // midhash256 CID computed by meta-core
    oldPath?: string;
    payload?: string;
    timestamp: string;
}

/**
 * Parsed meta:events key
 * Extracts hashId and property from keys like 'file:abc123/property'
 */
export interface ParsedMetaEventKey {
    hashId: string;
    property: string;
}

/**
 * Stream consumer callback
 */
export type StreamMessageHandler = (message: StreamMessage) => Promise<void>;

/**
 * Full metadata structure including fields needed for virtual path computation
 */
export interface FileMetadata {
    // Path information
    sourcePath: string;      // Full path: /files/media1/Movies/...
    originalPath: string;    // Relative path from meta-sort: media1/Movies/...

    // File stats
    size: number;
    mtime: number;
    ctime: number;

    // Identification
    hashId?: string;         // midhash256 hash ID

    // Title information (for folder organization)
    title?: string;
    titles?: { eng?: string; [key: string]: string | undefined };
    originalTitle?: string;
    fileName?: string;

    // Series metadata
    season?: number;
    episode?: number;
    extra?: boolean;

    // Movie metadata
    movieYear?: number;
    year?: number;

    // File type
    fileType?: string;       // 'video', 'subtitle', 'torrent', etc.
    extension?: string;

    // Version/variant info
    version?: string;
    subtitleLanguage?: string;

    // Generic metadata container
    [key: string]: unknown;
}

export interface RedisClientConfig {
    url?: string;
    prefix?: string;
    filesVolume?: string;
    reconnectInterval?: number;
}

export class RedisClient implements Partial<IKVClient> {
    private client: Redis | null = null;
    private subscriber: Redis | null = null;
    private config: Required<RedisClientConfig>;
    private isConnected = false;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private subscriptions: Map<string, (message: string) => void> = new Map();

    // Stream consumer state
    private streamConsumerRunning = false;
    private streamConsumerAbort: AbortController | null = null;
    private consumerName: string;

    constructor(config: RedisClientConfig = {}) {
        this.config = {
            url: config.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
            prefix: config.prefix ?? process.env.REDIS_PREFIX ?? '',
            filesVolume: config.filesVolume ?? process.env.FILES_VOLUME ?? '/files',
            reconnectInterval: config.reconnectInterval ?? 5000,
        };

        // Unique consumer name for this instance
        this.consumerName = `${os.hostname()}-${process.pid}`;
    }

    /**
     * Connect to Redis
     */
    async connect(): Promise<void> {
        if (this.client && this.isConnected) {
            return;
        }

        try {
            this.client = new Redis(this.config.url, {
                retryStrategy: (times: number) => {
                    if (times > 10) {
                        logger.warn('Max reconnection attempts reached');
                        return null;
                    }
                    return Math.min(times * 500, 5000);
                },
                maxRetriesPerRequest: 3,
            });

            this.client.on('connect', () => {
                logger.info('Connected to Redis');
                this.isConnected = true;
            });

            this.client.on('error', (err: Error) => {
                logger.error('Redis error:', err.message);
                this.isConnected = false;
            });

            this.client.on('close', () => {
                logger.warn('Redis connection closed');
                this.isConnected = false;
                this.scheduleReconnect();
            });

            // Wait for connection
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => {
                    reject(new Error('Redis connection timeout'));
                }, 10000);

                this.client!.once('ready', () => {
                    clearTimeout(timeout);
                    this.isConnected = true;
                    resolve();
                });

                this.client!.once('error', (err: Error) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });
        } catch (error) {
            logger.error('Failed to connect to Redis:', error);
            this.scheduleReconnect();
            throw error;
        }
    }

    /**
     * Schedule reconnection attempt
     */
    private scheduleReconnect(): void {
        if (this.reconnectTimer) {
            return;
        }

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            try {
                await this.connect();
            } catch {
                // Will retry via scheduleReconnect
            }
        }, this.config.reconnectInterval);
    }

    /**
     * Disconnect from Redis
     */
    async disconnect(): Promise<void> {
        // Stop stream consumer first
        this.stopStreamConsumer();

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.subscriber) {
            await this.subscriber.quit();
            this.subscriber = null;
        }

        if (this.client) {
            await this.client.quit();
            this.client = null;
            this.isConnected = false;
        }

        this.subscriptions.clear();
    }

    /**
     * Check if connected
     */
    get connected(): boolean {
        return this.isConnected;
    }

    // ========================================================================
    // Flat Key Methods (for meta-core flat key architecture)
    // ========================================================================

    /**
     * Get a single property value from Redis using flat key format
     * Key format: file:{hashId}/{property}
     *
     * @param hashId - The file hash ID
     * @param property - The property name (can include / for nested props like 'titles/eng')
     * @returns The property value or null if not found
     */
    async getProperty(hashId: string, property: string): Promise<string | null> {
        if (!this.client || !this.isConnected) {
            return null;
        }

        try {
            const key = `${this.config.prefix}file:${hashId}/${property}`;
            return await this.client.get(key);
        } catch (error: any) {
            logger.error(`Failed to get property ${property} for ${hashId}:`, error.message);
            return null;
        }
    }

    /**
     * Get multiple properties for a file using flat keys
     * More efficient than multiple getProperty calls using MGET
     *
     * @param hashId - The file hash ID
     * @param properties - Array of property names to fetch
     * @returns Map of property name to value (null values excluded)
     */
    async getProperties(hashId: string, properties: string[]): Promise<Map<string, string>> {
        const result = new Map<string, string>();

        if (!this.client || !this.isConnected || properties.length === 0) {
            return result;
        }

        try {
            const keys = properties.map(prop => `${this.config.prefix}file:${hashId}/${prop}`);
            const values = await this.client.mget(keys);

            for (let i = 0; i < properties.length; i++) {
                const value = values[i];
                if (value !== null) {
                    result.set(properties[i], value);
                }
            }
        } catch (error: any) {
            logger.error(`Failed to get properties for ${hashId}:`, error.message);
        }

        return result;
    }

    /**
     * Parse a meta:events key to extract hashId and property
     * Key format: file:{hashId}/{property}
     *
     * @param key - The Redis key from the event
     * @returns Parsed key with hashId and property, or null if invalid format
     */
    parseMetaEventKey(key: string): ParsedMetaEventKey | null {
        // Remove prefix if present
        let keyWithoutPrefix = key;
        if (this.config.prefix && key.startsWith(this.config.prefix)) {
            keyWithoutPrefix = key.slice(this.config.prefix.length);
        }

        // Key format: file:{hashId}/{property}
        // Property can contain slashes (e.g., 'titles/eng')
        const match = keyWithoutPrefix.match(/^file:([^/]+)\/(.+)$/);
        if (!match) {
            return null;
        }

        return {
            hashId: match[1],
            property: match[2],
        };
    }

    /**
     * Check if a key is a file metadata key (vs other keys like indexes)
     *
     * @param key - The Redis key to check
     * @returns True if this is a file metadata key
     */
    isFileMetadataKey(key: string): boolean {
        return this.parseMetaEventKey(key) !== null;
    }

    // ========================================================================
    // Legacy HGETALL-based Methods (deprecated, kept for compatibility)
    // ========================================================================

    /**
     * Get all file metadata from Redis
     * @deprecated Use streaming state builder with flat keys instead
     */
    async getAllFiles(): Promise<Map<string, FileMetadata>> {
        const files = new Map<string, FileMetadata>();

        if (!this.client || !this.isConnected) {
            logger.warn('Redis not connected, returning empty file list');
            return files;
        }

        try {
            // Get all file keys using the index
            const indexKey = `${this.config.prefix}file:__index__`;
            const hashIds = await this.client.smembers(indexKey);

            if (hashIds.length === 0) {
                // Fallback: scan for file keys directly
                const pattern = `${this.config.prefix}file:*`;
                const keys = await this.scanKeys(pattern);
                logger.debug(`Found ${keys.length} file keys in Redis (via scan)`);

                for (const key of keys) {
                    if (key.includes('__index__')) continue;

                    try {
                        const data = await this.client.hgetall(key);
                        if (data && Object.keys(data).length > 0) {
                            const hashId = key.replace(`${this.config.prefix}file:`, '');
                            const metadata = this.parseMetadata(data, hashId);
                            files.set(metadata.sourcePath, metadata);
                        }
                    } catch (err) {
                        logger.warn(`Failed to get metadata for key ${key}:`, err);
                    }
                }
            } else {
                logger.debug(`Found ${hashIds.length} files in index`);

                // Fetch metadata for each hash ID
                for (const hashId of hashIds) {
                    try {
                        const key = `${this.config.prefix}file:${hashId}`;
                        const data = await this.client.hgetall(key);
                        if (data && Object.keys(data).length > 0) {
                            const metadata = this.parseMetadata(data, hashId);
                            files.set(metadata.sourcePath, metadata);
                        }
                    } catch (err) {
                        logger.warn(`Failed to get metadata for hashId ${hashId}:`, err);
                    }
                }
            }

            logger.info(`Loaded ${files.size} files from Redis`);
        } catch (error) {
            logger.error('Failed to get files from Redis:', error);
        }

        return files;
    }

    /**
     * Get file metadata by hash ID
     * @deprecated Use streaming state builder with flat keys instead
     */
    async getFileByHashId(hashId: string): Promise<FileMetadata | null> {
        if (!this.client || !this.isConnected) {
            return null;
        }

        try {
            const key = `${this.config.prefix}file:${hashId}`;
            const data = await this.client.hgetall(key);

            if (data && Object.keys(data).length > 0) {
                return this.parseMetadata(data, hashId);
            }

            return null;
        } catch (error) {
            logger.error(`Failed to get file ${hashId}:`, error);
            return null;
        }
    }

    /**
     * Get all hash IDs from Redis index
     */
    async getAllHashIds(): Promise<string[]> {
        if (!this.client || !this.isConnected) {
            return [];
        }

        try {
            const indexKey = `${this.config.prefix}file:__index__`;
            return await this.client.smembers(indexKey);
        } catch (error) {
            logger.error('Failed to get hash IDs:', error);
            return [];
        }
    }

    /**
     * Scan Redis keys matching pattern
     */
    private async scanKeys(pattern: string): Promise<string[]> {
        if (!this.client) return [];

        const keys: string[] = [];
        let cursor = '0';

        do {
            const [newCursor, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 1000);
            cursor = newCursor;
            keys.push(...batch);
        } while (cursor !== '0');

        return keys;
    }

    /**
     * Parse metadata from Redis hash
     * Handles meta-sort format and resolves paths with FILES_VOLUME
     */
    private parseMetadata(data: Record<string, string>, hashId?: string): FileMetadata {
        // Get the original path (relative to FILES_VOLUME)
        const originalPath = data.filePath ?? data.sourcePath ?? '';

        // Resolve full source path by prepending FILES_VOLUME
        let sourcePath = originalPath;
        if (originalPath && !originalPath.startsWith('/')) {
            // Relative path - prepend FILES_VOLUME
            sourcePath = `${this.config.filesVolume}/${originalPath}`;
        } else if (!originalPath.startsWith(this.config.filesVolume) && originalPath.startsWith('/')) {
            // Absolute path but not in FILES_VOLUME - still prepend
            sourcePath = `${this.config.filesVolume}${originalPath}`;
        }

        // Parse size
        const size = parseInt(data.fileSize ?? data.size ?? data.sizeByte ?? '0', 10);

        // Parse timestamps
        let mtime = 0;
        if (data.mtime) {
            const parsed = Date.parse(data.mtime);
            mtime = isNaN(parsed) ? parseFloat(data.mtime) : parsed;
        }

        // Parse titles - can be nested object or simple string
        let titles: { eng?: string; [key: string]: string | undefined } | undefined;
        if (data['titles/eng']) {
            titles = { eng: data['titles/eng'] };
        }

        // Parse season/episode (can be 0 for specials)
        const season = data.season !== undefined ? parseInt(data.season, 10) : undefined;
        const episode = data.episode !== undefined ? parseInt(data.episode, 10) : undefined;

        // Parse year
        const movieYear = data.movieYear ? parseInt(data.movieYear, 10) : undefined;
        const year = data.year ? parseInt(data.year, 10) : movieYear;

        return {
            // Path information
            sourcePath,
            originalPath,

            // File stats
            size,
            mtime,
            ctime: data.ctime ? parseFloat(data.ctime) : mtime,

            // Identification
            hashId: hashId ?? data.cid_midhash256 ?? data.hashId,

            // Title information
            title: data.title,
            titles,
            originalTitle: data.originalTitle,
            fileName: data.fileName,

            // Series metadata
            season,
            episode,
            extra: data.extra === 'true',

            // Movie metadata
            movieYear,
            year,

            // File type
            fileType: data.fileType,
            extension: data.extension,

            // Version/variant
            version: data.version,
            subtitleLanguage: data.subtitleLanguage,
        };
    }

    /**
     * Subscribe to Redis pub/sub channel
     */
    async subscribe(channel: string, callback: (message: string) => void): Promise<void> {
        if (!this.client) {
            throw new Error('Redis not connected');
        }

        // Create subscriber connection if not exists
        if (!this.subscriber) {
            this.subscriber = this.client.duplicate();
            await new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Subscriber connection timeout')), 10000);
                this.subscriber!.once('ready', () => {
                    clearTimeout(timeout);
                    resolve();
                });
                this.subscriber!.once('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });
            });

            // Set up message handler
            this.subscriber.on('message', (ch: string, message: string) => {
                const handler = this.subscriptions.get(ch);
                if (handler) {
                    try {
                        handler(message);
                    } catch (error: any) {
                        logger.error(`Error in subscription handler for ${ch}:`, error.message);
                    }
                }
            });
        }

        // Store callback and subscribe
        this.subscriptions.set(channel, callback);
        await this.subscriber.subscribe(channel);
        logger.info(`Subscribed to channel: ${channel}`);
    }

    /**
     * Unsubscribe from Redis pub/sub channel
     */
    async unsubscribe(channel: string): Promise<void> {
        if (this.subscriber) {
            await this.subscriber.unsubscribe(channel);
            this.subscriptions.delete(channel);
            logger.info(`Unsubscribed from channel: ${channel}`);
        }
    }

    // ========================================================================
    // Redis Streams Consumer Methods
    // ========================================================================

    /**
     * Initialize stream consumer group
     * Creates the consumer group at position 0 to read all historical events
     *
     * @param stream - Stream name (e.g., 'file:events')
     * @param group - Consumer group name (e.g., 'meta-fuse-vfs')
     */
    async initStreamConsumer(stream: string, group: string): Promise<void> {
        if (!this.client) {
            throw new Error('Redis not connected');
        }

        try {
            // Create consumer group at position 0 (read all historical events)
            // MKSTREAM creates the stream if it doesn't exist
            await this.client.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
            logger.info(`Created consumer group '${group}' for stream '${stream}'`);
        } catch (error: any) {
            // BUSYGROUP means group already exists - that's fine
            if (error.message?.includes('BUSYGROUP')) {
                logger.debug(`Consumer group '${group}' already exists`);
            } else {
                throw error;
            }
        }
    }

    /**
     * Process pending entries from crashed consumers
     * Uses XAUTOCLAIM to claim entries that have been idle too long
     *
     * @param stream - Stream name
     * @param group - Consumer group name
     * @param minIdleTime - Minimum idle time in ms before claiming (default: 30000)
     * @param onMessage - Handler for each message
     */
    async processPendingEntries(
        stream: string,
        group: string,
        minIdleTime: number = 30000,
        onMessage: StreamMessageHandler
    ): Promise<number> {
        if (!this.client) {
            return 0;
        }

        let processed = 0;
        let cursor = '0-0';

        try {
            while (true) {
                // XAUTOCLAIM claims idle entries and returns them
                const result = await this.client.xautoclaim(
                    stream,
                    group,
                    this.consumerName,
                    minIdleTime,
                    cursor,
                    'COUNT',
                    100
                ) as [string, Array<[string, string[]]>, string[]];

                const [nextCursor, entries] = result;
                cursor = nextCursor;

                if (!entries || entries.length === 0) {
                    break;
                }

                for (const [id, fields] of entries) {
                    try {
                        const message = this.parseStreamEntry(id, fields);
                        if (message) {
                            await onMessage(message);
                            // ACK the message after successful processing
                            await this.client.xack(stream, group, id);
                            processed++;
                        }
                    } catch (error: any) {
                        logger.error(`Error processing pending entry ${id}:`, error.message);
                    }
                }

                // If cursor is 0-0, we've processed all pending entries
                if (cursor === '0-0') {
                    break;
                }
            }

            if (processed > 0) {
                logger.info(`Processed ${processed} pending stream entries`);
            }
        } catch (error: any) {
            logger.error('Error processing pending entries:', error.message);
        }

        return processed;
    }

    /**
     * Start stream consumer loop
     * Reads messages using XREADGROUP and calls the handler
     *
     * @param stream - Stream name
     * @param group - Consumer group name
     * @param onMessage - Handler for each message
     * @param blockMs - Block timeout in ms (default: 5000)
     */
    async startStreamConsumer(
        stream: string,
        group: string,
        onMessage: StreamMessageHandler,
        blockMs: number = 5000
    ): Promise<void> {
        if (!this.client) {
            throw new Error('Redis not connected');
        }

        if (this.streamConsumerRunning) {
            logger.warn('Stream consumer already running');
            return;
        }

        this.streamConsumerRunning = true;
        this.streamConsumerAbort = new AbortController();

        logger.info(`Starting stream consumer: ${stream} (group: ${group}, consumer: ${this.consumerName})`);

        // Consumer loop
        while (this.streamConsumerRunning && !this.streamConsumerAbort.signal.aborted) {
            try {
                // XREADGROUP blocks waiting for new messages
                // '>' means only read new messages (not already delivered to this consumer)
                // Use call() to bypass TypeScript's strict argument checking for xreadgroup
                const result = await (this.client.call(
                    'XREADGROUP',
                    'GROUP', group,
                    this.consumerName,
                    'BLOCK', blockMs,
                    'COUNT', 10,
                    'STREAMS', stream,
                    '>'
                ) as Promise<Array<[string, Array<[string, string[]]>]> | null>);

                if (!result || result.length === 0) {
                    continue; // Timeout, loop again
                }

                // Process each stream's messages
                for (const [streamName, entries] of result) {
                    for (const [id, fields] of entries) {
                        try {
                            const message = this.parseStreamEntry(id, fields);
                            if (message) {
                                await onMessage(message);
                                // ACK the message after successful processing
                                await this.client!.xack(stream, group, id);
                            }
                        } catch (error: any) {
                            logger.error(`Error processing stream entry ${id}:`, error.message);
                            // Don't ACK on error - message will be reprocessed
                        }
                    }
                }
            } catch (error: any) {
                if (this.streamConsumerAbort?.signal.aborted) {
                    break;
                }
                logger.error('Stream consumer error:', error.message);
                // Brief pause before retrying
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        logger.info('Stream consumer stopped');
    }

    /**
     * Stop the stream consumer loop
     */
    stopStreamConsumer(): void {
        if (!this.streamConsumerRunning) {
            return;
        }

        logger.info('Stopping stream consumer...');
        this.streamConsumerRunning = false;
        this.streamConsumerAbort?.abort();
        this.streamConsumerAbort = null;
    }

    /**
     * Read stream entries from a specific position using XREAD (no consumer groups)
     * Used for streaming bootstrap - replays all events from the beginning
     *
     * @param stream - Stream name
     * @param fromId - Start position ('0' for beginning, '$' for end/new only)
     * @param count - Maximum entries to read per call
     * @param blockMs - Block timeout (0 for non-blocking)
     * @returns Array of [id, message] tuples, empty if none
     */
    async readStreamFrom(
        stream: string,
        fromId: string,
        count: number = 100,
        blockMs: number = 0
    ): Promise<Array<{ id: string; message: StreamMessage }>> {
        if (!this.client || !this.isConnected) {
            return [];
        }

        try {
            let result: Array<[string, Array<[string, string[]]>]> | null;

            if (blockMs > 0) {
                result = await this.client.call(
                    'XREAD',
                    'BLOCK', blockMs,
                    'COUNT', count,
                    'STREAMS', stream,
                    fromId
                ) as typeof result;
            } else {
                result = await this.client.call(
                    'XREAD',
                    'COUNT', count,
                    'STREAMS', stream,
                    fromId
                ) as typeof result;
            }

            if (!result || result.length === 0) {
                return [];
            }

            const entries: Array<{ id: string; message: StreamMessage }> = [];

            for (const [_streamName, streamEntries] of result) {
                for (const [id, fields] of streamEntries) {
                    const message = this.parseStreamEntry(id, fields);
                    if (message) {
                        entries.push({ id, message });
                    }
                }
            }

            return entries;
        } catch (error: any) {
            logger.error('Error reading stream:', error.message);
            return [];
        }
    }

    /**
     * Read all stream entries from a position, calling handler for each
     * Returns the last processed entry ID for resumption
     *
     * @param stream - Stream name
     * @param fromId - Start position ('0' for beginning)
     * @param onMessage - Handler for each message
     * @param batchSize - Entries per read
     * @returns Last processed entry ID, or fromId if no entries
     */
    async replayStream(
        stream: string,
        fromId: string,
        onMessage: StreamMessageHandler,
        batchSize: number = 100
    ): Promise<string> {
        let lastId = fromId;
        let totalProcessed = 0;
        const startTime = Date.now();

        logger.info(`Replaying stream ${stream} from position ${fromId}...`);

        while (true) {
            const entries = await this.readStreamFrom(stream, lastId, batchSize, 0);

            if (entries.length === 0) {
                break;
            }

            for (const { id, message } of entries) {
                try {
                    await onMessage(message);
                    lastId = id;
                    totalProcessed++;
                } catch (error: any) {
                    logger.error(`Error processing stream entry ${id}:`, error.message);
                    // Continue with next entry
                }
            }

            // If we got fewer than batchSize entries, we've reached the end
            if (entries.length < batchSize) {
                break;
            }
        }

        const elapsed = Date.now() - startTime;
        logger.info(`Stream replay complete: ${totalProcessed} entries in ${elapsed}ms, last ID: ${lastId}`);

        return lastId;
    }

    /**
     * Start a stream consumer that reads from a specific position using XREAD
     * Does not use consumer groups - for simpler replay/live consumption
     *
     * @param stream - Stream name
     * @param fromId - Start position ('0' for beginning, or last ID from replayStream)
     * @param onMessage - Handler for each message
     * @param blockMs - Block timeout for polling (default: 5000)
     */
    async startSimpleStreamConsumer(
        stream: string,
        fromId: string,
        onMessage: StreamMessageHandler,
        blockMs: number = 5000
    ): Promise<void> {
        if (!this.client) {
            throw new Error('Redis not connected');
        }

        if (this.streamConsumerRunning) {
            logger.warn('Stream consumer already running');
            return;
        }

        this.streamConsumerRunning = true;
        this.streamConsumerAbort = new AbortController();

        let lastId = fromId;
        logger.info(`Starting simple stream consumer: ${stream} from ${fromId}`);

        while (this.streamConsumerRunning && !this.streamConsumerAbort.signal.aborted) {
            try {
                const entries = await this.readStreamFrom(stream, lastId, 10, blockMs);

                for (const { id, message } of entries) {
                    try {
                        await onMessage(message);
                        lastId = id;
                    } catch (error: any) {
                        logger.error(`Error processing stream entry ${id}:`, error.message);
                    }
                }
            } catch (error: any) {
                if (this.streamConsumerAbort?.signal.aborted) {
                    break;
                }
                logger.error('Stream consumer error:', error.message);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }

        logger.info('Simple stream consumer stopped');
    }

    /**
     * Parse a stream entry into a StreamMessage
     *
     * Supports two formats:
     * 1. New meta:events format: { type: 'set'|'del', key: 'file:abc123/prop', ts: '...' }
     * 2. Legacy file:events format: { type: 'add'|'change'|..., path: '...', payload: '...' }
     */
    private parseStreamEntry(id: string, fields: string[]): StreamMessage | null {
        // Fields come as flat array: ['type', 'set', 'key', 'file:abc123/prop', 'ts', '123']
        const fieldMap: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) {
            fieldMap[fields[i]] = fields[i + 1];
        }

        if (!fieldMap.type) {
            logger.warn(`Invalid stream entry ${id}: missing type`);
            return null;
        }

        // New meta:events format (set/del events with key field)
        const metaEventTypes = ['set', 'del'];
        if (metaEventTypes.includes(fieldMap.type)) {
            if (!fieldMap.key) {
                logger.warn(`Invalid stream entry ${id}: missing key for ${fieldMap.type} event`);
                return null;
            }

            return {
                id,
                type: fieldMap.type as 'set' | 'del',
                key: fieldMap.key,
                ts: fieldMap.ts,
                timestamp: fieldMap.ts || fieldMap.timestamp || '0',
            };
        }

        // Legacy file:events format
        // For direct file events (add/change/delete/rename), path is required
        // For legacy events (batch/reset/plugin:complete), payload is required
        const directEventTypes = ['add', 'change', 'delete', 'rename'];
        const isDirectEvent = directEventTypes.includes(fieldMap.type);

        if (isDirectEvent && !fieldMap.path) {
            logger.warn(`Invalid stream entry ${id}: missing path for ${fieldMap.type} event`);
            return null;
        }

        const legacyEventTypes = ['batch', 'reset', 'plugin:complete'];
        if (legacyEventTypes.includes(fieldMap.type) && !fieldMap.payload) {
            logger.warn(`Invalid stream entry ${id}: missing payload for ${fieldMap.type} event`);
            return null;
        }

        return {
            id,
            type: fieldMap.type as StreamMessage['type'],
            path: fieldMap.path,
            size: fieldMap.size,
            midhash256: fieldMap.midhash256,
            oldPath: fieldMap.oldPath,
            payload: fieldMap.payload,
            timestamp: fieldMap.timestamp || '0',
        };
    }

    /**
     * Get stats about Redis data
     */
    async getStats(): Promise<{ totalKeys: number; fileCount: number; connected: boolean }> {
        if (!this.client || !this.isConnected) {
            return { totalKeys: 0, fileCount: 0, connected: false };
        }

        try {
            // Try index first
            const indexKey = `${this.config.prefix}file:__index__`;
            const count = await this.client.scard(indexKey);

            if (count > 0) {
                return {
                    totalKeys: count,
                    fileCount: count,
                    connected: true,
                };
            }

            // Fallback to scanning
            const filePattern = `${this.config.prefix}file:*`;
            const fileKeys = await this.scanKeys(filePattern);
            const actualFileKeys = fileKeys.filter(k => !k.includes('__index__'));

            return {
                totalKeys: actualFileKeys.length,
                fileCount: actualFileKeys.length,
                connected: true,
            };
        } catch {
            return { totalKeys: 0, fileCount: 0, connected: false };
        }
    }

    /**
     * Health check
     */
    async health(): Promise<boolean> {
        if (!this.client || !this.isConnected) {
            return false;
        }

        try {
            const result = await this.client.ping();
            return result === 'PONG';
        } catch {
            return false;
        }
    }

    /**
     * Close connections
     */
    async close(): Promise<void> {
        await this.disconnect();
    }

    /**
     * Get the raw ioredis client for direct access if needed
     * Use with caution - prefer using the typed methods above
     */
    getRawClient(): Redis | null {
        return this.client;
    }
}
