/**
 * Leader Discovery for meta-fuse (FOLLOWER-only)
 *
 * This is a simplified version of leader election that only discovers
 * the existing leader. meta-fuse never spawns Redis - it only connects
 * to the leader's Redis instance.
 *
 * Architecture:
 * - Leader holds flock on META_CORE_PATH/locks/kv-leader.lock
 * - Leader writes info to META_CORE_PATH/locks/kv-leader.info
 * - This class reads the info file to discover the leader
 * - Watches for leader changes via health checks
 * - Triggers reconnection callbacks on leader failure/change
 */

import { promises as fs, watch } from 'fs';
import { dirname } from 'path';
import { Logger } from 'tslog';
import type { LeaderLockInfo } from './IKVClient.js';

const logger = new Logger({ name: 'LeaderDiscovery' });

interface LeaderDiscoveryConfig {
    /** Path to META_CORE_VOLUME (e.g., /meta-core) */
    metaCorePath: string;

    /** Health check interval in ms (default: 5000) */
    healthCheckInterval?: number;

    /** Max consecutive failures before marking leader as lost (default: 3) */
    maxFailures?: number;
}

export class LeaderDiscovery {
    private config: Required<LeaderDiscoveryConfig>;
    private lockFilePath: string;
    private leaderInfo: LeaderLockInfo | null = null;
    private healthCheckTimer: NodeJS.Timeout | null = null;
    private fileWatcher: ReturnType<typeof watch> | null = null;
    private isStarted = false;
    private consecutiveFailures = 0;

    // Event callbacks
    private onLeaderFoundCallback?: (info: LeaderLockInfo) => void;
    private onLeaderLostCallback?: () => void;

    constructor(config: LeaderDiscoveryConfig) {
        this.config = {
            healthCheckInterval: 5000,
            maxFailures: 3,
            ...config
        };

        this.lockFilePath = `${this.config.metaCorePath}/locks/kv-leader.info`;
    }

    /**
     * Start watching for leader
     */
    async start(): Promise<void> {
        if (this.isStarted) {
            logger.warn('LeaderDiscovery already started');
            return;
        }

        logger.info(`Starting leader discovery, lock file: ${this.lockFilePath}`);

        // Ensure lock directory exists (for file watching)
        await this.ensureLockDir();

        // Try to read existing leader info
        await this.checkForLeader();

        // Start file watcher for immediate detection of leader changes
        this.startFileWatcher();

        // Start health check for ongoing monitoring
        this.startHealthCheck();

        this.isStarted = true;
    }

    /**
     * Stop watching
     */
    async stop(): Promise<void> {
        if (!this.isStarted) return;

        logger.info('Stopping leader discovery');

        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }

        if (this.fileWatcher) {
            this.fileWatcher.close();
            this.fileWatcher = null;
        }

        this.isStarted = false;
    }

    /**
     * Ensure lock directory exists
     */
    private async ensureLockDir(): Promise<void> {
        const lockDir = dirname(this.lockFilePath);
        try {
            await fs.mkdir(lockDir, { recursive: true });
        } catch (error: any) {
            if (error.code !== 'EEXIST') {
                logger.warn(`Could not create lock directory: ${error.message}`);
            }
        }
    }

    /**
     * Check for leader by reading lock file
     */
    private async checkForLeader(): Promise<void> {
        try {
            const content = await fs.readFile(this.lockFilePath, 'utf-8');
            const info = JSON.parse(content) as LeaderLockInfo;

            // Validate leader info
            if (info && info.api && info.http) {
                const isNew = !this.leaderInfo || this.leaderInfo.api !== info.api;
                this.leaderInfo = info;
                this.consecutiveFailures = 0;

                if (isNew) {
                    logger.info(`Leader found: ${info.host} at ${info.api}`);
                    this.onLeaderFoundCallback?.(info);
                }
            }
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                // Lock file doesn't exist - no leader yet
                if (this.leaderInfo) {
                    logger.warn('Lock file removed, leader lost');
                    this.handleLeaderLost();
                }
            } else {
                logger.warn(`Error reading lock file: ${error.message}`);
            }
        }
    }

    /**
     * Check if current leader is still healthy
     */
    private async isLeaderHealthy(): Promise<boolean> {
        if (!this.leaderInfo) return false;

        try {
            const response = await fetch(`${this.leaderInfo.http}/health`, {
                signal: AbortSignal.timeout(5000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    /**
     * Handle leader being lost
     */
    private handleLeaderLost(): void {
        this.leaderInfo = null;
        this.onLeaderLostCallback?.();
    }

    /**
     * Start watching lock file for changes
     */
    private startFileWatcher(): void {
        try {
            const lockDir = dirname(this.lockFilePath);
            this.fileWatcher = watch(lockDir, async (eventType, filename) => {
                if (filename === 'kv-leader.info') {
                    logger.debug(`Lock file ${eventType}, checking for leader...`);
                    await this.checkForLeader();
                }
            });

            this.fileWatcher.on('error', (error) => {
                logger.warn(`File watcher error: ${error.message}`);
            });
        } catch (error: any) {
            logger.warn(`Could not start file watcher: ${error.message}`);
        }
    }

    /**
     * Start health check loop
     */
    private startHealthCheck(): void {
        this.healthCheckTimer = setInterval(async () => {
            if (!this.leaderInfo) {
                // No leader known, try to find one
                await this.checkForLeader();
                return;
            }

            // Check if current leader is healthy
            const healthy = await this.isLeaderHealthy();

            if (healthy) {
                this.consecutiveFailures = 0;
            } else {
                this.consecutiveFailures++;
                logger.warn(`Leader health check failed (${this.consecutiveFailures}/${this.config.maxFailures})`);

                if (this.consecutiveFailures >= this.config.maxFailures) {
                    logger.warn('Leader appears dead, marking as lost');
                    this.handleLeaderLost();

                    // Try to find new leader
                    await this.checkForLeader();
                }
            }
        }, this.config.healthCheckInterval);
    }

    // ========================================================================
    // Event Registration
    // ========================================================================

    /**
     * Register callback for when leader is found/changed
     */
    onLeaderFound(callback: (info: LeaderLockInfo) => void): this {
        this.onLeaderFoundCallback = callback;

        // If we already have leader info, call immediately
        if (this.leaderInfo) {
            callback(this.leaderInfo);
        }

        return this;
    }

    /**
     * Register callback for when leader is lost
     */
    onLeaderLost(callback: () => void): this {
        this.onLeaderLostCallback = callback;
        return this;
    }

    // ========================================================================
    // Getters
    // ========================================================================

    /**
     * Get current leader info
     */
    getLeaderInfo(): LeaderLockInfo | null {
        return this.leaderInfo;
    }

    /**
     * Get Redis URL of current leader
     */
    getRedisUrl(): string | null {
        return this.leaderInfo?.api ?? null;
    }

    /**
     * Check if a leader is known
     */
    hasLeader(): boolean {
        return this.leaderInfo !== null;
    }
}
