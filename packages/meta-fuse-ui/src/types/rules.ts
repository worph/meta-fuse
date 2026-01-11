/**
 * Types for renaming rules UI
 * These mirror the backend types for API communication
 */

export type ConditionOperator =
  | 'EXISTS'
  | 'NOT_EXISTS'
  | 'EQUALS'
  | 'NOT_EQUALS'
  | 'CONTAINS'
  | 'MATCHES';

export interface Condition {
  type: ConditionOperator;
  field: string;
  value?: string | number | boolean;
}

export interface ConditionGroup {
  operator: 'AND' | 'OR';
  conditions: (Condition | ConditionGroup)[];
}

export interface RenamingRule {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  priority: number;
  conditions: ConditionGroup;
  template: string;
  fallbackToUnsorted: boolean;
}

export interface RenamingConfig {
  version: number;
  rules: RenamingRule[];
  defaultRule?: RenamingRule;
  lastModified?: string;
  isDefault?: boolean;  // True if this is the default config (not user-customized)
}

export interface PreviewItem {
  sourcePath: string;
  currentVirtualPath: string;
  newVirtualPath: string | null;
  matchedRule: string | null;
  error?: string;
}

export interface PreviewResponse {
  previews: PreviewItem[];
  total: number;
  limited: boolean;
}

export interface TemplateVariable {
  name: string;
  path: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  example?: string;
}

// Helper function to check if a condition is a group
export function isConditionGroup(condition: Condition | ConditionGroup): condition is ConditionGroup {
  return 'operator' in condition && 'conditions' in condition;
}

// Generate a unique ID
export function generateId(): string {
  return `rule-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}
