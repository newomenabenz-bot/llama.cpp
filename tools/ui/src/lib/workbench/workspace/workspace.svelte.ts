/**
 * WorkspaceStore - Reactive Svelte 5 Rune Store for Project Filesystem
 *
 * Manages the active workspace root directory, hierarchical file tree,
 * folder expansion states, active file selection, and in-memory file buffers.
 */

import type { FileDiffPayload } from '../diff/types';
import {
	DEFAULT_WORKSPACE_FILTER_CONFIG,
	type WorkspaceFileNode,
	type WorkspaceFilterConfig
} from './types';
import {
	buildFileTree,
	collectDirectoryPaths,
	findNodeByPath,
	normalizeWorkspacePath,
	toggleNodeExpansion
} from './workspace-tree';
import { WorkbenchWorkspaceService } from './workspace.service';

export class WorkspaceStore {
	rootPath = $state<string>('/home/ubuntu');
	tree = $state<WorkspaceFileNode[]>([]);
	flatPaths = $state<string[]>([]);
	selectedPath = $state<string | null>(null);
	expandedPaths = $state<Set<string>>(new Set());
	fileBuffers = $state<Map<string, string>>(new Map());
	diffPayload = $state<FileDiffPayload | null>(null);
	isLoading = $state<boolean>(false);
	isLoadingFile = $state<boolean>(false);
	isExplorerOpen = $state<boolean>(false);
	error = $state<string | null>(null);
	filterConfig = $state<WorkspaceFilterConfig>({ ...DEFAULT_WORKSPACE_FILTER_CONFIG });

	/**
	 * Opens the workspace explorer drawer and triggers an initial refresh if empty.
	 */
	openExplorer(): void {
		this.isExplorerOpen = true;
		if (this.tree.length === 0 && !this.isLoading) {
			void this.refreshTree();
		}
	}

	/**
	 * Closes the workspace explorer drawer.
	 */
	closeExplorer(): void {
		this.isExplorerOpen = false;
	}

	/**
	 * Toggles the workspace explorer drawer state.
	 */
	toggleExplorer(): void {
		this.isExplorerOpen = !this.isExplorerOpen;
		if (this.isExplorerOpen && this.tree.length === 0 && !this.isLoading) {
			void this.refreshTree();
		}
	}

	/**
	 * Sets the active workspace root directory.
	 */
	setRoot(newRoot: string): void {
		let normalized: string;
		if (newRoot && newRoot.startsWith('/')) {
			normalized = newRoot.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/home/ubuntu';
		} else {
			normalized = normalizeWorkspacePath(newRoot) || '/home/ubuntu';
		}
		if (this.rootPath !== normalized) {
			this.rootPath = normalized;
			this.selectedPath = null;
			this.tree = [];
			this.flatPaths = [];
			this.expandedPaths = new Set();
			this.error = null;
		}
	}

	/**
	 * Populates the workspace tree from a flat list of paths.
	 */
	setTree(paths: string[]): void {
		this.flatPaths = [...paths];
		this.tree = buildFileTree(this.flatPaths, this.filterConfig, this.expandedPaths);
	}

	/**
	 * Scans the workspace root and builds the updated file tree.
	 */
	async refreshTree(signal?: AbortSignal): Promise<void> {
		this.isLoading = true;
		this.error = null;

		try {
			const paths = await WorkbenchWorkspaceService.fetchWorkspaceFiles(
				this.rootPath,
				this.filterConfig,
				signal
			);
			this.setTree(paths);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.error = message;
			console.warn('[WorkspaceStore] Refresh failed:', message);
		} finally {
			this.isLoading = false;
		}
	}

	/**
	 * Selects an active file node by path and loads its content into the file buffer.
	 */
	async selectFile(path: string | null): Promise<string | null> {
		if (!path) {
			this.selectedPath = null;
			return null;
		}

		const normalized = normalizeWorkspacePath(path);
		this.selectedPath = normalized;

		// Check buffer cache first
		if (this.fileBuffers.has(normalized)) {
			return this.fileBuffers.get(normalized)!;
		}

		// Fetch file content via tool service
		this.isLoadingFile = true;
		try {
			const content = await WorkbenchWorkspaceService.fetchFileContent(
				normalized,
				this.rootPath
			);
			this.cacheFileContent(normalized, content);
			return content;
		} catch (err) {
			console.warn('[WorkspaceStore] Failed to read file content for', normalized, err);
			return null;
		} finally {
			this.isLoadingFile = false;
		}
	}

	/**
	 * Toggles a folder's expanded state.
	 */
	toggleFolder(path: string): void {
		const normalized = normalizeWorkspacePath(path);
		if (!normalized) return;

		const nextExpanded = new Set(this.expandedPaths);
		if (nextExpanded.has(normalized)) {
			nextExpanded.delete(normalized);
		} else {
			nextExpanded.add(normalized);
		}
		this.expandedPaths = nextExpanded;

		// Update node expansion on the current tree
		this.tree = toggleNodeExpansion(this.tree, normalized);
	}

	/**
	 * Expands all directories in the tree.
	 */
	expandAll(): void {
		const allDirs = collectDirectoryPaths(this.tree);
		this.expandedPaths = new Set(allDirs);
		this.tree = buildFileTree(this.flatPaths, this.filterConfig, this.expandedPaths);
	}

	/**
	 * Collapses all directories in the tree.
	 */
	collapseAll(): void {
		this.expandedPaths = new Set();
		this.tree = buildFileTree(this.flatPaths, this.filterConfig, this.expandedPaths);
	}

	/**
	 * Stores raw file content in the in-memory buffer.
	 */
	cacheFileContent(path: string, content: string): void {
		const normalized = normalizeWorkspacePath(path);
		const newBuffers = new Map(this.fileBuffers);
		newBuffers.set(normalized, content);
		this.fileBuffers = newBuffers;
	}

	/**
	 * Retrieves cached file content.
	 */
	getFileContent(path: string): string | undefined {
		const normalized = normalizeWorkspacePath(path);
		return this.fileBuffers.get(normalized);
	}

	/**
	 * Clears the file content buffer cache.
	 */
	clearCache(): void {
		this.fileBuffers = new Map();
	}

	/**
	 * Finds a file node by path in the current tree.
	 */
	findNode(path: string): WorkspaceFileNode | null {
		return findNodeByPath(this.tree, path);
	}

	/**
	 * Sets the active diff payload for comparison.
	 */
	setDiff(payload: FileDiffPayload | null): void {
		this.diffPayload = payload;
	}

	/**
	 * Clears the active diff payload.
	 */
	clearDiff(): void {
		this.diffPayload = null;
	}

	/**
	 * Resets store to initial empty state.
	 */
	reset(): void {
		this.rootPath = '/home/ubuntu';
		this.tree = [];
		this.flatPaths = [];
		this.selectedPath = null;
		this.expandedPaths = new Set();
		this.fileBuffers = new Map();
		this.diffPayload = null;
		this.isLoading = false;
		this.isLoadingFile = false;
		this.isExplorerOpen = false;
		this.error = null;
		this.filterConfig = { ...DEFAULT_WORKSPACE_FILTER_CONFIG };
	}
}

export const workspaceStore = new WorkspaceStore();

