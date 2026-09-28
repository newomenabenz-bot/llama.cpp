/**
 * Pure DAG Algorithms for Workbench Task Orchestration.
 *
 * Provides deterministic topological sorting, cycle detection, runnable node
 * identification, terminal state checks, and failure cascading.
 */

import type { TaskGraphProgress, TaskNode } from './types';

/**
 * Builds forward adjacency map: parentNodeId -> childNodeIds (nodes that depend on parent).
 */
export function buildAdjacencyList(nodes: Record<string, TaskNode>): Map<string, string[]> {
	const adjacency = new Map<string, string[]>();

	for (const id of Object.keys(nodes)) {
		adjacency.set(id, []);
	}

	for (const [id, node] of Object.entries(nodes)) {
		for (const depId of node.dependencies) {
			if (!adjacency.has(depId)) {
				adjacency.set(depId, []);
			}
			adjacency.get(depId)!.push(id);
		}
	}

	return adjacency;
}

/**
 * Detects whether a directed cycle exists in the task graph using Kahn's algorithm.
 * Returns true if a cycle is present; otherwise false.
 */
export function detectCycles(nodes: Record<string, TaskNode>): boolean {
	const nodeIds = Object.keys(nodes);
	if (nodeIds.length === 0) return false;

	const inDegree: Record<string, number> = {};
	const adjacency = buildAdjacencyList(nodes);

	for (const id of nodeIds) {
		const validDeps = nodes[id].dependencies.filter((dep) => Boolean(nodes[dep]));
		inDegree[id] = validDeps.length;
	}

	const queue: string[] = [];
	for (const id of nodeIds) {
		if (inDegree[id] === 0) {
			queue.push(id);
		}
	}

	let visitedCount = 0;

	while (queue.length > 0) {
		const current = queue.shift()!;
		visitedCount++;

		const children = adjacency.get(current) ?? [];
		for (const child of children) {
			if (inDegree[child] !== undefined) {
				inDegree[child]--;
				if (inDegree[child] === 0) {
					queue.push(child);
				}
			}
		}
	}

	return visitedCount < nodeIds.length;
}

/**
 * Topologically sorts task nodes into a valid linear execution order (dependencies before dependents).
 * Throws an Error if a cycle is detected.
 */
export function topologicalSort(nodes: Record<string, TaskNode>): string[] {
	const nodeIds = Object.keys(nodes);
	if (nodeIds.length === 0) return [];

	const inDegree: Record<string, number> = {};
	const adjacency = buildAdjacencyList(nodes);

	for (const id of nodeIds) {
		const validDeps = nodes[id].dependencies.filter((dep) => Boolean(nodes[dep]));
		inDegree[id] = validDeps.length;
	}

	// Deterministic alphabetical queue for nodes with in-degree 0
	const queue: string[] = [];
	for (const id of nodeIds.sort()) {
		if (inDegree[id] === 0) {
			queue.push(id);
		}
	}

	const sortedOrder: string[] = [];

	while (queue.length > 0) {
		const current = queue.shift()!;
		sortedOrder.push(current);

		const children = adjacency.get(current) ?? [];
		// Sort children for stable deterministic traversal
		for (const child of children.sort()) {
			if (inDegree[child] !== undefined) {
				inDegree[child]--;
				if (inDegree[child] === 0) {
					queue.push(child);
				}
			}
		}
	}

	if (sortedOrder.length < nodeIds.length) {
		throw new Error(
			`Cycle detected in task graph: circular dependencies are not permitted (${nodeIds.length - sortedOrder.length} unreachable nodes)`
		);
	}

	return sortedOrder;
}

/**
 * Returns all task nodes that are currently eligible for execution:
 * - Node status must be 'pending'
 * - Every dependency ID must be present in `nodes` and have status === 'completed'
 */
export function getRunnableNodes(nodes: Record<string, TaskNode>): TaskNode[] {
	const runnable: TaskNode[] = [];

	for (const node of Object.values(nodes)) {
		if (node.status !== 'pending') continue;

		const dependenciesFulfilled = node.dependencies.every(
			(depId) => nodes[depId] && nodes[depId].status === 'completed'
		);

		if (dependenciesFulfilled) {
			runnable.push(node);
		}
	}

	return runnable;
}

/**
 * Checks whether all tasks in the graph have reached terminal success states ('completed' or 'skipped').
 */
export function isGraphComplete(nodes: Record<string, TaskNode>): boolean {
	const values = Object.values(nodes);
	if (values.length === 0) return true;

	return values.every((node) => node.status === 'completed' || node.status === 'skipped');
}

/**
 * Checks whether any task in the graph has failed.
 */
export function isGraphFailed(nodes: Record<string, TaskNode>): boolean {
	return Object.values(nodes).some((node) => node.status === 'failed');
}

/**
 * Cascades failure downstream: finds all unexecuted dependents that depend directly
 * or indirectly on `failedNodeId`, and transitions their status to 'skipped'.
 * Pure function: returns a new updated Record of nodes.
 */
export function cascadeFailure(
	nodes: Record<string, TaskNode>,
	failedNodeId: string
): Record<string, TaskNode> {
	const result: Record<string, TaskNode> = {};
	for (const [id, node] of Object.entries(nodes)) {
		result[id] = { ...node, dependencies: [...node.dependencies] };
	}

	const adjacency = buildAdjacencyList(result);
	const queue = [...(adjacency.get(failedNodeId) ?? [])];
	const visited = new Set<string>();

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (visited.has(current)) continue;
		visited.add(current);

		const node = result[current];
		if (node && (node.status === 'pending' || node.status === 'in_progress')) {
			result[current] = {
				...node,
				status: 'skipped',
				error: node.error ?? `Skipped due to upstream failure in dependency "${failedNodeId}"`,
				completedAt: Date.now()
			};
		}

		const nextChildren = adjacency.get(current) ?? [];
		for (const child of nextChildren) {
			if (!visited.has(child)) {
				queue.push(child);
			}
		}
	}

	return result;
}

/**
 * Computes execution metrics and progress percentages across task nodes.
 */
export function computeTaskProgress(nodes: Record<string, TaskNode>): TaskGraphProgress {
	const values = Object.values(nodes);
	const total = values.length;

	let pending = 0;
	let inProgress = 0;
	let completed = 0;
	let failed = 0;
	let skipped = 0;

	for (const node of values) {
		switch (node.status) {
			case 'pending':
				pending++;
				break;
			case 'in_progress':
				inProgress++;
				break;
			case 'completed':
				completed++;
				break;
			case 'failed':
				failed++;
				break;
			case 'skipped':
				skipped++;
				break;
		}
	}

	const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

	return {
		completed,
		failed,
		inProgress,
		pending,
		percent,
		skipped,
		total
	};
}
