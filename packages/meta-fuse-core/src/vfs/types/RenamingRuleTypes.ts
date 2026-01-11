/**
 * Renaming Rule Types
 *
 * Defines the schema for configurable renaming rules that replace
 * the hardcoded renamingRule() function.
 */

/**
 * Condition operators for evaluating metadata fields
 */
export type ConditionOperator =
  | 'EXISTS'      // Field exists and is not null/undefined
  | 'NOT_EXISTS'  // Field is null/undefined
  | 'EQUALS'      // Field equals specified value
  | 'NOT_EQUALS'  // Field does not equal specified value
  | 'CONTAINS'    // String field contains specified substring
  | 'MATCHES';    // String field matches specified regex

/**
 * A single condition that evaluates a metadata field
 */
export interface Condition {
  type: ConditionOperator;
  field: string;            // Metadata field path, e.g., "titles.eng", "season", "fileType"
  value?: string | number | boolean;  // Required for EQUALS, NOT_EQUALS, CONTAINS, MATCHES
}

/**
 * A group of conditions combined with AND or OR logic
 */
export interface ConditionGroup {
  operator: 'AND' | 'OR';
  conditions: (Condition | ConditionGroup)[];
}

/**
 * A single renaming rule with conditions and a template
 */
export interface RenamingRule {
  id: string;               // Unique identifier (UUID)
  name: string;             // Human-readable name
  description?: string;     // Optional description
  enabled: boolean;         // Can disable without deleting
  priority: number;         // Higher = evaluated first (default: 0)
  conditions: ConditionGroup;
  template: string;         // Template string with variables
  fallbackToUnsorted: boolean;  // If template fails, put in Unsorted/
}

/**
 * Full renaming configuration with all rules
 */
export interface RenamingConfig {
  version: number;          // Schema version for migrations
  rules: RenamingRule[];
  defaultRule?: RenamingRule;  // Catch-all rule when no conditions match
  lastModified?: string;    // ISO timestamp of last modification
  isDefault?: boolean;      // True if this is the default config (not user-customized)
}

/**
 * Preview item showing how a file would be renamed
 */
export interface PreviewItem {
  sourcePath: string;
  currentVirtualPath: string;
  newVirtualPath: string | null;
  matchedRule: string | null;  // Rule ID that matched
  error?: string;
}

/**
 * Response for preview endpoint
 */
export interface PreviewResponse {
  previews: PreviewItem[];
  total: number;
  limited: boolean;
}

/**
 * Available template variable metadata for UI
 */
export interface TemplateVariable {
  name: string;         // Display name
  path: string;         // Field path (e.g., "titles.eng")
  type: 'string' | 'number' | 'boolean';
  description: string;
  example?: string;
}

/**
 * List of all available template variables
 */
export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  { name: 'English Title', path: 'titles.eng', type: 'string', description: 'English title from metadata', example: 'Breaking Bad' },
  { name: 'Original Title', path: 'originalTitle', type: 'string', description: 'Original/native title', example: 'Breaking Bad' },
  { name: 'Title', path: 'title', type: 'string', description: 'Simple title field', example: 'Breaking Bad' },
  { name: 'Season', path: 'season', type: 'number', description: 'Season number', example: '1' },
  { name: 'Episode', path: 'episode', type: 'number', description: 'Episode number', example: '1' },
  { name: 'Is Extra', path: 'extra', type: 'boolean', description: 'Whether this is a special/extra', example: 'false' },
  { name: 'Movie Year', path: 'movieYear', type: 'number', description: 'Movie release year', example: '2010' },
  { name: 'Year', path: 'year', type: 'number', description: 'General year field', example: '2010' },
  { name: 'File Type', path: 'fileType', type: 'string', description: 'Type: video, subtitle, torrent', example: 'video' },
  { name: 'Extension', path: 'extension', type: 'string', description: 'File extension', example: 'mkv' },
  { name: 'Version', path: 'version', type: 'string', description: 'Quality/release version', example: '1080p BluRay' },
  { name: 'Subtitle Language', path: 'subtitleLanguage', type: 'string', description: 'Language code for subtitles', example: 'eng' },
  { name: 'File Name', path: 'fileName', type: 'string', description: 'Original filename', example: 'Breaking.Bad.S01E01.mkv' },
];

/**
 * Type guard to check if a condition is a ConditionGroup
 */
export function isConditionGroup(condition: Condition | ConditionGroup): condition is ConditionGroup {
  return 'operator' in condition && 'conditions' in condition;
}
