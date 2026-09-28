import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchSecurityBridge, policyService } from '$lib/workbench/security';
import { WorkbenchSettingsService } from '$lib/workbench/settings/workbench-settings.service';
import { WorkbenchTaskController } from '$lib/workbench/task/task-controller.service';
import { WorkbenchTaskGraphService } from '$lib/workbench/task/task-graph.service';
import { taskGraphStore } from '$lib/workbench/task/task-graph.svelte';
import type { TaskExecutionEvent, TaskNode } from '$lib/workbench/task/types';

describe('WorkbenchTaskController Subsystem', () => {
	beforeEach(() => {
		WorkbenchTaskGraphService.setStorageDisabledForTest(true);
		taskGraphStore.reset();
		WorkbenchSettingsService.setExecutionMode('SAFE');
	});

	it('a) executes a multi-node linear graph to completion in order', async () => {
		const nodes: TaskNode[] = [
			{
				dependencies: [],
				id: 'step-1',
				status: 'pending',
				title: 'Read configuration',
				toolCall: { args: { path: 'config.json' }, name: 'read_file' }
			},
			{
				dependencies: ['step-1'],
				id: 'step-2',
				status: 'pending',
				title: 'Generate output',
				toolCall: { args: { content: 'hello', path: 'out.txt' }, name: 'write_file' }
			},
			{
				dependencies: ['step-2'],
				id: 'step-3',
				status: 'pending',
				title: 'Run test validation'
			}
		];

		const graph = WorkbenchTaskGraphService.createGraph('conv-linear', 'Linear Pipeline', nodes);
		const executedTools: string[] = [];

		const mockExecutor = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
			executedTools.push(toolName);
			return { ok: true, tool: toolName };
		});

		const resultGraph = await WorkbenchTaskController.executeGraph(
			graph,
			{ maxTurns: 10 },
			undefined,
			mockExecutor
		);

		expect(resultGraph.status).toBe('completed');
		expect(executedTools).toEqual(['read_file', 'write_file']);
		expect(resultGraph.nodes['step-1'].status).toBe('completed');
		expect(resultGraph.nodes['step-2'].status).toBe('completed');
		expect(resultGraph.nodes['step-3'].status).toBe('completed');
		expect(taskGraphStore.progressPercent).toBe(100);
	});

	it('b) executes diamond dependency graphs ensuring parents finish before children', async () => {
		// A -> B, A -> C, B & C -> D
		const nodes: TaskNode[] = [
			{
				dependencies: [],
				id: 'A',
				status: 'pending',
				title: 'Root task',
				toolCall: { args: {}, name: 'tool_A' }
			},
			{
				dependencies: ['A'],
				id: 'B',
				status: 'pending',
				title: 'Branch B',
				toolCall: { args: {}, name: 'tool_B' }
			},
			{
				dependencies: ['A'],
				id: 'C',
				status: 'pending',
				title: 'Branch C',
				toolCall: { args: {}, name: 'tool_C' }
			},
			{
				dependencies: ['B', 'C'],
				id: 'D',
				status: 'pending',
				title: 'Merge D',
				toolCall: { args: {}, name: 'tool_D' }
			}
		];

		const graph = WorkbenchTaskGraphService.createGraph('conv-diamond', 'Diamond Graph', nodes);
		const executionOrder: string[] = [];

		const mockExecutor = vi.fn(async (toolName: string) => {
			executionOrder.push(toolName);
			return { output: toolName };
		});

		const resultGraph = await WorkbenchTaskController.executeGraph(
			graph,
			{},
			undefined,
			mockExecutor
		);

		expect(resultGraph.status).toBe('completed');
		expect(executionOrder[0]).toBe('tool_A');
		expect(executionOrder.indexOf('tool_D')).toBe(3);
		expect(executionOrder.indexOf('tool_B')).toBeGreaterThan(0);
		expect(executionOrder.indexOf('tool_C')).toBeGreaterThan(0);
	});

	it('c) halts and aborts graph when consecutive failure threshold is breached', async () => {
		const nodes: TaskNode[] = [
			{
				dependencies: [],
				id: 'f1',
				status: 'pending',
				title: 'Fail 1',
				toolCall: { args: {}, name: 'tool_fail' }
			},
			{
				dependencies: [],
				id: 'f2',
				status: 'pending',
				title: 'Fail 2',
				toolCall: { args: {}, name: 'tool_fail' }
			},
			{
				dependencies: [],
				id: 'f3',
				status: 'pending',
				title: 'Fail 3',
				toolCall: { args: {}, name: 'tool_fail' }
			},
			{
				dependencies: [],
				id: 'f4',
				status: 'pending',
				title: 'Should Not Run',
				toolCall: { args: {}, name: 'tool_ok' }
			}
		];

		const graph = WorkbenchTaskGraphService.createGraph('conv-failure', 'Failure Test', nodes);
		let executionCount = 0;

		const mockExecutor = vi.fn(async () => {
			executionCount++;
			throw new Error('Synthetic tool crash');
		});

		const resultGraph = await WorkbenchTaskController.executeGraph(
			graph,
			{ maxConsecutiveFailures: 3 },
			undefined,
			mockExecutor
		);

		expect(resultGraph.status).toBe('failed');
		expect(executionCount).toBe(3);
		expect(resultGraph.nodes.f4.status).toBe('skipped');
	});

	it('d) aborts long-running graphs when timeout envelope is exceeded', async () => {
		const nodes: TaskNode[] = [
			{
				dependencies: [],
				id: 'slow-step',
				status: 'pending',
				title: 'Slow execution',
				toolCall: { args: {}, name: 'slow_tool' }
			},
			{
				dependencies: ['slow-step'],
				id: 'next-step',
				status: 'pending',
				title: 'Next'
			}
		];

		const graph = WorkbenchTaskGraphService.createGraph('conv-timeout', 'Timeout Test', nodes);

		const mockExecutor = vi.fn(async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			return 'done';
		});

		const resultGraph = await WorkbenchTaskController.executeGraph(
			graph,
			{ timeoutMs: 30 },
			undefined,
			mockExecutor
		);

		expect(resultGraph.status).toBe('aborted');
		expect(resultGraph.nodes['next-step'].status).toBe('skipped');
	});

	it('e) cleanly halts execution upon AbortSignal trigger', async () => {
		const nodes: TaskNode[] = [
			{
				dependencies: [],
				id: 'step-a',
				status: 'pending',
				title: 'Step A',
				toolCall: { args: {}, name: 'tool_step' }
			},
			{
				dependencies: ['step-a'],
				id: 'step-b',
				status: 'pending',
				title: 'Step B',
				toolCall: { args: {}, name: 'tool_step' }
			}
		];

		const graph = WorkbenchTaskGraphService.createGraph('conv-abort', 'Abort Test', nodes);
		const abortController = new AbortController();

		const mockExecutor = vi.fn(async () => {
			abortController.abort();
			return { ok: true };
		});

		const resultGraph = await WorkbenchTaskController.executeGraph(
			graph,
			{},
			abortController.signal,
			mockExecutor
		);

		expect(resultGraph.status).toBe('aborted');
		expect(resultGraph.nodes['step-a'].status).toBe('completed');
		expect(resultGraph.nodes['step-b'].status).toBe('skipped');
	});

	it('f) automatically skips downstream dependents when an upstream task fails', async () => {
		// A (fails) -> B (depends on A) -> C (depends on B)
		// Independent: D (depends on nothing)
		const nodes: TaskNode[] = [
			{
				dependencies: [],
				id: 'A',
				status: 'pending',
				title: 'Root task',
				toolCall: { args: {}, name: 'fail_tool' }
			},
			{
				dependencies: ['A'],
				id: 'B',
				status: 'pending',
				title: 'Dependent B'
			},
			{
				dependencies: ['B'],
				id: 'C',
				status: 'pending',
				title: 'Dependent C'
			},
			{
				dependencies: [],
				id: 'D',
				status: 'pending',
				title: 'Independent D',
				toolCall: { args: {}, name: 'ok_tool' }
			}
		];

		const graph = WorkbenchTaskGraphService.createGraph('conv-cascade', 'Cascade Plan', nodes);

		const mockExecutor = vi.fn(async (toolName: string) => {
			if (toolName === 'fail_tool') {
				throw new Error('Root task exploded');
			}
			return { success: true };
		});

		const resultGraph = await WorkbenchTaskController.executeGraph(
			graph,
			{ maxConsecutiveFailures: 5 },
			undefined,
			mockExecutor
		);

		expect(resultGraph.nodes.A.status).toBe('failed');
		expect(resultGraph.nodes.B.status).toBe('skipped');
		expect(resultGraph.nodes.C.status).toBe('skipped');
		expect(resultGraph.nodes.D.status).toBe('completed');
		expect(resultGraph.status).toBe('failed');
	});

	it('emits lifecycle events during task orchestration', async () => {
		const nodes: TaskNode[] = [
			{ dependencies: [], id: 't1', status: 'pending', title: 'Task 1' }
		];
		const graph = WorkbenchTaskGraphService.createGraph('conv-events', 'Event Plan', nodes);

		const events: TaskExecutionEvent[] = [];
		const unsubscribe = WorkbenchTaskController.subscribeEvents((ev) => {
			events.push(ev);
		});

		await WorkbenchTaskController.executeGraph(graph);
		unsubscribe();

		const types = events.map((e) => e.type);
		expect(types).toContain('node_started');
		expect(types).toContain('node_completed');
		expect(types).toContain('graph_completed');
	});

	it('denies execution when WorkbenchSecurityBridge rejects a critical tool call', async () => {
		WorkbenchSettingsService.setExecutionMode('AUTONOMOUS');

		const nodes: TaskNode[] = [
			{
				dependencies: [],
				id: 'danger',
				status: 'pending',
				title: 'Dangerous Operation',
				toolCall: {
					args: { command: 'rm -rf /' },
					name: 'exec_shell_command'
				}
			}
		];

		const graph = WorkbenchTaskGraphService.createGraph('conv-sec', 'Security Test', nodes);
		const mockExecutor = vi.fn();

		const resultGraph = await WorkbenchTaskController.executeGraph(
			graph,
			{},
			undefined,
			mockExecutor
		);

		expect(resultGraph.nodes.danger.status).toBe('failed');
		expect(resultGraph.nodes.danger.error).toMatch(/security policy/i);
		expect(mockExecutor).not.toHaveBeenCalled();
	});
});
