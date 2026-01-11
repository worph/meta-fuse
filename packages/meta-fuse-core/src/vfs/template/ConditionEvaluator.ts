/**
 * Condition Evaluator
 *
 * Evaluates conditions and condition groups against metadata
 * to determine which renaming rule should be applied.
 */

import { Logger } from 'tslog';
import type { Condition, ConditionGroup } from '../types/RenamingRuleTypes.js';
import { isConditionGroup } from '../types/RenamingRuleTypes.js';
import { getNestedValue } from './TemplateEngine.js';

const logger = new Logger({ name: 'ConditionEvaluator' });

/**
 * Condition Evaluator class
 */
export class ConditionEvaluator {
  /**
   * Evaluate a single condition against metadata
   *
   * @param condition The condition to evaluate
   * @param metadata The metadata object to check against
   * @returns true if the condition is satisfied
   */
  evaluateCondition(condition: Condition, metadata: Record<string, unknown>): boolean {
    const value = getNestedValue(metadata, condition.field);

    switch (condition.type) {
      case 'EXISTS':
        return value !== null && value !== undefined;

      case 'NOT_EXISTS':
        return value === null || value === undefined;

      case 'EQUALS':
        // Handle type coercion for common cases
        if (typeof condition.value === 'boolean') {
          return value === condition.value;
        }
        if (typeof condition.value === 'number') {
          return Number(value) === condition.value;
        }
        return String(value) === String(condition.value);

      case 'NOT_EQUALS':
        if (typeof condition.value === 'boolean') {
          return value !== condition.value;
        }
        if (typeof condition.value === 'number') {
          return Number(value) !== condition.value;
        }
        return String(value) !== String(condition.value);

      case 'CONTAINS':
        if (value === null || value === undefined) {
          return false;
        }
        return String(value).includes(String(condition.value));

      case 'MATCHES':
        if (value === null || value === undefined) {
          return false;
        }
        try {
          const regex = new RegExp(String(condition.value));
          return regex.test(String(value));
        } catch (error) {
          logger.warn(`Invalid regex in condition: ${condition.value}`);
          return false;
        }

      default:
        logger.warn(`Unknown condition type: ${(condition as Condition).type}`);
        return false;
    }
  }

  /**
   * Evaluate a condition group (AND/OR of multiple conditions)
   *
   * @param group The condition group to evaluate
   * @param metadata The metadata object to check against
   * @returns true if the group condition is satisfied
   */
  evaluateGroup(group: ConditionGroup, metadata: Record<string, unknown>): boolean {
    // Empty conditions means always match
    if (group.conditions.length === 0) {
      return true;
    }

    const results = group.conditions.map(condition => {
      if (isConditionGroup(condition)) {
        return this.evaluateGroup(condition, metadata);
      }
      return this.evaluateCondition(condition, metadata);
    });

    if (group.operator === 'AND') {
      return results.every(r => r);
    } else {
      return results.some(r => r);
    }
  }

  /**
   * Evaluate conditions - convenience method that handles both single conditions and groups
   *
   * @param conditions A single condition or condition group
   * @param metadata The metadata object to check against
   * @returns true if the conditions are satisfied
   */
  evaluate(conditions: Condition | ConditionGroup, metadata: Record<string, unknown>): boolean {
    if (isConditionGroup(conditions)) {
      return this.evaluateGroup(conditions, metadata);
    }
    return this.evaluateCondition(conditions, metadata);
  }

  /**
   * Validate a condition or condition group
   *
   * @param conditions The conditions to validate
   * @returns Validation result with any errors
   */
  validate(conditions: Condition | ConditionGroup): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (isConditionGroup(conditions)) {
      // Validate group
      if (!['AND', 'OR'].includes(conditions.operator)) {
        errors.push(`Invalid operator: ${conditions.operator}`);
      }

      for (const condition of conditions.conditions) {
        const result = this.validate(condition);
        errors.push(...result.errors);
      }
    } else {
      // Validate single condition
      const validTypes = ['EXISTS', 'NOT_EXISTS', 'EQUALS', 'NOT_EQUALS', 'CONTAINS', 'MATCHES'];
      if (!validTypes.includes(conditions.type)) {
        errors.push(`Invalid condition type: ${conditions.type}`);
      }

      if (!conditions.field || typeof conditions.field !== 'string') {
        errors.push('Condition must have a valid field');
      }

      // Check if value is required
      const requiresValue = ['EQUALS', 'NOT_EQUALS', 'CONTAINS', 'MATCHES'];
      if (requiresValue.includes(conditions.type) && conditions.value === undefined) {
        errors.push(`Condition type ${conditions.type} requires a value`);
      }

      // Validate regex for MATCHES
      if (conditions.type === 'MATCHES' && conditions.value !== undefined) {
        try {
          new RegExp(String(conditions.value));
        } catch (error) {
          errors.push(`Invalid regex: ${conditions.value}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
