/**
 * Unit tests for WorkbenchRecoveryCoordinator and Session Resumption State Machine.
 *
 * Verifies:
 * 1. Detection of recoverable vs unrecoverable checkpoints.
 * 2. Proper hydration of AgenticStore session turn on resumption.
 * 3. Restoration of ExecutionMode across recovery transitions.
 * 4. Clean purge of checkpoint state on session discard.
 * 5. Event notification subscribers for UI synchronization.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	WorkbenchAgentCheckpointService,
	WorkbenchRecoveryCoordinator
} from '$lib/workbench/persistence';
import type { AgentCheckpoint } from '$lib/workbench/persistence/types';
import { WorkbenchSettingsService } from '$lib/workbench/settings/workbench-settings.service';
import { agenticStore } from '$lib/stores/agentic/index.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';

describe('WorkbenchRecoveryCoordinator', () => {
	const CONV_ID = 'conv-recovery-001';

	beforeEach(() => {
		WorkbenchAgentCheckpointService.clearAllCheckpoints();
		WorkbenchAgentCheckpointService.setStorageDisabledForTest(false);
		if (typeof localStorage !== 'undefined') {
			localStorage.clear();
		}
		agenticStore.clearSession(CONV_ID);
		WorkbenchSettingsService.setExecutionMode('SAFE');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		WorkbenchAgentCheckpointService.clearAllCheckpoints();
		if (typeof localStorage !== 'undefined') {
			localStorage.clear();
		}
		agenticStore.clearSession(CONV_ID);
	});

	describe('a) Checkpoint Recovery Detection', () => {
		it('returns unrecoverable status when no checkpoint exists', () => {
			const status = WorkbenchRecoveryCoordinator.checkRecoveryStatus('nonexistent-conv');
			expect(status.recoverable).toBe(false);
			expect(status.checkpoint).toBeNull();
			expect(WorkbenchRecoveryCoordinator.hasRecoverableSession('nonexistent-conv')).toBe(false);
		});

		it('detects a valid recoverable checkpoint with pending tools in EXECUTING_TOOLS state', () => {
			const checkpoint: AgentCheckpoint = {
				conversationId: CONV_ID,
				currNodeId: 'node-turn-2',
				turn: 2,
				maxTurns: 5,
				state: 'EXECUTING_TOOLS',
				pendingToolCalls: [{ id: 'call-1', name: 'read_file', args: { path: 'test.ts' } }],
				completedToolCalls: [],
				executionMode: 'AUTONOMOUS',
				updatedAt: Date.now()
			};

			WorkbenchAgentCheckpointService.saveCheckpoint(checkpoint);

			const status = WorkbenchRecoveryCoordinator.checkRecoveryStatus(CONV_ID);
			expect(status.recoverable).toBe(true);
			expect(status.checkpoint).toEqual(checkpoint);
			expect(WorkbenchRecoveryCoordinator.hasRecoverableSession(CONV_ID)).toBe(true);
		});

		it('flags completed runs as unrecoverable', () => {
			const checkpoint: AgentCheckpoint = {
				conversationId: CONV_ID,
				currNodeId: 'node-finished',
				turn: 3,
				maxTurns: 5,
				state: 'COMPLETED',
				pendingToolCalls: [],
				completedToolCalls: [],
				executionMode: 'SAFE',
				updatedAt: Date.now()
			};

			WorkbenchAgentCheckpointService.saveCheckpoint(checkpoint);

			const status = WorkbenchRecoveryCoordinator.checkRecoveryStatus(CONV_ID);
			expect(status.recoverable).toBe(false);
			expect(WorkbenchRecoveryCoordinator.hasRecoverableSession(CONV_ID)).toBe(false);
		});
	});

	describe('b) Session Resumption & State Hydration', () => {
		it('hydrates AgenticStore turn and invokes chatStore continuation on resumeSession', async () => {
			const checkpoint: AgentCheckpoint = {
				conversationId: CONV_ID,
				currNodeId: 'node-target-assist-999',
				turn: 4,
				maxTurns: 10,
				state: 'EXECUTING_TOOLS',
				pendingToolCalls: [{ id: 'c1', name: 'bash', args: { cmd: 'ls' } }],
				completedToolCalls: [],
				executionMode: 'ASSISTED',
				updatedAt: Date.now()
			};

			WorkbenchAgentCheckpointService.saveCheckpoint(checkpoint);

			const continueSpy = vi
				.spyOn(chatStore, 'continueAssistantMessage')
				.mockImplementation(async () => {});

			await WorkbenchRecoveryCoordinator.resumeSession(CONV_ID);

			// AgenticStore turn count must be hydrated to checkpoint turn
			expect(agenticStore.getCurrentTurn(CONV_ID)).toBe(4);

			// chatStore.continueAssistantMessage must be invoked with currNodeId
			expect(continueSpy).toHaveBeenCalledWith('node-target-assist-999');
		});

		it('restores executionMode from checkpoint upon resumption', async () => {
			expect(WorkbenchSettingsService.getExecutionMode()).toBe('SAFE');

			const checkpoint: AgentCheckpoint = {
				conversationId: CONV_ID,
				currNodeId: 'node-auto-mode',
				turn: 2,
				maxTurns: 5,
				state: 'THINKING',
				pendingToolCalls: [],
				completedToolCalls: [],
				executionMode: 'AUTONOMOUS',
				updatedAt: Date.now()
			};

			WorkbenchAgentCheckpointService.saveCheckpoint(checkpoint);

			vi.spyOn(chatStore, 'continueAssistantMessage').mockImplementation(async () => {});

			await WorkbenchRecoveryCoordinator.resumeSession(CONV_ID);

			// Mode must be updated to match the checkpoint
			expect(WorkbenchSettingsService.getExecutionMode()).toBe('AUTONOMOUS');
		});
	});

	describe('c) Session Discard & Purging', () => {
		it('purges checkpoint and clears AgenticStore session cleanly on discardSession', () => {
			const checkpoint: AgentCheckpoint = {
				conversationId: CONV_ID,
				currNodeId: 'node-to-discard',
				turn: 2,
				maxTurns: 5,
				state: 'EXECUTING_TOOLS',
				pendingToolCalls: [{ id: 'c1', name: 'calc', args: {} }],
				completedToolCalls: [],
				executionMode: 'SAFE',
				updatedAt: Date.now()
			};

			WorkbenchAgentCheckpointService.saveCheckpoint(checkpoint);
			agenticStore.updateSession(CONV_ID, { currentTurn: 2 });

			expect(WorkbenchRecoveryCoordinator.hasRecoverableSession(CONV_ID)).toBe(true);

			WorkbenchRecoveryCoordinator.discardSession(CONV_ID);

			expect(WorkbenchAgentCheckpointService.getCheckpoint(CONV_ID)).toBeNull();
			expect(WorkbenchRecoveryCoordinator.hasRecoverableSession(CONV_ID)).toBe(false);
			expect(agenticStore.getCurrentTurn(CONV_ID)).toBe(0);
			expect(agenticStore.isRunning(CONV_ID)).toBe(false);
		});
	});

	describe('d) Event Subscriptions', () => {
		it('notifies registered listeners on resume and discard events', async () => {
			const checkpoint: AgentCheckpoint = {
				conversationId: CONV_ID,
				currNodeId: 'node-event-test',
				turn: 1,
				maxTurns: 5,
				state: 'THINKING',
				pendingToolCalls: [],
				completedToolCalls: [],
				executionMode: 'SAFE',
				updatedAt: Date.now()
			};

			WorkbenchAgentCheckpointService.saveCheckpoint(checkpoint);
			vi.spyOn(chatStore, 'continueAssistantMessage').mockImplementation(async () => {});

			const events: string[] = [];
			const unsubscribe = WorkbenchRecoveryCoordinator.subscribe((convId) => {
				events.push(convId);
			});

			await WorkbenchRecoveryCoordinator.resumeSession(CONV_ID);
			expect(events).toContain(CONV_ID);

			WorkbenchRecoveryCoordinator.discardSession(CONV_ID);
			expect(events.length).toBe(2);

			unsubscribe();
			WorkbenchRecoveryCoordinator.discardSession(CONV_ID);
			expect(events.length).toBe(2); // No new events after unsubscribe
		});
	});
});
