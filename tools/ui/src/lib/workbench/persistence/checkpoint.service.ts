/**
 * WorkbenchAgentCheckpointService - Crash-resilient state machine persistence for agentic sessions.
 *
 * Serializes active agent execution state (conversation ID, current node, turn,
 * pending tool calls, completed tool calls, and execution mode) to localStorage
 * with graceful in-memory fallback.
 */

import { STORAGE_APP_NAME } from '$lib/constants/storage.constants';
import type { ExecutionMode } from '../security/types';
import type {
	AgentCheckpoint,
	AgentExecutionState,
	CheckpointCompletedToolCall,
	CheckpointPendingToolCall
} from './types';

export const CHECKPOINT_STORAGE_PREFIX = `${STORAGE_APP_NAME}.workbench.checkpoint.`;

const RECOVERABLE_STATES: ReadonlySet<AgentExecutionState> = new Set([
	'THINKING',
	'EXECUTING_TOOLS',
	'AWAITING_PERMISSION',
	'HALTED'
]);

export class WorkbenchAgentCheckpointService {
	private static inMemoryStore = new Map<string, string>();
	private static storageDisabledForTest = false;

	/**
	 * Configures test override to simulate localStorage failure or headless/quota scenarios.
	 */
	static setStorageDisabledForTest(disabled: boolean): void {
		this.storageDisabledForTest = disabled;
	}

	/**
	 * Generates the storage key for a given conversation ID.
	 */
	static getStorageKey(conversationId: string): string {
		return `${CHECKPOINT_STORAGE_PREFIX}${conversationId}`;
	}

	/**
	 * Persists an agentic session checkpoint.
	 * Writes to both in-memory store and localStorage (if available).
	 */
	static saveCheckpoint(checkpoint: AgentCheckpoint): void {
		const key = this.getStorageKey(checkpoint.conversationId);
		const payload: AgentCheckpoint = {
			...checkpoint,
			updatedAt: checkpoint.updatedAt || Date.now()
		};
		const serialized = JSON.stringify(payload);

		// Always update in-memory cache
		this.inMemoryStore.set(key, serialized);

		if (!this.storageDisabledForTest && typeof localStorage !== 'undefined') {
			try {
				localStorage.setItem(key, serialized);
			} catch (err) {
				console.warn(
					`[WorkbenchAgentCheckpointService] Failed to persist checkpoint to localStorage (${checkpoint.conversationId}):`,
					err
				);
			}
		}
	}

	/**
	 * Retrieves the checkpoint for a conversation ID.
	 * Checks localStorage first, falling back to the in-memory store.
	 */
	static getCheckpoint(conversationId: string): AgentCheckpoint | null {
		const key = this.getStorageKey(conversationId);

		if (!this.storageDisabledForTest && typeof localStorage !== 'undefined') {
			try {
				const item = localStorage.getItem(key);
				if (item) {
					return JSON.parse(item) as AgentCheckpoint;
				}
			} catch (err) {
				console.warn(
					`[WorkbenchAgentCheckpointService] Failed to read checkpoint from localStorage (${conversationId}):`,
					err
				);
			}
		}

		const memoryItem = this.inMemoryStore.get(key);
		if (memoryItem) {
			try {
				return JSON.parse(memoryItem) as AgentCheckpoint;
			} catch {
				return null;
			}
		}

		return null;
	}

	/**
	 * Removes the checkpoint for a conversation ID upon clean completion or explicit termination.
	 */
	static clearCheckpoint(conversationId: string): void {
		const key = this.getStorageKey(conversationId);
		this.inMemoryStore.delete(key);

		if (!this.storageDisabledForTest && typeof localStorage !== 'undefined') {
			try {
				localStorage.removeItem(key);
			} catch (err) {
				console.warn(
					`[WorkbenchAgentCheckpointService] Failed to clear checkpoint from localStorage (${conversationId}):`,
					err
				);
			}
		}
	}

	/**
	 * Lists all active agent checkpoints stored in localStorage and the in-memory cache.
	 */
	static listActiveCheckpoints(): AgentCheckpoint[] {
		const checkpointsMap = new Map<string, AgentCheckpoint>();

		// Load from in-memory store first
		for (const [key, value] of this.inMemoryStore.entries()) {
			if (key.startsWith(CHECKPOINT_STORAGE_PREFIX)) {
				try {
					const cp = JSON.parse(value) as AgentCheckpoint;
					checkpointsMap.set(cp.conversationId, cp);
				} catch {
					// Ignore corrupted entries
				}
			}
		}

		// Overlay / load from localStorage if available
		if (!this.storageDisabledForTest && typeof localStorage !== 'undefined') {
			try {
				const len = localStorage.length;
				for (let i = 0; i < len; i++) {
					const key = localStorage.key(i);
					if (key && key.startsWith(CHECKPOINT_STORAGE_PREFIX)) {
						const raw = localStorage.getItem(key);
						if (raw) {
							try {
								const cp = JSON.parse(raw) as AgentCheckpoint;
								checkpointsMap.set(cp.conversationId, cp);
							} catch {
								// Ignore corrupted entries
							}
						}
					}
				}
			} catch (err) {
				console.warn('[WorkbenchAgentCheckpointService] Failed to scan localStorage for checkpoints:', err);
			}
		}

		return Array.from(checkpointsMap.values()).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/**
	 * Returns true if an interrupted or un-cleared recoverable session exists for the conversation.
	 */
	static hasRecoverableSession(conversationId: string): boolean {
		const checkpoint = this.getCheckpoint(conversationId);
		if (!checkpoint) return false;

		return (
			RECOVERABLE_STATES.has(checkpoint.state) ||
			(checkpoint.state !== 'COMPLETED' &&
				checkpoint.state !== 'IDLE' &&
				(checkpoint.pendingToolCalls.length > 0 || checkpoint.completedToolCalls.length > 0))
		);
	}

	/**
	 * Purges all checkpoints from both memory and localStorage (useful for teardowns and tests).
	 */
	static clearAllCheckpoints(): void {
		this.inMemoryStore.clear();

		if (!this.storageDisabledForTest && typeof localStorage !== 'undefined') {
			try {
				const keysToRemove: string[] = [];
				for (let i = 0; i < localStorage.length; i++) {
					const key = localStorage.key(i);
					if (key && key.startsWith(CHECKPOINT_STORAGE_PREFIX)) {
						keysToRemove.push(key);
					}
				}
				for (const key of keysToRemove) {
					localStorage.removeItem(key);
				}
			} catch (err) {
				console.warn('[WorkbenchAgentCheckpointService] Failed to clear all checkpoints:', err);
			}
		}
	}

	// --------------------------------------------------------------------------
	// High-level lifecycle helper methods
	// --------------------------------------------------------------------------

	/**
	 * Emits a checkpoint when the agent enters the THINKING state.
	 */
	static recordThinking(params: {
		conversationId: string;
		currNodeId: string;
		turn: number;
		maxTurns: number;
		executionMode: ExecutionMode;
	}): AgentCheckpoint {
		const existing = this.getCheckpoint(params.conversationId);
		const checkpoint: AgentCheckpoint = {
			conversationId: params.conversationId,
			currNodeId: params.currNodeId,
			turn: params.turn,
			maxTurns: params.maxTurns,
			state: 'THINKING',
			pendingToolCalls: existing ? existing.pendingToolCalls : [],
			completedToolCalls: existing ? existing.completedToolCalls : [],
			executionMode: params.executionMode,
			updatedAt: Date.now()
		};

		this.saveCheckpoint(checkpoint);
		return checkpoint;
	}

	/**
	 * Emits a checkpoint when the agent transitions to EXECUTING_TOOLS with queued calls.
	 */
	static recordExecutingTools(params: {
		conversationId: string;
		currNodeId: string;
		turn: number;
		maxTurns: number;
		executionMode: ExecutionMode;
		pendingToolCalls: CheckpointPendingToolCall[];
	}): AgentCheckpoint {
		const existing = this.getCheckpoint(params.conversationId);
		const checkpoint: AgentCheckpoint = {
			conversationId: params.conversationId,
			currNodeId: params.currNodeId,
			turn: params.turn,
			maxTurns: params.maxTurns,
			state: 'EXECUTING_TOOLS',
			pendingToolCalls: [...params.pendingToolCalls],
			completedToolCalls: existing ? existing.completedToolCalls : [],
			executionMode: params.executionMode,
			updatedAt: Date.now()
		};

		this.saveCheckpoint(checkpoint);
		return checkpoint;
	}

	/**
	 * Updates the checkpoint when an individual tool call completes.
	 * Removes the tool call from pending and appends it to completed.
	 */
	static recordToolCompletion(params: {
		conversationId: string;
		toolCallId: string;
		toolName: string;
		result: unknown;
	}): AgentCheckpoint | null {
		const checkpoint = this.getCheckpoint(params.conversationId);
		if (!checkpoint) return null;

		const completedEntry: CheckpointCompletedToolCall = {
			id: params.toolCallId,
			name: params.toolName,
			result: params.result,
			timestamp: Date.now()
		};

		const updatedPending = checkpoint.pendingToolCalls.filter((tc) => tc.id !== params.toolCallId);
		const updatedCompleted = [...checkpoint.completedToolCalls, completedEntry];

		const updatedCheckpoint: AgentCheckpoint = {
			...checkpoint,
			pendingToolCalls: updatedPending,
			completedToolCalls: updatedCompleted,
			state: updatedPending.length === 0 ? 'THINKING' : 'EXECUTING_TOOLS',
			updatedAt: Date.now()
		};

		this.saveCheckpoint(updatedCheckpoint);
		return updatedCheckpoint;
	}

	/**
	 * Records a state transition to AWAITING_PERMISSION while user approval is pending.
	 */
	static recordAwaitingPermission(conversationId: string): AgentCheckpoint | null {
		const checkpoint = this.getCheckpoint(conversationId);
		if (!checkpoint) return null;

		const updated: AgentCheckpoint = {
			...checkpoint,
			state: 'AWAITING_PERMISSION',
			updatedAt: Date.now()
		};

		this.saveCheckpoint(updated);
		return updated;
	}

	/**
	 * Records a state transition to HALTED (e.g. user abort, steering interruption).
	 */
	static recordHalted(conversationId: string): AgentCheckpoint | null {
		const checkpoint = this.getCheckpoint(conversationId);
		if (!checkpoint) return null;

		const updated: AgentCheckpoint = {
			...checkpoint,
			state: 'HALTED',
			updatedAt: Date.now()
		};

		this.saveCheckpoint(updated);
		return updated;
	}

	/**
	 * Records an unexpected error state.
	 */
	static recordError(conversationId: string): AgentCheckpoint | null {
		const checkpoint = this.getCheckpoint(conversationId);
		if (!checkpoint) return null;

		const updated: AgentCheckpoint = {
			...checkpoint,
			state: 'ERROR',
			updatedAt: Date.now()
		};

		this.saveCheckpoint(updated);
		return updated;
	}
}
