/**
 * Fastify API Server for FUSE operations
 *
 * Exposes the VirtualFileSystem over HTTP for consumption by the FUSE driver
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import { Logger } from 'tslog';
import { VirtualFileSystem } from '../vfs/VirtualFileSystem.js';
import type { KVManager } from '../kv/KVManager.js';
import type { RenamingConfig, RenamingRule, PreviewResponse } from '../vfs/types/RenamingRuleTypes.js';
import { TEMPLATE_VARIABLES } from '../vfs/types/RenamingRuleTypes.js';
import { TemplateEngine } from '../vfs/template/TemplateEngine.js';
import { ConditionEvaluator } from '../vfs/template/ConditionEvaluator.js';

const logger = new Logger({ name: 'APIServer' });

export interface APIServerConfig {
  port?: number;
  host?: string;
}

interface PathBody {
  path: string;
}

export class APIServer {
  private app: FastifyInstance;
  private vfs: VirtualFileSystem;
  private kvManager: KVManager | null = null;
  private config: Required<APIServerConfig>;

  constructor(vfs: VirtualFileSystem, config: APIServerConfig = {}, kvManager?: KVManager) {
    this.vfs = vfs;
    this.kvManager = kvManager || null;
    this.config = {
      port: config.port ?? parseInt(process.env.API_PORT ?? '3000', 10),
      host: config.host ?? process.env.API_HOST ?? '0.0.0.0',
    };

    this.app = Fastify({
      logger: false,
    });

    this.setupRoutes();
  }

  /**
   * Setup API routes
   */
  private setupRoutes(): void {
    // CORS
    this.app.register(cors, {
      origin: true,
      methods: ['GET', 'POST', 'OPTIONS'],
    });

    // Health check
    this.app.get('/health', this.handleHealth.bind(this));
    this.app.get('/api/health', this.handleHealth.bind(this));
    this.app.get('/api/fuse/health', this.handleHealth.bind(this));

    // Stats
    this.app.get('/api/fuse/stats', this.handleStats.bind(this));

    // FUSE operations
    this.app.post('/api/fuse/readdir', this.handleReaddir.bind(this));
    this.app.post('/api/fuse/getattr', this.handleGetattr.bind(this));
    this.app.post('/api/fuse/exists', this.handleExists.bind(this));
    this.app.post('/api/fuse/read', this.handleRead.bind(this));
    this.app.post('/api/fuse/metadata', this.handleMetadata.bind(this));

    // Directory listing endpoints
    this.app.get('/api/fuse/files', this.handleFiles.bind(this));
    this.app.get('/api/fuse/directories', this.handleDirectories.bind(this));

    // Refresh
    this.app.post('/api/fuse/refresh', this.handleRefresh.bind(this));

    // Renaming rules configuration
    this.app.get('/api/fuse/rules', this.handleGetRules.bind(this));
    this.app.put('/api/fuse/rules', this.handleUpdateRules.bind(this));
    this.app.post('/api/fuse/rules/preview', this.handlePreviewRules.bind(this));
    this.app.post('/api/fuse/rules/validate', this.handleValidateRule.bind(this));
    this.app.get('/api/fuse/rules/variables', this.handleGetVariables.bind(this));

    // Service discovery (for inter-service navigation)
    if (this.kvManager) {
      this.app.get('/api/services', this.handleServices.bind(this));
    }
  }

  /**
   * Start the server
   */
  async start(): Promise<void> {
    try {
      await this.app.listen({
        port: this.config.port,
        host: this.config.host,
      });
      logger.info(`API Server listening on http://${this.config.host}:${this.config.port}`);
    } catch (error) {
      logger.error('Failed to start API server:', error);
      throw error;
    }
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    await this.app.close();
    logger.info('API Server stopped');
  }

  // Route handlers

  private async handleHealth(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'meta-fuse',
    });
  }

  private async handleStats(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const stats = this.vfs.getStats();
    reply.send(stats);
  }

  private async handleReaddir(
    req: FastifyRequest<{ Body: PathBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { path } = req.body;

    if (typeof path !== 'string') {
      reply.status(400).send({ error: 'Missing or invalid "path" parameter' });
      return;
    }

    const entries = this.vfs.readdir(path);

    if (entries === null) {
      reply.status(404).send({ error: 'Directory not found' });
      return;
    }

    reply.send({ entries });
  }

  private async handleGetattr(
    req: FastifyRequest<{ Body: PathBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { path } = req.body;

    if (typeof path !== 'string') {
      reply.status(400).send({ error: 'Missing or invalid "path" parameter' });
      return;
    }

    const attrs = this.vfs.getattr(path);

    if (attrs === null) {
      reply.status(404).send({ error: 'Path not found' });
      return;
    }

    reply.send(attrs);
  }

  private async handleExists(
    req: FastifyRequest<{ Body: PathBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { path } = req.body;

    if (typeof path !== 'string') {
      reply.status(400).send({ error: 'Missing or invalid "path" parameter' });
      return;
    }

    const exists = this.vfs.exists(path);
    reply.send({ exists });
  }

  private async handleRead(
    req: FastifyRequest<{ Body: PathBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { path } = req.body;

    if (typeof path !== 'string') {
      reply.status(400).send({ error: 'Missing or invalid "path" parameter' });
      return;
    }

    const result = this.vfs.read(path);

    if (result === null) {
      reply.status(404).send({ error: 'File not found' });
      return;
    }

    // Return source path and/or WebDAV URL for FUSE driver to read from
    const response: Record<string, unknown> = {
      sourcePath: result.sourcePath,
      size: result.size,
    };

    // Include WebDAV URL if available (for remote file access)
    if (result.webdavUrl) {
      response.webdavUrl = result.webdavUrl;
    }

    // If content is provided (virtual file), encode as base64
    if (result.content !== null) {
      response.content = result.content.toString('base64');
      response.contentEncoding = 'base64';
    }

    reply.send(response);
  }

  private async handleMetadata(
    req: FastifyRequest<{ Body: PathBody }>,
    reply: FastifyReply
  ): Promise<void> {
    const { path } = req.body;

    if (typeof path !== 'string') {
      reply.status(400).send({ error: 'Missing or invalid "path" parameter' });
      return;
    }

    const metadata = this.vfs.getMetadata(path);

    if (metadata === null) {
      reply.status(404).send({ error: 'Metadata not found' });
      return;
    }

    reply.send(metadata);
  }

  private async handleFiles(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const files = this.vfs.getAllFiles();
    reply.send({ files });
  }

  private async handleDirectories(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const directories = this.vfs.getAllDirectories();
    reply.send({ directories });
  }

  private async handleRefresh(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    await this.vfs.refresh();
    reply.send({ status: 'ok' });
  }

  private async handleServices(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    interface ServiceResponse {
      name: string;
      url: string;
      api: string;
      status: string;
      capabilities: string[];
      version: string;
    }

    const services: ServiceResponse[] = [];
    let leaderInfo: { host: string; api: string; http: string } | null = null;

    try {
      const serviceDiscovery = this.kvManager?.getServiceDiscovery();
      if (serviceDiscovery) {
        const allServices = await serviceDiscovery.discoverAllServices();

        for (const svc of allServices) {
          // Build dashboard URL from API URL
          const apiUrl = svc.api || '';
          const dashboardPath = svc.endpoints?.dashboard || '/';

          services.push({
            name: svc.name || 'Unknown',
            url: apiUrl + dashboardPath,
            api: apiUrl,
            status: svc.status || 'unknown',
            capabilities: svc.capabilities || [],
            version: svc.version || '',
          });
        }
      }
    } catch (error) {
      logger.error('Error discovering services:', error);
    }

    // Get leader info
    if (this.kvManager) {
      const info = this.kvManager.getLeaderInfo();
      if (info) {
        leaderInfo = {
          host: info.host,
          api: info.api,
          http: info.http,
        };
      }
    }

    reply.send({
      services,
      current: 'meta-fuse',
      leader: leaderInfo,
      isLeader: false, // meta-fuse is never the leader
    });
  }

  // ============================================
  // Renaming Rules API Handlers
  // ============================================

  /**
   * Get current renaming rules configuration
   */
  private async handleGetRules(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const config = this.vfs.getRulesConfig();
      reply.send({
        config,
        lastModified: config.lastModified || new Date().toISOString(),
      });
    } catch (error: any) {
      logger.error('Failed to get rules:', error);
      reply.status(500).send({ error: 'Failed to get rules configuration' });
    }
  }

  /**
   * Update renaming rules configuration
   */
  private async handleUpdateRules(
    req: FastifyRequest<{ Body: { config: RenamingConfig } }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      const { config } = req.body;

      if (!config || typeof config !== 'object') {
        reply.status(400).send({ error: 'Missing or invalid config in request body' });
        return;
      }

      // Validate rules
      const errors: string[] = [];
      const templateEngine = new TemplateEngine();
      const conditionEvaluator = new ConditionEvaluator();

      for (const rule of config.rules) {
        // Validate template
        const templateValidation = templateEngine.validate(rule.template);
        if (!templateValidation.valid) {
          errors.push(`Rule "${rule.name}": ${templateValidation.errors.join(', ')}`);
        }

        // Validate conditions
        const conditionValidation = conditionEvaluator.validate(rule.conditions);
        if (!conditionValidation.valid) {
          errors.push(`Rule "${rule.name}": ${conditionValidation.errors.join(', ')}`);
        }
      }

      if (errors.length > 0) {
        reply.status(400).send({ success: false, errors });
        return;
      }

      // Save configuration
      this.vfs.saveRulesConfig(config);

      // Trigger immediate VFS refresh
      await this.vfs.refresh();

      reply.send({ success: true, refreshed: true });
    } catch (error: any) {
      logger.error('Failed to update rules:', error);
      reply.status(500).send({ error: 'Failed to update rules configuration' });
    }
  }

  /**
   * Preview how files would be renamed with given rules
   */
  private async handlePreviewRules(
    req: FastifyRequest<{ Body: { rules?: RenamingRule[]; limit?: number } }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      const { rules, limit = 100 } = req.body || {};
      const preview = await this.vfs.previewRules(rules, limit);
      reply.send(preview);
    } catch (error: any) {
      logger.error('Failed to preview rules:', error);
      reply.status(500).send({ error: 'Failed to generate preview' });
    }
  }

  /**
   * Validate a single rule
   */
  private async handleValidateRule(
    req: FastifyRequest<{ Body: { rule: RenamingRule; sampleMetadata?: Record<string, unknown> } }>,
    reply: FastifyReply
  ): Promise<void> {
    try {
      const { rule, sampleMetadata } = req.body;

      if (!rule || typeof rule !== 'object') {
        reply.status(400).send({ error: 'Missing or invalid rule in request body' });
        return;
      }

      const templateEngine = new TemplateEngine();
      const conditionEvaluator = new ConditionEvaluator();

      const errors: string[] = [];
      const warnings: string[] = [];

      // Validate template
      const templateValidation = templateEngine.validate(rule.template);
      errors.push(...templateValidation.errors);
      warnings.push(...templateValidation.warnings);

      // Validate conditions
      const conditionValidation = conditionEvaluator.validate(rule.conditions);
      errors.push(...conditionValidation.errors);

      // Generate sample output if metadata provided
      let sampleOutput: string | undefined;
      if (sampleMetadata && errors.length === 0) {
        sampleOutput = templateEngine.interpolate(rule.template, sampleMetadata) || undefined;
      }

      reply.send({
        valid: errors.length === 0,
        errors,
        warnings,
        sampleOutput,
      });
    } catch (error: any) {
      logger.error('Failed to validate rule:', error);
      reply.status(500).send({ error: 'Failed to validate rule' });
    }
  }

  /**
   * Get list of available template variables
   */
  private async handleGetVariables(_req: FastifyRequest, reply: FastifyReply): Promise<void> {
    reply.send({ variables: TEMPLATE_VARIABLES });
  }
}
