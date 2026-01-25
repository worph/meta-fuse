/**
 * meta-fuse-core entry point
 *
 * Standalone FUSE API server that reads metadata from Redis,
 * computes virtual paths, and exposes organized folder structure.
 */

import 'dotenv/config';
import { Logger } from 'tslog';
import { KVManager } from './kv/KVManager.js';
import { RedisClient } from './kv/RedisClient.js';
import { VirtualFileSystem } from './vfs/VirtualFileSystem.js';
import { APIServer } from './api/APIServer.js';

const logger = new Logger({ name: 'meta-fuse' });

// Pub/sub channel for batched updates from meta-sort
const UPDATE_CHANNEL = 'meta-sort:file:batch';

// Pub/sub channel for scan reset notification from meta-sort
const RESET_CHANNEL = 'meta-sort:scan:reset';

// Pub/sub channel for plugin completion events from meta-sort
const PLUGIN_COMPLETE_CHANNEL = 'meta-sort:plugin:complete';

// Plugins that provide metadata needed for VFS virtual paths
// When these complete, we should update the VFS entry for that file
const VFS_RELEVANT_PLUGINS = new Set(['filename-parser', 'tmdb', 'jellyfin-nfo']);

interface PluginCompleteMessage {
    fileHash: string;
    pluginId: string;
    filePath: string;
    timestamp: number;
}

interface BatchUpdateMessage {
    timestamp: number;
    changes: Array<{
        action: 'add' | 'update' | 'remove';
        hashId: string;
    }>;
}

async function main(): Promise<void> {
    logger.info('Starting meta-fuse...');
    logger.info(`Node.js ${process.version}`);

    // Configuration
    const config = {
        metaCorePath: process.env.META_CORE_PATH ?? '/meta-core',
        filesPath: process.env.FILES_VOLUME ?? '/files',
        redisUrl: process.env.REDIS_URL,
        redisPrefix: process.env.REDIS_PREFIX ?? '',
        apiPort: parseInt(process.env.API_PORT ?? '3000', 10),
        apiHost: process.env.API_HOST ?? '0.0.0.0',
        vfsRefreshInterval: parseInt(process.env.VFS_REFRESH_INTERVAL ?? '30000', 10),
        baseUrl: process.env.BASE_URL,
        serviceVersion: process.env.SERVICE_VERSION ?? '1.0.0',
        // WebDAV URL for meta-core file access (e.g., http://meta-core/webdav)
        metaCoreWebdavUrl: process.env.META_CORE_WEBDAV_URL,
    };

    logger.info(`Config: META_CORE_PATH=${config.metaCorePath}, FILES_VOLUME=${config.filesPath}`);
    if (config.metaCoreWebdavUrl) {
        logger.info(`WebDAV: Using meta-core WebDAV at ${config.metaCoreWebdavUrl}`);
    } else {
        logger.info(`WebDAV: Not configured, FUSE driver will use local filesystem`);
    }

    // Initialize KV Manager (handles leader discovery)
    const kvManager = new KVManager({
        metaCorePath: config.metaCorePath,
        filesPath: config.filesPath,
        serviceName: 'meta-fuse',
        version: config.serviceVersion,
        apiPort: config.apiPort,
        redisUrl: config.redisUrl,
        redisPrefix: config.redisPrefix,
        baseUrl: config.baseUrl,
        capabilities: ['read', 'vfs'],
    });

    let redisClient: RedisClient | null = null;
    let vfs: VirtualFileSystem | null = null;
    let apiServer: APIServer | null = null;

    // Graceful shutdown
    const shutdown = async (signal: string): Promise<void> => {
        logger.info(`Received ${signal}, shutting down...`);

        try {
            if (apiServer) await apiServer.stop();
            if (vfs) await vfs.stop();
            await kvManager.stop();
            logger.info('Shutdown complete');
            process.exit(0);
        } catch (error) {
            logger.error('Error during shutdown:', error);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    // Handle ready event from KV manager
    kvManager.onReady(async () => {
        logger.info('KV Manager ready, initializing VFS...');

        try {
            // Get Redis client from KV manager
            redisClient = kvManager.getClient();

            if (!redisClient) {
                logger.error('Redis client not available');
                return;
            }

            // Initialize VFS
            vfs = new VirtualFileSystem(redisClient, {
                fileMode: parseInt(process.env.FUSE_FILE_MODE ?? '644', 8),
                directoryMode: parseInt(process.env.FUSE_DIR_MODE ?? '755', 8),
                uid: parseInt(process.env.PUID ?? '1000', 10),
                gid: parseInt(process.env.PGID ?? '1000', 10),
                refreshInterval: config.vfsRefreshInterval,
                configDir: process.env.CONFIG_DIR ?? '/meta-fuse/config',
                webdavBaseUrl: config.metaCoreWebdavUrl,
                filesPath: config.filesPath,
            });

            // Start VFS
            logger.info('Starting VirtualFileSystem...');
            await vfs.start();

            // Subscribe to batch updates from meta-sort
            logger.info(`Subscribing to ${UPDATE_CHANNEL}...`);
            await redisClient.subscribe(UPDATE_CHANNEL, async (message: string) => {
                try {
                    const batch: BatchUpdateMessage = JSON.parse(message);
                    logger.debug(`Received batch update: ${batch.changes.length} changes`);

                    // Process each change incrementally
                    for (const change of batch.changes) {
                        await vfs!.onFileUpdate(change.hashId, change.action);
                    }
                } catch (error: any) {
                    logger.error(`Error processing batch update: ${error.message}`);
                }
            });

            // Subscribe to scan reset events from meta-sort
            logger.info(`Subscribing to ${RESET_CHANNEL}...`);
            await redisClient.subscribe(RESET_CHANNEL, async (message: string) => {
                try {
                    const event = JSON.parse(message);
                    logger.info(`Received scan reset event: ${event.action}`);

                    // Reset VFS for fresh scan - will be rebuilt incrementally
                    vfs!.reset();

                    logger.info('VFS reset complete, awaiting new file updates from meta-sort');
                } catch (error: any) {
                    logger.error(`Error processing reset event: ${error.message}`);
                }
            });

            // Subscribe to plugin completion events from meta-sort
            // When relevant plugins complete (filename-parser, tmdb, etc.), update VFS
            logger.info(`Subscribing to ${PLUGIN_COMPLETE_CHANNEL}...`);
            await redisClient.subscribe(PLUGIN_COMPLETE_CHANNEL, async (message: string) => {
                try {
                    const event: PluginCompleteMessage = JSON.parse(message);

                    // Only process plugins that provide VFS-relevant metadata
                    if (VFS_RELEVANT_PLUGINS.has(event.pluginId)) {
                        logger.debug(`Plugin ${event.pluginId} completed for ${event.fileHash}, updating VFS`);
                        await vfs!.onFileUpdate(event.fileHash, 'update');
                    }
                } catch (error: any) {
                    logger.error(`Error processing plugin complete event: ${error.message}`);
                }
            });

            // Initialize API server (with kvManager for service discovery)
            apiServer = new APIServer(vfs, {
                port: config.apiPort,
                host: config.apiHost,
            }, kvManager);

            // Start API server
            logger.info('Starting API server...');
            await apiServer.start();

            logger.info('meta-fuse is ready!');
            logger.info(`API: http://${config.apiHost}:${config.apiPort}`);

            // Log initial stats
            const stats = vfs.getStats();
            logger.info(`VFS: ${stats.fileCount} files, ${stats.directoryCount} directories`);
        } catch (error) {
            logger.error('Failed to initialize after KV ready:', error);
        }
    });

    // Handle disconnect event
    kvManager.onDisconnect(() => {
        logger.warn('Redis disconnected, VFS will use cached data');
    });

    // Start KV Manager (initiates leader discovery)
    try {
        logger.info('Starting KV Manager...');
        await kvManager.start();

        // Wait for ready with timeout
        await kvManager.waitForReady(60000);
    } catch (error) {
        logger.error('Failed to start meta-fuse:', error);
        process.exit(1);
    }
}

main().catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
});
