/**
 * Template Engine
 *
 * Parses and interpolates template strings for renaming rules.
 *
 * Supported syntax:
 * - {var}           - Basic variable interpolation
 * - {var:pad2}      - Zero-pad to 2 digits
 * - {var:pad3}      - Zero-pad to 3 digits
 * - {var?}          - Optional: omit if missing
 * - {var?(text)}    - Conditional section: include text only if var exists
 * - {var|default}   - Use default value if var is missing
 * - {a.b}           - Nested object access
 */

import { Logger } from 'tslog';

const logger = new Logger({ name: 'TemplateEngine' });

/**
 * Token types for template parsing
 */
type TokenType = 'literal' | 'variable' | 'optional' | 'conditional' | 'default';

interface Token {
  type: TokenType;
  value: string;
  field?: string;
  format?: string;
  defaultValue?: string;
  innerTemplate?: string;
}

/**
 * Get a nested value from an object using dot notation
 * e.g., getNestedValue({titles: {eng: 'Test'}}, 'titles.eng') => 'Test'
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * Apply a format to a value
 */
function applyFormat(value: unknown, format: string): string {
  if (value === null || value === undefined) {
    return '';
  }

  const strValue = String(value);

  switch (format) {
    case 'pad2':
      return strValue.padStart(2, '0');
    case 'pad3':
      return strValue.padStart(3, '0');
    case 'pad4':
      return strValue.padStart(4, '0');
    case 'upper':
    case 'uppercase':
      return strValue.toUpperCase();
    case 'lower':
    case 'lowercase':
      return strValue.toLowerCase();
    default:
      // Check for custom padding: padN where N is a number
      const padMatch = format.match(/^pad(\d+)$/);
      if (padMatch) {
        return strValue.padStart(parseInt(padMatch[1], 10), '0');
      }
      return strValue;
  }
}

/**
 * Parse a template string into tokens
 */
function tokenize(template: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let literalStart = 0;

  while (i < template.length) {
    if (template[i] === '{') {
      // Save any literal text before this
      if (i > literalStart) {
        tokens.push({
          type: 'literal',
          value: template.slice(literalStart, i),
        });
      }

      // Find the matching closing brace
      const start = i + 1;
      let depth = 1;
      let end = start;

      while (end < template.length && depth > 0) {
        if (template[end] === '{') depth++;
        if (template[end] === '}') depth--;
        if (depth > 0) end++;
      }

      if (depth !== 0) {
        // Unclosed brace, treat as literal
        tokens.push({
          type: 'literal',
          value: template.slice(i, end),
        });
      } else {
        const content = template.slice(start, end);
        tokens.push(parseVariable(content));
      }

      i = end + 1;
      literalStart = i;
    } else {
      i++;
    }
  }

  // Add any remaining literal text
  if (literalStart < template.length) {
    tokens.push({
      type: 'literal',
      value: template.slice(literalStart),
    });
  }

  return tokens;
}

/**
 * Parse a variable expression inside braces
 */
function parseVariable(content: string): Token {
  // Check for conditional section: var?(inner template)
  const conditionalMatch = content.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)\?\((.*)\)$/s);
  if (conditionalMatch) {
    return {
      type: 'conditional',
      value: content,
      field: conditionalMatch[1],
      innerTemplate: conditionalMatch[2],
    };
  }

  // Check for optional variable: var?
  if (content.endsWith('?')) {
    const field = content.slice(0, -1);
    // Check for format: var:format?
    const formatMatch = field.match(/^([a-zA-Z_][a-zA-Z0-9_.]*):([a-z0-9]+)$/);
    if (formatMatch) {
      return {
        type: 'optional',
        value: content,
        field: formatMatch[1],
        format: formatMatch[2],
      };
    }
    return {
      type: 'optional',
      value: content,
      field: field,
    };
  }

  // Check for default value: var|default
  const defaultMatch = content.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)\|(.+)$/);
  if (defaultMatch) {
    return {
      type: 'default',
      value: content,
      field: defaultMatch[1],
      defaultValue: defaultMatch[2],
    };
  }

  // Check for format: var:format
  const formatMatch = content.match(/^([a-zA-Z_][a-zA-Z0-9_.]*):([a-z0-9]+)$/);
  if (formatMatch) {
    return {
      type: 'variable',
      value: content,
      field: formatMatch[1],
      format: formatMatch[2],
    };
  }

  // Simple variable
  return {
    type: 'variable',
    value: content,
    field: content,
  };
}

/**
 * Template Engine class for interpolating templates
 */
export class TemplateEngine {
  /**
   * Interpolate a template string with metadata
   *
   * @param template The template string with variables
   * @param metadata The metadata object to get values from
   * @returns The interpolated string, or null if a required variable is missing
   */
  interpolate(template: string, metadata: Record<string, unknown>): string | null {
    const tokens = tokenize(template);
    const result: string[] = [];

    for (const token of tokens) {
      switch (token.type) {
        case 'literal':
          result.push(token.value);
          break;

        case 'variable': {
          const value = getNestedValue(metadata, token.field!);
          if (value === null || value === undefined) {
            // Required variable is missing
            logger.debug(`Missing required variable: ${token.field}`);
            return null;
          }
          const formatted = token.format ? applyFormat(value, token.format) : String(value);
          result.push(formatted);
          break;
        }

        case 'optional': {
          const value = getNestedValue(metadata, token.field!);
          if (value !== null && value !== undefined) {
            const formatted = token.format ? applyFormat(value, token.format) : String(value);
            result.push(formatted);
          }
          // If missing, just skip (don't add anything)
          break;
        }

        case 'conditional': {
          const value = getNestedValue(metadata, token.field!);
          if (value !== null && value !== undefined) {
            // Variable exists, interpolate the inner template
            const innerResult = this.interpolate(token.innerTemplate!, metadata);
            if (innerResult !== null) {
              result.push(innerResult);
            }
          }
          // If missing, skip the entire conditional section
          break;
        }

        case 'default': {
          const value = getNestedValue(metadata, token.field!);
          if (value !== null && value !== undefined) {
            result.push(String(value));
          } else {
            // Check if defaultValue looks like a field name (for field fallback)
            // Field names: start with letter/underscore, contain alphanumeric/dot/underscore
            const fieldPattern = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
            if (fieldPattern.test(token.defaultValue!)) {
              // Try to get value from fallback field
              const fallbackValue = getNestedValue(metadata, token.defaultValue!);
              if (fallbackValue !== null && fallbackValue !== undefined) {
                result.push(String(fallbackValue));
              } else {
                // Neither field exists - treat as missing required variable
                // Don't use the field name as a literal string
                logger.debug(`Missing both primary field '${token.field}' and fallback field '${token.defaultValue}'`);
                return null;
              }
            } else {
              // defaultValue is not a field name, use as literal
              result.push(token.defaultValue!);
            }
          }
          break;
        }
      }
    }

    return result.join('');
  }

  /**
   * Validate a template string for syntax errors
   *
   * @param template The template to validate
   * @returns An object with valid flag and any errors/warnings
   */
  validate(template: string): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      const tokens = tokenize(template);

      for (const token of tokens) {
        if (token.type !== 'literal' && !token.field) {
          errors.push(`Invalid variable syntax: {${token.value}}`);
        }

        // Check for nested conditional templates
        if (token.type === 'conditional' && token.innerTemplate) {
          const innerValidation = this.validate(token.innerTemplate);
          errors.push(...innerValidation.errors.map(e => `In conditional {${token.field}?()}: ${e}`));
          warnings.push(...innerValidation.warnings.map(w => `In conditional {${token.field}?()}: ${w}`));
        }
      }
    } catch (error) {
      errors.push(`Template parsing error: ${error}`);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Extract all variable names from a template
   *
   * @param template The template to analyze
   * @returns Array of variable field paths used in the template
   */
  extractVariables(template: string): string[] {
    const variables: Set<string> = new Set();
    const tokens = tokenize(template);

    for (const token of tokens) {
      if (token.field) {
        variables.add(token.field);
      }
      // Recursively extract from conditional templates
      if (token.type === 'conditional' && token.innerTemplate) {
        const innerVars = this.extractVariables(token.innerTemplate);
        innerVars.forEach(v => variables.add(v));
      }
    }

    return Array.from(variables);
  }
}
