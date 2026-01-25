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
    refreshInterval?: number;
    configDir?: string;  // Directory for config files (renaming rules, etc.)
    webdavBaseUrl?: string | null;  // meta-sort WebDAV URL for file access (e.g., http://meta-sort-dev/webdav)
    filesPath?: string;  // Local files path prefix to strip when building WebDAV URLs
}

export class VirtualFileSystem {
    private nodes: Map<string, VFSNode> = new Map();
    private sourcePathToVirtualPath: Map<string, string> = new Map();
    private redisClient: RedisClient;
    private configStorage: ConfigStorage;
    private metaDataToFolderStruct: MetaDataToFolderStruct;
    private templateEngine: TemplateEngine;
    private conditionEvaluator: ConditionEvaluator;
    private rulesConfig: RenamingConfig | null = null;
    private config: Required<VFSConfig>;
    private refreshTimer: NodeJS.Timeout | null = null;
    private lastRefresh: Date | null = null;

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
            refreshInterval: config.refreshInterval ?? 30000, // 30 seconds
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
        this.nodes.set('/', {
            type: 'directory',
            name: '',
            parent: null,
            children: new Set(),
        });
        this.cachedStats = { fileCount: 0, directoryCount: 1, totalSize: 0 };
    }

    /**
     * Start the VFS (connect to Redis and load data)
     */
    async start(): Promise<void> {
        logger.info('Starting VirtualFileSystem');

        // Initial load
        await this.refresh();

        // Start periodic refresh
        this.refreshTimer = setInterval(async () => {
            try {
                await this.refresh();
            } catch (error) {
                logger.error('Failed to refresh VFS:', error);
            }
        }, this.config.refreshInterval);

        logger.info('VirtualFileSystem started');
    }

    /**
     * Stop the VFS
     */
    async stop(): Promise<void> {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
        logger.info('VirtualFileSystem stopped');
    }

    /**
     * Reset the VFS to empty state
     * Called when meta-sort triggers a fresh scan
     * The VFS will be rebuilt incrementally as files are processed via pub/sub
     *
     * IMPORTANT: This stops the periodic refresh timer to prevent repopulating
     * from Redis (which still has old data). The VFS will only update via
     * incremental pub/sub events until the next full refresh is triggered.
     */
    reset(): void {
        logger.info('Resetting VFS for fresh scan...');

        // Stop periodic refresh to prevent repopulating from stale Redis data
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
            logger.info('Periodic refresh timer stopped - VFS will update via pub/sub only');
        }

        this.initRoot();
        this.lastRefresh = null;
        logger.info('VFS reset complete - awaiting new file updates from meta-sort');
    }

    /**
     * Resume periodic refresh from Redis
     * Called after a scan is complete to re-enable auto-refresh
     */
    resumePeriodicRefresh(): void {
        if (this.refreshTimer) {
            logger.debug('Periodic refresh already running');
            return;
        }

        logger.info('Resuming periodic refresh from Redis');
        this.refreshTimer = setInterval(async () => {
            try {
                await this.refresh();
            } catch (error) {
                logger.error('Failed to refresh VFS:', error);
            }
        }, this.config.refreshInterval);
    }

    /**
     * Refresh the VFS from Redis
     * Uses template-based rules if configured, otherwise falls back to MetaDataToFolderStruct
     */
    async refresh(): Promise<void> {
        logger.debug('Refreshing VFS from Redis');

        try {
            // Load rules configuration
            this.loadRulesConfig();

            // Get all files from Redis (keyed by sourcePath)
            const files = await this.redisClient.getAllFiles();

            if (files.size === 0) {
                logger.info('No files found in Redis');
                this.initRoot();
                return;
            }

            // Rebuild VFS with computed paths
            this.initRoot();

            for (const [sourcePath, metadata] of files) {
                // Compute virtual path using rules or fallback
                const virtualPath = this.computeVirtualPath(metadata, sourcePath);
                if (virtualPath) {
                    await this.addFile(virtualPath, metadata);
                    this.sourcePathToVirtualPath.set(sourcePath, virtualPath);
                }
            }

            this.lastRefresh = new Date();
            logger.info(`VFS refreshed: ${this.cachedStats.fileCount} files, ${this.cachedStats.directoryCount} directories`);
        } catch (error) {
            logger.error('Failed to refresh VFS:', error);
        }
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
     * Handle incremental file update from pub/sub
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
}
