/**
 * MetaDataToFolderStruct - Generates virtual filesystem structure from metadata
 *
 * Migrated from meta-mesh to meta-fuse.
 * Takes a collection of file metadata and generates organized virtual paths.
 */

import { renamingRule, sanitizePath } from './RenamingRule.js';
import { Logger } from 'tslog';

const logger = new Logger({ name: 'MetaDataToFolderStruct' });

type RenamingRuleFunction = (metadata: any, filepath: string) => string | null;

export class MetaDataToFolderStruct {
    public renamingRule: RenamingRuleFunction;

    constructor(customRenamingRule?: RenamingRuleFunction) {
        this.renamingRule = customRenamingRule ?? renamingRule;
    }

    /**
     * Compute virtual filesystem structure for FUSE/WebDAV
     * Generates organized paths based on metadata without creating physical files
     *
     * @param data Map of source paths to metadata
     * @returns Map of source paths to virtual paths
     */
    private computeVirtualStructure(data: Map<string, any>): Map<string, string> {
        const virtualMap = new Map<string, string>();

        for (const [filepath, metadata] of data) {
            // Compute the virtual path for the file
            let virtualPath: string | null = null;

            try {
                virtualPath = this.renamingRule(metadata, filepath);
            } catch (e: any) {
                logger.warn(`Failed to compute virtual path for ${filepath}: ${e.message || e}`);
            }

            if (!virtualPath) {
                // Fallback: use filename directly if renaming rule fails
                const filename = filepath.split('/').pop() || filepath.split('\\').pop() || filepath;
                virtualPath = `Unsorted/${filename}`;
            }

            virtualPath = sanitizePath(virtualPath);
            virtualMap.set(filepath, virtualPath);
        }

        logger.debug(`Computed virtual structure for ${virtualMap.size} files`);
        return virtualMap;
    }

    /**
     * Generate virtual filesystem structure for FUSE/WebDAV
     * Returns only the computed virtual paths without checking physical filesystem
     *
     * @param data Map of source paths to metadata
     * @returns Map of source paths to virtual paths
     */
    public generateVirtualStructure(data: Map<string, any>): Map<string, string> {
        const start = performance.now();
        const computed = this.computeVirtualStructure(data);
        logger.debug(`Compute virtual structure took ${Math.ceil(performance.now() - start)}ms`);
        return computed;
    }

    /**
     * Generate virtual path for a single file
     *
     * @param sourcePath The source file path
     * @param metadata The file metadata
     * @returns Virtual path or fallback path
     */
    public generateSingleVirtualPath(sourcePath: string, metadata: any): string {
        let virtualPath: string | null = null;

        try {
            virtualPath = this.renamingRule(metadata, sourcePath);
        } catch (e: any) {
            logger.warn(`Failed to compute virtual path for ${sourcePath}: ${e.message || e}`);
        }

        if (!virtualPath) {
            // Fallback: use filename directly if renaming rule fails
            const filename = sourcePath.split('/').pop() || sourcePath.split('\\').pop() || sourcePath;
            virtualPath = `Unsorted/${filename}`;
        }

        return sanitizePath(virtualPath);
    }
}
