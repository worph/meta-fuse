/**
 * meta-fuse-core entry point
 *
 * Standalone FUSE API server that reads metadata from Redis,
 * computes virtual paths, and exposes organized folder structure.
 *
 * Uses Redis Streams for reliable event delivery from meta-sort.
 */

import 'dotenv/config';
import { Logger } from 'tslog';
import { KVManager } from './kv/KVManager.js';
import { RedisClient, StreamMessage } from './kv/RedisClient.js';
import { VirtualFileSystem } from './vfs/VirtualFileSystem.js';
import { APIServer } from './api/APIServer.js';

const logger = new Logger({ name: 'meta-fuse' });

// Redis Streams for reliable event delivery from meta-sort
const EVENTS_STREAM = 'meta-sort:events';
const CONSUMER_GROUP = 'meta-fuse-vfs';

// Plugins that provide metadata needed for VFS virtual paths
// When these complete, we should update the VFS entry for that file
const VFS_RELEVANT_PLUGINS = new Set(['filename-parser', 'tmdb', 'jellyfin-nfo']);

interface PluginCompletePayload {
    fileHash: string;
    pluginId: string;
    filePath: string;
    timestamp: number;
}

interface BatchUpdatePayload {
    timestamp: number;
    changes: Array<{
        action: 'add' | 'update' | 'remove';
        hashId: string;
    }>;
}

interface ResetPayload {
    timestamp: number;
    action: 'reset';
}

/**
 * Handle a stream message from Redis Streams
 * Routes messages by type to appropriate handlers
 */
async function handleStreamMessage(message: StreamMessage, vfs: VirtualFileSystem): Promise<void> {
    try {
        switch (message.type) {
            case 'batch': {
                const batch: BatchUpdatePayload = JSON.parse(message.payload);
                logger.debug(`Processing batch update: ${batch.changes.length} changes`);

                for (const change of batch.changes) {
                    await vfs.onFileUpdate(change.hashId, change.action);
                }
                break;
            }

            case 'reset': {
                const reset: ResetPayload = JSON.parse(message.payload);
                logger.info(`Processing reset event: ${reset.action}`);
                await vfs.resetAndReload();
                break;
            }

            case 'plugin:complete': {
                const event: PluginCompletePayload = JSON.parse(message.payload);

                // Only process plugins that provide VFS-relevant metadata
                if (VFS_RELEVANT_PLUGINS.has(event.pluginId)) {
                    logger.debug(`Plugin ${event.pluginId} completed for ${event.fileHash}, updating VFS`);
                    await vfs.onFileUpdate(event.fileHash, 'update');
                }
                break;
            }

            default:
                logger.warn(`Unknown stream message type: ${message.type}`);
        }
    } catch (error: any) {
        logger.error(`Error processing stream message ${message.id}:`, error.message);
        throw error; // Re-throw to prevent ACK
    }
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
        baseUrl: process.env.BASE_URL,
        serviceVersion: process.env.SERVICE_VERSION ?? '1.0.0',
    };

    logger.info(`Config: META_CORE_PATH=${config.metaCorePath}, FILES_VOLUME=${config.filesPath}`);

    // Initialize KV Manager (handles leader discovery)
    const kvManager = new KVManager({
        metaCorePath: config.metaCorePath,
        filesPath: config.filesPath,
        serviceName: 'meta-fuse',
        apiPort: config.apiPort,
        baseUrl: config.baseUrl,
        redisPrefix: config.redisPrefix,
    });

    let redisClient: RedisClient | null = null;
    let vfs: VirtualFileSystem | null = null;
    let apiServer: APIServer | null = null;

    // Graceful shutdown
    const shutdown = async (signal: string): Promise<void> => {
        logger.info(`Received ${signal}, shutting down...`);

        try {
            // Stop stream consumer first
            if (redisClient) {
                redisClient.stopStreamConsumer();
            }
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

            // Get WebDAV URL from leader info (discovered via service discovery)
            // Use hostname to construct internal URL since webdavUrl uses external baseUrl
            const leaderInfo = kvManager.getLeaderInfo();
            let webdavUrl: string | null = null;
            if (leaderInfo?.hostname) {
                // Construct internal WebDAV URL using leader hostname (nginx on port 80)
                webdavUrl = `http://${leaderInfo.hostname}/webdav`;
                logger.info(`WebDAV: Using ${webdavUrl} (from service discovery, leader: ${leaderInfo.hostname})`);
            } else {
                logger.info('WebDAV: Not available from leader, FUSE driver will use local filesystem');
            }

            // Initialize VFS (no periodic refresh - uses Redis Streams)
            vfs = new VirtualFileSystem(redisClient, {
                fileMode: parseInt(process.env.FUSE_FILE_MODE ?? '644', 8),
                directoryMode: parseInt(process.env.FUSE_DIR_MODE ?? '755', 8),
                uid: parseInt(process.env.PUID ?? '1000', 10),
                gid: parseInt(process.env.PGID ?? '1000', 10),
                configDir: process.env.CONFIG_DIR ?? '/meta-fuse/config',
                webdavBaseUrl: webdavUrl,
                filesPath: config.filesPath,
            });

            // Start VFS (initial load from Redis)
            logger.info('Starting VirtualFileSystem...');
            await vfs.start();

            // Initialize Redis Streams consumer
            logger.info(`Initializing stream consumer for ${EVENTS_STREAM}...`);
            await redisClient.initStreamConsumer(EVENTS_STREAM, CONSUMER_GROUP);

            // Process any pending entries from crashed consumers
            await redisClient.processPendingEntries(
                EVENTS_STREAM,
                CONSUMER_GROUP,
                30000, // 30 second idle threshold
                async (message: StreamMessage) => {
                    await handleStreamMessage(message, vfs!);
                }
            );

            // Start stream consumer in background
            logger.info('Starting stream consumer...');
            redisClient.startStreamConsumer(
                EVENTS_STREAM,
                CONSUMER_GROUP,
                async (message: StreamMessage) => {
                    await handleStreamMessage(message, vfs!);
                },
                5000 // 5 second block timeout
            ).catch(error => {
                logger.error('Stream consumer error:', error);
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
