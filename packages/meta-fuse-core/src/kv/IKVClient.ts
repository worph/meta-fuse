/**
 * KV Client Interface - Read-only abstraction for meta-fuse
 *
 * meta-fuse is a FOLLOWER service that only reads metadata from Redis.
 * This interface provides the subset of operations needed for reading.
 */

export interface KeyValuePair {
    key: string;
    value: string;
}

export interface IKVClient {
    /**
     * Get a value by key (value is JSON deserialized)
     */
    get(key: string): Promise<any | null>;

    /**
     * Count keys with a given prefix
     */
    countKeysWithPrefix(prefix: string): Promise<number>;

    /**
     * Health check - verifies KV store is accessible
     */
    health(): Promise<boolean>;

    /**
     * Get all key-value pairs with a given prefix
     */
    getRange(prefix: string): Promise<KeyValuePair[]>;

    /**
     * Retrieve file metadata - reconstructs from individual property keys
     */
    getMetadataFlat(hashId: string): Promise<any | null>;

    /**
     * Get all unique hash IDs (files) stored in KV
     */
    getAllHashIds(): Promise<string[]>;

    /**
     * Subscribe to Redis pub/sub channel
     */
    subscribe(channel: string, callback: (message: string) => void): Promise<void>;

    /**
     * Unsubscribe from Redis pub/sub channel
     */
    unsubscribe(channel: string): Promise<void>;

    /**
     * Close connections and cleanup resources
     */
    close(): Promise<void>;
}

/**
 * Leader lock file content format
 */
export interface LeaderLockInfo {
    /** Hostname of the leader */
    host: string;

    /** Redis connection URL (e.g., redis://10.0.1.50:6379) */
    api: string;

    /** HTTP API URL for the leader service */
    http: string;

    /** Timestamp when leadership was acquired */
    timestamp: number;

    /** Process ID of the leader */
    pid: number;
}

/**
 * Service registration info stored in JSON file
 */
export interface ServiceInfo {
    /** Service name */
    name: string;

    /** Service version */
    version: string;

    /** HTTP API URL (e.g., http://10.0.1.50:3000) */
    api: string;

    /** Service status */
    status: 'starting' | 'running' | 'stopping' | 'stopped';

    /** Process ID */
    pid: number;

    /** Hostname */
    hostname: string;

    /** Service start time (ISO string) */
    startedAt: string;

    /** Last heartbeat time (ISO string) */
    lastHeartbeat: string;

    /** Service capabilities */
    capabilities: string[];

    /** Named endpoints */
    endpoints: Record<string, string>;
}
