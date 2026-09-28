/**
 * Persistence contracts and state schemas for OMENA Autonomous Agent Checkpoint Service.
 */

import type { ExecutionMode } from '../security/types';

export type AgentExecutionState =
	| 'IDLE'
	| 'THINKING'
	| 'PROPOSING_ACTION'
	| 'EXECUTING_TOOLS'
	| 'AWAITING_PERMISSION'
	| 'HALTED'
	| 'COMPLETED'
	| 'ERROR';

export interface CheckpointPendingToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export interface CheckpointCompletedToolCall {
	id: string;
	name: string;
	result: unknown;
	timestamp: number;
}

export interface AgentCheckpoint {
	conversationId: string;
	currNodeId: string;
	turn: number;
	maxTurns: number;
	state: AgentExecutionState;
	pendingToolCalls: CheckpointPendingToolCall[];
	completedToolCalls: CheckpointCompletedToolCall[];
	executionMode: ExecutionMode;
	updatedAt: number;
}
