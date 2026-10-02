/**
 * Unit tests for Workspace Tree Parser, Construction, and WorkspaceStore.
 *
 * Verifies:
 * 1. Conversion of flat path lists into nested tree structures.
 * 2. Correct filtering of ignored directories (.git, node_modules, dist, etc.).
 * 3. Sorting invariants: directories appear before files at all nesting levels,
 *    and within each category alphabetical order is maintained.
 * 4. Expansion and toggle mechanics across deep nested subtrees.
 * 5. Node lookup and active file selection by path.
 * 6. Safe handling of edge cases (empty paths, duplicate paths, Windows vs POSIX slashes).
 * 7. WorkspaceStore reactive operations, caching, and tool bridge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildFileTree,
	collectDirectoryPaths,
	findNodeByPath,
	flattenTree,
	getFileExtension,
	normalizeWorkspacePath,
	shouldIgnorePath,
	toggleNodeExpansion
} from '$lib/workbench/workspace/workspace-tree';
import {
	DEFAULT_WORKSPACE_FILTER_CONFIG,
	type WorkspaceFileNode
} from '$lib/workbench/workspace/types';
import { WorkbenchWorkspaceService } from '$lib/workbench/workspace/workspace.service';
import { workspaceStore } from '$lib/workbench/workspace/workspace.svelte';
import { ToolsService } from '$lib/services/tools.service';
import { BuiltInTool } from '$lib/enums';

describe('Workspace Tree Subsystem', () => {
	beforeEach(() => {
		workspaceStore.reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		workspaceStore.reset();
	});

	describe('a) Path Normalization & Utilities', () => {
		it('normalizes Windows backslashes and redundant prefixes', () => {
			expect(normalizeWorkspacePath('src\\lib\\Button.svelte')).toBe('src/lib/Button.svelte');
			expect(normalizeWorkspacePath('.\\src\\lib\\Button.svelte')).toBe('src/lib/Button.svelte');
			expect(normalizeWorkspacePath('./src/lib/Button.svelte')).toBe('src/lib/Button.svelte');
			expect(normalizeWorkspacePath('/src/lib/Button.svelte')).toBe('src/lib/Button.svelte');
			expect(normalizeWorkspacePath('src//lib///Button.svelte')).toBe('src/lib/Button.svelte');
			expect(normalizeWorkspacePath('src/lib/')).toBe('src/lib');
			expect(normalizeWorkspacePath('.')).toBe('');
			expect(normalizeWorkspacePath('')).toBe('');
		});

		it('extracts file extensions correctly', () => {
			expect(getFileExtension('Button.svelte')).toBe('svelte');
			expect(getFileExtension('index.ts')).toBe('ts');
			expect(getFileExtension('package.json')).toBe('json');
			expect(getFileExtension('styles.css.map')).toBe('map');
			expect(getFileExtension('.gitignore')).toBe('');
			expect(getFileExtension('Dockerfile')).toBe('');
			expect(getFileExtension('')).toBe('');
		});

		it('identifies ignored path segments correctly', () => {
			const ignored = ['.git', 'node_modules', 'dist', '.svelte-kit', '.DS_Store'];

			expect(shouldIgnorePath('.git/HEAD', ignored)).toBe(true);
			expect(shouldIgnorePath('node_modules/vite/package.json', ignored)).toBe(true);
			expect(shouldIgnorePath('dist/bundle.js', ignored)).toBe(true);
			expect(shouldIgnorePath('src/.DS_Store', ignored)).toBe(true);
			expect(shouldIgnorePath('src/components/node_modules/test.ts', ignored)).toBe(true);
			expect(shouldIgnorePath('src/lib/Button.svelte', ignored)).toBe(false);
			expect(shouldIgnorePath('package.json', ignored)).toBe(false);
		});
	});

	describe('b) Flat Path to Hierarchical Tree Construction', () => {
		it('converts a flat path list into a structured nested tree', () => {
			const flatPaths = [
				'package.json',
				'README.md',
				'src/app.css',
				'src/routes/+page.svelte',
				'src/lib/index.ts',
				'src/lib/components/Button.svelte'
			];

			const tree = buildFileTree(flatPaths);

			// Root should have 1 directory ('src') and 2 files ('package.json', 'README.md')
			expect(tree).toHaveLength(3);

			// Directories first
			expect(tree[0].name).toBe('src');
			expect(tree[0].type).toBe('directory');
			expect(tree[0].path).toBe('src');

			expect(tree[1].name).toBe('package.json');
			expect(tree[1].type).toBe('file');
			expect(tree[1].extension).toBe('json');

			expect(tree[2].name).toBe('README.md');
			expect(tree[2].type).toBe('file');
			expect(tree[2].extension).toBe('md');

			// Under 'src'
			const srcChildren = tree[0].children!;
			expect(srcChildren).toBeDefined();
			expect(srcChildren).toHaveLength(3);

			// Directories first under 'src' ('lib', 'routes') then 'app.css'
			expect(srcChildren[0].name).toBe('lib');
			expect(srcChildren[0].type).toBe('directory');
			expect(srcChildren[1].name).toBe('routes');
			expect(srcChildren[1].type).toBe('directory');
			expect(srcChildren[2].name).toBe('app.css');
			expect(srcChildren[2].type).toBe('file');

			// Under 'src/lib'
			const libChildren = srcChildren[0].children!;
			expect(libChildren).toHaveLength(2);
			expect(libChildren[0].name).toBe('components');
			expect(libChildren[0].type).toBe('directory');
			expect(libChildren[1].name).toBe('index.ts');
			expect(libChildren[1].type).toBe('file');

			// Under 'src/lib/components'
			const compChildren = libChildren[0].children!;
			expect(compChildren).toHaveLength(1);
			expect(compChildren[0].name).toBe('Button.svelte');
			expect(compChildren[0].type).toBe('file');
			expect(compChildren[0].path).toBe('src/lib/components/Button.svelte');
		});

		it('filters out ignored directory trees completely', () => {
			const flatPaths = [
				'.git/config',
				'.git/refs/heads/main',
				'node_modules/svelte/package.json',
				'dist/index.html',
				'src/main.ts',
				'.DS_Store'
			];

			const tree = buildFileTree(flatPaths);

			// Only 'src/main.ts' should remain
			expect(tree).toHaveLength(1);
			expect(tree[0].name).toBe('src');
			expect(tree[0].children).toHaveLength(1);
			expect(tree[0].children![0].name).toBe('main.ts');
		});

		it('enforces sorting invariants: directories appear before files at all levels', () => {
			const flatPaths = [
				'zebra.txt',
				'alpha.ts',
				'tools/build.ts',
				'src/index.ts',
				'beta.json',
				'docs/intro.md',
				'src/components/Header.svelte',
				'src/components/Footer.svelte'
			];

			const tree = buildFileTree(flatPaths);

			// Root level
			const rootTypes = tree.map((n) => n.type);
			expect(rootTypes).toEqual([
				'directory',
				'directory',
				'directory',
				'file',
				'file',
				'file'
			]);

			// Root directory names alphabetical
			const rootDirs = tree.filter((n) => n.type === 'directory').map((n) => n.name);
			expect(rootDirs).toEqual(['docs', 'src', 'tools']);

			// Root file names alphabetical
			const rootFiles = tree.filter((n) => n.type === 'file').map((n) => n.name);
			expect(rootFiles).toEqual(['alpha.ts', 'beta.json', 'zebra.txt']);

			// Inside 'src'
			const srcNode = tree.find((n) => n.name === 'src')!;
			expect(srcNode.children![0].name).toBe('components');
			expect(srcNode.children![0].type).toBe('directory');
			expect(srcNode.children![1].name).toBe('index.ts');
			expect(srcNode.children![1].type).toBe('file');
		});
	});

	describe('c) Expansion States & Toggle Mechanics', () => {
		it('marks nodes expanded if present in expandedPaths set', () => {
			const flatPaths = ['src/lib/Button.svelte', 'docs/guide.md'];
			const expanded = new Set(['src', 'src/lib']);

			const tree = buildFileTree(flatPaths, undefined, expanded);

			const srcNode = tree.find((n) => n.name === 'src')!;
			expect(srcNode.isExpanded).toBe(true);

			const libNode = srcNode.children!.find((n) => n.name === 'lib')!;
			expect(libNode.isExpanded).toBe(true);

			const docsNode = tree.find((n) => n.name === 'docs')!;
			expect(docsNode.isExpanded).toBe(false);
		});

		it('toggles expansion state immutably with toggleNodeExpansion', () => {
			const flatPaths = ['src/components/Button.svelte'];
			const tree = buildFileTree(flatPaths);

			const srcNode = tree.find((n) => n.name === 'src')!;
			expect(srcNode.isExpanded).toBe(false);

			const updated = toggleNodeExpansion(tree, 'src');
			const updatedSrc = updated.find((n) => n.name === 'src')!;
			expect(updatedSrc.isExpanded).toBe(true);

			const collapsedAgain = toggleNodeExpansion(updated, 'src');
			const collapsedSrc = collapsedAgain.find((n) => n.name === 'src')!;
			expect(collapsedSrc.isExpanded).toBe(false);
		});

		it('collects all directory paths and supports flattening', () => {
			const flatPaths = [
				'src/lib/components/Button.svelte',
				'src/utils/math.ts',
				'docs/index.md'
			];
			const tree = buildFileTree(flatPaths);

			const dirPaths = collectDirectoryPaths(tree);
			expect(dirPaths).toContain('docs');
			expect(dirPaths).toContain('src');
			expect(dirPaths).toContain('src/lib');
			expect(dirPaths).toContain('src/lib/components');
			expect(dirPaths).toContain('src/utils');

			const flattened = flattenTree(tree);
			expect(flattened.map((n) => n.name)).toContain('Button.svelte');
			expect(flattened.map((n) => n.name)).toContain('math.ts');
		});
	});

	describe('d) Node Lookup by Path', () => {
		it('finds existing file and directory nodes accurately', () => {
			const flatPaths = ['src/lib/Button.svelte', 'package.json'];
			const tree = buildFileTree(flatPaths);

			const file = findNodeByPath(tree, 'src/lib/Button.svelte');
			expect(file).not.toBeNull();
			expect(file?.name).toBe('Button.svelte');
			expect(file?.type).toBe('file');

			const dir = findNodeByPath(tree, 'src/lib');
			expect(dir).not.toBeNull();
			expect(dir?.name).toBe('lib');
			expect(dir?.type).toBe('directory');

			const rootFile = findNodeByPath(tree, 'package.json');
			expect(rootFile).not.toBeNull();
			expect(rootFile?.name).toBe('package.json');
		});

		it('returns null for non-existent paths', () => {
			const flatPaths = ['src/lib/Button.svelte'];
			const tree = buildFileTree(flatPaths);

			expect(findNodeByPath(tree, 'nonexistent/file.ts')).toBeNull();
			expect(findNodeByPath(tree, '')).toBeNull();
		});
	});

	describe('e) Edge Cases & Fault Tolerance', () => {
		it('handles empty inputs, duplicates, and mixed slashes gracefully', () => {
			expect(buildFileTree([])).toEqual([]);

			const mixed = [
				'src\\lib\\Button.svelte',
				'src/lib/Button.svelte', // Duplicate
				'./src/lib/Button.svelte', // Redundant prefix
				'src//lib///Button.svelte' // Multi-slash
			];

			const tree = buildFileTree(mixed);
			expect(tree).toHaveLength(1);
			expect(tree[0].name).toBe('src');
			expect(tree[0].children![0].children!).toHaveLength(1);
		});

		it('respects maxFiles and maxDepth configuration bounds', () => {
			const paths = [
				'a/b/c/d/e/deep.txt',
				'file1.txt',
				'file2.txt',
				'file3.txt'
			];

			// Depth limit of 2 (a/b allowed, c/d/e truncated)
			const depthLimited = buildFileTree(paths, { maxDepth: 2 });
			const deepNode = findNodeByPath(depthLimited, 'a/b/c/d/e/deep.txt');
			expect(deepNode).toBeNull();

			// File limit of 2
			const countLimited = buildFileTree(['1.txt', '2.txt', '3.txt', '4.txt'], { maxFiles: 2 });
			expect(countLimited).toHaveLength(2);
		});
	});

	describe('f) WorkbenchWorkspaceService Integration', () => {
		it('fetches workspace files via ToolsService.executeToolRaw', async () => {
			const mockRawResponse = {
				entries: [
					'src/index.ts',
					'src/app.svelte',
					'package.json'
				]
			};

			const executeToolRawSpy = vi
				.spyOn(ToolsService, 'executeToolRaw')
				.mockResolvedValue(mockRawResponse);

			const files = await WorkbenchWorkspaceService.fetchWorkspaceFiles('.');
			expect(executeToolRawSpy).toHaveBeenCalledWith(
				BuiltInTool.SERVER_FILE_GLOB_SEARCH,
				expect.objectContaining({ path: '.' }),
				undefined,
				'.'
			);
			expect(files).toEqual(['src/index.ts', 'src/app.svelte', 'package.json']);
		});

		it('fetches file content via ToolsService.executeTool', async () => {
			const executeSpy = vi.spyOn(ToolsService, 'executeTool').mockResolvedValue({
				content: 'export const hello = "world";',
				isError: false
			});

			const content = await WorkbenchWorkspaceService.fetchFileContent('src/index.ts');
			expect(executeSpy).toHaveBeenCalledWith(
				BuiltInTool.SERVER_READ_FILE,
				{ path: 'src/index.ts' },
				undefined,
				undefined
			);
			expect(content).toBe('export const hello = "world";');
		});

		it('throws an error if file read fails', async () => {
			vi.spyOn(ToolsService, 'executeTool').mockResolvedValue({
				content: 'File not found',
				isError: true
			});

			await expect(
				WorkbenchWorkspaceService.fetchFileContent('missing.txt')
			).rejects.toThrow('File not found');
		});
	});

	describe('g) WorkspaceStore State Machine', () => {
		it('manages root changes and clears active selection', async () => {
			workspaceStore.setTree(['src/index.ts']);
			workspaceStore.cacheFileContent('src/index.ts', 'file content');
			await workspaceStore.selectFile('src/index.ts');
			expect(workspaceStore.selectedPath).toBe('src/index.ts');

			workspaceStore.setRoot('new-root');
			expect(workspaceStore.rootPath).toBe('new-root');
			expect(workspaceStore.selectedPath).toBeNull();
			expect(workspaceStore.tree).toEqual([]);
		});

		it('caches file content in in-memory fileBuffers', async () => {
			const serviceSpy = vi
				.spyOn(WorkbenchWorkspaceService, 'fetchFileContent')
				.mockResolvedValue('// cached content');

			const content = await workspaceStore.selectFile('src/main.ts');
			expect(content).toBe('// cached content');
			expect(workspaceStore.getFileContent('src/main.ts')).toBe('// cached content');
			expect(serviceSpy).toHaveBeenCalledTimes(1);

			// Second select should hit cache without calling service again
			const cached = await workspaceStore.selectFile('src/main.ts');
			expect(cached).toBe('// cached content');
			expect(serviceSpy).toHaveBeenCalledTimes(1);
		});

		it('toggles folder expansion and expands/collapses all folders', () => {
			workspaceStore.setTree(['src/lib/a.ts', 'docs/readme.md']);

			expect(workspaceStore.expandedPaths.has('src')).toBe(false);

			workspaceStore.toggleFolder('src');
			expect(workspaceStore.expandedPaths.has('src')).toBe(true);

			workspaceStore.expandAll();
			expect(workspaceStore.expandedPaths.has('src')).toBe(true);
			expect(workspaceStore.expandedPaths.has('src/lib')).toBe(true);
			expect(workspaceStore.expandedPaths.has('docs')).toBe(true);

			workspaceStore.collapseAll();
			expect(workspaceStore.expandedPaths.size).toBe(0);
		});
	});
});
