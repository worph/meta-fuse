/**
 * Renaming Rule - Defines folder organization logic
 *
 * Migrated from meta-mesh to meta-fuse for virtual path computation.
 * Organizes files into structured folders based on metadata:
 * - TV Shows/{title}/S01/{filename} for series
 * - Movies/{title} (year)/{filename} for movies
 */

/**
 * Minimal metadata interface for folder organization
 * Contains only the fields needed for virtual path computation
 */
export interface MediaMeta {
    // Title information
    titles?: { eng?: string; [key: string]: string | undefined };
    originalTitle?: string;
    title?: string;

    // Series metadata
    season?: number;
    episode?: number;
    extra?: boolean;

    // Movie metadata
    movieYear?: number;
    year?: number;

    // File type info
    fileType?: string;      // 'video', 'subtitle', 'torrent'
    extension?: string;

    // Version/variant
    version?: string;
    subtitleLanguage?: string;

    // Allow additional fields
    [key: string]: unknown;
}

/**
 * Compute the virtual path for a file based on its metadata
 * Returns the path relative to the VFS root
 *
 * @param metadata File metadata with title, season, episode, year, etc.
 * @param filepath Original file path (used for warnings)
 * @returns Virtual path (e.g., "TV Shows/Show Name/S01/Episode.mkv") or null if unsupported
 */
export function renamingRule(metadata: Partial<MediaMeta>, filepath?: string): string | null {
    const supported = ['video', 'subtitle', 'torrent'];

    // Check if filetype is one of the supported ones
    if (!metadata.fileType || !supported.includes(metadata.fileType)) {
        return null;
    }

    // Extract the file extension
    const extension = metadata.extension;
    if (!extension) {
        console.warn(`[RenamingRule] No extension found for file: ${filepath}`);
        return null;
    }

    // Get title - try various fields
    const title = metadata.titles?.eng || metadata.originalTitle;
    if (!title) {
        if (metadata.fileType !== 'torrent') {
            // Don't warn for torrent files because they don't always have a title
            console.warn(`[RenamingRule] No title found for file: ${filepath}`);
        }
        return null;
    }

    let newPath = '';

    // Build filename components
    const season = metadata.season ? ('S' + String(metadata.season).padStart(2, '0')) : '';
    const seasonSpace = metadata.season ? ` ${season}` : '';
    const episode = metadata.episode ? ('E' + String(metadata.episode).padStart(2, '0')) : '';
    const version = metadata.version ? ` ${metadata.version}` : '';
    const year = metadata.movieYear ? ` (${metadata.movieYear})` : '';
    const subtitle = metadata.fileType === 'subtitle' && metadata.subtitleLanguage
        ? `.${metadata.subtitleLanguage}`
        : '';

    const fileName = `${title}${seasonSpace}${episode}${year}${subtitle}${version}.${extension}`;

    // Determine structure: TV Shows for series, Movies for standalone content
    // Note: season can be 0 (special episodes), so check for null/undefined explicitly
    const hasSeason = metadata.season !== null && metadata.season !== undefined;
    const hasEpisode = metadata.episode !== null && metadata.episode !== undefined;

    if (metadata.extra) {
        newPath = `TV Shows/${title}/extra/${fileName}`;
    } else if (hasSeason && hasEpisode) {
        newPath = `TV Shows/${title}/${season}/${fileName}`;
    } else {
        newPath = `Movies/${title}${year}/${fileName}`;
    }

    return newPath;
}

/**
 * Sanitize a path to remove illegal characters
 * Works for both Windows and Unix-like systems
 */
export function sanitizePath(newPath: string): string {
    // Isolate any potential Windows drive letter at the start
    const driveMatch = newPath.match(/^[a-zA-Z]:/);
    const drive = driveMatch ? driveMatch[0] : '';

    // Define illegal characters for Windows and potentially problematic ones for Unix
    const illegalChars = /[<>:"|?*]/g;

    // Replace illegal characters in the path, excluding the drive part
    const pathWithoutDrive = newPath.slice(drive.length);
    const sanitizedPath = pathWithoutDrive.replace(illegalChars, '');

    // Combine the drive (if any) and the sanitized path
    const cleanPath = drive + sanitizedPath;

    // Normalize to forward slashes (works cross-platform)
    return cleanPath.replace(/\\/g, '/');
}
