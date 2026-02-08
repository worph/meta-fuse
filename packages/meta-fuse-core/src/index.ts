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
import { StreamingStateBuilder } from './vfs/StreamingStateBuilder.js';
import { APIServer } from './api/APIServer.js';

const logger = new Logger({ name: 'meta-fuse' });

// Redis Streams - using new meta:events stream from meta-core flat key architecture
const EVENTS_STREAM = 'meta:events';

// Legacy stream name for backward compatibility during transition
const LEGACY_EVENTS_STREAM = 'file:events';

/**
 * Handle a stream message from meta:events stream
 *
 * New meta:events format (flat key architecture):
 * - set/del: Property-level changes, processed by StreamingStateBuilder
 *
 * The StreamingStateBuilder filters events by VFS-relevant properties,
 * fetches values, and notifies VFS when files are complete.
 */
async function handleStreamingEvent(
    message: StreamMessage,
    stateBuilder: StreamingStateBuilder
): Promise<void> {
    try {
        await stateBuilder.processEvent(message);
    } catch (error: any) {
        logger.error(`Error processing stream message ${message.id}:`, error.message);
        throw error;
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
    let stateBuilder: StreamingStateBuilder | null = null;
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
        logger.info('KV Manager ready, initializing VFS with streaming bootstrap...');

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

            // Initialize VFS in streaming mode (no HGETALL/SCAN bootstrap)
            vfs = new VirtualFileSystem(redisClient, {
                fileMode: parseInt(process.env.FUSE_FILE_MODE ?? '644', 8),
                directoryMode: parseInt(process.env.FUSE_DIR_MODE ?? '755', 8),
                uid: parseInt(process.env.PUID ?? '1000', 10),
                gid: parseInt(process.env.PGID ?? '1000', 10),
                configDir: process.env.CONFIG_DIR ?? '/meta-fuse/config',
                webdavBaseUrl: webdavUrl,
                filesPath: config.filesPath,
            });

            // Enable streaming mode - VFS will be populated via event callbacks
            vfs.enableStreamingMode();

            // Start VFS (just initializes, no data load in streaming mode)
            logger.info('Starting VirtualFileSystem in streaming mode...');
            await vfs.start();

            // Create streaming state builder with VFS as callback
            stateBuilder = new StreamingStateBuilder({
                redisClient,
                rulesConfig: vfs.getRulesConfig(),
                vfsCallback: vfs,
                filesPath: config.filesPath,
            });

            // Bootstrap: Replay meta:events stream from position 0
            // This rebuilds state from all historical events
            logger.info(`Replaying ${EVENTS_STREAM} stream from position 0 (streaming bootstrap)...`);
            const bootstrapStart = Date.now();

            const lastId = await redisClient.replayStream(
                EVENTS_STREAM,
                '0',
                async (message: StreamMessage) => {
                    await handleStreamingEvent(message, stateBuilder!);
                },
                100 // Batch size
            );

            const bootstrapTime = Date.now() - bootstrapStart;
            const stats = vfs.getStats();
            logger.info(`Streaming bootstrap complete: ${stats.fileCount} files in ${bootstrapTime}ms`);

            // Start live stream consumer from where replay left off
            logger.info(`Starting live stream consumer from ${lastId}...`);
            redisClient.startSimpleStreamConsumer(
                EVENTS_STREAM,
                lastId,
                async (message: StreamMessage) => {
                    await handleStreamingEvent(message, stateBuilder!);
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

            // Log final stats
            const finalStats = vfs.getStats();
            logger.info(`VFS: ${finalStats.fileCount} files, ${finalStats.directoryCount} directories`);

            // Log streaming state builder stats
            const builderStats = stateBuilder.getStats();
            logger.info(`State builder: ${builderStats.eventsProcessed} events, ${builderStats.propertiesFetched} properties fetched, ${builderStats.propertiesSkipped} skipped`);
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
