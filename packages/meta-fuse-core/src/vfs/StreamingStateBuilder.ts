/**
 * Streaming State Builder
 *
 * Manages file metadata state by processing events from the meta:events stream.
 * Each event triggers a GET for the changed property, building state incrementally.
 *
 * This replaces the batch HGETALL/SCAN approach with a streaming model:
 * 1. On startup: Replay meta:events from position 0 to rebuild state
 * 2. Live: Continue consuming new events for real-time updates
 */

import { Logger } from 'tslog';
import { RedisClient, StreamMessage, ParsedMetaEventKey } from '../kv/RedisClient.js';
import { RulesPropertyExtractor, isVfsRelevantProperty } from './RulesPropertyExtractor.js';
import type { RenamingConfig } from './types/RenamingRuleTypes.js';

const logger = new Logger({ name: 'StreamingStateBuilder' });

/**
 * File metadata state - map of property name to value
 */
export type FileState = Map<string, string>;

/**
 * All files state - map of hashId to FileState
 */
export type FilesState = Map<string, FileState>;

/**
 * Callback for VFS updates
 */
export interface VFSUpdateCallback {
    onPropertyChange(hashId: string, property: string, value: string): void;
    onPropertyDelete(hashId: string, property: string): void;
    onFileDelete(hashId: string): void;
    onFileComplete(hashId: string, metadata: Record<string, string>): void;
}

/**
 * Configuration for StreamingStateBuilder
 */
export interface StreamingStateBuilderConfig {
    /** Redis client for fetching property values */
    redisClient: RedisClient;
    /** Renaming rules config for extracting VFS-relevant properties */
    rulesConfig: RenamingConfig;
    /** VFS update callback */
    vfsCallback?: VFSUpdateCallback;
    /** FILES_VOLUME path prefix */
    filesPath?: string;
}

/**
 * StreamingStateBuilder class
 *
 * Builds and maintains file metadata state by processing stream events.
 * Only fetches and stores VFS-relevant properties to minimize memory usage.
 */
export class StreamingStateBuilder {
    private state: FilesState = new Map();
    private vfsRelevantProps: Set<string>;
    private redisClient: RedisClient;
    private vfsCallback?: VFSUpdateCallback;
    private filesPath: string;
    private propertyExtractor: RulesPropertyExtractor;

    // Stats
    private stats = {
        eventsProcessed: 0,
        propertiesFetched: 0,
        propertiesSkipped: 0,
        filesComplete: 0,
        lastEventId: '0',
    };

    constructor(config: StreamingStateBuilderConfig) {
        this.redisClient = config.redisClient;
        this.vfsCallback = config.vfsCallback;
        this.filesPath = config.filesPath ?? '/files';

        // Extract VFS-relevant properties from rules
        this.propertyExtractor = new RulesPropertyExtractor();
        this.vfsRelevantProps = this.propertyExtractor.extractVfsProperties(config.rulesConfig);

        logger.info(`StreamingStateBuilder initialized with ${this.vfsRelevantProps.size} VFS-relevant properties`);
        logger.debug('VFS-relevant properties:', Array.from(this.vfsRelevantProps).join(', '));
    }

    /**
     * Set the VFS update callback
     */
    setVFSCallback(callback: VFSUpdateCallback): void {
        this.vfsCallback = callback;
    }

    /**
     * Update rules config and re-extract VFS-relevant properties
     */
    updateRulesConfig(rulesConfig: RenamingConfig): void {
        this.vfsRelevantProps = this.propertyExtractor.extractVfsProperties(rulesConfig);
        logger.info(`Updated VFS-relevant properties: ${this.vfsRelevantProps.size}`);
    }

    /**
     * Process a stream message event
     * This is the main entry point for event processing
     */
    async processEvent(message: StreamMessage): Promise<void> {
        this.stats.eventsProcessed++;
        this.stats.lastEventId = message.id;

        // Handle new meta:events format (set/del with key field)
        if ((message.type === 'set' || message.type === 'del') && message.key) {
            await this.processMetaEvent(message);
            return;
        }

        // Ignore legacy event types - they're not supported in flat key architecture
        // Legacy events used path/payload format which doesn't apply to flat keys
        logger.debug(`Ignoring legacy event type: ${message.type}`);
    }

    /**
     * Process a meta:events format event (set/del with key)
     */
    private async processMetaEvent(message: StreamMessage): Promise<void> {
        const parsed = this.redisClient.parseMetaEventKey(message.key!);
        if (!parsed) {
            // Not a file metadata key (could be index or other key)
            return;
        }

        const { hashId, property } = parsed;

        if (message.type === 'del') {
            this.handlePropertyDelete(hashId, property);
            return;
        }

        // message.type === 'set'
        await this.handlePropertySet(hashId, property);
    }

    /**
     * Handle a property set event
     * Fetches the property value if VFS-relevant and updates state
     */
    private async handlePropertySet(hashId: string, property: string): Promise<void> {
        // Check if this property is VFS-relevant
        if (!isVfsRelevantProperty(property, this.vfsRelevantProps)) {
            this.stats.propertiesSkipped++;
            return;
        }

        // Fetch the property value from Redis
        const value = await this.redisClient.getProperty(hashId, property);
        if (value === null) {
            // Property was set then deleted before we could fetch it
            // Or it's a different data type (shouldn't happen in flat key architecture)
            return;
        }

        this.stats.propertiesFetched++;

        // Check if file was complete BEFORE updating state
        const wasComplete = this.isFileComplete(hashId);

        // Update internal state
        this.updateProperty(hashId, property, value);

        // Notify VFS of changes
        if (this.vfsCallback) {
            this.vfsCallback.onPropertyChange(hashId, property, value);

            // If file just became complete (has filePath now), notify VFS
            if (!wasComplete && this.isFileComplete(hashId)) {
                this.stats.filesComplete++;
                const metadata = this.getFileMetadata(hashId);
                if (metadata) {
                    this.vfsCallback.onFileComplete(hashId, metadata);
                }
            } else if (wasComplete) {
                // File was already complete, but properties changed - update VFS
                // This handles cases where title, season, etc. arrive after filePath
                const metadata = this.getFileMetadata(hashId);
                if (metadata) {
                    this.vfsCallback.onFileComplete(hashId, metadata);
                }
            }
        }
    }

    /**
     * Handle a property delete event
     */
    private handlePropertyDelete(hashId: string, property: string): void {
        const fileState = this.state.get(hashId);
        if (!fileState) {
            return;
        }

        // Remove the property
        fileState.delete(property);

        // If this was the filePath, the file is no longer in VFS
        if (property === 'filePath') {
            this.state.delete(hashId);
            if (this.vfsCallback) {
                this.vfsCallback.onFileDelete(hashId);
            }
            return;
        }

        // If file has no more properties, remove it
        if (fileState.size === 0) {
            this.state.delete(hashId);
            if (this.vfsCallback) {
                this.vfsCallback.onFileDelete(hashId);
            }
            return;
        }

        // Notify VFS of property deletion
        if (this.vfsCallback) {
            this.vfsCallback.onPropertyDelete(hashId, property);
        }
    }

    /**
     * Update a property in the state
     */
    private updateProperty(hashId: string, property: string, value: string): void {
        let fileState = this.state.get(hashId);
        if (!fileState) {
            fileState = new Map();
            this.state.set(hashId, fileState);
        }
        fileState.set(property, value);
    }

    /**
     * Check if a file has filePath (required to appear in VFS)
     */
    private isFileComplete(hashId: string): boolean {
        const fileState = this.state.get(hashId);
        return fileState?.has('filePath') ?? false;
    }

    /**
     * Get metadata for a single file
     */
    getFileMetadata(hashId: string): Record<string, string> | null {
        const fileState = this.state.get(hashId);
        if (!fileState) {
            return null;
        }
        return Object.fromEntries(fileState);
    }

    /**
     * Get all files with their metadata
     * Only returns files that are "complete" (have filePath)
     */
    getAllFiles(): Map<string, Record<string, string>> {
        const result = new Map<string, Record<string, string>>();

        for (const [hashId, fileState] of this.state) {
            if (fileState.has('filePath')) {
                result.set(hashId, Object.fromEntries(fileState));
            }
        }

        return result;
    }

    /**
     * Get file count (complete files only)
     */
    getFileCount(): number {
        let count = 0;
        for (const fileState of this.state.values()) {
            if (fileState.has('filePath')) {
                count++;
            }
        }
        return count;
    }

    /**
     * Get statistics
     */
    getStats(): typeof this.stats & { fileCount: number; stateSize: number } {
        return {
            ...this.stats,
            fileCount: this.getFileCount(),
            stateSize: this.state.size,
        };
    }

    /**
     * Clear all state (for reset)
     */
    clear(): void {
        this.state.clear();
        this.stats = {
            eventsProcessed: 0,
            propertiesFetched: 0,
            propertiesSkipped: 0,
            filesComplete: 0,
            lastEventId: '0',
        };
        logger.info('State cleared');
    }

    /**
     * Get the last processed event ID
     */
    getLastEventId(): string {
        return this.stats.lastEventId;
    }

    /**
     * Resolve source path from filePath property
     * Prepends FILES_VOLUME if needed
     */
    resolveSourcePath(filePath: string): string {
        if (filePath.startsWith('/')) {
            // Already absolute
            if (filePath.startsWith(this.filesPath)) {
                return filePath;
            }
            // Absolute but not in filesPath - prepend
            return `${this.filesPath}${filePath}`;
        }
        // Relative path - prepend filesPath
        return `${this.filesPath}/${filePath}`;
    }
}
