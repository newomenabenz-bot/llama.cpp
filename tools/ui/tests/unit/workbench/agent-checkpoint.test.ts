/**
 * Unit tests for WorkbenchAgentCheckpointService.
 *
 * Verifies crash-resilient turn serialization, partial tool completion handling,
 * recovery detection, clean purging, and in-memory fallback behaviors.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CHECKPOINT_STORAGE_PREFIX,
	WorkbenchAgentCheckpointService
} from '$lib/workbench/persistence/checkpoint.service';
import type { AgentCheckpoint } from '$lib/workbench/persistence/types';

describe('WorkbenchAgentCheckpointService', () => {
	const CONV_ID_1 = 'conv-test-alpha-111';
	const CONV_ID_2 = 'conv-test-beta-222';

	beforeEach(() => {
		WorkbenchAgentCheckpointService.setStorageDisabledForTest(false);
		WorkbenchAgentCheckpointService.clearAllCheckpoints();
		if (typeof localStorage !== 'undefined') {
			localStorage.clear();
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		WorkbenchAgentCheckpointService.setStorageDisabledForTest(false);
		WorkbenchAgentCheckpointService.clearAllCheckpoints();
		if (typeof localStorage !== 'undefined') {
			localStorage.clear();
		}
	});

	describe('a) Serialization and Deserialization', () => {
		it('serializes and deserializes an active checkpoint with all fields preserved', () => {
			const checkpoint: AgentCheckpoint = {
				conversationId: CONV_ID_1,
				currNodeId: 'node-msg-leaf-001',
				turn: 2,
				maxTurns: 10,
				state: 'EXECUTING_TOOLS',
				pendingToolCalls: [
					{
						id: 'call-1',
						name: 'server_read_file',
						args: { path: '/workspace/src/app.ts' }
					}
				],
				completedToolCalls: [
					{
						id: 'call-0',
						name: 'server_list_dir',
						result: ['src', 'package.json'],
						timestamp: 1700000000000
					}
				],
				executionMode: 'ASSISTED',
				updatedAt: 1700000005000
			};

			WorkbenchAgentCheckpointService.saveCheckpoint(checkpoint);

			const retrieved = WorkbenchAgentCheckpointService.getCheckpoint(CONV_ID_1);
			expect(retrieved).not.toBeNull();
			expect(retrieved).toEqual(checkpoint);

			// Verify direct localStorage serialization
			if (typeof localStorage !== 'undefined') {
				const raw = localStorage.getItem(`${CHECKPOINT_STORAGE_PREFIX}${CONV_ID_1}`);
				expect(raw).not.toBeNull();
				const parsed = JSON.parse(raw!);
				expect(parsed.currNodeId).toBe('node-msg-leaf-001');
				expect(parsed.state).toBe('EXECUTING_TOOLS');
				expect(parsed.pendingToolCalls[0].name).toBe('server_read_file');
			}
		});

		it('returns null for nonexistent conversation checkpoints', () => {
			const nonExistent = WorkbenchAgentCheckpointService.getCheckpoint('non-existent-conv');
			expect(nonExistent).toBeNull();
		});
	});

	describe('b) Recovery Detection', () => {
		it('detects recoverable sessions for interrupted execution states', () => {
			expect(WorkbenchAgentCheckpointService.hasRecoverableSession(CONV_ID_1)).toBe(false);

			const recoverableStates: Array<AgentCheckpoint['state']> = [
				'THINKING',
				'EXECUTING_TOOLS',
				'AWAITING_PERMISSION',
				'HALTED'
			];

			for (const state of recoverableStates) {
				WorkbenchAgentCheckpointService.saveCheckpoint({
					conversationId: CONV_ID_1,
					currNodeId: 'node-1',
					turn: 1,
					maxTurns: 5,
					state,
					pendingToolCalls: [],
					completedToolCalls: [],
					executionMode: 'SAFE',
					updatedAt: Date.now()
				});

				expect(WorkbenchAgentCheckpointService.hasRecoverableSession(CONV_ID_1)).toBe(true);
			}
		});

		it('flags completed or idle sessions as non-recoverable when queues are empty', () => {
			WorkbenchAgentCheckpointService.saveCheckpoint({
				conversationId: CONV_ID_1,
				currNodeId: 'node-1',
				turn: 1,
				maxTurns: 5,
				state: 'COMPLETED',
				pendingToolCalls: [],
				completedToolCalls: [],
				executionMode: 'SAFE',
				updatedAt: Date.now()
			});

			expect(WorkbenchAgentCheckpointService.hasRecoverableSession(CONV_ID_1)).toBe(false);

			WorkbenchAgentCheckpointService.saveCheckpoint({
				conversationId: CONV_ID_1,
				currNodeId: 'node-1',
				turn: 0,
				maxTurns: 5,
				state: 'IDLE',
				pendingToolCalls: [],
				completedToolCalls: [],
				executionMode: 'SAFE',
				updatedAt: Date.now()
			});

			expect(WorkbenchAgentCheckpointService.hasRecoverableSession(CONV_ID_1)).toBe(false);
		});

		it('lists all active checkpoints sorted by newest updatedAt first', async () => {
			WorkbenchAgentCheckpointService.saveCheckpoint({
				conversationId: CONV_ID_1,
				currNodeId: 'node-1',
				turn: 1,
				maxTurns: 5,
				state: 'THINKING',
				pendingToolCalls: [],
				completedToolCalls: [],
				executionMode: 'SAFE',
				updatedAt: 1000
			});

			WorkbenchAgentCheckpointService.saveCheckpoint({
				conversationId: CONV_ID_2,
				currNodeId: 'node-2',
				turn: 2,
				maxTurns: 5,
				state: 'EXECUTING_TOOLS',
				pendingToolCalls: [{ id: 'c1', name: 'calc', args: {} }],
				completedToolCalls: [],
				executionMode: 'AUTONOMOUS',
				updatedAt: 2000
			});

			const active = WorkbenchAgentCheckpointService.listActiveCheckpoints();
			expect(active).toHaveLength(2);
			expect(active[0].conversationId).toBe(CONV_ID_2);
			expect(active[1].conversationId).toBe(CONV_ID_1);
		});
	});

	describe('c) Partial Tool Completions Within a Turn', () => {
		it('correctly shifts completed tools from pending to completed and transitions state', () => {
			WorkbenchAgentCheckpointService.recordExecutingTools({
				conversationId: CONV_ID_1,
				currNodeId: 'leaf-node-turn-1',
				turn: 1,
				maxTurns: 5,
				executionMode: 'ASSISTED',
				pendingToolCalls: [
					{ id: 'call-alpha', name: 'search_files', args: { pattern: '*.ts' } },
					{ id: 'call-beta', name: 'read_file', args: { path: 'index.ts' } }
				]
			});

			let cp = WorkbenchAgentCheckpointService.getCheckpoint(CONV_ID_1)!;
			expect(cp.state).toBe('EXECUTING_TOOLS');
			expect(cp.pendingToolCalls).toHaveLength(2);
			expect(cp.completedToolCalls).toHaveLength(0);

			// Complete first tool
			const updated1 = WorkbenchAgentCheckpointService.recordToolCompletion({
				conversationId: CONV_ID_1,
				toolCallId: 'call-alpha',
				toolName: 'search_files',
				result: ['main.ts', 'index.ts']
			});

			expect(updated1).not.toBeNull();
			expect(updated1!.pendingToolCalls).toHaveLength(1);
			expect(updated1!.pendingToolCalls[0].id).toBe('call-beta');
			expect(updated1!.completedToolCalls).toHaveLength(1);
			expect(updated1!.completedToolCalls[0].id).toBe('call-alpha');
			expect(updated1!.completedToolCalls[0].result).toEqual(['main.ts', 'index.ts']);
			expect(updated1!.state).toBe('EXECUTING_TOOLS');

			// Complete second tool
			const updated2 = WorkbenchAgentCheckpointService.recordToolCompletion({
				conversationId: CONV_ID_1,
				toolCallId: 'call-beta',
				toolName: 'read_file',
				result: 'console.log("hello world");'
			});

			expect(updated2).not.toBeNull();
			expect(updated2!.pendingToolCalls).toHaveLength(0);
			expect(updated2!.completedToolCalls).toHaveLength(2);
			// With all pending tools finished, state transitions back to THINKING
			expect(updated2!.state).toBe('THINKING');
		});

		it('returns null when updating tool completion for an un-checkpointed conversation', () => {
			const res = WorkbenchAgentCheckpointService.recordToolCompletion({
				conversationId: 'unknown-conv',
				toolCallId: 'call-x',
				toolName: 'test',
				result: 'none'
			});
			expect(res).toBeNull();
		});
	});

	describe('d) Automatic Purging and Lifecycle State Transitions', () => {
		it('purges checkpoint cleanly on clearCheckpoint', () => {
			WorkbenchAgentCheckpointService.recordThinking({
				conversationId: CONV_ID_1,
				currNodeId: 'node-start',
				turn: 1,
				maxTurns: 5,
				executionMode: 'SAFE'
			});

			expect(WorkbenchAgentCheckpointService.getCheckpoint(CONV_ID_1)).not.toBeNull();

			WorkbenchAgentCheckpointService.clearCheckpoint(CONV_ID_1);

			expect(WorkbenchAgentCheckpointService.getCheckpoint(CONV_ID_1)).toBeNull();
			expect(WorkbenchAgentCheckpointService.hasRecoverableSession(CONV_ID_1)).toBe(false);
		});

		it('transitions through AWAITING_PERMISSION, HALTED, and ERROR states correctly', () => {
			WorkbenchAgentCheckpointService.recordThinking({
				conversationId: CONV_ID_1,
				currNodeId: 'node-root',
				turn: 1,
				maxTurns: 5,
				executionMode: 'ASSISTED'
			});

			const awaiting = WorkbenchAgentCheckpointService.recordAwaitingPermission(CONV_ID_1);
			expect(awaiting?.state).toBe('AWAITING_PERMISSION');
			expect(WorkbenchAgentCheckpointService.hasRecoverableSession(CONV_ID_1)).toBe(true);

			const halted = WorkbenchAgentCheckpointService.recordHalted(CONV_ID_1);
			expect(halted?.state).toBe('HALTED');
			expect(WorkbenchAgentCheckpointService.hasRecoverableSession(CONV_ID_1)).toBe(true);

			const error = WorkbenchAgentCheckpointService.recordError(CONV_ID_1);
			expect(error?.state).toBe('ERROR');
		});
	});

	describe('e) In-Memory Fallback Behavior', () => {
		it('falls back to in-memory store when localStorage is disabled or unavailable', () => {
			WorkbenchAgentCheckpointService.setStorageDisabledForTest(true);

			const checkpoint: AgentCheckpoint = {
				conversationId: 'conv-memory-only',
				currNodeId: 'node-mem-0',
				turn: 1,
				maxTurns: 5,
				state: 'EXECUTING_TOOLS',
				pendingToolCalls: [{ id: 'c-mem', name: 'mem_tool', args: {} }],
				completedToolCalls: [],
				executionMode: 'AUTONOMOUS',
				updatedAt: Date.now()
			};

			WorkbenchAgentCheckpointService.saveCheckpoint(checkpoint);

			// localStorage must remain untouched
			if (typeof localStorage !== 'undefined') {
				expect(localStorage.getItem(`${CHECKPOINT_STORAGE_PREFIX}conv-memory-only`)).toBeNull();
			}

			// In-memory retrieve succeeds seamlessly
			const retrieved = WorkbenchAgentCheckpointService.getCheckpoint('conv-memory-only');
			expect(retrieved).toEqual(checkpoint);
			expect(WorkbenchAgentCheckpointService.hasRecoverableSession('conv-memory-only')).toBe(true);

			const active = WorkbenchAgentCheckpointService.listActiveCheckpoints();
			expect(active.some((cp) => cp.conversationId === 'conv-memory-only')).toBe(true);

			// In-memory clear succeeds
			WorkbenchAgentCheckpointService.clearCheckpoint('conv-memory-only');
			expect(WorkbenchAgentCheckpointService.getCheckpoint('conv-memory-only')).toBeNull();
		});

		it('handles localStorage exceptions (e.g. QuotaExceededError) without throwing', () => {
			if (typeof localStorage !== 'undefined') {
				vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
					throw new Error('QuotaExceededError: storage full');
				});

				const checkpoint: AgentCheckpoint = {
					conversationId: 'conv-quota-test',
					currNodeId: 'node-q',
					turn: 3,
					maxTurns: 5,
					state: 'THINKING',
					pendingToolCalls: [],
					completedToolCalls: [],
					executionMode: 'SAFE',
					updatedAt: Date.now()
				};

				expect(() => {
					WorkbenchAgentCheckpointService.saveCheckpoint(checkpoint);
				}).not.toThrow();

				// Checkpoint is still retained in memory
				const retrieved = WorkbenchAgentCheckpointService.getCheckpoint('conv-quota-test');
				expect(retrieved).toEqual(checkpoint);
			}
		});
	});
});
