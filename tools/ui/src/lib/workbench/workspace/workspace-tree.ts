/**
 * Workspace Tree Construction & Path Utilities
 *
 * Provides pure functional utilities for parsing flat path lists into
 * nested directory/file hierarchies, filtering ignored directories,
 * sorting with directory-precedence, and querying tree nodes.
 */

import {
	DEFAULT_WORKSPACE_FILTER_CONFIG,
	type WorkspaceFileNode,
	type WorkspaceFilterConfig
} from './types';

/**
 * Normalizes any Windows or POSIX path into a standardized relative path:
 * - Forward slashes ('/')
 * - No redundant leading './' or '/'
 * - No trailing slashes
 * - Strips consecutive duplicate slashes
 */
export function normalizeWorkspacePath(rawPath: string): string {
	if (!rawPath) return '';

	let p = rawPath.replace(/\\/g, '/');

	// Strip leading './' or '/'
	while (p.startsWith('./')) {
		p = p.slice(2);
	}
	while (p.startsWith('/')) {
		p = p.slice(1);
	}

	// Strip trailing '/'
	while (p.endsWith('/') && p.length > 0) {
		p = p.slice(0, -1);
	}

	// Collapse duplicate consecutive slashes
	p = p.replace(/\/+/g, '/');

	if (p === '.' || p === '') return '';
	return p;
}

/**
 * Extracts lowercase file extension without dot (e.g. 'Button.svelte' -> 'svelte').
 */
export function getFileExtension(filename: string): string {
	if (!filename) return '';
	const idx = filename.lastIndexOf('.');
	if (idx > 0 && idx < filename.length - 1) {
		return filename.substring(idx + 1).toLowerCase();
	}
	return '';
}

/**
 * Checks whether any segment of a path matches the configured ignored patterns.
 */
export function shouldIgnorePath(normalizedPath: string, ignoredPatterns: string[]): boolean {
	if (!normalizedPath || ignoredPatterns.length === 0) return false;

	const segments = normalizedPath.split('/');
	for (const segment of segments) {
		for (const pattern of ignoredPatterns) {
			if (pattern === segment) return true;
			// Match patterns like '*.tmp' or exact prefix
			if (pattern.startsWith('*') && segment.endsWith(pattern.slice(1))) return true;
		}
	}
	return false;
}

interface IntermediateDirNode {
	name: string;
	path: string;
	type: 'directory';
	subdirs: Map<string, IntermediateDirNode>;
	files: Map<string, WorkspaceFileNode>;
}

function createIntermediateDir(name: string, path: string): IntermediateDirNode {
	return {
		files: new Map(),
		name,
		path,
		subdirs: new Map(),
		type: 'directory'
	};
}

/**
 * Compares two nodes for display order:
 * 1. Directories always appear before files.
 * 2. Case-insensitive alphabetical sort within the same type.
 */
export function compareWorkspaceNodes(a: WorkspaceFileNode, b: WorkspaceFileNode): number {
	if (a.type === 'directory' && b.type === 'file') return -1;
	if (a.type === 'file' && b.type === 'directory') return 1;
	return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

/**
 * Converts intermediate tree map to sorted WorkspaceFileNode array.
 */
function convertToWorkspaceNodes(
	dirMap: IntermediateDirNode,
	expandedPaths?: Set<string>
): WorkspaceFileNode[] {
	const result: WorkspaceFileNode[] = [];

	// Process directory children
	for (const subDir of dirMap.subdirs.values()) {
		const children = convertToWorkspaceNodes(subDir, expandedPaths);
		const isExpanded = expandedPaths ? expandedPaths.has(subDir.path) : false;

		result.push({
			children,
			id: subDir.path,
			isExpanded,
			name: subDir.name,
			path: subDir.path,
			type: 'directory'
		});
	}

	// Process file children
	for (const fileNode of dirMap.files.values()) {
		result.push(fileNode);
	}

	// Sort directories first, then alphabetical
	result.sort(compareWorkspaceNodes);
	return result;
}

/**
 * Recursively converts a flat array of file paths into a structured hierarchical
 * tree of WorkspaceFileNode objects.
 *
 * @param filePaths - Array of raw file or folder paths.
 * @param filter - Optional filter overrides (ignoredPatterns, maxDepth, maxFiles).
 * @param expandedPaths - Optional set of paths that should have isExpanded = true.
 */
export function buildFileTree(
	filePaths: string[],
	filter?: Partial<WorkspaceFilterConfig>,
	expandedPaths?: Set<string>
): WorkspaceFileNode[] {
	if (!filePaths || filePaths.length === 0) return [];

	const config: WorkspaceFilterConfig = {
		ignoredPatterns: filter?.ignoredPatterns ?? DEFAULT_WORKSPACE_FILTER_CONFIG.ignoredPatterns,
		maxDepth: filter?.maxDepth ?? DEFAULT_WORKSPACE_FILTER_CONFIG.maxDepth,
		maxFiles: filter?.maxFiles ?? DEFAULT_WORKSPACE_FILTER_CONFIG.maxFiles
	};

	const rootDir = createIntermediateDir('', '');
	const seenPaths = new Set<string>();
	let fileCount = 0;

	for (const raw of filePaths) {
		if (fileCount >= config.maxFiles) break;

		const normalized = normalizeWorkspacePath(raw);
		if (!normalized || seenPaths.has(normalized)) continue;
		seenPaths.add(normalized);

		if (shouldIgnorePath(normalized, config.ignoredPatterns)) continue;

		const segments = normalized.split('/');
		if (segments.length > config.maxDepth + 1) continue;

		let currentDir = rootDir;
		let accumulatedPath = '';

		// Traverse and create intermediate directory structures
		for (let i = 0; i < segments.length - 1; i++) {
			const seg = segments[i];
			accumulatedPath = accumulatedPath ? `${accumulatedPath}/${seg}` : seg;

			let nextDir = currentDir.subdirs.get(seg);
			if (!nextDir) {
				nextDir = createIntermediateDir(seg, accumulatedPath);
				currentDir.subdirs.set(seg, nextDir);
			}
			currentDir = nextDir;
		}

		// Leaf node (file or trailing directory)
		const leafName = segments[segments.length - 1];
		const leafPath = accumulatedPath ? `${accumulatedPath}/${leafName}` : leafName;

		// Check if the leaf was explicitly marked as a directory (e.g. raw ended with '/')
		const isExplicitDirectory = raw.endsWith('/') || raw.endsWith('\\');

		if (isExplicitDirectory) {
			if (!currentDir.subdirs.has(leafName)) {
				currentDir.subdirs.set(leafName, createIntermediateDir(leafName, leafPath));
			}
		} else {
			if (!currentDir.files.has(leafName)) {
				currentDir.files.set(leafName, {
					extension: getFileExtension(leafName),
					id: leafPath,
					name: leafName,
					path: leafPath,
					type: 'file'
				});
				fileCount++;
			}
		}
	}

	return convertToWorkspaceNodes(rootDir, expandedPaths);
}

/**
 * Searches for a node matching the target path in the tree hierarchy.
 */
export function findNodeByPath(
	tree: WorkspaceFileNode[],
	targetPath: string
): WorkspaceFileNode | null {
	const normalizedTarget = normalizeWorkspacePath(targetPath);
	if (!normalizedTarget || !tree) return null;

	for (const node of tree) {
		if (node.path === normalizedTarget || node.id === normalizedTarget) {
			return node;
		}
		if (node.type === 'directory' && node.children && node.children.length > 0) {
			const found = findNodeByPath(node.children, normalizedTarget);
			if (found) return found;
		}
	}

	return null;
}

/**
 * Toggles the expansion state of a directory node matching targetPath,
 * returning a new deep-cloned tree representation.
 */
export function toggleNodeExpansion(
	tree: WorkspaceFileNode[],
	targetPath: string
): WorkspaceFileNode[] {
	const normalizedTarget = normalizeWorkspacePath(targetPath);
	if (!normalizedTarget || !tree) return tree;

	return tree.map((node) => {
		if (node.path === normalizedTarget && node.type === 'directory') {
			return {
				...node,
				children: node.children ? [...node.children] : undefined,
				isExpanded: !node.isExpanded
			};
		}
		if (node.type === 'directory' && node.children) {
			return {
				...node,
				children: toggleNodeExpansion(node.children, normalizedTarget)
			};
		}
		return node;
	});
}

/**
 * Flattens all nodes in the tree into a single array using depth-first ordering.
 */
export function flattenTree(tree: WorkspaceFileNode[]): WorkspaceFileNode[] {
	const flat: WorkspaceFileNode[] = [];

	function traverse(nodes: WorkspaceFileNode[]) {
		for (const node of nodes) {
			flat.push(node);
			if (node.type === 'directory' && node.children) {
				traverse(node.children);
			}
		}
	}

	traverse(tree);
	return flat;
}

/**
 * Collects all directory paths from the tree.
 */
export function collectDirectoryPaths(tree: WorkspaceFileNode[]): string[] {
	const paths: string[] = [];

	function traverse(nodes: WorkspaceFileNode[]) {
		for (const node of nodes) {
			if (node.type === 'directory') {
				paths.push(node.path);
				if (node.children) {
					traverse(node.children);
				}
			}
		}
	}

	traverse(tree);
	return paths;
}
