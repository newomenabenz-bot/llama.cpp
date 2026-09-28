/**
 * WorkbenchRecoveryCoordinator - Crash recovery state machine and resumption executor.
 *
 * Detects interrupted agentic sessions upon conversation activation, coordinates safe
 * user-confirmed resumption (restoring pending tools and execution mode), and manages
 * session discarding.
 */

import { MessageRole } from '$lib/enums';
import { agenticStore } from '$lib/stores/agentic/index.svelte';
import { chatStore } from '$lib/stores/chat/index.svelte';
import { conversationsStore } from '$lib/stores/conversations/index.svelte';
import { WorkbenchSettingsService } from '../settings/workbench-settings.service';
import { WorkbenchAgentCheckpointService } from './checkpoint.service';
import type { AgentCheckpoint } from './types';

export type RecoveryListener = (conversationId: string) => void;

export class WorkbenchRecoveryCoordinator {
	private static listeners = new Set<RecoveryListener>();

	/**
	 * Subscribes to session recovery events (resume or discard).
	 */
	static subscribe(listener: RecoveryListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private static notify(conversationId: string): void {
		for (const listener of this.listeners) {
			try {
				listener(conversationId);
			} catch (err) {
				console.warn('[WorkbenchRecoveryCoordinator] Listener error:', err);
			}
		}
	}

	/**
	 * Checks whether a conversation has an interrupted recoverable checkpoint.
	 */
	static checkRecoveryStatus(conversationId: string): {
		recoverable: boolean;
		checkpoint: AgentCheckpoint | null;
	} {
		if (!conversationId) {
			return { checkpoint: null, recoverable: false };
		}

		const checkpoint = WorkbenchAgentCheckpointService.getCheckpoint(conversationId);
		if (!checkpoint) {
			return { checkpoint: null, recoverable: false };
		}

		const recoverable = WorkbenchAgentCheckpointService.hasRecoverableSession(conversationId);
		return { checkpoint, recoverable };
	}

	/**
	 * Shorthand helper for boolean recovery checks.
	 */
	static hasRecoverableSession(conversationId?: string | null): boolean {
		if (!conversationId) return false;
		return WorkbenchAgentCheckpointService.hasRecoverableSession(conversationId);
	}

	/**
	 * Resumes an interrupted agent session from its checkpoint.
	 */
	static async resumeSession(conversationId: string): Promise<void> {
		const { checkpoint, recoverable } = this.checkRecoveryStatus(conversationId);
		if (!recoverable || !checkpoint) {
			return;
		}

		// 1. Restore execution mode
		if (checkpoint.executionMode) {
			WorkbenchSettingsService.setExecutionMode(checkpoint.executionMode);
		}

		// 2. Hydrate AgenticStore session
		agenticStore.updateSession(conversationId, {
			currentTurn: checkpoint.turn
		});

		// 3. Re-trigger execution from active leaf node or last assistant message
		const targetNodeId = checkpoint.currNodeId;

		if (targetNodeId && typeof chatStore?.continueAssistantMessage === 'function') {
			try {
				await chatStore.continueAssistantMessage(targetNodeId);
			} catch (err) {
				console.warn(
					'[WorkbenchRecoveryCoordinator] Failed to continue target node, attempting fallback:',
					err
				);
				await this.fallbackResumption(conversationId);
			}
		} else {
			await this.fallbackResumption(conversationId);
		}

		this.notify(conversationId);
	}

	/**
	 * Fallback resumption finding the latest assistant message.
	 */
	private static async fallbackResumption(conversationId: string): Promise<void> {
		const activeMessages = conversationsStore.activeMessages ?? [];
		for (let i = activeMessages.length - 1; i >= 0; i--) {
			if (activeMessages[i].role === MessageRole.ASSISTANT) {
				await chatStore.continueAssistantMessage(activeMessages[i].id);
				return;
			}
		}

		if (activeMessages.length > 0 && typeof chatStore?.regenerateMessage === 'function') {
			await chatStore.regenerateMessage(activeMessages[activeMessages.length - 1].id);
		}
	}

	/**
	 * Discards an interrupted session checkpoint cleanly.
	 */
	static discardSession(conversationId: string): void {
		if (!conversationId) return;

		WorkbenchAgentCheckpointService.clearCheckpoint(conversationId);
		agenticStore.clearSession(conversationId);
		this.notify(conversationId);
	}
}
