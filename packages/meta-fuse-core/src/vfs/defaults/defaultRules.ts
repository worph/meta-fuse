/**
 * Default Renaming Rules
 *
 * These rules match the current hardcoded behavior in RenamingRule.ts.
 * They serve as the initial configuration when no custom rules are set.
 *
 * Old behavior:
 * - Only processes video, subtitle, torrent files
 * - Requires extension
 * - Title from titles.eng || originalTitle
 * - Files without title/extension are hidden (not in Unsorted)
 */

import type { RenamingConfig, RenamingRule } from '../types/RenamingRuleTypes.js';

/**
 * Supported file types condition (video, subtitle, torrent)
 * Used by all rules to filter out unsupported file types
 */
const supportedFileTypeCondition = {
  operator: 'OR' as const,
  conditions: [
    { type: 'EQUALS' as const, field: 'fileType', value: 'video' },
    { type: 'EQUALS' as const, field: 'fileType', value: 'subtitle' },
    { type: 'EQUALS' as const, field: 'fileType', value: 'torrent' },
  ],
};

/**
 * TV Series - Extras rule
 * Matches files marked as extra/special content
 */
const tvExtrasRule: RenamingRule = {
  id: 'tv-extras',
  name: 'TV Series - Extras',
  description: 'Special episodes, behind the scenes, extras',
  enabled: true,
  priority: 100,
  conditions: {
    operator: 'AND',
    conditions: [
      supportedFileTypeCondition,
      { type: 'EXISTS', field: 'extension' },
      { type: 'EQUALS', field: 'extra', value: true },
    ],
  },
  // Old format: TV Shows/{title}/extra/{title}{seasonSpace}{episode}{subtitle}{version}.{extension}
  template: 'TV Shows/{title|originalTitle}/extra/{title|originalTitle}{season?( S{season:pad2})}{episode?(E{episode:pad2})}{subtitleLanguage?(.{subtitleLanguage})}{version?( {version})}.{extension}',
  fallbackToUnsorted: true, // If template fails (no title), put in Unsorted
};

/**
 * TV Series rule
 * Matches files with both season and episode numbers
 */
const tvSeriesRule: RenamingRule = {
  id: 'tv-series',
  name: 'TV Series',
  description: 'Regular TV show episodes with season and episode numbers',
  enabled: true,
  priority: 90,
  conditions: {
    operator: 'AND',
    conditions: [
      supportedFileTypeCondition,
      { type: 'EXISTS', field: 'extension' },
      { type: 'EXISTS', field: 'season' },
      { type: 'EXISTS', field: 'episode' },
    ],
  },
  // Old format: TV Shows/{title}/S{season}/{title} S{season}E{episode}{subtitle}{version}.{extension}
  template: 'TV Shows/{title|originalTitle}/S{season:pad2}/{title|originalTitle} S{season:pad2}E{episode:pad2}{subtitleLanguage?(.{subtitleLanguage})}{version?( {version})}.{extension}',
  fallbackToUnsorted: true, // If template fails (no title), put in Unsorted
};

/**
 * Movies rule
 * Matches files with a title but no season number (assumed to be movies)
 */
const moviesRule: RenamingRule = {
  id: 'movies',
  name: 'Movies',
  description: 'Standalone movies without season/episode numbers',
  enabled: true,
  priority: 80,
  conditions: {
    operator: 'AND',
    conditions: [
      supportedFileTypeCondition,
      { type: 'EXISTS', field: 'extension' },
      {
        operator: 'OR',
        conditions: [
          { type: 'EXISTS', field: 'title' },
          { type: 'EXISTS', field: 'originalTitle' },
        ],
      },
      { type: 'NOT_EXISTS', field: 'season' },
    ],
  },
  // Old format: Movies/{title}{year}/{title}{year}{subtitle}{version}.{extension}
  template: 'Movies/{title|originalTitle}{movieYear?( ({movieYear}))}/{title|originalTitle}{movieYear?( ({movieYear}))}{subtitleLanguage?(.{subtitleLanguage})}{version?( {version})}.{extension}',
  fallbackToUnsorted: true, // If template fails, put in Unsorted
};

/**
 * Images rule
 * Matches image files (posters, backdrops, etc.)
 * Note: Poster images are classified as 'document' type
 */
const imagesRule: RenamingRule = {
  id: 'images',
  name: 'Images',
  description: 'Image files like posters and backdrops',
  enabled: true,
  priority: 70,
  conditions: {
    operator: 'AND',
    conditions: [
      {
        operator: 'OR',
        conditions: [
          { type: 'EQUALS', field: 'fileType', value: 'image' },
          { type: 'EQUALS', field: 'fileType', value: 'document' },
        ],
      },
    ],
  },
  template: 'Images/{fileName}',
  fallbackToUnsorted: true,
};

/**
 * Default fallback rule
 * Used when no other rules match - places files in Unsorted folder
 * Note: In old behavior, unsupported files were hidden. This rule provides visibility.
 */
const fallbackRule: RenamingRule = {
  id: 'fallback-unsorted',
  name: 'Unsorted',
  description: 'Files that do not match any other rule',
  enabled: true,
  priority: 0,
  conditions: {
    operator: 'AND',
    conditions: [], // Always matches
  },
  template: 'Unsorted/{fileName}',
  fallbackToUnsorted: false,
};

/**
 * Get the default renaming configuration
 *
 * @returns The default RenamingConfig matching current hardcoded behavior
 */
export function getDefaultRulesConfig(): RenamingConfig {
  return {
    version: 1,
    rules: [
      tvExtrasRule,
      tvSeriesRule,
      moviesRule,
      imagesRule,
    ],
    defaultRule: fallbackRule,
    lastModified: new Date().toISOString(),
  };
}

/**
 * Plex-style naming preset
 * Uses Plex's preferred naming conventions
 */
export function getPlexPreset(): RenamingConfig {
  return {
    version: 1,
    rules: [
      {
        ...tvSeriesRule,
        id: 'plex-tv',
        name: 'TV Series (Plex)',
        template: 'TV Shows/{title|originalTitle}/Season {season:pad2}/{title|originalTitle} - S{season:pad2}E{episode:pad2}{subtitleLanguage?(.{subtitleLanguage})}{version?( - {version})}.{extension}',
      },
      {
        ...moviesRule,
        id: 'plex-movies',
        name: 'Movies (Plex)',
        template: 'Movies/{title|originalTitle} ({movieYear|Unknown})/{title|originalTitle} ({movieYear|Unknown}){subtitleLanguage?(.{subtitleLanguage})}{version?( - {version})}.{extension}',
      },
    ],
    defaultRule: fallbackRule,
    lastModified: new Date().toISOString(),
  };
}

/**
 * Jellyfin-style naming preset
 * Uses Jellyfin's preferred naming conventions
 */
export function getJellyfinPreset(): RenamingConfig {
  return {
    version: 1,
    rules: [
      {
        ...tvSeriesRule,
        id: 'jellyfin-tv',
        name: 'TV Series (Jellyfin)',
        template: 'Shows/{title|originalTitle}{year?( ({year}))}/Season {season:pad2}/S{season:pad2}E{episode:pad2}{subtitleLanguage?(.{subtitleLanguage})}.{extension}',
      },
      {
        ...moviesRule,
        id: 'jellyfin-movies',
        name: 'Movies (Jellyfin)',
        template: 'Movies/{title|originalTitle} ({movieYear})/{title|originalTitle} ({movieYear}){subtitleLanguage?(.{subtitleLanguage})}.{extension}',
      },
    ],
    defaultRule: fallbackRule,
    lastModified: new Date().toISOString(),
  };
}

/**
 * Available presets
 */
export const PRESETS = {
  default: getDefaultRulesConfig,
  plex: getPlexPreset,
  jellyfin: getJellyfinPreset,
} as const;

export type PresetName = keyof typeof PRESETS;
