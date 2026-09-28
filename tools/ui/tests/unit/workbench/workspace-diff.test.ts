/**
 * Unit tests for Workspace Diff Service and WorkspaceDiffViewer Component.
 *
 * Verifies:
 * 1. Line-by-line diff computation and kind assignment (SAME, ADD, REMOVE).
 * 2. Diff statistics calculation (additions, deletions, modifications, isClean).
 * 3. Unified canonical patch text generation.
 * 4. Side-by-side split row alignment and padding.
 * 5. Reactive WorkspaceStore diffPayload management.
 * 6. SSR DOM rendering of WorkspaceDiffViewer in Unified and Split modes.
 * 7. Integration with WorkspaceExplorer preview slot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { DiffLineKind } from '$lib/enums';
import { prefixFor, WorkbenchDiffService } from '$lib/workbench/diff/diff.service';
import type { FileDiffPayload } from '$lib/workbench/diff/types';
import { workspaceStore } from '$lib/workbench/workspace/workspace.svelte';
import WorkspaceDiffViewer from '$lib/workbench/components/WorkspaceDiffViewer.svelte';
import WorkspaceExplorer from '$lib/workbench/components/WorkspaceExplorer.svelte';

describe('Workspace Diff Subsystem', () => {
	beforeEach(() => {
		workspaceStore.reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		workspaceStore.reset();
	});

	describe('a) Diff Computation & Statistics', () => {
		it('computes empty diff for identical inputs', () => {
			const original = 'const a = 1;\nconst b = 2;';
			const modified = 'const a = 1;\nconst b = 2;';

			const diff = WorkbenchDiffService.computeDiff(original, modified);
			expect(diff).toHaveLength(2);
			expect(diff.every((l) => l.kind === DiffLineKind.CONTEXT)).toBe(true);

			const stats = WorkbenchDiffService.getDiffStats(diff);
			expect(stats.isClean).toBe(true);
			expect(stats.additions).toBe(0);
			expect(stats.deletions).toBe(0);
			expect(stats.modifications).toBe(0);
		});

		it('identifies additions and deletions correctly', () => {
			const original = 'first line\nsecond line';
			const modified = 'first line\ninserted line\nsecond line';

			const diff = WorkbenchDiffService.computeDiff(original, modified);
			const stats = WorkbenchDiffService.getDiffStats(diff);

			expect(stats.isClean).toBe(false);
			expect(stats.additions).toBe(1);
			expect(stats.deletions).toBe(0);

			const addLine = diff.find((l) => l.kind === DiffLineKind.ADD);
			expect(addLine?.text).toBe('inserted line');
		});

		it('computes modifications when lines are replaced', () => {
			const original = 'line 1\nold line\nline 3';
			const modified = 'line 1\nnew line\nline 3';

			const diff = WorkbenchDiffService.computeDiff(original, modified);
			const stats = WorkbenchDiffService.getDiffStats(diff);

			expect(stats.isClean).toBe(false);
			expect(stats.additions).toBe(1);
			expect(stats.deletions).toBe(1);
			expect(stats.modifications).toBe(1);
		});

		it('returns correct prefix characters for line kinds', () => {
			expect(prefixFor(DiffLineKind.ADD)).toBe('+');
			expect(prefixFor(DiffLineKind.REMOVE)).toBe('-');
			expect(prefixFor(DiffLineKind.CONTEXT)).toBe(' ');
		});
	});

	describe('b) Unified Diff Text Generation', () => {
		it('generates canonical unified diff patch string', () => {
			const original = 'function test() {\n  return false;\n}';
			const modified = 'function test() {\n  return true;\n}';

			const patch = WorkbenchDiffService.generateUnifiedDiffText(
				'src/auth.ts',
				original,
				modified
			);

			expect(patch).toContain('--- a/src/auth.ts');
			expect(patch).toContain('+++ b/src/auth.ts');
			expect(patch).toContain('-  return false;');
			expect(patch).toContain('+  return true;');
			expect(patch).toContain(' function test() {');
		});
	});

	describe('c) Side-by-Side Split Row Pairing', () => {
		it('pairs unchanged lines symmetrically with correct line numbers', () => {
			const original = 'alpha\nbeta';
			const modified = 'alpha\nbeta';

			const diff = WorkbenchDiffService.computeDiff(original, modified);
			const splitRows = WorkbenchDiffService.computeSplitRows(diff);

			expect(splitRows).toHaveLength(2);
			expect(splitRows[0].left).toEqual({ kind: 'context', lineNum: 1, text: 'alpha' });
			expect(splitRows[0].right).toEqual({ kind: 'context', lineNum: 1, text: 'alpha' });
			expect(splitRows[1].left).toEqual({ kind: 'context', lineNum: 2, text: 'beta' });
			expect(splitRows[1].right).toEqual({ kind: 'context', lineNum: 2, text: 'beta' });
		});

		it('pairs deletions on the left with empty padding on the right', () => {
			const original = 'alpha\nbeta\ngamma';
			const modified = 'alpha\ngamma';

			const diff = WorkbenchDiffService.computeDiff(original, modified);
			const splitRows = WorkbenchDiffService.computeSplitRows(diff);

			// Should have: context (alpha), remove (beta) paired with empty, context (gamma)
			expect(splitRows).toHaveLength(3);
			expect(splitRows[1].left.kind).toBe('remove');
			expect(splitRows[1].left.text).toBe('beta');
			expect(splitRows[1].right.kind).toBe('empty');
			expect(splitRows[1].right.text).toBe('');
		});

		it('pairs additions on the right with empty padding on the left', () => {
			const original = 'alpha\ngamma';
			const modified = 'alpha\nbeta\ngamma';

			const diff = WorkbenchDiffService.computeDiff(original, modified);
			const splitRows = WorkbenchDiffService.computeSplitRows(diff);

			expect(splitRows).toHaveLength(3);
			expect(splitRows[1].left.kind).toBe('empty');
			expect(splitRows[1].right.kind).toBe('add');
			expect(splitRows[1].right.text).toBe('beta');
		});

		it('pairs replaced chunks side-by-side with padding if counts differ', () => {
			const original = 'line 1\nold 1\nold 2\nline 4';
			const modified = 'line 1\nnew 1\nline 4';

			const diff = WorkbenchDiffService.computeDiff(original, modified);
			const splitRows = WorkbenchDiffService.computeSplitRows(diff);

			// line 1 (context)
			// old 1 (remove) vs new 1 (add)
			// old 2 (remove) vs empty
			// line 4 (context)
			expect(splitRows).toHaveLength(4);
			expect(splitRows[1].left.text).toBe('old 1');
			expect(splitRows[1].right.text).toBe('new 1');
			expect(splitRows[2].left.text).toBe('old 2');
			expect(splitRows[2].right.kind).toBe('empty');
		});
	});

	describe('d) WorkspaceStore Diff State Management', () => {
		it('manages diffPayload via setDiff and clearDiff', () => {
			expect(workspaceStore.diffPayload).toBeNull();

			const payload: FileDiffPayload = {
				filePath: 'src/app.ts',
				originalContent: 'const x = 1;',
				modifiedContent: 'const x = 2;',
				viewMode: 'split'
			};

			workspaceStore.setDiff(payload);
			expect(workspaceStore.diffPayload).toEqual(payload);
			expect(workspaceStore.diffPayload?.filePath).toBe('src/app.ts');

			workspaceStore.clearDiff();
			expect(workspaceStore.diffPayload).toBeNull();
		});

		it('clears diffPayload on store reset', () => {
			workspaceStore.setDiff({
				filePath: 'test.ts',
				originalContent: 'a',
				modifiedContent: 'b'
			});
			expect(workspaceStore.diffPayload).not.toBeNull();

			workspaceStore.reset();
			expect(workspaceStore.diffPayload).toBeNull();
		});
	});

	describe('e) WorkspaceDiffViewer SSR DOM Rendering', () => {
		it('renders clean placeholder when files are identical', () => {
			const { body } = render(WorkspaceDiffViewer, {
				props: {
					filePath: 'src/equal.ts',
					originalContent: 'const same = true;',
					modifiedContent: 'const same = true;'
				}
			});

			expect(body).toContain('src/equal.ts');
			expect(body).toContain('Clean');
			expect(body).toContain('Files are identical');
			expect(body).toContain('No line differences detected');
		});

		it('renders unified diff view with line numbers and markers', () => {
			const { body } = render(WorkspaceDiffViewer, {
				props: {
					filePath: 'src/config.ts',
					initialMode: 'unified',
					originalContent: 'port = 3000;\nhost = "localhost";',
					modifiedContent: 'port = 8080;\nhost = "localhost";'
				}
			});

			expect(body).toContain('src/config.ts');
			expect(body).toContain('+1');
			expect(body).toContain('-1');
			expect(body).toContain('diff-remove');
			expect(body).toContain('port = 3000;');
			expect(body).toContain('diff-add');
			expect(body).toContain('port = 8080;');
			expect(body).toContain('Unified');
			expect(body).toContain('Split');
		});

		it('renders side-by-side split diff view with column headers', () => {
			const { body } = render(WorkspaceDiffViewer, {
				props: {
					filePath: 'src/config.ts',
					initialMode: 'split',
					originalContent: 'line A;\nline B;',
					modifiedContent: 'line A;\nline C;'
				}
			});

			expect(body).toContain('split-diff-container');
			expect(body).toContain('Original');
			expect(body).toContain('Modified');
			expect(body).toContain('split-left');
			expect(body).toContain('split-right');
			expect(body).toContain('line B;');
			expect(body).toContain('line C;');
		});

		it('renders close button when onClose prop is provided', () => {
			const onCloseMock = vi.fn();
			const { body } = render(WorkspaceDiffViewer, {
				props: {
					filePath: 'src/test.ts',
					originalContent: 'a',
					modifiedContent: 'b',
					onClose: onCloseMock
				}
			});

			expect(body).toContain('aria-label="Close diff"');
		});
	});

	describe('f) WorkspaceExplorer Diff Viewer Integration', () => {
		it('renders WorkspaceDiffViewer in preview pane when diffPayload is active', () => {
			workspaceStore.setRoot('my-project');
			workspaceStore.setTree(['src/main.ts']);

			workspaceStore.setDiff({
				filePath: 'src/main.ts',
				originalContent: 'console.log("old");',
				modifiedContent: 'console.log("new");',
				viewMode: 'unified'
			});

			const { body } = render(WorkspaceExplorer);

			expect(body).toContain('data-testid="workspace-diff-viewer"');
			expect(body).toContain('src/main.ts');
			expect(body).toContain('console.log("old");');
			expect(body).toContain('console.log("new");');
			expect(body).toContain('Diff (main.ts)');
		});

		it('reverts to WorkspaceFileViewer when diffPayload is cleared', () => {
			workspaceStore.setRoot('my-project');
			workspaceStore.setTree(['src/main.ts']);
			workspaceStore.clearDiff();

			const { body } = render(WorkspaceExplorer);

			expect(body).not.toContain('data-testid="workspace-diff-viewer"');
			expect(body).toContain('data-testid="workspace-file-viewer"');
			expect(body).toContain('No file selected');
		});
	});
});
