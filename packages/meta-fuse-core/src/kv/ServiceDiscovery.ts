/**
 * Service Discovery using shared filesystem
 *
 * Each service registers itself in /meta-core/services/{service-name}.json
 * with its API endpoint, status, and heartbeat timestamp.
 *
 * Services can discover each other by reading these JSON files.
 * Stale detection: if lastHeartbeat > 60 seconds ago, service is considered dead.
 */

import { promises as fs } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { Logger } from 'tslog';
import type { ServiceInfo } from './IKVClient.js';

const logger = new Logger({ name: 'ServiceDiscovery' });

interface ServiceDiscoveryConfig {
    /** Path to META_CORE_VOLUME (e.g., /meta-core) */
    metaCorePath: string;

    /** Service name */
    serviceName: string;

    /** Service version */
    version: string;

    /** HTTP API URL (can be overridden by baseUrl) */
    apiUrl?: string;

    /** Base URL for service discovery (overrides auto-detected URL) */
    baseUrl?: string;

    /** Service capabilities */
    capabilities?: string[];

    /** Named endpoints */
    endpoints?: Record<string, string>;

    /** Heartbeat interval in ms (default: 30000) */
    heartbeatInterval?: number;

    /** Stale threshold in ms (default: 60000) */
    staleThreshold?: number;
}

export class ServiceDiscovery {
    private config: ServiceDiscoveryConfig;
    private servicesDir: string;
    private serviceFilePath: string;
    private heartbeatTimer: NodeJS.Timeout | null = null;
    private isShuttingDown = false;
    private isStarted = false;

    constructor(config: ServiceDiscoveryConfig) {
        this.config = {
            heartbeatInterval: 30000,
            staleThreshold: 60000,
            capabilities: [],
            endpoints: {},
            ...config
        };

        this.servicesDir = `${this.config.metaCorePath}/services`;
        this.serviceFilePath = `${this.servicesDir}/${this.config.serviceName}.json`;
    }

    /**
     * Ensure services directory exists
     */
    private async ensureServicesDir(): Promise<void> {
        await fs.mkdir(this.servicesDir, { recursive: true });
    }

    /**
     * Build service info for this service
     */
    private buildServiceInfo(status: ServiceInfo['status']): ServiceInfo {
        return {
            name: this.config.serviceName,
            version: this.config.version,
            api: this.config.baseUrl || this.config.apiUrl || '',
            status,
            pid: process.pid,
            hostname: hostname(),
            startedAt: new Date().toISOString(),
            lastHeartbeat: new Date().toISOString(),
            capabilities: this.config.capabilities || [],
            endpoints: this.config.endpoints || {}
        };
    }

    /**
     * Register this service
     */
    async register(): Promise<void> {
        await this.ensureServicesDir();

        const info = this.buildServiceInfo('starting');
        await fs.writeFile(this.serviceFilePath, JSON.stringify(info, null, 2));

        logger.info(`Registered ${this.config.serviceName}`);
    }

    /**
     * Update service status
     */
    async updateStatus(status: ServiceInfo['status']): Promise<void> {
        try {
            const content = await fs.readFile(this.serviceFilePath, 'utf-8');
            const info = JSON.parse(content) as ServiceInfo;

            info.status = status;
            info.lastHeartbeat = new Date().toISOString();

            await fs.writeFile(this.serviceFilePath, JSON.stringify(info, null, 2));
        } catch (error) {
            logger.error('Failed to update status:', error);
        }
    }

    /**
     * Send heartbeat (update lastHeartbeat timestamp)
     */
    async heartbeat(): Promise<void> {
        try {
            const content = await fs.readFile(this.serviceFilePath, 'utf-8');
            const info = JSON.parse(content) as ServiceInfo;

            info.lastHeartbeat = new Date().toISOString();

            await fs.writeFile(this.serviceFilePath, JSON.stringify(info, null, 2));
        } catch (error: any) {
            // If file was deleted, re-register
            if (error.code === 'ENOENT') {
                await this.register();
                await this.updateStatus('running');
            } else {
                logger.error('Heartbeat failed:', error);
            }
        }
    }

    /**
     * Start heartbeat loop
     */
    startHeartbeat(): void {
        this.heartbeatTimer = setInterval(async () => {
            if (this.isShuttingDown) return;
            await this.heartbeat();
        }, this.config.heartbeatInterval);
    }

    /**
     * Stop heartbeat loop
     */
    stopHeartbeat(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    /**
     * Unregister this service (on shutdown)
     */
    async unregister(): Promise<void> {
        this.isShuttingDown = true;
        this.stopHeartbeat();

        try {
            // Update status to stopped before removing
            await this.updateStatus('stopped');

            logger.info(`Unregistered ${this.config.serviceName}`);
        } catch (error) {
            logger.error('Failed to unregister:', error);
        }
    }

    // ========================================================================
    // Discovery Methods
    // ========================================================================

    /**
     * Discover a service by name
     */
    async discoverService(name: string): Promise<ServiceInfo | null> {
        const servicePath = join(this.servicesDir, `${name}.json`);

        try {
            const content = await fs.readFile(servicePath, 'utf-8');
            const service = JSON.parse(content) as ServiceInfo;

            // Check if service is alive (heartbeat within threshold)
            const lastHeartbeat = new Date(service.lastHeartbeat).getTime();
            const isAlive = Date.now() - lastHeartbeat < this.config.staleThreshold!;

            if (!isAlive) {
                logger.warn(`Service ${name} appears stale (last heartbeat: ${service.lastHeartbeat})`);
                return null;
            }

            return service;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return null; // Service not registered
            }
            throw error;
        }
    }

    /**
     * Discover all registered services
     */
    async discoverAllServices(): Promise<ServiceInfo[]> {
        try {
            const files = await fs.readdir(this.servicesDir);
            const services: ServiceInfo[] = [];

            for (const file of files) {
                if (!file.endsWith('.json')) continue;

                const name = file.replace('.json', '');
                const service = await this.discoverService(name);

                if (service && service.status === 'running') {
                    services.push(service);
                }
            }

            return services;
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                return []; // Services directory doesn't exist yet
            }
            throw error;
        }
    }

    /**
     * Check if a service is healthy
     */
    async isServiceHealthy(name: string): Promise<boolean> {
        const service = await this.discoverService(name);
        if (!service) return false;

        // Try to ping the service's health endpoint
        const healthEndpoint = service.endpoints.health || '/health';
        const url = `${service.api}${healthEndpoint}`;

        try {
            const response = await fetch(url, {
                signal: AbortSignal.timeout(5000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    // ========================================================================
    // Lifecycle
    // ========================================================================

    /**
     * Full startup sequence
     */
    async start(): Promise<void> {
        if (this.isStarted) return;

        await this.register();
        await this.updateStatus('running');
        this.startHeartbeat();
        this.isStarted = true;

        logger.info(`Started ${this.config.serviceName} at ${this.config.baseUrl || this.config.apiUrl}`);
    }

    /**
     * Full shutdown sequence
     */
    async stop(): Promise<void> {
        if (!this.isStarted) return;

        await this.unregister();
        this.isStarted = false;
    }

    // ========================================================================
    // Getters
    // ========================================================================

    getServiceFilePath(): string {
        return this.serviceFilePath;
    }

    getServicesDir(): string {
        return this.servicesDir;
    }

    getIsStarted(): boolean {
        return this.isStarted;
    }
}
