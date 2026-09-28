/**
 * Task Graph Service for Workbench Autonomous Execution.
 *
 * Manages plan lifecycle, graph validation, node state transitions (start, complete, fail),
 * failure cascading, and serialization/deserialization with storage persistence.
 */

import { STORAGE_APP_NAME } from '$lib/constants/storage.constants';
import { cascadeFailure, detectCycles, isGraphComplete } from './dag';
import type { TaskGraph, TaskNode } from './types';

export const TASK_GRAPH_STORAGE_PREFIX = `${STORAGE_APP_NAME}.workbench.taskgraph.`;

function generateGraphId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID();
	}
	return 'graph_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
}

export class WorkbenchTaskGraphService {
	private static inMemoryStore = new Map<string, string>();
	private static storageDisabledForTest = false;

	/**
	 * Configures test override for headless/quota scenarios.
	 */
	static setStorageDisabledForTest(disabled: boolean): void {
		this.storageDisabledForTest = disabled;
	}

	/**
	 * Computes the storage key for a conversation's active task graph.
	 */
	static getStorageKey(conversationId: string): string {
		return `${TASK_GRAPH_STORAGE_PREFIX}${conversationId}`;
	}

	/**
	 * Creates and validates a new TaskGraph from a list of TaskNodes.
	 * Throws an Error if circular dependencies exist between nodes.
	 */
	static createGraph(conversationId: string, title: string, nodes: TaskNode[]): TaskGraph {
		const nodeMap: Record<string, TaskNode> = {};

		for (const node of nodes) {
			nodeMap[node.id] = {
				...node,
				dependencies: [...node.dependencies],
				status: node.status || 'pending'
			};
		}

		if (detectCycles(nodeMap)) {
			throw new Error('Cannot create TaskGraph: circular dependencies detected between nodes');
		}

		const now = Date.now();
		return {
			conversationId,
			createdAt: now,
			id: generateGraphId(),
			nodes: nodeMap,
			status: 'idle',
			title: title.trim() || 'Autonomous Plan',
			updatedAt: now
		};
	}

	/**
	 * Transitions a task node to 'in_progress'.
	 * Throws if the node does not exist or unfulfilled dependencies are present.
	 */
	static startNode(graph: TaskGraph, nodeId: string): TaskGraph {
		const target = graph.nodes[nodeId];
		if (!target) {
			throw new Error(`Node "${nodeId}" not found in task graph "${graph.id}"`);
		}

		const unfulfilled = target.dependencies.filter(
			(depId) => !graph.nodes[depId] || graph.nodes[depId].status !== 'completed'
		);
		if (unfulfilled.length > 0) {
			throw new Error(
				`Cannot start node "${nodeId}": dependencies not completed (${unfulfilled.join(', ')})`
			);
		}

		const now = Date.now();
		const updatedNodes: Record<string, TaskNode> = {
			...graph.nodes,
			[nodeId]: {
				...target,
				startedAt: target.startedAt || now,
				status: 'in_progress'
			}
		};

		return {
			...graph,
			nodes: updatedNodes,
			status: 'running',
			updatedAt: now
		};
	}

	/**
	 * Marks a task node as 'completed' and records its result.
	 * Automatically transitions graph status to 'completed' if all tasks are finished.
	 */
	static completeNode(graph: TaskGraph, nodeId: string, result?: unknown): TaskGraph {
		const target = graph.nodes[nodeId];
		if (!target) {
			throw new Error(`Node "${nodeId}" not found in task graph "${graph.id}"`);
		}

		const now = Date.now();
		const updatedNodes: Record<string, TaskNode> = {
			...graph.nodes,
			[nodeId]: {
				...target,
				completedAt: now,
				result: result !== undefined ? result : target.result,
				status: 'completed'
			}
		};

		const complete = isGraphComplete(updatedNodes);

		return {
			...graph,
			nodes: updatedNodes,
			status: complete ? 'completed' : 'running',
			updatedAt: now
		};
	}

	/**
	 * Marks a task node as 'failed', records the error, and cascades 'skipped' status
	 * to all unexecuted downstream dependents. Transitions graph status to 'failed'.
	 */
	static failNode(graph: TaskGraph, nodeId: string, error: string): TaskGraph {
		const target = graph.nodes[nodeId];
		if (!target) {
			throw new Error(`Node "${nodeId}" not found in task graph "${graph.id}"`);
		}

		const now = Date.now();
		const withFailedNode: Record<string, TaskNode> = {
			...graph.nodes,
			[nodeId]: {
				...target,
				completedAt: now,
				error: error || 'Task execution failed',
				status: 'failed'
			}
		};

		const cascadedNodes = cascadeFailure(withFailedNode, nodeId);

		return {
			...graph,
			nodes: cascadedNodes,
			status: 'failed',
			updatedAt: now
		};
	}

	/**
	 * Aborts graph execution, marking any active in-progress nodes as 'skipped' or aborted.
	 */
	static abortGraph(graph: TaskGraph, reason = 'Execution aborted by user'): TaskGraph {
		const now = Date.now();
		const updatedNodes: Record<string, TaskNode> = {};

		for (const [id, node] of Object.entries(graph.nodes)) {
			if (node.status === 'in_progress' || node.status === 'pending') {
				updatedNodes[id] = {
					...node,
					completedAt: now,
					error: node.error ?? reason,
					status: 'skipped'
				};
			} else {
				updatedNodes[id] = { ...node };
			}
		}

		return {
			...graph,
			nodes: updatedNodes,
			status: 'aborted',
			updatedAt: now
		};
	}

	/**
	 * Serializes a TaskGraph to a formatted JSON string.
	 */
	static serializeGraph(graph: TaskGraph): string {
		return JSON.stringify(graph, null, 2);
	}

	/**
	 * Deserializes a JSON string into a valid TaskGraph.
	 * Validates schema and integrity.
	 */
	static deserializeGraph(jsonStr: string): TaskGraph {
		if (!jsonStr || typeof jsonStr !== 'string') {
			throw new Error('Cannot deserialize TaskGraph: invalid or empty JSON string');
		}

		try {
			const parsed = JSON.parse(jsonStr) as TaskGraph;
			if (!parsed || typeof parsed !== 'object') {
				throw new Error('Deserialized payload is not an object');
			}
			if (typeof parsed.id !== 'string' || typeof parsed.conversationId !== 'string') {
				throw new Error('Deserialized task graph is missing required identity fields');
			}
			if (!parsed.nodes || typeof parsed.nodes !== 'object') {
				throw new Error('Deserialized task graph has invalid nodes structure');
			}
			return parsed;
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`Failed to parse TaskGraph JSON: ${detail}`);
		}
	}

	/**
	 * Persists an active TaskGraph to both localStorage and in-memory cache.
	 */
	static saveToStorage(graph: TaskGraph): void {
		const key = this.getStorageKey(graph.conversationId);
		const serialized = this.serializeGraph(graph);

		this.inMemoryStore.set(key, serialized);

		if (!this.storageDisabledForTest && typeof localStorage !== 'undefined') {
			try {
				localStorage.setItem(key, serialized);
			} catch (err) {
				console.warn(
					`[WorkbenchTaskGraphService] Failed to persist task graph to localStorage (${graph.conversationId}):`,
					err
				);
			}
		}
	}

	/**
	 * Loads a TaskGraph for a conversation ID from localStorage or in-memory cache.
	 */
	static loadFromStorage(conversationId: string): TaskGraph | null {
		const key = this.getStorageKey(conversationId);

		if (!this.storageDisabledForTest && typeof localStorage !== 'undefined') {
			try {
				const item = localStorage.getItem(key);
				if (item) {
					return this.deserializeGraph(item);
				}
			} catch (err) {
				console.warn(
					`[WorkbenchTaskGraphService] Failed to read task graph from localStorage (${conversationId}):`,
					err
				);
			}
		}

		const memoryItem = this.inMemoryStore.get(key);
		if (memoryItem) {
			try {
				return this.deserializeGraph(memoryItem);
			} catch {
				return null;
			}
		}

		return null;
	}

	/**
	 * Removes a conversation's active TaskGraph from storage.
	 */
	static clearFromStorage(conversationId: string): void {
		const key = this.getStorageKey(conversationId);
		this.inMemoryStore.delete(key);

		if (!this.storageDisabledForTest && typeof localStorage !== 'undefined') {
			try {
				localStorage.removeItem(key);
			} catch {
				/* Ignore storage cleanup errors */
			}
		}
	}
}
