/**
 * Workspace Node Contracts & Data Specifications
 *
 * Types for hierarchical workspace representation, file node metadata,
 * directory traversal filtering, and file buffer caching.
 */

export type WorkspaceNodeType = 'file' | 'directory';

export interface WorkspaceFileNode {
	/** Normalized relative or unique path identifier */
	id: string;
	/** File or folder display name (e.g. 'Button.svelte') */
	name: string;
	/** Normalized relative path from workspace root (e.g. 'src/lib/Button.svelte') */
	path: string;
	/** Node type: directory or file */
	type: WorkspaceNodeType;
	/** File size in bytes (if known) */
	size?: number;
	/** Lowercase file extension without dot (e.g. 'svelte', 'ts', 'json') */
	extension?: string;
	/** Child nodes for directories, sorted directories-first then alphabetically */
	children?: WorkspaceFileNode[];
	/** Whether directory is expanded in tree views */
	isExpanded?: boolean;
}

export interface WorkspaceFilterConfig {
	/** Directory and file patterns ignored during tree building */
	ignoredPatterns: string[];
	/** Maximum directory recursion depth */
	maxDepth: number;
	/** Maximum total file count to parse into the tree */
	maxFiles: number;
}

export const DEFAULT_WORKSPACE_FILTER_CONFIG: WorkspaceFilterConfig = {
	ignoredPatterns: ['.git', 'node_modules', 'dist', '.svelte-kit', '.DS_Store'],
	maxDepth: 10,
	maxFiles: 5000
};

export interface FileBufferEntry {
	path: string;
	content: string;
	cachedAt: number;
}
