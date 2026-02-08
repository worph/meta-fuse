/**
 * Rules Property Extractor
 *
 * Extracts the set of metadata properties that are relevant for VFS
 * virtual path computation. This is used to filter which Redis key
 * change events should trigger VFS updates.
 *
 * Properties are extracted from:
 * 1. Rule templates: {title|originalTitle}, {season:pad2}, etc.
 * 2. Rule conditions: { field: 'fileType', value: 'video' }, etc.
 */

import { Logger } from 'tslog';
import { TemplateEngine } from './template/TemplateEngine.js';
import type {
    RenamingConfig,
    RenamingRule,
    Condition,
    ConditionGroup,
} from './types/RenamingRuleTypes.js';
import { isConditionGroup } from './types/RenamingRuleTypes.js';

const logger = new Logger({ name: 'RulesPropertyExtractor' });

/**
 * Core properties that are always required for VFS operation
 * These are needed regardless of what rules are configured
 */
const CORE_PROPERTIES = new Set([
    'filePath',      // Source file location (must exist for file to appear in VFS)
    'size',          // File size attribute
    'fileSize',      // Alternative name for size
    'mtime',         // Modification time
    'ctime',         // Creation time
    'fileName',      // Filename for fallback naming
    'extension',     // File extension
]);

/**
 * Extract all property names used in a ConditionGroup (recursively)
 */
function extractConditionFields(conditionOrGroup: Condition | ConditionGroup): string[] {
    if (isConditionGroup(conditionOrGroup)) {
        const fields: string[] = [];
        for (const condition of conditionOrGroup.conditions) {
            fields.push(...extractConditionFields(condition));
        }
        return fields;
    }

    // It's a Condition
    return [conditionOrGroup.field];
}

/**
 * Extract all property names from a single rule
 */
function extractRuleProperties(rule: RenamingRule, templateEngine: TemplateEngine): string[] {
    const properties: string[] = [];

    // Extract from template
    const templateVars = templateEngine.extractVariables(rule.template);
    properties.push(...templateVars);

    // Extract from conditions
    const conditionFields = extractConditionFields(rule.conditions);
    properties.push(...conditionFields);

    return properties;
}

/**
 * Normalize a property path for comparison
 * Handles nested paths like 'titles/eng' vs 'titles.eng'
 */
function normalizePropertyPath(path: string): string {
    // Convert slash-separated to dot-separated
    return path.replace(/\//g, '.');
}

/**
 * Check if a property path matches any of the VFS-relevant properties
 * Handles both exact matches and prefix matches for nested properties
 */
export function isVfsRelevantProperty(property: string, vfsProperties: Set<string>): boolean {
    const normalized = normalizePropertyPath(property);

    // Direct match
    if (vfsProperties.has(normalized)) {
        return true;
    }

    // Check if this is a nested property of a tracked property
    // e.g., if we track 'titles', then 'titles.eng' or 'titles/eng' should match
    for (const vfsProp of vfsProperties) {
        const normalizedVfsProp = normalizePropertyPath(vfsProp);

        // Check if the property starts with a tracked path
        if (normalized.startsWith(normalizedVfsProp + '.')) {
            return true;
        }

        // Check if a tracked path starts with this property
        // e.g., if we track 'titles.eng' and get update for 'titles'
        if (normalizedVfsProp.startsWith(normalized + '.')) {
            return true;
        }
    }

    return false;
}

/**
 * RulesPropertyExtractor class
 *
 * Analyzes renaming rules configuration and extracts the set of
 * metadata properties that are needed for VFS virtual path computation.
 */
export class RulesPropertyExtractor {
    private templateEngine: TemplateEngine;

    constructor() {
        this.templateEngine = new TemplateEngine();
    }

    /**
     * Extract all VFS-relevant properties from a RenamingConfig
     *
     * @param config The renaming configuration to analyze
     * @returns Set of property names that affect VFS virtual paths
     */
    extractVfsProperties(config: RenamingConfig): Set<string> {
        const properties = new Set<string>(CORE_PROPERTIES);

        // Extract from all rules
        for (const rule of config.rules) {
            if (!rule.enabled) continue;

            const ruleProps = extractRuleProperties(rule, this.templateEngine);
            for (const prop of ruleProps) {
                properties.add(normalizePropertyPath(prop));
            }
        }

        // Extract from default rule if present
        if (config.defaultRule) {
            const defaultProps = extractRuleProperties(config.defaultRule, this.templateEngine);
            for (const prop of defaultProps) {
                properties.add(normalizePropertyPath(prop));
            }
        }

        logger.debug(`Extracted ${properties.size} VFS-relevant properties from rules config`);
        return properties;
    }

    /**
     * Get the core properties that are always required
     */
    getCoreProperties(): Set<string> {
        return new Set(CORE_PROPERTIES);
    }
}
