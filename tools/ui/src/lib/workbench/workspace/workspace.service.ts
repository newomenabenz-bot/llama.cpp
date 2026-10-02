/**
 * WorkbenchWorkspaceService - Workspace Tool Bridge & File Data Service
 *
 * Coordinates filesystem queries with ToolsService:
 * - Traverses directory hierarchies using file_glob_search
 * - Retrieves and caches file contents via read_file
 * - Normalizes and filters paths according to workspace policy
 */

import { BuiltInTool } from '$lib/enums';
import { ToolsService } from '$lib/services/tools.service';
import { splitSearchSummaryList } from '$lib/utils';
import {
	DEFAULT_WORKSPACE_FILTER_CONFIG,
	type WorkspaceFilterConfig
} from './types';
import { normalizeWorkspacePath, shouldIgnorePath } from './workspace-tree';

export class WorkbenchWorkspaceService {
	/**
	 * Fetches the flat list of relative file and folder paths in the workspace root.
	 *
	 * @param rootPath - Root directory to scan (defaults to '.')
	 * @param filter - Optional filter overrides
	 * @param signal - Optional abort signal
	 */
	static async fetchWorkspaceFiles(
		rootPath: string = '/home/ubuntu',
		filter?: Partial<WorkspaceFilterConfig>,
		signal?: AbortSignal
	): Promise<string[]> {
		const config: WorkspaceFilterConfig = {
			ignoredPatterns: filter?.ignoredPatterns ?? DEFAULT_WORKSPACE_FILTER_CONFIG.ignoredPatterns,
			maxDepth: filter?.maxDepth ?? DEFAULT_WORKSPACE_FILTER_CONFIG.maxDepth,
			maxFiles: filter?.maxFiles ?? DEFAULT_WORKSPACE_FILTER_CONFIG.maxFiles
		};

		const normalizedRoot =
			rootPath && rootPath.startsWith('/')
				? rootPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/home/ubuntu'
				: normalizeWorkspacePath(rootPath) || (rootPath === '.' ? '.' : '/home/ubuntu');

		try {
			const rawResult = await ToolsService.executeToolRaw(
				BuiltInTool.SERVER_FILE_GLOB_SEARCH,
				{
					exclude: '{.git/**,node_modules/**,build*/**,.cache/**,dist*/**,.npm/**}',
					limit: 100,
					path: normalizedRoot,
					type: 'all'
				},
				signal,
				normalizedRoot
			);

			const rawList: string[] = [];

			if (rawResult) {
				// 1. Structured entries field (preserved by executeToolRaw)
				if (Array.isArray(rawResult.entries)) {
					for (const entry of rawResult.entries) {
						if (typeof entry === 'string') {
							rawList.push(entry);
						} else if (
							entry &&
							typeof entry === 'object' &&
							'path' in entry &&
							typeof (entry as { path: unknown }).path === 'string'
						) {
							const obj = entry as { path: string; type?: string };
							const isDir = obj.type === 'dir' || obj.type === 'directory';
							rawList.push(isDir && !obj.path.endsWith('/') ? `${obj.path}/` : obj.path);
						}
					}
				} else if (typeof rawResult.plain_text_response === 'string') {
					// 2. Plain text response summary
					const split = splitSearchSummaryList(rawResult.plain_text_response, () => {});
					rawList.push(...split.lines);
				} else if (typeof rawResult.content === 'string') {
					// 3. Fallback string content
					const split = splitSearchSummaryList(rawResult.content, () => {});
					rawList.push(...split.lines);
				}
			}

			// Clean, normalize and filter returned paths
			const validPaths: string[] = [];
			const seen = new Set<string>();

			for (const raw of rawList) {
				const isDir = raw.endsWith('/') || raw.endsWith('\\');
				const norm = normalizeWorkspacePath(raw);
				if (!norm || seen.has(norm)) continue;
				seen.add(norm);

				if (!shouldIgnorePath(norm, config.ignoredPatterns)) {
					validPaths.push(isDir ? `${norm}/` : norm);
				}

				if (validPaths.length >= config.maxFiles) break;
			}

			return validPaths;
		} catch (error) {
			console.warn('[WorkbenchWorkspaceService] fetchWorkspaceFiles failed:', error);
			throw error;
		}
	}

	/**
	 * Reads and returns the raw text content of a file in the workspace.
	 *
	 * @param filePath - Path to the target file
	 * @param rootPath - Optional workspace root directory
	 * @param signal - Optional abort signal
	 */
	static async fetchFileContent(
		filePath: string,
		rootPath?: string,
		signal?: AbortSignal
	): Promise<string> {
		const normPath = normalizeWorkspacePath(filePath);
		if (!normPath) {
			throw new Error('File path cannot be empty');
		}

		const result = await ToolsService.executeTool(
			BuiltInTool.SERVER_READ_FILE,
			{ path: normPath },
			signal,
			rootPath
		);

		if (result.isError) {
			throw new Error(result.content || `Failed to read file: ${normPath}`);
		}

		return result.content;
	}

	/**
	 * Fetches direct child files and folders under a specific sub-directory for on-demand expansion.
	 *
	 * @param dirPath - Subdirectory path relative to workspace root
	 * @param rootPath - Workspace root path (defaults to '/home/ubuntu')
	 * @param signal - Optional abort signal
	 */
	static async fetchDirectoryChildren(
		dirPath: string,
		rootPath: string = '/home/ubuntu',
		signal?: AbortSignal
	): Promise<string[]> {
		const cleanDir = normalizeWorkspacePath(dirPath);
		const targetPath = cleanDir ? `${rootPath}/${cleanDir}` : rootPath;

		try {
			const rawResult = await ToolsService.executeToolRaw(
				BuiltInTool.SERVER_FILE_GLOB_SEARCH,
				{
					exclude: '{.git/**,node_modules/**,build*/**,.cache/**,dist*/**,.npm/**}',
					limit: 100,
					max_depth: 2,
					path: targetPath,
					type: 'all'
				},
				signal,
				targetPath
			);

			const results: string[] = [];
			if (rawResult && Array.isArray(rawResult.entries)) {
				for (const entry of rawResult.entries) {
					let rel =
						typeof entry === 'string'
							? entry
							: (entry && typeof entry === 'object' && 'path' in entry ? String((entry as { path: unknown }).path) : '');
					const isDir =
						entry &&
						typeof entry === 'object' &&
						('type' in entry && (entry.type === 'dir' || entry.type === 'directory'));
					if (rel) {
						if (cleanDir && !rel.startsWith(cleanDir)) {
							rel = `${cleanDir}/${rel}`;
						}
						results.push(isDir && !rel.endsWith('/') ? `${rel}/` : rel);
					}
				}
			}
			return results;
		} catch (err) {
			console.warn('[WorkbenchWorkspaceService] fetchDirectoryChildren failed for', dirPath, err);
			return [];
		}
	}
}
