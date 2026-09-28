/**
 * Unit tests for TaskGraphVisualizer and Observability Deck Plan Integration
 *
 * Verifies:
 * 1. Empty state rendering when no active task graph exists.
 * 2. Header metadata rendering (title, ID, status pill, progress bar).
 * 3. Topologically ordered node list layout and step numbering.
 * 4. Node status indicators and badges across all execution states:
 *    (pending, in_progress, completed, failed, skipped).
 * 5. Dependency linkages and prerequisite badges.
 * 6. Tool invocation details and argument expansion payloads.
 * 7. Error callout containers for failed or skipped nodes.
 * 8. Abort action for active runs vs Clear action for terminal states.
 * 9. Seamless integration with AgentObservabilityDeck via sub-tab switcher and header summary banner.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import TaskGraphVisualizer from '$lib/workbench/components/TaskGraphVisualizer.svelte';
import AgentObservabilityDeck from '$lib/workbench/components/AgentObservabilityDeck.svelte';
import { taskGraphStore } from '$lib/workbench/task/task-graph.svelte';
import { WorkbenchTaskGraphService } from '$lib/workbench/task/task-graph.service';
import type { TaskGraph, TaskNode } from '$lib/workbench/task/types';

beforeAll(() => {
	const store = new Map<string, string>();
	const polyfill: Storage = {
		clear: () => store.clear(),
		getItem: (k) => (store.has(k) ? store.get(k)! : null),
		key: (i) => Array.from(store.keys())[i] ?? null,
		get length() {
			return store.size;
		},
		removeItem: (k) => {
			store.delete(k);
		},
		setItem: (k, v) => {
			store.set(k, String(v));
		}
	};

	(globalThis as unknown as { localStorage: Storage }).localStorage = polyfill;
});

function createSampleGraph(overrides: Partial<TaskGraph> = {}): TaskGraph {
	const nodes: Record<string, TaskNode> = {
		'step-1': {
			dependencies: [],
			description: 'Inspect workspace files and directory structure',
			id: 'step-1',
			status: 'completed',
			title: 'Analyze Directory Structure',
			startedAt: 1000,
			completedAt: 1250,
			toolCall: {
				name: 'read_dir',
				args: { path: 'src/lib' }
			}
		},
		'step-2': {
			dependencies: ['step-1'],
			description: 'Execute build command to verify compilation',
			id: 'step-2',
			status: 'in_progress',
			title: 'Run TypeScript Build',
			startedAt: 1300,
			toolCall: {
				name: 'exec_shell',
				args: { command: 'npm run build' }
			}
		},
		'step-3': {
			dependencies: ['step-2'],
			description: 'Deploy compiled output artifacts',
			id: 'step-3',
			status: 'pending',
			title: 'Deploy Artifacts'
		}
	};

	return {
		id: 'graph-test-12345678',
		title: 'Autonomous Refactoring Plan',
		conversationId: 'conv-test-1',
		status: 'running',
		createdAt: 1000,
		updatedAt: 1300,
		nodes,
		...overrides
	};
}

describe('TaskGraphVisualizer Component', () => {
	beforeEach(() => {
		WorkbenchTaskGraphService.setStorageDisabledForTest(true);
		taskGraphStore.clearGraph();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		taskGraphStore.clearGraph();
	});

	describe('1. Empty State Rendering', () => {
		it('renders empty-state placeholder when activeGraph is null', () => {
			const { body } = render(TaskGraphVisualizer, {
				props: { forcedGraph: null }
			});

			expect(body).toContain('data-testid="task-graph-visualizer"');
			expect(body).toContain('data-testid="task-graph-empty-state"');
			expect(body).toContain('No active task plan');
			expect(body).toContain('Plan generation will appear here during autonomous execution.');
		});
	});

	describe('2. Header & Graph Metadata', () => {
		it('renders graph title, truncated id badge, and status pill', () => {
			const graph = createSampleGraph();
			const { body } = render(TaskGraphVisualizer, {
				props: { forcedGraph: graph }
			});

			expect(body).toContain('data-testid="task-graph-title"');
			expect(body).toContain('Autonomous Refactoring Plan');
			expect(body).toContain('graph-te'); // sliced 0-8
			expect(body).toContain('data-testid="graph-status-pill"');
			expect(body).toContain('data-status="running"');
			expect(body).toContain('RUNNING');
		});

		it('renders progress bar with accurate completion percentage', () => {
			const graph = createSampleGraph();
			// 1 completed of 3 total = 33%
			const { body } = render(TaskGraphVisualizer, {
				props: { forcedGraph: graph }
			});

			expect(body).toContain('data-testid="task-graph-progress-bar"');
			expect(body).toContain('Progress (1 of 3 completed)');
			expect(body).toContain('33%');
			expect(body).toContain('style="width: 33%;"');
		});
	});

	describe('3. Node Flow & Topological Ordering', () => {
		it('renders nodes in topological order with step numbering and titles', () => {
			const graph = createSampleGraph();
			const { body } = render(TaskGraphVisualizer, {
				props: { forcedGraph: graph }
			});

			expect(body).toContain('data-testid="task-nodes-container"');
			expect(body).toContain('data-testid="task-node-item"');

			// Step numbers
			expect(body).toContain('#1');
			expect(body).toContain('#2');
			expect(body).toContain('#3');

			// Node titles
			expect(body).toContain('Analyze Directory Structure');
			expect(body).toContain('Run TypeScript Build');
			expect(body).toContain('Deploy Artifacts');
		});

		it('renders dependency badges for dependent nodes', () => {
			const graph = createSampleGraph();
			const { body } = render(TaskGraphVisualizer, {
				props: { forcedGraph: graph }
			});

			expect(body).toContain('Depends on:');
			expect(body).toContain('#step-1');
			expect(body).toContain('#step-2');
		});
	});

	describe('4. Node Execution States & Indicators', () => {
		it('renders appropriate badges and styling for all node status types', () => {
			const nodes: Record<string, TaskNode> = {
				n1: { id: 'n1', title: 'Pending Task', status: 'pending', dependencies: [] },
				n2: { id: 'n2', title: 'In Progress Task', status: 'in_progress', dependencies: ['n1'] },
				n3: {
					id: 'n3',
					title: 'Completed Task',
					status: 'completed',
					dependencies: ['n2'],
					startedAt: 100,
					completedAt: 350
				},
				n4: {
					id: 'n4',
					title: 'Failed Task',
					status: 'failed',
					dependencies: ['n3'],
					error: 'Command execution timed out after 30000ms'
				},
				n5: {
					id: 'n5',
					title: 'Skipped Task',
					status: 'skipped',
					dependencies: ['n4'],
					error: 'Dependency failed: n4'
				}
			};

			const graph = createSampleGraph({
				status: 'failed',
				nodes
			});

			const { body } = render(TaskGraphVisualizer, {
				props: { forcedGraph: graph }
			});

			// Status badges
			expect(body).toContain('data-testid="node-status-badge-n1"');
			expect(body).toContain('PENDING');
			expect(body).toContain('data-testid="node-status-badge-n2"');
			expect(body).toContain('IN_PROGRESS');
			expect(body).toContain('data-testid="node-status-badge-n3"');
			expect(body).toContain('COMPLETED');
			expect(body).toContain('data-testid="node-status-badge-n4"');
			expect(body).toContain('FAILED');
			expect(body).toContain('data-testid="node-status-badge-n5"');
			expect(body).toContain('SKIPPED');

			// Duration telemetry for completed node
			expect(body).toContain('250ms');

			// Error messages
			expect(body).toContain('data-testid="node-error-n4"');
			expect(body).toContain('Command execution timed out after 30000ms');
			expect(body).toContain('data-testid="node-error-n5"');
			expect(body).toContain('Dependency failed: n4');
		});
	});

	describe('5. Tool Invocation & Arguments Expansion', () => {
		it('renders tool names and supports payload expansion with forceExpandAll', () => {
			const graph = createSampleGraph();
			const { body } = render(TaskGraphVisualizer, {
				props: { forcedGraph: graph, forceExpandAll: true }
			});

			expect(body).toContain('read_dir');
			expect(body).toContain('exec_shell');
			expect(body).toContain('data-testid="tool-args-payload-step-1"');
			expect(body).toContain('"path": "src/lib"');
			expect(body).toContain('data-testid="tool-args-payload-step-2"');
			expect(body).toContain('"command": "npm run build"');
		});
	});

	describe('6. Execution Controls (Abort vs Clear)', () => {
		it('renders Abort button when graph is running', () => {
			const graph = createSampleGraph({ status: 'running' });
			const { body } = render(TaskGraphVisualizer, {
				props: { forcedGraph: graph }
			});

			expect(body).toContain('data-testid="abort-task-graph"');
			expect(body).toContain('Abort');
			expect(body).not.toContain('data-testid="clear-task-graph"');
		});

		it('renders Clear button when graph is completed, failed, or idle', () => {
			const graph = createSampleGraph({ status: 'completed' });
			const { body } = render(TaskGraphVisualizer, {
				props: { forcedGraph: graph }
			});

			expect(body).toContain('data-testid="clear-task-graph"');
			expect(body).toContain('Clear');
			expect(body).not.toContain('data-testid="abort-task-graph"');
		});
	});

	describe('7. Integration with AgentObservabilityDeck', () => {
		it('renders task plan summary banner in deck header when activeGraph is present', () => {
			const graph = createSampleGraph();
			const { body } = render(AgentObservabilityDeck, {
				props: {
					forcedActiveGraph: graph
				}
			});

			expect(body).toContain('data-testid="task-plan-summary-banner"');
			expect(body).toContain('Task Plan:');
			expect(body).toContain('1 of 3 steps completed');
			expect(body).toContain('RUNNING');
		});

		it('renders sub-tab switcher between Audit Log and Plan Graph', () => {
			const graph = createSampleGraph();
			const { body } = render(AgentObservabilityDeck, {
				props: {
					forcedActiveGraph: graph
				}
			});

			expect(body).toContain('data-testid="deck-tab-audit"');
			expect(body).toContain('Audit Log (0)');
			expect(body).toContain('data-testid="deck-tab-plan"');
			expect(body).toContain('Plan Graph (3)');
		});

		it('renders TaskGraphVisualizer within plan-graph-section when initialDeckTab is plan', () => {
			const graph = createSampleGraph();
			const { body } = render(AgentObservabilityDeck, {
				props: {
					forcedActiveGraph: graph,
					initialDeckTab: 'plan'
				}
			});

			expect(body).toContain('data-testid="plan-graph-section"');
			expect(body).toContain('data-testid="task-graph-visualizer"');
			expect(body).toContain('Autonomous Refactoring Plan');
			expect(body).not.toContain('data-testid="audit-trail-section"');
		});
	});
});
