/**
 * Unit tests for Workbench Workspace Journal & Pre-Mutation Snapshots
 *
 * Verifies:
 * 1. Pre-mutation snapshot captures existing file content ('modify').
 * 2. Pre-mutation snapshot flags new files with originalContent: null ('create').
 * 3. Rollback of single snapshot restores original content via write_file.
 * 4. Rollback of newly created file cleans content and purges file buffer.
 * 5. Rollback of task (rollbackTask) executes in reverse chronological order.
 * 6. Ring buffer capacity limits snapshots to configured max size.
 * 7. Reactive workspaceJournalStore tracks snapshots, canRollback, and unRevertedCount.
 * 8. Task controller integrates pre-mutation capture before mutating tools (write_file).
 * 9. Task controller bypasses pre-mutation capture for non-mutating tools (read_file).
 * 10. Task controller executes auto-rollback when autoRollbackOnFailure is enabled.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	WorkbenchWorkspaceJournalService,
	workspaceJournalStore,
	type FileSnapshot
} from '$lib/workbench/workspace';
import { workspaceStore } from '$lib/workbench/workspace/workspace.svelte';
import { WorkbenchTaskController } from '$lib/workbench/task/task-controller.service';
import { WorkbenchTaskGraphService } from '$lib/workbench/task/task-graph.service';
import { taskGraphStore } from '$lib/workbench/task/task-graph.svelte';
import type { TaskNode } from '$lib/workbench/task/types';

describe('Workbench Workspace Journal Subsystem', () => {
	beforeEach(() => {
		WorkbenchWorkspaceJournalService.clearJournal();
		WorkbenchWorkspaceJournalService.setToolExecutor(async () => ({ isError: false, content: '' }));
		workspaceStore.reset();
		taskGraphStore.reset();
		WorkbenchTaskGraphService.setStorageDisabledForTest(true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		WorkbenchWorkspaceJournalService.clearJournal();
		WorkbenchWorkspaceJournalService.setToolExecutor(null);
		workspaceStore.reset();
		taskGraphStore.reset();
	});

	describe('a) Pre-Mutation Snapshot Capture', () => {
		it('captures existing file content and marks mutationType as modify', async () => {
			const mockFs = new Map<string, string>([['src/app.ts', 'const x = 10;']]);

			WorkbenchWorkspaceJournalService.setToolExecutor(async (toolName, args) => {
				if (toolName === 'read_file') {
					const path = args.path as string;
					if (mockFs.has(path)) {
						return { content: mockFs.get(path)!, isError: false };
					}
					throw new Error('File not found');
				}
				return {};
			});

			const snapshot = await WorkbenchWorkspaceJournalService.capturePreMutation('src/app.ts', {
				conversationId: 'conv-1',
				taskNodeId: 'node-1'
			});

			expect(snapshot.filePath).toBe('src/app.ts');
			expect(snapshot.originalContent).toBe('const x = 10;');
			expect(snapshot.mutationType).toBe('modify');
			expect(snapshot.reverted).toBe(false);
			expect(snapshot.taskNodeId).toBe('node-1');
			expect(snapshot.conversationId).toBe('conv-1');

			const stored = WorkbenchWorkspaceJournalService.getSnapshot(snapshot.id);
			expect(stored).toBeDefined();
			expect(stored?.id).toBe(snapshot.id);
		});

		it('captures from workspaceStore fileBuffers if already cached in memory', async () => {
			workspaceStore.cacheFileContent('config.json', '{"debug": true}');

			const snapshot = await WorkbenchWorkspaceJournalService.capturePreMutation('config.json');

			expect(snapshot.filePath).toBe('config.json');
			expect(snapshot.originalContent).toBe('{"debug": true}');
			expect(snapshot.mutationType).toBe('modify');
		});

		it('flags new files with originalContent: null and mutationType: create when file does not exist', async () => {
			WorkbenchWorkspaceJournalService.setToolExecutor(async () => {
				throw new Error('ENOENT: no such file or directory');
			});

			const snapshot = await WorkbenchWorkspaceJournalService.capturePreMutation(
				'brand-new-file.txt',
				{ taskNodeId: 'node-create' }
			);

			expect(snapshot.filePath).toBe('brand-new-file.txt');
			expect(snapshot.originalContent).toBeNull();
			expect(snapshot.mutationType).toBe('create');
			expect(snapshot.reverted).toBe(false);
			expect(snapshot.taskNodeId).toBe('node-create');
		});

		it('respects ring buffer size and discards oldest snapshots when limit is reached', async () => {
			WorkbenchWorkspaceJournalService.setConfig({ maxSnapshots: 3 });

			await WorkbenchWorkspaceJournalService.capturePreMutation('file1.txt');
			await WorkbenchWorkspaceJournalService.capturePreMutation('file2.txt');
			await WorkbenchWorkspaceJournalService.capturePreMutation('file3.txt');
			expect(WorkbenchWorkspaceJournalService.getSnapshots().length).toBe(3);

			await WorkbenchWorkspaceJournalService.capturePreMutation('file4.txt');
			const snapshots = WorkbenchWorkspaceJournalService.getSnapshots();
			expect(snapshots.length).toBe(3);
			expect(snapshots.map((s) => s.filePath)).toEqual(['file2.txt', 'file3.txt', 'file4.txt']);

			// Restore default config
			WorkbenchWorkspaceJournalService.setConfig({ maxSnapshots: 100 });
		});
	});

	describe('b) Snapshot Rollback Execution', () => {
		it('restores original content via write_file and updates workspaceStore', async () => {
			let writtenPath = '';
			let writtenContent = '';

			WorkbenchWorkspaceJournalService.setToolExecutor(async (toolName, args) => {
				if (toolName === 'write_file') {
					writtenPath = args.path as string;
					writtenContent = args.content as string;
					return { content: 'File written successfully', isError: false };
				}
				return {};
			});

			// Setup existing file snapshot
			workspaceStore.cacheFileContent('docs/readme.md', 'Updated content');
			const snapshot = await WorkbenchWorkspaceJournalService.capturePreMutation('docs/readme.md');
			// Simulate mutation happened
			workspaceStore.cacheFileContent('docs/readme.md', 'Mutated content!');

			const rollbackResult = await WorkbenchWorkspaceJournalService.rollbackSnapshot(snapshot.id);

			expect(rollbackResult.success).toBe(true);
			expect(rollbackResult.filePath).toBe('docs/readme.md');
			expect(writtenPath).toBe('docs/readme.md');
			expect(writtenContent).toBe('Updated content');

			const updatedSnapshot = WorkbenchWorkspaceJournalService.getSnapshot(snapshot.id);
			expect(updatedSnapshot?.reverted).toBe(true);

			// Buffer cache refreshed with original content
			expect(workspaceStore.getFileContent('docs/readme.md')).toBe('Updated content');
		});

		it('cleans content and removes buffer when rolling back a created file', async () => {
			let writtenContent = 'not-called';

			WorkbenchWorkspaceJournalService.setToolExecutor(async (toolName, args) => {
				if (toolName === 'write_file') {
					writtenContent = args.content as string;
					return { isError: false };
				}
				throw new Error('Not found');
			});

			// File did not exist originally
			const snapshot = await WorkbenchWorkspaceJournalService.capturePreMutation('new-script.py');
			expect(snapshot.mutationType).toBe('create');

			// Put something into the buffer as if tool created it
			workspaceStore.cacheFileContent('new-script.py', 'print("hello")');

			const result = await WorkbenchWorkspaceJournalService.rollbackSnapshot(snapshot.id);

			expect(result.success).toBe(true);
			expect(writtenContent).toBe('');
			expect(workspaceStore.getFileContent('new-script.py')).toBeUndefined();
		});

		it('returns error when attempting to rollback a non-existent snapshot ID', async () => {
			const result = await WorkbenchWorkspaceJournalService.rollbackSnapshot('non-existent-id');
			expect(result.success).toBe(false);
			expect(result.error).toContain('not found');
		});

		it('is idempotent when snapshot is already reverted', async () => {
			let writeCalls = 0;
			WorkbenchWorkspaceJournalService.setToolExecutor(async (toolName) => {
				if (toolName === 'write_file') writeCalls++;
				return { isError: false };
			});

			const snapshot = await WorkbenchWorkspaceJournalService.capturePreMutation('test.ts');
			await WorkbenchWorkspaceJournalService.rollbackSnapshot(snapshot.id);
			expect(writeCalls).toBe(1);

			// Second rollback should be a no-op
			const secondResult = await WorkbenchWorkspaceJournalService.rollbackSnapshot(snapshot.id);
			expect(secondResult.success).toBe(true);
			expect(writeCalls).toBe(1);
		});
	});

	describe('c) Task-Level Rollback (rollbackTask)', () => {
		it('rolls back multiple snapshots for a task in reverse chronological order', async () => {
			const rollbackOrder: string[] = [];

			WorkbenchWorkspaceJournalService.setToolExecutor(async (toolName, args) => {
				if (toolName === 'write_file') {
					rollbackOrder.push(args.path as string);
				}
				return { isError: false };
			});

			// Create 3 mutations for task-A with increasing timestamps
			const s1 = await WorkbenchWorkspaceJournalService.capturePreMutation('fileA.txt', {
				taskNodeId: 'task-A'
			});
			s1.timestamp = 1000;

			const s2 = await WorkbenchWorkspaceJournalService.capturePreMutation('fileB.txt', {
				taskNodeId: 'task-A'
			});
			s2.timestamp = 2000;

			const s3 = await WorkbenchWorkspaceJournalService.capturePreMutation('fileC.txt', {
				taskNodeId: 'task-A'
			});
			s3.timestamp = 3000;

			// Another task's snapshot should NOT be rolled back
			await WorkbenchWorkspaceJournalService.capturePreMutation('fileOther.txt', {
				taskNodeId: 'task-OTHER'
			});

			const results = await WorkbenchWorkspaceJournalService.rollbackTask('task-A');

			expect(results.length).toBe(3);
			expect(results.every((r) => r.success)).toBe(true);
			// Reverse order: fileC, fileB, fileA
			expect(rollbackOrder).toEqual(['fileC.txt', 'fileB.txt', 'fileA.txt']);

			// fileOther should remain un-reverted
			const other = WorkbenchWorkspaceJournalService.getSnapshotsForFile('fileOther.txt');
			expect(other[0].reverted).toBe(false);
		});
	});

	describe('d) Reactive Svelte 5 Store (workspaceJournalStore)', () => {
		it('maintains reactive snapshots and derived properties', async () => {
			expect(workspaceJournalStore.snapshots.length).toBe(0);
			expect(workspaceJournalStore.canRollback).toBe(false);
			expect(workspaceJournalStore.unRevertedCount).toBe(0);

			await WorkbenchWorkspaceJournalService.capturePreMutation('index.html');

			expect(workspaceJournalStore.snapshots.length).toBe(1);
			expect(workspaceJournalStore.canRollback).toBe(true);
			expect(workspaceJournalStore.unRevertedCount).toBe(1);

			const snap = workspaceJournalStore.snapshots[0];
			workspaceJournalStore.selectSnapshot(snap);
			expect(workspaceJournalStore.activeSnapshot?.id).toBe(snap.id);

			await workspaceJournalStore.rollback(snap.id);
			expect(workspaceJournalStore.canRollback).toBe(false);
			expect(workspaceJournalStore.unRevertedCount).toBe(0);
			expect(workspaceJournalStore.activeSnapshot?.reverted).toBe(true);

			workspaceJournalStore.clear();
			expect(workspaceJournalStore.snapshots.length).toBe(0);
			expect(workspaceJournalStore.activeSnapshot).toBeNull();
		});
	});

	describe('e) Task Controller Integration & Auto-Rollback', () => {
		it('captures pre-mutation snapshot prior to executing write_file in a task node', async () => {
			const mockFs = new Map<string, string>([['src/service.ts', 'export class OldService {}']]);

			WorkbenchWorkspaceJournalService.setToolExecutor(async (toolName, args) => {
				if (toolName === 'read_file') {
					return { content: mockFs.get(args.path as string) || '', isError: false };
				}
				if (toolName === 'write_file') {
					mockFs.set(args.path as string, args.content as string);
					return { isError: false };
				}
				return {};
			});

			const nodes: TaskNode[] = [
				{
					dependencies: [],
					id: 'task-node-write',
					status: 'pending',
					title: 'Update Service',
					toolCall: {
						name: 'write_file',
						args: { path: 'src/service.ts', content: 'export class NewService {}' }
					}
				}
			];

			const graph = WorkbenchTaskGraphService.createGraph('conv-journal', 'Journal Test', nodes);

			const result = await WorkbenchTaskController.executeGraph(
				graph,
				{ maxTurns: 5 },
				undefined,
				async (toolName, args) => {
					return { success: true };
				}
			);

			expect(result.status).toBe('completed');

			const snapshots = WorkbenchWorkspaceJournalService.getSnapshotsForFile('src/service.ts');
			expect(snapshots.length).toBe(1);
			expect(snapshots[0].originalContent).toBe('export class OldService {}');
			expect(snapshots[0].taskNodeId).toBe('task-node-write');
			expect(snapshots[0].reverted).toBe(false);
		});

		it('bypasses pre-mutation snapshot for read operations', async () => {
			const nodes: TaskNode[] = [
				{
					dependencies: [],
					id: 'task-node-read',
					status: 'pending',
					title: 'Inspect Service',
					toolCall: {
						name: 'read_file',
						args: { path: 'src/service.ts' }
					}
				}
			];

			const graph = WorkbenchTaskGraphService.createGraph('conv-read', 'Read Test', nodes);

			await WorkbenchTaskController.executeGraph(
				graph,
				{ maxTurns: 5 },
				undefined,
				async () => ({ content: 'some data' })
			);

			expect(WorkbenchWorkspaceJournalService.getSnapshots().length).toBe(0);
		});

		it('triggers automatic rollback when autoRollbackOnFailure is enabled and node fails', async () => {
			let rollbackInvoked = false;

			WorkbenchWorkspaceJournalService.setToolExecutor(async (toolName, args) => {
				if (toolName === 'read_file') {
					return { content: 'original-version-data', isError: false };
				}
				if (toolName === 'write_file') {
					rollbackInvoked = true;
					return { isError: false };
				}
				return {};
			});

			const nodes: TaskNode[] = [
				{
					dependencies: [],
					id: 'task-fail-node',
					status: 'pending',
					title: 'Failing Mutation Step',
					toolCall: {
						name: 'write_file',
						args: { path: 'src/target.ts', content: 'new content' }
					}
				}
			];

			const graph = WorkbenchTaskGraphService.createGraph('conv-fail', 'Failure Test', nodes);

			const result = await WorkbenchTaskController.executeGraph(
				graph,
				{
					maxTurns: 5,
					autoRollbackOnFailure: true,
					maxConsecutiveFailures: 1
				},
				undefined,
				async () => {
					// Simulate failure during tool execution
					throw new Error('Simulated tool write error');
				}
			);

			expect(result.status).toBe('failed');
			expect(rollbackInvoked).toBe(true);

			const snapshots = WorkbenchWorkspaceJournalService.getSnapshotsForFile('src/target.ts');
			expect(snapshots.length).toBe(1);
			expect(snapshots[0].reverted).toBe(true);
		});
	});
});
