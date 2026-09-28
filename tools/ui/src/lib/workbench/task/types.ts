/**
 * Task Graph Contracts & Schema Definitions for Workbench Autonomous Execution.
 *
 * Defines node statuses, task nodes, execution graphs, progress metrics,
 * execution envelopes, and controller event contracts.
 */

export type TaskStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface TaskToolCall {
	name: string;
	args: Record<string, unknown>;
}

export interface TaskNode {
	id: string;
	title: string;
	description?: string;
	status: TaskStepStatus;
	dependencies: string[]; // Array of parent task node IDs that must be completed first
	toolCall?: TaskToolCall;
	result?: unknown;
	error?: string;
	startedAt?: number;
	completedAt?: number;
}

export type TaskGraphStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted';

export interface TaskGraph {
	id: string;
	conversationId: string;
	title: string;
	nodes: Record<string, TaskNode>;
	status: TaskGraphStatus;
	createdAt: number;
	updatedAt: number;
}

export interface TaskGraphProgress {
	total: number;
	pending: number;
	inProgress: number;
	completed: number;
	failed: number;
	skipped: number;
	percent: number;
}

export interface TaskExecutionConfig {
	maxTurns: number; // Turn ceiling (default: 25)
	timeoutMs: number; // Execution timeout (default: 15 * 60 * 1000)
	maxConsecutiveFailures: number; // Failure ceiling before abort (default: 3)
	autoResume: boolean; // Resume unblocked dependents automatically
	autoRollbackOnFailure?: boolean; // Rollback pre-mutation snapshots on task failure (default: false)
}

export const DEFAULT_TASK_EXECUTION_CONFIG: TaskExecutionConfig = {
	autoResume: true,
	autoRollbackOnFailure: false,
	maxConsecutiveFailures: 3,
	maxTurns: 25,
	timeoutMs: 15 * 60 * 1000
};

export type TaskExecutionEventType =
	| 'node_started'
	| 'node_completed'
	| 'node_failed'
	| 'graph_completed'
	| 'graph_aborted';

export interface TaskExecutionEvent {
	type: TaskExecutionEventType;
	nodeId?: string;
	graphId: string;
	timestamp: number;
	error?: string;
}

export type TaskToolExecutor = (
	toolName: string,
	args: Record<string, unknown>,
	signal?: AbortSignal
) => Promise<unknown>;
