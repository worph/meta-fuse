/**
 * VirtualFileSystem - In-memory representation of the virtual filesystem
 *
 * Reads metadata from Redis and computes organized virtual paths
 * using MetaDataToFolderStruct for folder structure organization.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from 'tslog';
import { RedisClient, FileMetadata } from '../kv/RedisClient.js';
import { MetaDataToFolderStruct } from './MetaDataToFolderStruct.js';
import { sanitizePath } from './RenamingRule.js';
import { TemplateEngine } from './template/TemplateEngine.js';
import { ConditionEvaluator } from './template/ConditionEvaluator.js';
import { ConfigStorage } from '../config/ConfigStorage.js';
import type { RenamingConfig, RenamingRule, PreviewItem, PreviewResponse } from './types/RenamingRuleTypes.js';
import type { VFSUpdateCallback, StreamingStateBuilder } from './StreamingStateBuilder.js';

const logger = new Logger({ name: 'VirtualFileSystem' });

export interface FileAttributes {
    size: number;
    mode: number;
    mtime: number;
    atime: number;
    ctime: number;
    nlink: number;
    uid: number;
    gid: number;
}

export interface ReadResult {
    sourcePath: string | null;
    webdavUrl: string | null;
    content: Buffer | null;
    size: number;
}

interface VFSNode {
    type: 'file' | 'directory';
    name: string;
    parent: string | null;
    sourcePath?: string;
    size?: number;
    mtime?: Date;
    ctime?: Date;
    metadata?: FileMetadata;
    children?: Set<string>;
}

export interface VFSConfig {
    fileMode?: number;
    directoryMode?: number;
    uid?: number;
    gid?: number;
    configDir?: string;  // Directory for config files (renaming rules, etc.)
    webdavBaseUrl?: string | null;  // meta-sort WebDAV URL for file access (e.g., http://meta-sort-dev/webdav)
    filesPath?: string;  // Local files path prefix to strip when building WebDAV URLs
}

export class VirtualFileSystem implements VFSUpdateCallback {
    private nodes: Map<string, VFSNode> = new Map();
    private sourcePathToVirtualPath: Map<string, string> = new Map();
    private hashIdToVirtualPath: Map<string, string> = new Map();  // Track hashId -> virtualPath for streaming updates
    private redisClient: RedisClient;
    private configStorage: ConfigStorage;
    private metaDataToFolderStruct: MetaDataToFolderStruct;
    private templateEngine: TemplateEngine;
    private conditionEvaluator: ConditionEvaluator;
    private rulesConfig: RenamingConfig | null = null;
    private config: Required<VFSConfig>;
    private lastRefresh: Date | null = null;
    private useStreamingMode: boolean = false;  // Flag to indicate streaming mode
    private stateBuilder: StreamingStateBuilder | null = null;  // For stream replay during refresh

    private cachedStats = {
        fileCount: 0,
        directoryCount: 0,
        totalSize: 0,
    };

    constructor(redisClient: RedisClient, config: VFSConfig = {}) {
        this.redisClient = redisClient;
        this.metaDataToFolderStruct = new MetaDataToFolderStruct();
        this.templateEngine = new TemplateEngine();
        this.conditionEvaluator = new ConditionEvaluator();

        // Default config directory
        const configDir = config.configDir ?? '/meta-fuse/config';
        this.configStorage = new ConfigStorage({ configDir });

        this.config = {
            fileMode: config.fileMode ?? 0o644,
            directoryMode: config.directoryMode ?? 0o755,
            uid: config.uid ?? 1000,
            gid: config.gid ?? 1000,
            configDir,
            webdavBaseUrl: config.webdavBaseUrl ?? null,
            filesPath: config.filesPath ?? '/files',
        };

        // Initialize root directory
        this.initRoot();
    }

    /**
     * Initialize root directory
     */
    private initRoot(): void {
        this.nodes.clear();
        this.sourcePathToVirtualPath.clear();
        this.hashIdToVirtualPath.clear();
        this.nodes.set('/', {
            type: 'directory',
            name: '',
            parent: null,
            children: new Set(),
        });
        this.cachedStats = { fileCount: 0, directoryCount: 1, totalSize: 0 };
    }

    /**
     * Enable streaming mode
     * In streaming mode, VFS is populated via event callbacks instead of refresh()
     */
    enableStreamingMode(): void {
        this.useStreamingMode = true;
        logger.info('VFS streaming mode enabled');
    }

    /**
     * Set the streaming state builder for refresh operations
     * This enables refresh() to replay the event stream instead of using broken HGETALL
     */
    setStreamingStateBuilder(builder: StreamingStateBuilder): void {
        this.stateBuilder = builder;
        logger.debug('StreamingStateBuilder set for VFS refresh');
    }

    /**
     * Convert flat properties map to FileMetadata
     * Used when processing streaming events
     *
     * Note: During migration, not all metadata may be in flat key format yet.
     * We extract what we can from filePath as a fallback.
     */
    private flatPropertiesToMetadata(props: Record<string, string>, hashId: string): FileMetadata {
        // Get the original path (relative to FILES_VOLUME)
        const originalPath = props.filePath ?? '';

        // Resolve full source path by prepending FILES_VOLUME
        let sourcePath = originalPath;
        if (originalPath && !originalPath.startsWith('/')) {
            sourcePath = `${this.config.filesPath}/${originalPath}`;
        } else if (!originalPath.startsWith(this.config.filesPath) && originalPath.startsWith('/')) {
            sourcePath = `${this.config.filesPath}${originalPath}`;
        }

        // Extract filename from path as fallback
        const pathFileName = sourcePath ? path.basename(sourcePath) : undefined;
        const fileName = props.fileName ?? pathFileName;

        // Extract extension from filename
        const extension = props.extension ?? (pathFileName ? path.extname(pathFileName).slice(1) : undefined);

        // Parse size
        const size = parseInt(props.fileSize ?? props.size ?? props.sizeByte ?? '0', 10);

        // Parse timestamps
        let mtime = 0;
        if (props.mtime) {
            const parsed = Date.parse(props.mtime);
            mtime = isNaN(parsed) ? parseFloat(props.mtime) : parsed;
        }

        // Parse titles - can be from nested paths like 'titles/eng'
        let titles: { eng?: string; [key: string]: string | undefined } | undefined;
        if (props['titles/eng']) {
            titles = { eng: props['titles/eng'] };
        }

        // Parse season/episode
        const season = props.season !== undefined ? parseInt(props.season, 10) : undefined;
        const episode = props.episode !== undefined ? parseInt(props.episode, 10) : undefined;

        // Parse year
        const movieYear = props.movieYear ? parseInt(props.movieYear, 10) : undefined;
        const year = props.year ? parseInt(props.year, 10) : movieYear;

        // Infer fileType from extension if not provided
        let fileType = props.fileType;
        if (!fileType && extension) {
            const videoExts = ['mkv', 'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v'];
            const subtitleExts = ['srt', 'ass', 'ssa', 'sub', 'idx', 'vtt'];
            const torrentExts = ['torrent'];

            if (videoExts.includes(extension.toLowerCase())) {
                fileType = 'video';
            } else if (subtitleExts.includes(extension.toLowerCase())) {
                fileType = 'subtitle';
            } else if (torrentExts.includes(extension.toLowerCase())) {
                fileType = 'torrent';
            }
        }

        return {
            sourcePath,
            originalPath,
            size,
            mtime,
            ctime: props.ctime ? parseFloat(props.ctime) : mtime,
            hashId,
            title: props.title,
            titles,
            originalTitle: props.originalTitle,
            fileName,
            season,
            episode,
            extra: props.extra === 'true',
            movieYear,
            year,
            fileType,
            extension,
            version: props.version,
            subtitleLanguage: props.subtitleLanguage,
        };
    }

    /**
     * Start the VFS (connect to Redis and load data)
     *
     * In legacy mode: Does initial load from Redis using HGETALL/SCAN
     * In streaming mode: Just initializes, data comes via StreamingStateBuilder events
     */
    async start(): Promise<void> {
        logger.info('Starting VirtualFileSystem');

        // Load rules configuration
        this.loadRulesConfig();

        if (this.useStreamingMode) {
            // In streaming mode, VFS is populated via event callbacks
            // StreamingStateBuilder will call onFileComplete for each file
            logger.info('VirtualFileSystem started in streaming mode (data via events)');
        } else {
            // Legacy mode: Initial load from Redis (bootstrap)
            await this.refresh();
            logger.info('VirtualFileSystem started in legacy mode (updates via Redis Streams)');
        }
    }

    /**
     * Stop the VFS
     */
    async stop(): Promise<void> {
        logger.info('VirtualFileSystem stopped');
    }

    /**
     * Reset the VFS to empty state
     * Called when meta-sort triggers a fresh scan
     * The VFS will be rebuilt incrementally as files are processed via Redis Streams
     */
    reset(): void {
        logger.info('Resetting VFS for fresh scan...');

        this.initRoot();
        this.lastRefresh = null;
        logger.info('VFS reset complete - awaiting new file updates from meta-sort');
    }

    /**
     * Reset the VFS and immediately reload from Redis
     * Called when meta-sort triggers a fresh scan (reset event)
     * Unlike reset(), this method immediately repopulates from Redis keys.
     */
    async resetAndReload(): Promise<void> {
        const startTime = Date.now();
        logger.info('Resetting VFS and reloading from Redis...');

        // Clear the VFS
        this.initRoot();
        this.lastRefresh = null;

        // Immediately reload from Redis keys
        await this.refresh();

        const elapsed = Date.now() - startTime;
        logger.info(`VFS reset and reload complete: ${this.cachedStats.fileCount} files in ${elapsed}ms`);
    }

    /**
     * Refresh the VFS from Redis by replaying the event stream
     *
     * This method replays the meta:events stream from position 0, applying updates
     * incrementally without wiping the existing VFS state. Files not seen during
     * the replay are considered deleted and removed.
     *
     * Design principles:
     * - Do NOT wipe the internal model (no initRoot() call)
     * - Track which files are seen during replay
     * - Remove only files that are no longer in the stream (deleted)
     * - Single code path - reuses StreamingStateBuilder event processing
     */
    async refresh(): Promise<void> {
        logger.info('Refreshing VFS from event stream...');
        const startTime = Date.now();

        // Load rules configuration
        this.loadRulesConfig();

        // Check if we have a streaming state builder configured
        if (!this.stateBuilder) {
            logger.warn('No StreamingStateBuilder set - cannot refresh from stream');
            logger.warn('VFS refresh skipped. Set streaming state builder via setStreamingStateBuilder()');
            return;
        }

        try {
            // Track which hashIds we see during this refresh
            const seenHashIds = new Set<string>();

            // Create a tracking callback that records seen hashIds
            const originalCallback = this.stateBuilder.getVFSCallback();
            const trackingVFS: VFSUpdateCallback = {
                onPropertyChange: (hashId, property, value) => {
                    this.onPropertyChange(hashId, property, value);
                },
                onPropertyDelete: (hashId, property) => {
                    this.onPropertyDelete(hashId, property);
                },
                onFileDelete: (hashId) => {
                    this.onFileDelete(hashId);
                },
                onFileComplete: (hashId, metadata) => {
                    seenHashIds.add(hashId);
                    this.onFileComplete(hashId, metadata);
                },
            };

            // Temporarily set tracking callback
            this.stateBuilder.setVFSCallback(trackingVFS);

            // Clear state builder's internal state (but NOT VFS nodes)
            this.stateBuilder.clear();

            // Replay meta:events stream from position 0
            const lastId = await this.redisClient.replayStream(
                'meta:events',
                '0',
                async (message) => {
                    await this.stateBuilder!.processEvent(message);
                },
                100 // Batch size
            );

            // Fallback: If no files found from stream replay, scan flat keys directly
            // This handles the case where meta:events stream isn't being populated
            // but data exists in flat key format
            if (seenHashIds.size === 0) {
                const indexCount = await this.redisClient.getIndexCount();
                if (indexCount > 0) {
                    logger.info(`Stream replay found no files but index has ${indexCount} - scanning flat keys...`);

                    // Get VFS-relevant properties from state builder
                    const vfsRelevantProps = this.stateBuilder.getVfsRelevantProperties();

                    // Scan flat keys
                    const flatKeyFiles = await this.redisClient.scanFlatKeysForFiles(vfsRelevantProps);

                    // Process each file through onFileComplete
                    for (const [hashId, props] of flatKeyFiles) {
                        seenHashIds.add(hashId);
                        this.onFileComplete(hashId, props);
                    }

                    logger.info(`Flat key scan populated ${seenHashIds.size} files`);
                }
            }

            // Restore original callback
            this.stateBuilder.setVFSCallback(originalCallback || this);

            // Remove files not seen during replay (these were deleted)
            const toRemove: string[] = [];
            for (const [hashId, virtualPath] of this.hashIdToVirtualPath) {
                if (!seenHashIds.has(hashId)) {
                    logger.debug(`Removing deleted file: ${hashId} -> ${virtualPath}`);
                    toRemove.push(hashId);
                }
            }

            for (const hashId of toRemove) {
                const virtualPath = this.hashIdToVirtualPath.get(hashId);
                if (virtualPath) {
                    this.removeFile(virtualPath);
                }
                this.hashIdToVirtualPath.delete(hashId);
            }

            this.lastRefresh = new Date();
            this.updateStats();
            const elapsed = Date.now() - startTime;
            logger.info(`VFS refresh complete: ${this.cachedStats.fileCount} files, ${this.cachedStats.directoryCount} directories in ${elapsed}ms`);
            logger.info(`Replay ended at stream position: ${lastId}, removed ${toRemove.length} deleted files`);
        } catch (error) {
            logger.error('Failed to refresh VFS:', error);
        }
    }

    /**
     * Update cached stats from current nodes
     */
    private updateStats(): void {
        let fileCount = 0;
        let directoryCount = 0;
        let totalSize = 0;

        for (const node of this.nodes.values()) {
            if (node.type === 'file') {
                fileCount++;
                totalSize += node.size ?? 0;
            } else {
                directoryCount++;
            }
        }

        this.cachedStats = { fileCount, directoryCount, totalSize };
    }

    /**
     * Load rules configuration from file
     * ConfigStorage creates the default config file if it doesn't exist
     */
    private loadRulesConfig(): void {
        this.rulesConfig = this.configStorage.getRulesConfig();
        const isDefault = this.rulesConfig.isDefault ? ' (default)' : '';
        logger.debug(`Loaded ${this.rulesConfig.rules.length} renaming rules${isDefault}`);
    }

    /**
     * Compute virtual path for a file using template rules
     */
    private computeVirtualPath(metadata: FileMetadata, sourcePath: string): string {
        if (!this.rulesConfig) {
            // Fallback to old behavior
            return this.metaDataToFolderStruct.generateSingleVirtualPath(sourcePath, metadata);
        }

        // Sort rules by priority (descending)
        const sortedRules = [...this.rulesConfig.rules]
            .filter(r => r.enabled)
            .sort((a, b) => b.priority - a.priority);

        // Find first matching rule
        for (const rule of sortedRules) {
            if (this.conditionEvaluator.evaluateGroup(rule.conditions, metadata as Record<string, unknown>)) {
                const result = this.templateEngine.interpolate(rule.template, metadata as Record<string, unknown>);
                if (result) {
                    return sanitizePath(result);
                }
                if (rule.fallbackToUnsorted) {
                    const filename = metadata.fileName || sourcePath.split('/').pop() || 'unknown';
                    return `Unsorted/${filename}`;
                }
            }
        }

        // Apply default rule if no rules matched
        if (this.rulesConfig.defaultRule) {
            const result = this.templateEngine.interpolate(
                this.rulesConfig.defaultRule.template,
                metadata as Record<string, unknown>
            );
            if (result) {
                return sanitizePath(result);
            }
        }

        // Ultimate fallback
        const filename = metadata.fileName || sourcePath.split('/').pop() || 'unknown';
        return `Unsorted/${filename}`;
    }

    /**
     * Handle file event by path (from meta-core)
     * Used for direct file events where we have the path but not the hashId
     *
     * @param path - File path relative to FILES_VOLUME
     * @param action - Event type: add, change, delete, rename
     * @param oldPath - For rename events, the old path
     */
    async onFileEventByPath(path: string, action: 'add' | 'change' | 'delete' | 'rename', oldPath?: string): Promise<void> {
        // Construct source path by prepending FILES_VOLUME
        const sourcePath = path.startsWith('/') ? `${this.config.filesPath}${path}` : `${this.config.filesPath}/${path}`;

        if (action === 'delete') {
            // Find and remove file by source path
            const virtualPath = this.sourcePathToVirtualPath.get(sourcePath);
            if (virtualPath) {
                this.removeFile(virtualPath);
                logger.debug(`File deleted: ${virtualPath}`);
            }
            return;
        }

        if (action === 'rename' && oldPath) {
            // Remove old file first
            const oldSourcePath = oldPath.startsWith('/') ? `${this.config.filesPath}${oldPath}` : `${this.config.filesPath}/${oldPath}`;
            const oldVirtualPath = this.sourcePathToVirtualPath.get(oldSourcePath);
            if (oldVirtualPath) {
                this.removeFile(oldVirtualPath);
            }
            // Fall through to add the renamed file
        }

        // For add/change/rename: Look up metadata in Redis by path
        // We need to find the hashId for this path, then get the full metadata
        const files = await this.redisClient.getAllFiles();
        const metadata = files.get(sourcePath);

        if (!metadata) {
            // File exists on disk but not yet processed (metadata not in Redis)
            // This is expected - meta-core detects files before meta-sort processes them
            logger.debug(`File not yet in Redis: ${sourcePath}`);
            return;
        }

        // Compute virtual path for this file
        const virtualPath = this.computeVirtualPath(metadata, sourcePath);

        if (!virtualPath) {
            logger.debug(`Could not compute virtual path for: ${sourcePath}`);
            return;
        }

        // If updating, remove old entry first
        if (action === 'change') {
            const oldVirtualPath = this.sourcePathToVirtualPath.get(sourcePath);
            if (oldVirtualPath && oldVirtualPath !== virtualPath) {
                this.removeFile(oldVirtualPath);
            }
        }

        // Add/update file
        await this.addFile(virtualPath, metadata);
        this.sourcePathToVirtualPath.set(sourcePath, virtualPath);

        logger.debug(`File ${action}: ${virtualPath}`);
    }

    /**
     * Handle incremental file update from pub/sub (legacy, hashId-based)
     * Adds or updates a single file without full rebuild
     */
    async onFileUpdate(hashId: string, action: 'add' | 'update' | 'remove'): Promise<void> {
        if (action === 'remove') {
            // Find and remove file by hashId
            for (const [vPath, node] of this.nodes) {
                if (node.type === 'file' && node.metadata?.hashId === hashId) {
                    this.removeFile(vPath);
                    break;
                }
            }
            return;
        }

        // Add or update: fetch metadata and compute virtual path
        const metadata = await this.redisClient.getFileByHashId(hashId);
        if (!metadata) {
            logger.warn(`File not found in Redis: ${hashId}`);
            return;
        }

        // Compute virtual path for this single file
        const virtualPath = this.metaDataToFolderStruct.generateSingleVirtualPath(
            metadata.sourcePath,
            metadata
        );

        // If updating, remove old entry first
        if (action === 'update') {
            const oldVirtualPath = this.sourcePathToVirtualPath.get(metadata.sourcePath);
            if (oldVirtualPath && oldVirtualPath !== virtualPath) {
                this.removeFile(oldVirtualPath);
            }
        }

        // Add/update file
        await this.addFile(virtualPath, metadata);
        this.sourcePathToVirtualPath.set(metadata.sourcePath, virtualPath);

        logger.debug(`File ${action}ed: ${virtualPath}`);
    }

    /**
     * Add a file to the VFS
     */
    private async addFile(virtualPath: string, metadata: FileMetadata): Promise<void> {
        virtualPath = this.normalizePath(virtualPath);

        // Skip if file already exists at this path
        if (this.nodes.has(virtualPath) && this.nodes.get(virtualPath)!.type === 'file') {
            // Update existing file
            const node = this.nodes.get(virtualPath)!;
            const oldSize = node.size ?? 0;
            this.cachedStats.totalSize -= oldSize;
            this.cachedStats.fileCount--;
        }

        // Create parent directories
        const dirname = path.dirname(virtualPath);
        this.ensureDirectory(dirname);

        // Get file stats
        let size = metadata.size;
        let mtime = new Date(metadata.mtime || Date.now());
        let ctime = new Date(metadata.ctime || metadata.mtime || Date.now());

        // Fallback: stat the source file if metadata is incomplete
        if (!size && metadata.sourcePath) {
            try {
                const stats = fs.statSync(metadata.sourcePath);
                size = stats.size;
                mtime = stats.mtime;
                ctime = stats.ctime;
            } catch {
                // Local stat failed, try WebDAV if configured
                if (this.config.webdavBaseUrl) {
                    const webdavStats = await this.statViaWebDAV(metadata.sourcePath);
                    if (webdavStats) {
                        size = webdavStats.size;
                        mtime = webdavStats.mtime || mtime;
                    } else {
                        logger.warn(`Cannot stat source file via WebDAV: ${metadata.sourcePath}`);
                        return;
                    }
                } else {
                    logger.warn(`Cannot stat source file: ${metadata.sourcePath}`);
                    return;
                }
            }
        }

        // Add file node
        const filename = path.basename(virtualPath);
        this.nodes.set(virtualPath, {
            type: 'file',
            name: filename,
            parent: dirname,
            sourcePath: metadata.sourcePath,
            size,
            mtime,
            ctime,
            metadata,
        });

        // Add to parent's children
        const parentNode = this.nodes.get(dirname);
        if (parentNode && parentNode.type === 'directory') {
            parentNode.children!.add(filename);
        }

        // Update stats
        this.cachedStats.fileCount++;
        this.cachedStats.totalSize += size;
    }

    /**
     * Get file stats via WebDAV HEAD request
     */
    private async statViaWebDAV(sourcePath: string): Promise<{ size: number; mtime?: Date } | null> {
        if (!this.config.webdavBaseUrl) {
            return null;
        }

        try {
            // Convert source path to WebDAV URL
            let relativePath = sourcePath;
            if (this.config.filesPath && sourcePath.startsWith(this.config.filesPath)) {
                relativePath = sourcePath.slice(this.config.filesPath.length);
            }
            if (!relativePath.startsWith('/')) {
                relativePath = '/' + relativePath;
            }

            // URL-encode path segments (but not slashes)
            const encodedPath = relativePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
            const webdavUrl = this.config.webdavBaseUrl + encodedPath;

            // Make HEAD request
            const response = await fetch(webdavUrl, { method: 'HEAD' });

            if (response.ok) {
                const contentLength = response.headers.get('Content-Length');
                const lastModified = response.headers.get('Last-Modified');

                return {
                    size: contentLength ? parseInt(contentLength, 10) : 0,
                    mtime: lastModified ? new Date(lastModified) : undefined,
                };
            }

            logger.debug(`WebDAV HEAD failed for ${webdavUrl}: ${response.status}`);
            return null;
        } catch (error: any) {
            logger.debug(`WebDAV stat error for ${sourcePath}: ${error.message}`);
            return null;
        }
    }

    /**
     * Remove a file from the VFS
     */
    private removeFile(virtualPath: string): void {
        virtualPath = this.normalizePath(virtualPath);
        const node = this.nodes.get(virtualPath);

        if (!node || node.type !== 'file') {
            return;
        }

        // Remove from parent's children
        if (node.parent) {
            const parentNode = this.nodes.get(node.parent);
            if (parentNode && parentNode.type === 'directory') {
                parentNode.children!.delete(node.name);
            }
        }

        // Update stats
        this.cachedStats.fileCount--;
        this.cachedStats.totalSize -= node.size ?? 0;

        // Remove node
        this.nodes.delete(virtualPath);

        // Remove from source path mapping
        if (node.sourcePath) {
            this.sourcePathToVirtualPath.delete(node.sourcePath);
        }

        // Clean up empty parent directories
        this.cleanEmptyDirectories(node.parent);
    }

    /**
     * Clean up empty directories
     */
    private cleanEmptyDirectories(dirPath: string | null): void {
        if (!dirPath || dirPath === '/') {
            return;
        }

        const node = this.nodes.get(dirPath);
        if (!node || node.type !== 'directory') {
            return;
        }

        // Only remove if empty
        if (node.children!.size === 0) {
            // Remove from parent
            if (node.parent) {
                const parentNode = this.nodes.get(node.parent);
                if (parentNode && parentNode.type === 'directory') {
                    parentNode.children!.delete(node.name);
                }
            }

            // Remove this directory
            this.nodes.delete(dirPath);
            this.cachedStats.directoryCount--;

            // Recursively clean parent
            this.cleanEmptyDirectories(node.parent);
        }
    }

    /**
     * Ensure a directory exists in the VFS
     */
    private ensureDirectory(dirPath: string): void {
        dirPath = this.normalizePath(dirPath);

        if (dirPath === '/' || this.nodes.has(dirPath)) {
            return;
        }

        // Recursively create parent
        const parentPath = path.dirname(dirPath);
        this.ensureDirectory(parentPath);

        // Create this directory
        const dirName = path.basename(dirPath);
        this.nodes.set(dirPath, {
            type: 'directory',
            name: dirName,
            parent: parentPath,
            children: new Set(),
        });

        // Add to parent's children
        const parentNode = this.nodes.get(parentPath);
        if (parentNode && parentNode.type === 'directory') {
            parentNode.children!.add(dirName);
        }

        this.cachedStats.directoryCount++;
    }

    /**
     * Normalize path
     */
    private normalizePath(p: string): string {
        p = p.split(path.sep).join('/');
        if (!p.startsWith('/')) {
            p = '/' + p;
        }
        if (p !== '/' && p.endsWith('/')) {
            p = p.slice(0, -1);
        }
        return p;
    }

    // FUSE API Methods

    /**
     * List directory contents
     */
    readdir(dirPath: string): string[] | null {
        dirPath = this.normalizePath(dirPath);
        const node = this.nodes.get(dirPath);

        if (!node || node.type !== 'directory') {
            return null;
        }

        return Array.from(node.children!);
    }

    /**
     * Get file attributes
     */
    getattr(filepath: string): FileAttributes | null {
        filepath = this.normalizePath(filepath);
        const node = this.nodes.get(filepath);

        if (!node) {
            return null;
        }

        if (node.type === 'directory') {
            return {
                size: 4096,
                mode: 0o040000 | this.config.directoryMode,
                mtime: Date.now() / 1000,
                atime: Date.now() / 1000,
                ctime: Date.now() / 1000,
                nlink: 2,
                uid: this.config.uid,
                gid: this.config.gid,
            };
        } else {
            return {
                size: node.size!,
                mode: 0o100000 | this.config.fileMode,
                mtime: node.mtime!.getTime() / 1000,
                atime: node.mtime!.getTime() / 1000,
                ctime: node.ctime!.getTime() / 1000,
                nlink: 1,
                uid: this.config.uid,
                gid: this.config.gid,
            };
        }
    }

    /**
     * Check if path exists
     */
    exists(filepath: string): boolean {
        filepath = this.normalizePath(filepath);
        return this.nodes.has(filepath);
    }

    /**
     * Read file (returns source path and/or WebDAV URL for actual reading)
     */
    read(filepath: string): ReadResult | null {
        filepath = this.normalizePath(filepath);
        const node = this.nodes.get(filepath);

        if (!node || node.type !== 'file') {
            return null;
        }

        // Compute WebDAV URL if configured
        let webdavUrl: string | null = null;
        if (this.config.webdavBaseUrl && node.sourcePath) {
            // Convert sourcePath (e.g., /files/watch/movie.mkv) to WebDAV URL
            // Strip filesPath prefix and append to webdavBaseUrl
            let relativePath = node.sourcePath;
            const filesPath = this.config.filesPath;
            if (relativePath.startsWith(filesPath + '/')) {
                relativePath = relativePath.substring(filesPath.length);
            } else if (relativePath.startsWith(filesPath)) {
                relativePath = relativePath.substring(filesPath.length);
            }
            // Ensure path starts with /
            if (!relativePath.startsWith('/')) {
                relativePath = '/' + relativePath;
            }
            // URL-encode the path components (but not the slashes)
            const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/');
            webdavUrl = this.config.webdavBaseUrl.replace(/\/$/, '') + encodedPath;
        }

        return {
            sourcePath: node.sourcePath!,
            webdavUrl,
            content: null,
            size: node.size!,
        };
    }

    /**
     * Get file metadata
     */
    getMetadata(filepath: string): FileMetadata | null {
        filepath = this.normalizePath(filepath);
        const node = this.nodes.get(filepath);

        if (!node || node.type !== 'file') {
            return null;
        }

        return node.metadata ?? null;
    }

    /**
     * Get all file paths
     */
    getAllFiles(): string[] {
        const files: string[] = [];
        for (const [filepath, node] of this.nodes.entries()) {
            if (node.type === 'file') {
                files.push(filepath);
            }
        }
        return files;
    }

    /**
     * Get all directory paths
     */
    getAllDirectories(): string[] {
        const dirs: string[] = [];
        for (const [dirpath, node] of this.nodes.entries()) {
            if (node.type === 'directory') {
                dirs.push(dirpath);
            }
        }
        return dirs;
    }

    /**
     * Get VFS statistics
     */
    getStats(): {
        fileCount: number;
        directoryCount: number;
        totalSize: number;
        lastRefresh: string | null;
        redisConnected: boolean;
    } {
        return {
            ...this.cachedStats,
            lastRefresh: this.lastRefresh?.toISOString() ?? null,
            redisConnected: this.redisClient.connected,
        };
    }

    /**
     * Get virtual path for a source path
     */
    getVirtualPath(sourcePath: string): string | null {
        return this.sourcePathToVirtualPath.get(sourcePath) ?? null;
    }

    // ============================================
    // Rules Configuration API
    // ============================================

    /**
     * Get current rules configuration
     */
    getRulesConfig(): RenamingConfig {
        if (!this.rulesConfig) {
            this.loadRulesConfig();
        }
        return this.rulesConfig!;
    }

    /**
     * Save rules configuration to file
     */
    saveRulesConfig(config: RenamingConfig): void {
        this.configStorage.saveRulesConfig(config);
        this.rulesConfig = config;
        logger.info(`Saved rules configuration with ${config.rules.length} rules`);
    }

    /**
     * Preview how files would be renamed with given rules
     */
    async previewRules(testRules?: RenamingRule[], limit: number = 100): Promise<PreviewResponse> {
        const files = await this.redisClient.getAllFiles();
        const previews: PreviewItem[] = [];

        // Use test rules or current config
        const rulesToTest = testRules || this.rulesConfig?.rules || [];
        const defaultRule = this.rulesConfig?.defaultRule;

        let count = 0;
        for (const [sourcePath, metadata] of files) {
            if (count >= limit) break;

            const currentVirtualPath = this.sourcePathToVirtualPath.get(sourcePath) || 'Unknown';

            try {
                // Compute new path with test rules
                const newVirtualPath = this.computeVirtualPathWithRules(
                    metadata,
                    sourcePath,
                    rulesToTest,
                    defaultRule
                );
                const matchedRule = this.findMatchingRule(metadata, rulesToTest);

                previews.push({
                    sourcePath,
                    currentVirtualPath,
                    newVirtualPath,
                    matchedRule: matchedRule?.id || null,
                });
            } catch (error: any) {
                previews.push({
                    sourcePath,
                    currentVirtualPath,
                    newVirtualPath: null,
                    matchedRule: null,
                    error: error.message,
                });
            }

            count++;
        }

        return {
            previews,
            total: files.size,
            limited: files.size > limit,
        };
    }

    /**
     * Compute virtual path with specific rules (for preview)
     */
    private computeVirtualPathWithRules(
        metadata: FileMetadata,
        sourcePath: string,
        rules: RenamingRule[],
        defaultRule?: RenamingRule
    ): string {
        // Sort rules by priority (descending)
        const sortedRules = [...rules]
            .filter(r => r.enabled)
            .sort((a, b) => b.priority - a.priority);

        // Find first matching rule
        for (const rule of sortedRules) {
            if (this.conditionEvaluator.evaluateGroup(rule.conditions, metadata as Record<string, unknown>)) {
                const result = this.templateEngine.interpolate(rule.template, metadata as Record<string, unknown>);
                if (result) {
                    return sanitizePath(result);
                }
                if (rule.fallbackToUnsorted) {
                    const filename = metadata.fileName || sourcePath.split('/').pop() || 'unknown';
                    return `Unsorted/${filename}`;
                }
            }
        }

        // Apply default rule if no rules matched
        if (defaultRule) {
            const result = this.templateEngine.interpolate(
                defaultRule.template,
                metadata as Record<string, unknown>
            );
            if (result) {
                return sanitizePath(result);
            }
        }

        // Ultimate fallback
        const filename = metadata.fileName || sourcePath.split('/').pop() || 'unknown';
        return `Unsorted/${filename}`;
    }

    /**
     * Find which rule matches a file
     */
    private findMatchingRule(metadata: FileMetadata, rules: RenamingRule[]): RenamingRule | null {
        const sortedRules = [...rules]
            .filter(r => r.enabled)
            .sort((a, b) => b.priority - a.priority);

        for (const rule of sortedRules) {
            if (this.conditionEvaluator.evaluateGroup(rule.conditions, metadata as Record<string, unknown>)) {
                return rule;
            }
        }

        return null;
    }

    // ============================================
    // VFSUpdateCallback Implementation
    // (for streaming state builder integration)
    // ============================================

    /**
     * Handle a property change event from the streaming state builder
     * This is called for each VFS-relevant property that changes
     *
     * In streaming mode, we don't immediately update the VFS on every property change.
     * Instead, we wait for onFileComplete which has the full metadata.
     */
    onPropertyChange(hashId: string, property: string, value: string): void {
        // In streaming mode, individual property changes don't trigger VFS updates
        // The VFS is updated when onFileComplete is called with full metadata
        logger.debug(`Property changed for ${hashId}: ${property}=${value.substring(0, 50)}...`);
    }

    /**
     * Handle a property delete event from the streaming state builder
     */
    onPropertyDelete(hashId: string, property: string): void {
        logger.debug(`Property deleted for ${hashId}: ${property}`);

        // If filePath was deleted, the file should be removed from VFS
        // This is handled by onFileDelete, so we just log here
    }

    /**
     * Handle file deletion from the streaming state builder
     * Called when filePath is deleted or all properties are removed
     */
    onFileDelete(hashId: string): void {
        const virtualPath = this.hashIdToVirtualPath.get(hashId);

        if (virtualPath) {
            this.removeFile(virtualPath);
            this.hashIdToVirtualPath.delete(hashId);
            logger.debug(`File deleted from VFS: ${hashId} -> ${virtualPath}`);
        }
    }

    /**
     * Handle file complete event from the streaming state builder
     * Called when a file has filePath and enough metadata to compute virtual path
     *
     * @param hashId - The file hash ID
     * @param metadata - Flat properties map from the streaming state builder
     */
    onFileComplete(hashId: string, metadata: Record<string, string>): void {
        // Load rules if not loaded
        if (!this.rulesConfig) {
            this.loadRulesConfig();
        }

        // Convert flat properties to FileMetadata
        const fileMetadata = this.flatPropertiesToMetadata(metadata, hashId);

        if (!fileMetadata.sourcePath) {
            logger.warn(`onFileComplete: No sourcePath for ${hashId}`);
            return;
        }

        // Compute virtual path
        const virtualPath = this.computeVirtualPath(fileMetadata, fileMetadata.sourcePath);

        if (!virtualPath) {
            logger.debug(`Could not compute virtual path for: ${fileMetadata.sourcePath}`);
            return;
        }

        // If file already exists at a different virtual path, remove old entry
        const oldVirtualPath = this.hashIdToVirtualPath.get(hashId);
        if (oldVirtualPath && oldVirtualPath !== virtualPath) {
            this.removeFile(oldVirtualPath);
        }

        // Add/update file in VFS
        this.addFileSync(virtualPath, fileMetadata);
        this.sourcePathToVirtualPath.set(fileMetadata.sourcePath, virtualPath);
        this.hashIdToVirtualPath.set(hashId, virtualPath);

        logger.debug(`File complete: ${hashId} -> ${virtualPath}`);
        this.lastRefresh = new Date();
    }

    /**
     * Synchronous version of addFile for streaming updates
     * Used by onFileComplete which is called synchronously from event processing
     */
    private addFileSync(virtualPath: string, metadata: FileMetadata): void {
        virtualPath = this.normalizePath(virtualPath);

        // Skip if file already exists at this path
        if (this.nodes.has(virtualPath) && this.nodes.get(virtualPath)!.type === 'file') {
            // Update existing file
            const node = this.nodes.get(virtualPath)!;
            const oldSize = node.size ?? 0;
            this.cachedStats.totalSize -= oldSize;
            this.cachedStats.fileCount--;
        }

        // Create parent directories
        const dirname = path.dirname(virtualPath);
        this.ensureDirectory(dirname);

        // Get file stats from metadata
        const size = metadata.size || 0;
        const mtime = new Date(metadata.mtime || Date.now());
        const ctime = new Date(metadata.ctime || metadata.mtime || Date.now());

        // Add file node
        const filename = path.basename(virtualPath);
        this.nodes.set(virtualPath, {
            type: 'file',
            name: filename,
            parent: dirname,
            sourcePath: metadata.sourcePath,
            size,
            mtime,
            ctime,
            metadata,
        });

        // Add to parent's children
        const parentNode = this.nodes.get(dirname);
        if (parentNode && parentNode.type === 'directory') {
            parentNode.children!.add(filename);
        }

        // Update stats
        this.cachedStats.fileCount++;
        this.cachedStats.totalSize += size;
    }

    /**
     * Update a file in VFS when its metadata changes
     * Called when streaming events indicate a property change for an existing file
     *
     * @param hashId - The file hash ID
     * @param metadata - Updated metadata properties
     */
    updateFileFromStreaming(hashId: string, metadata: Record<string, string>): void {
        // Just delegate to onFileComplete which handles both add and update
        this.onFileComplete(hashId, metadata);
    }
}
