/**
 * ConfigStorage - File-based configuration storage
 *
 * Stores configuration (like renaming rules) in JSON files
 * instead of Redis, which should only be used for metadata.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Logger } from 'tslog';
import type { RenamingConfig } from '../vfs/types/RenamingRuleTypes.js';
import { getDefaultRulesConfig } from '../vfs/defaults/defaultRules.js';

const logger = new Logger({ name: 'ConfigStorage' });

export interface ConfigStorageOptions {
    configDir: string;  // Directory to store config files
}

export class ConfigStorage {
    private configDir: string;
    private rulesFile: string;

    constructor(options: ConfigStorageOptions) {
        this.configDir = options.configDir;
        this.rulesFile = path.join(this.configDir, 'renaming-rules.json');

        // Ensure config directory exists
        this.ensureConfigDir();
    }

    /**
     * Ensure the config directory exists
     */
    private ensureConfigDir(): void {
        try {
            if (!fs.existsSync(this.configDir)) {
                fs.mkdirSync(this.configDir, { recursive: true });
                logger.info(`Created config directory: ${this.configDir}`);
            }
        } catch (error) {
            logger.error(`Failed to create config directory: ${this.configDir}`, error);
        }
    }

    /**
     * Get renaming rules configuration from file
     * If no config file exists, creates one with default rules
     *
     * @returns The stored RenamingConfig
     */
    getRulesConfig(): RenamingConfig {
        try {
            if (!fs.existsSync(this.rulesFile)) {
                logger.info('No renaming rules config file found, creating default');
                const defaultConfig = this.createDefaultConfig();
                return defaultConfig;
            }

            const data = fs.readFileSync(this.rulesFile, 'utf-8');
            const config = JSON.parse(data) as RenamingConfig;
            logger.debug(`Loaded renaming rules config with ${config.rules.length} rules`);
            return config;
        } catch (error) {
            logger.error('Failed to read rules config, using defaults:', error);
            return this.createDefaultConfig();
        }
    }

    /**
     * Create and save the default configuration file
     */
    private createDefaultConfig(): RenamingConfig {
        const defaultConfig = getDefaultRulesConfig();

        // Mark as default configuration
        const configWithDefault: RenamingConfig = {
            ...defaultConfig,
            isDefault: true,
            lastModified: new Date().toISOString(),
        };

        // Save to file so user can see/edit it
        try {
            fs.writeFileSync(
                this.rulesFile,
                JSON.stringify(configWithDefault, null, 2),
                'utf-8'
            );
            logger.info('Created default renaming rules config file');
        } catch (error) {
            logger.error('Failed to create default config file:', error);
        }

        return configWithDefault;
    }

    /**
     * Save renaming rules configuration to file
     * Removes the isDefault field since this is now user-customized
     *
     * @param config The RenamingConfig to save
     */
    saveRulesConfig(config: RenamingConfig): void {
        try {
            // Create backup of current config if it exists
            if (fs.existsSync(this.rulesFile)) {
                const backupFile = path.join(
                    this.configDir,
                    `renaming-rules.backup.${Date.now()}.json`
                );
                fs.copyFileSync(this.rulesFile, backupFile);
                logger.debug(`Created backup: ${backupFile}`);

                // Clean up old backups (keep last 5)
                this.cleanupBackups();
            }

            // Remove isDefault flag (user is customizing) and update timestamp
            const { isDefault, ...configWithoutDefault } = config;
            const configToSave: RenamingConfig = {
                ...configWithoutDefault,
                lastModified: new Date().toISOString(),
            };

            // Save new config with pretty formatting
            fs.writeFileSync(
                this.rulesFile,
                JSON.stringify(configToSave, null, 2),
                'utf-8'
            );

            logger.info(`Saved renaming rules config with ${config.rules.length} rules`);
        } catch (error) {
            logger.error('Failed to save rules config:', error);
            throw error;
        }
    }

    /**
     * Clean up old backup files, keeping only the most recent ones
     */
    private cleanupBackups(keepCount: number = 5): void {
        try {
            const files = fs.readdirSync(this.configDir);
            const backups = files
                .filter(f => f.startsWith('renaming-rules.backup.') && f.endsWith('.json'))
                .map(f => ({
                    name: f,
                    path: path.join(this.configDir, f),
                    time: parseInt(f.replace('renaming-rules.backup.', '').replace('.json', ''), 10),
                }))
                .sort((a, b) => b.time - a.time);

            // Remove old backups beyond keepCount
            for (let i = keepCount; i < backups.length; i++) {
                fs.unlinkSync(backups[i].path);
                logger.debug(`Removed old backup: ${backups[i].name}`);
            }
        } catch (error) {
            logger.warn('Failed to cleanup backups:', error);
        }
    }

    /**
     * Get the config directory path
     */
    getConfigDir(): string {
        return this.configDir;
    }
}
