/**
 * Unit tests for Workspace Explorer UI components and layout integration.
 *
 * Verifies:
 * 1. SSR / DOM rendering of WorkspaceExplorer container.
 * 2. Recursive rendering of directories and files in WorkspaceTreeNode.
 * 3. File inspection header and syntax container in WorkspaceFileViewer.
 * 4. Interactive expansion toggles and file buffer caching via WorkspaceStore.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { WorkspaceFileNode } from '$lib/workbench/workspace/types';
import { workspaceStore } from '$lib/workbench/workspace/workspace.svelte';
import WorkspaceTreeNode from '$lib/workbench/components/WorkspaceTreeNode.svelte';
import WorkspaceFileViewer from '$lib/workbench/components/WorkspaceFileViewer.svelte';
import WorkspaceExplorer from '$lib/workbench/components/WorkspaceExplorer.svelte';

describe('Workspace UI Subsystem', () => {
	beforeEach(() => {
		workspaceStore.reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		workspaceStore.reset();
	});

	describe('a) WorkspaceTreeNode Component', () => {
		it('renders a file node with file name and data attributes', () => {
			const fileNode: WorkspaceFileNode = {
				extension: 'ts',
				id: 'src/main.ts',
				name: 'main.ts',
				path: 'src/main.ts',
				type: 'file'
			};

			const { body } = render(WorkspaceTreeNode, { props: { node: fileNode, level: 0 } });

			expect(body).toContain('main.ts');
			expect(body).toContain('data-path="src/main.ts"');
			expect(body).toContain('data-type="file"');
		});

		it('renders a collapsed directory without children rendered', () => {
			const dirNode: WorkspaceFileNode = {
				children: [
					{
						extension: 'svelte',
						id: 'src/App.svelte',
						name: 'App.svelte',
						path: 'src/App.svelte',
						type: 'file'
					}
				],
				id: 'src',
				isExpanded: false,
				name: 'src',
				path: 'src',
				type: 'directory'
			};

			const { body } = render(WorkspaceTreeNode, { props: { node: dirNode, level: 0 } });

			expect(body).toContain('src');
			expect(body).toContain('data-path="src"');
			expect(body).toContain('data-type="directory"');
			// Since isExpanded is false, child App.svelte should not be in the rendered HTML
			expect(body).not.toContain('App.svelte');
		});

		it('recursively renders children when a directory is expanded', () => {
			const dirNode: WorkspaceFileNode = {
				children: [
					{
						extension: 'svelte',
						id: 'src/App.svelte',
						name: 'App.svelte',
						path: 'src/App.svelte',
						type: 'file'
					},
					{
						children: [
							{
								extension: 'ts',
								id: 'src/lib/utils.ts',
								name: 'utils.ts',
								path: 'src/lib/utils.ts',
								type: 'file'
							}
						],
						id: 'src/lib',
						isExpanded: true,
						name: 'lib',
						path: 'src/lib',
						type: 'directory'
					}
				],
				id: 'src',
				isExpanded: true,
				name: 'src',
				path: 'src',
				type: 'directory'
			};

			const { body } = render(WorkspaceTreeNode, { props: { node: dirNode, level: 0 } });

			expect(body).toContain('src');
			expect(body).toContain('App.svelte');
			expect(body).toContain('lib');
			expect(body).toContain('utils.ts');
		});

		it('renders an empty folder notice when an expanded directory has no children', () => {
			const emptyDir: WorkspaceFileNode = {
				children: [],
				id: 'empty-dir',
				isExpanded: true,
				name: 'empty-dir',
				path: 'empty-dir',
				type: 'directory'
			};

			const { body } = render(WorkspaceTreeNode, { props: { node: emptyDir, level: 0 } });

			expect(body).toContain('empty-dir');
			expect(body).toContain('(empty folder)');
		});
	});

	describe('b) WorkspaceFileViewer Component', () => {
		it('renders empty placeholder when no file is selected', () => {
			const { body } = render(WorkspaceFileViewer);

			expect(body).toContain('No file selected');
			expect(body).toContain('Select a file from the workspace tree to inspect');
		});

		it('renders file header, language badge, and code content when a file is selected', () => {
			workspaceStore.cacheFileContent('src/index.ts', 'const answer = 42;\nconsole.log(answer);');
			void workspaceStore.selectFile('src/index.ts');

			const { body } = render(WorkspaceFileViewer);

			expect(body).toContain('src/index.ts');
			expect(body).toContain('typescript');
			expect(body).toContain('2 lines');
			expect(body).toContain('answer');
		});
	});

	describe('c) WorkspaceExplorer Container Component', () => {
		it('renders workspace title, root path, and actions', () => {
			workspaceStore.setRoot('my-project');
			workspaceStore.setTree(['package.json', 'src/index.ts']);

			const { body } = render(WorkspaceExplorer);

			expect(body).toContain('Workspace');
			expect(body).toContain('my-project');
			expect(body).toContain('Filter files...');
			expect(body).toContain('package.json');
			expect(body).toContain('src');
		});

		it('renders empty message when no files exist in tree', () => {
			workspaceStore.setTree([]);

			const { body } = render(WorkspaceExplorer);

			expect(body).toContain('No workspace files detected');
		});
	});

	describe('d) Store Actions & Drawer Integration', () => {
		it('toggles drawer visibility with openExplorer, closeExplorer, and toggleExplorer', () => {
			workspaceStore.setTree(['src/index.ts']);
			expect(workspaceStore.isExplorerOpen).toBe(false);

			workspaceStore.openExplorer();
			expect(workspaceStore.isExplorerOpen).toBe(true);

			workspaceStore.closeExplorer();
			expect(workspaceStore.isExplorerOpen).toBe(false);

			workspaceStore.toggleExplorer();
			expect(workspaceStore.isExplorerOpen).toBe(true);

			workspaceStore.toggleExplorer();
			expect(workspaceStore.isExplorerOpen).toBe(false);
		});

		it('tracks selection state and triggers viewer update', async () => {
			workspaceStore.setTree(['src/test.ts']);
			workspaceStore.cacheFileContent('src/test.ts', 'export const x = 1;');

			await workspaceStore.selectFile('src/test.ts');
			expect(workspaceStore.selectedPath).toBe('src/test.ts');

			const { body } = render(WorkspaceFileViewer);
			expect(body).toContain('src/test.ts');
			expect(body).toContain('export');
			expect(body).toContain('hljs-keyword');
		});
	});
});
