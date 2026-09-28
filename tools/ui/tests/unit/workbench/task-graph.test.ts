import { beforeEach, describe, expect, it } from 'vitest';
import {
	buildAdjacencyList,
	cascadeFailure,
	computeTaskProgress,
	detectCycles,
	getRunnableNodes,
	isGraphComplete,
	isGraphFailed,
	topologicalSort
} from '$lib/workbench/task/dag';
import { WorkbenchTaskGraphService } from '$lib/workbench/task/task-graph.service';
import { TaskGraphStore } from '$lib/workbench/task/task-graph.svelte';
import type { TaskGraph, TaskNode } from '$lib/workbench/task/types';

describe('Workbench Task Graph Subsystem', () => {
	beforeEach(() => {
		WorkbenchTaskGraphService.setStorageDisabledForTest(true);
	});

	describe('1. DAG Engine (dag.ts)', () => {
		it('builds forward adjacency list correctly', () => {
			const nodes: Record<string, TaskNode> = {
				a: { dependencies: [], id: 'a', status: 'pending', title: 'Task A' },
				b: { dependencies: ['a'], id: 'b', status: 'pending', title: 'Task B' },
				c: { dependencies: ['a'], id: 'c', status: 'pending', title: 'Task C' },
				d: { dependencies: ['b', 'c'], id: 'd', status: 'pending', title: 'Task D' }
			};

			const adj = buildAdjacencyList(nodes);
			expect(adj.get('a')?.sort()).toEqual(['b', 'c']);
			expect(adj.get('b')).toEqual(['d']);
			expect(adj.get('c')).toEqual(['d']);
			expect(adj.get('d')).toEqual([]);
		});

		it('topologically sorts a linear dependency chain (A -> B -> C)', () => {
			const nodes: Record<string, TaskNode> = {
				c: { dependencies: ['b'], id: 'c', status: 'pending', title: 'C' },
				a: { dependencies: [], id: 'a', status: 'pending', title: 'A' },
				b: { dependencies: ['a'], id: 'b', status: 'pending', title: 'B' }
			};

			expect(detectCycles(nodes)).toBe(false);
			const order = topologicalSort(nodes);
			expect(order).toEqual(['a', 'b', 'c']);
		});

		it('topologically sorts a diamond dependency graph (A -> B, C -> D)', () => {
			const nodes: Record<string, TaskNode> = {
				d: { dependencies: ['b', 'c'], id: 'd', status: 'pending', title: 'D' },
				b: { dependencies: ['a'], id: 'b', status: 'pending', title: 'B' },
				c: { dependencies: ['a'], id: 'c', status: 'pending', title: 'C' },
				a: { dependencies: [], id: 'a', status: 'pending', title: 'A' }
			};

			expect(detectCycles(nodes)).toBe(false);
			const order = topologicalSort(nodes);
			expect(order[0]).toBe('a');
			expect(order.indexOf('b')).toBeGreaterThan(order.indexOf('a'));
			expect(order.indexOf('c')).toBeGreaterThan(order.indexOf('a'));
			expect(order.indexOf('d')).toBeGreaterThan(order.indexOf('b'));
			expect(order.indexOf('d')).toBeGreaterThan(order.indexOf('c'));
			expect(order[3]).toBe('d');
		});

		it('detects simple cycles and rejects topological sorting', () => {
			// A -> B -> A
			const twoNodeCycle: Record<string, TaskNode> = {
				a: { dependencies: ['b'], id: 'a', status: 'pending', title: 'A' },
				b: { dependencies: ['a'], id: 'b', status: 'pending', title: 'B' }
			};

			expect(detectCycles(twoNodeCycle)).toBe(true);
			expect(() => topologicalSort(twoNodeCycle)).toThrow(/Cycle detected/);
		});

		it('detects 3-node circular dependencies (A -> B -> C -> A)', () => {
			const threeNodeCycle: Record<string, TaskNode> = {
				a: { dependencies: ['c'], id: 'a', status: 'pending', title: 'A' },
				b: { dependencies: ['a'], id: 'b', status: 'pending', title: 'B' },
				c: { dependencies: ['b'], id: 'c', status: 'pending', title: 'C' }
			};

			expect(detectCycles(threeNodeCycle)).toBe(true);
			expect(() => topologicalSort(threeNodeCycle)).toThrow(/Cycle detected/);
		});

		it('detects self-referential cycles (A -> A)', () => {
			const selfCycle: Record<string, TaskNode> = {
				a: { dependencies: ['a'], id: 'a', status: 'pending', title: 'Self' }
			};

			expect(detectCycles(selfCycle)).toBe(true);
			expect(() => topologicalSort(selfCycle)).toThrow(/Cycle detected/);
		});

		it('correctly identifies runnable nodes based on fulfilled dependencies', () => {
			const nodes: Record<string, TaskNode> = {
				a: { dependencies: [], id: 'a', status: 'completed', title: 'Task A' },
				b: { dependencies: ['a'], id: 'b', status: 'pending', title: 'Task B' },
				c: { dependencies: ['a'], id: 'c', status: 'in_progress', title: 'Task C' },
				d: { dependencies: ['b', 'c'], id: 'd', status: 'pending', title: 'Task D' },
				e: { dependencies: [], id: 'e', status: 'pending', title: 'Task E' }
			};

			const runnable = getRunnableNodes(nodes);
			const runnableIds = runnable.map((n) => n.id).sort();

			// 'b' is pending and parent 'a' is completed -> runnable
			// 'c' is in_progress -> not runnable (already running)
			// 'd' depends on 'b' and 'c' which are not completed -> not runnable
			// 'e' is pending with no dependencies -> runnable
			expect(runnableIds).toEqual(['b', 'e']);
		});

		it('evaluates graph completion and failure conditions', () => {
			const incomplete: Record<string, TaskNode> = {
				a: { dependencies: [], id: 'a', status: 'completed', title: 'A' },
				b: { dependencies: ['a'], id: 'b', status: 'in_progress', title: 'B' }
			};
			expect(isGraphComplete(incomplete)).toBe(false);
			expect(isGraphFailed(incomplete)).toBe(false);

			const failed: Record<string, TaskNode> = {
				a: { dependencies: [], id: 'a', status: 'completed', title: 'A' },
				b: { dependencies: ['a'], id: 'b', status: 'failed', title: 'B' }
			};
			expect(isGraphComplete(failed)).toBe(false);
			expect(isGraphFailed(failed)).toBe(true);

			const allDone: Record<string, TaskNode> = {
				a: { dependencies: [], id: 'a', status: 'completed', title: 'A' },
				b: { dependencies: ['a'], id: 'b', status: 'completed', title: 'B' },
				c: { dependencies: ['b'], id: 'c', status: 'skipped', title: 'C' }
			};
			expect(isGraphComplete(allDone)).toBe(true);
			expect(isGraphFailed(allDone)).toBe(false);
		});

		it('cascades failure to all downstream dependents without altering upstream tasks', () => {
			// A -> B -> C -> D
			// Independent: E
			const nodes: Record<string, TaskNode> = {
				a: { dependencies: [], id: 'a', status: 'completed', title: 'A' },
				b: { dependencies: ['a'], id: 'b', status: 'failed', title: 'B' },
				c: { dependencies: ['b'], id: 'c', status: 'pending', title: 'C' },
				d: { dependencies: ['c'], id: 'd', status: 'pending', title: 'D' },
				e: { dependencies: [], id: 'e', status: 'pending', title: 'E' }
			};

			const cascaded = cascadeFailure(nodes, 'b');

			expect(cascaded.a.status).toBe('completed');
			expect(cascaded.b.status).toBe('failed');
			expect(cascaded.c.status).toBe('skipped');
			expect(cascaded.c.error).toContain('Skipped due to upstream failure');
			expect(cascaded.d.status).toBe('skipped');
			expect(cascaded.d.error).toContain('Skipped due to upstream failure');
			expect(cascaded.e.status).toBe('pending');
		});

		it('computes task progress metrics accurately', () => {
			const nodes: Record<string, TaskNode> = {
				a: { dependencies: [], id: 'a', status: 'completed', title: 'A' },
				b: { dependencies: [], id: 'b', status: 'completed', title: 'B' },
				c: { dependencies: [], id: 'c', status: 'in_progress', title: 'C' },
				d: { dependencies: [], id: 'd', status: 'pending', title: 'D' },
				e: { dependencies: [], id: 'e', status: 'skipped', title: 'E' }
			};

			const progress = computeTaskProgress(nodes);
			expect(progress.total).toBe(5);
			expect(progress.completed).toBe(2);
			expect(progress.inProgress).toBe(1);
			expect(progress.pending).toBe(1);
			expect(progress.skipped).toBe(1);
			expect(progress.percent).toBe(40); // 2 / 5 = 40%
		});
	});

	describe('2. WorkbenchTaskGraphService', () => {
		it('creates a validated TaskGraph', () => {
			const taskNodes: TaskNode[] = [
				{ dependencies: [], id: 'step-1', status: 'pending', title: 'Inspect workspace' },
				{ dependencies: ['step-1'], id: 'step-2', status: 'pending', title: 'Generate code' }
			];

			const graph = WorkbenchTaskGraphService.createGraph('conv-123', 'Refactor Engine', taskNodes);

			expect(graph.id).toBeDefined();
			expect(graph.conversationId).toBe('conv-123');
			expect(graph.title).toBe('Refactor Engine');
			expect(graph.status).toBe('idle');
			expect(Object.keys(graph.nodes)).toEqual(['step-1', 'step-2']);
		});

		it('throws when creating a graph with circular dependencies', () => {
			const cyclicNodes: TaskNode[] = [
				{ dependencies: ['step-2'], id: 'step-1', status: 'pending', title: 'Step 1' },
				{ dependencies: ['step-1'], id: 'step-2', status: 'pending', title: 'Step 2' }
			];

			expect(() => {
				WorkbenchTaskGraphService.createGraph('conv-err', 'Cyclic Plan', cyclicNodes);
			}).toThrow(/circular dependencies/);
		});

		it('transitions node through start, complete, and finish lifecycle', () => {
			const taskNodes: TaskNode[] = [
				{ dependencies: [], id: 'step-1', status: 'pending', title: 'Step 1' },
				{ dependencies: ['step-1'], id: 'step-2', status: 'pending', title: 'Step 2' }
			];

			let graph = WorkbenchTaskGraphService.createGraph('conv-lifecycle', 'Lifecycle', taskNodes);

			// Start step-1
			graph = WorkbenchTaskGraphService.startNode(graph, 'step-1');
			expect(graph.status).toBe('running');
			expect(graph.nodes['step-1'].status).toBe('in_progress');
			expect(graph.nodes['step-1'].startedAt).toBeDefined();

			// Attempting to start step-2 before step-1 finishes throws
			expect(() => {
				WorkbenchTaskGraphService.startNode(graph, 'step-2');
			}).toThrow(/dependencies not completed/);

			// Complete step-1
			graph = WorkbenchTaskGraphService.completeNode(graph, 'step-1', { files: ['index.ts'] });
			expect(graph.status).toBe('running');
			expect(graph.nodes['step-1'].status).toBe('completed');
			expect(graph.nodes['step-1'].result).toEqual({ files: ['index.ts'] });

			// Now step-2 can start
			graph = WorkbenchTaskGraphService.startNode(graph, 'step-2');
			expect(graph.nodes['step-2'].status).toBe('in_progress');

			// Complete step-2 -> entire graph reaches completed status
			graph = WorkbenchTaskGraphService.completeNode(graph, 'step-2');
			expect(graph.nodes['step-2'].status).toBe('completed');
			expect(graph.status).toBe('completed');
		});

		it('fails node and cascades skipped status to dependents', () => {
			const taskNodes: TaskNode[] = [
				{ dependencies: [], id: 'build', status: 'pending', title: 'Build' },
				{ dependencies: ['build'], id: 'test', status: 'pending', title: 'Test' },
				{ dependencies: ['test'], id: 'deploy', status: 'pending', title: 'Deploy' }
			];

			let graph = WorkbenchTaskGraphService.createGraph('conv-fail', 'Failure test', taskNodes);
			graph = WorkbenchTaskGraphService.startNode(graph, 'build');
			graph = WorkbenchTaskGraphService.failNode(graph, 'build', 'Compilation error on line 42');

			expect(graph.status).toBe('failed');
			expect(graph.nodes.build.status).toBe('failed');
			expect(graph.nodes.build.error).toBe('Compilation error on line 42');
			expect(graph.nodes.test.status).toBe('skipped');
			expect(graph.nodes.deploy.status).toBe('skipped');
		});

		it('aborts graph and marks pending/in-progress tasks as skipped', () => {
			const taskNodes: TaskNode[] = [
				{ dependencies: [], id: 't1', status: 'completed', title: 'Task 1' },
				{ dependencies: ['t1'], id: 't2', status: 'pending', title: 'Task 2' }
			];

			let graph = WorkbenchTaskGraphService.createGraph('conv-abort', 'Abort plan', taskNodes);
			graph = WorkbenchTaskGraphService.abortGraph(graph, 'Interrupted by user');

			expect(graph.status).toBe('aborted');
			expect(graph.nodes.t1.status).toBe('completed');
			expect(graph.nodes.t2.status).toBe('skipped');
			expect(graph.nodes.t2.error).toBe('Interrupted by user');
		});

		it('serializes and deserializes graph cleanly without data loss', () => {
			const taskNodes: TaskNode[] = [
				{
					dependencies: [],
					id: 'cmd-run',
					status: 'pending',
					title: 'Execute tests',
					toolCall: { args: { cmd: 'npm test' }, name: 'exec_shell_command' }
				}
			];

			const graph = WorkbenchTaskGraphService.createGraph('conv-ser', 'Serial Plan', taskNodes);
			const json = WorkbenchTaskGraphService.serializeGraph(graph);
			const deserialized = WorkbenchTaskGraphService.deserializeGraph(json);

			expect(deserialized.id).toBe(graph.id);
			expect(deserialized.title).toBe(graph.title);
			expect(deserialized.nodes['cmd-run'].toolCall?.name).toBe('exec_shell_command');
			expect(deserialized.nodes['cmd-run'].toolCall?.args).toEqual({ cmd: 'npm test' });
		});

		it('handles storage round-trip and cleanup', () => {
			const taskNodes: TaskNode[] = [
				{ dependencies: [], id: 's1', status: 'pending', title: 'Step 1' }
			];
			const graph = WorkbenchTaskGraphService.createGraph('conv-persist', 'Persist Plan', taskNodes);

			WorkbenchTaskGraphService.saveToStorage(graph);
			const loaded = WorkbenchTaskGraphService.loadFromStorage('conv-persist');
			expect(loaded?.id).toBe(graph.id);

			WorkbenchTaskGraphService.clearFromStorage('conv-persist');
			const afterClear = WorkbenchTaskGraphService.loadFromStorage('conv-persist');
			expect(afterClear).toBeNull();
		});
	});

	describe('3. Reactive taskGraphStore', () => {
		it('manages active graph state and derived metrics reactively', () => {
			const store = new TaskGraphStore();

			expect(store.activeGraph).toBeNull();
			expect(store.isRunning).toBe(false);
			expect(store.progressPercent).toBe(0);
			expect(store.runnableNodes).toEqual([]);

			const nodes: TaskNode[] = [
				{ dependencies: [], id: 'init', status: 'pending', title: 'Initialize' },
				{ dependencies: ['init'], id: 'process', status: 'pending', title: 'Process' }
			];
			const graph = WorkbenchTaskGraphService.createGraph('conv-store', 'Store Plan', nodes);

			store.setGraph(graph, false);

			expect(store.activeGraph?.title).toBe('Store Plan');
			expect(store.runnableNodes.map((n) => n.id)).toEqual(['init']);
			expect(store.sortedNodeIds).toEqual(['init', 'process']);

			// Mark running
			store.markNodeRunning('init', false);
			expect(store.isRunning).toBe(true);

			// Mark completed
			store.markNodeCompleted('init', { success: true }, false);
			expect(store.progressPercent).toBe(50);
			expect(store.runnableNodes.map((n) => n.id)).toEqual(['process']);

			// Mark failed on process
			store.markNodeFailed('process', 'Fatal error', false);
			expect(store.isFailed).toBe(true);

			// Reset
			store.reset();
			expect(store.activeGraph).toBeNull();
		});
	});
});
