/**
 * Reactive Svelte 5 Rune Store for Workbench Task Graph Execution.
 *
 * Manages active task plan state, progress ratios, runnable node derivations,
 * and live node state transitions with storage synchronization.
 */

import { computeTaskProgress, getRunnableNodes, topologicalSort } from './dag';
import { WorkbenchTaskGraphService } from './task-graph.service';
import type { TaskGraph, TaskGraphProgress, TaskNode } from './types';

export class TaskGraphStore {
	activeGraph = $state<TaskGraph | null>(null);

	progress = $derived.by<TaskGraphProgress>(() => {
		if (!this.activeGraph) {
			return {
				completed: 0,
				failed: 0,
				inProgress: 0,
				pending: 0,
				percent: 0,
				skipped: 0,
				total: 0
			};
		}
		return computeTaskProgress(this.activeGraph.nodes);
	});

	progressPercent = $derived(this.progress.percent);
	progressRatio = $derived(
		this.progress.total === 0 ? 0 : this.progress.completed / this.progress.total
	);

	isRunning = $derived(this.activeGraph?.status === 'running');
	isCompleted = $derived(this.activeGraph?.status === 'completed');
	isFailed = $derived(this.activeGraph?.status === 'failed');
	isAborted = $derived(this.activeGraph?.status === 'aborted');

	runnableNodes = $derived.by<TaskNode[]>(() => {
		if (!this.activeGraph) return [];
		return getRunnableNodes(this.activeGraph.nodes);
	});

	sortedNodeIds = $derived.by<string[]>(() => {
		if (!this.activeGraph) return [];
		try {
			return topologicalSort(this.activeGraph.nodes);
		} catch {
			return Object.keys(this.activeGraph.nodes);
		}
	});

	/**
	 * Sets the active task graph and optionally persists it to storage.
	 */
	setGraph(graph: TaskGraph, persist = true): void {
		this.activeGraph = graph;
		if (persist) {
			WorkbenchTaskGraphService.saveToStorage(graph);
		}
	}

	/**
	 * Clears the active graph from memory and optionally from persistent storage.
	 */
	clearGraph(persist = true): void {
		if (this.activeGraph && persist) {
			WorkbenchTaskGraphService.clearFromStorage(this.activeGraph.conversationId);
		}
		this.activeGraph = null;
	}

	/**
	 * Loads a stored TaskGraph for the given conversation ID.
	 */
	loadForConversation(conversationId: string): TaskGraph | null {
		const loaded = WorkbenchTaskGraphService.loadFromStorage(conversationId);
		this.activeGraph = loaded;
		return loaded;
	}

	/**
	 * Transitions a node to 'in_progress' and marks graph status as 'running'.
	 */
	markNodeRunning(nodeId: string, persist = true): void {
		if (!this.activeGraph) return;
		this.activeGraph = WorkbenchTaskGraphService.startNode(this.activeGraph, nodeId);
		if (persist) {
			WorkbenchTaskGraphService.saveToStorage(this.activeGraph);
		}
	}

	/**
	 * Marks a node as 'completed' and records its result.
	 */
	markNodeCompleted(nodeId: string, result?: unknown, persist = true): void {
		if (!this.activeGraph) return;
		this.activeGraph = WorkbenchTaskGraphService.completeNode(this.activeGraph, nodeId, result);
		if (persist) {
			WorkbenchTaskGraphService.saveToStorage(this.activeGraph);
		}
	}

	/**
	 * Marks a node as 'failed', cascading 'skipped' to downstream dependents.
	 */
	markNodeFailed(nodeId: string, error: string, persist = true): void {
		if (!this.activeGraph) return;
		this.activeGraph = WorkbenchTaskGraphService.failNode(this.activeGraph, nodeId, error);
		if (persist) {
			WorkbenchTaskGraphService.saveToStorage(this.activeGraph);
		}
	}

	/**
	 * Aborts graph execution.
	 */
	abortGraph(reason?: string, persist = true): void {
		if (!this.activeGraph) return;
		this.activeGraph = WorkbenchTaskGraphService.abortGraph(this.activeGraph, reason);
		if (persist) {
			WorkbenchTaskGraphService.saveToStorage(this.activeGraph);
		}
	}

	/**
	 * Resets store state.
	 */
	reset(): void {
		this.activeGraph = null;
	}
}

export const taskGraphStore = new TaskGraphStore();
