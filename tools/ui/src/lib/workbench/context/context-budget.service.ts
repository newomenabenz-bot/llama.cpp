/**
 * WorkbenchContextBudgetService - Context monitoring, budgeting, and tool compaction orchestrator.
 *
 * Intercepts conversation messages before provider dispatch, monitors estimated tokens
 * against model context limits, and performs non-destructive head/tail compaction on
 * historical tool outputs while strictly protecting the current turn's active tool responses.
 */

import type { ApiChatMessageData } from '$lib/types';
import { compactToolOutput } from './tool-compactor';
import { estimateHistoryTokens } from './token-estimator';
import {
	DEFAULT_CONTEXT_BUDGET_CONFIG,
	type ContextBudgetConfig,
	type TokenEstimation
} from './types';

export class WorkbenchContextBudgetService {
	/**
	 * Computes the token estimation and threshold status for a message sequence.
	 */
	static getBudgetStatus(
		messages: ApiChatMessageData[],
		config?: Partial<ContextBudgetConfig>
	): TokenEstimation {
		const fullConfig: ContextBudgetConfig = { ...DEFAULT_CONTEXT_BUDGET_CONFIG, ...config };
		const totalTokens = estimateHistoryTokens(messages);
		const warningLimit = fullConfig.warningThreshold * fullConfig.maxTokens;
		const criticalLimit = fullConfig.criticalThreshold * fullConfig.maxTokens;

		return {
			isCritical: totalTokens >= criticalLimit,
			isWarning: totalTokens >= warningLimit,
			messageCount: messages.length,
			totalTokens
		};
	}

	/**
	 * Prepares messages for provider dispatch by enforcing the context budget.
	 *
	 * 1. Identifies the current turn's active tool responses (tail consecutive tool messages).
	 * 2. Compares total estimated tokens against warningThreshold.
	 * 3. If exceeding threshold, compacts historical tool outputs in reverse chronological order.
	 * 4. Strictly protects current-turn tool outputs from compaction.
	 */
	static prepareMessagesForDispatch(
		messages: ApiChatMessageData[],
		config?: Partial<ContextBudgetConfig>
	): ApiChatMessageData[] {
		if (!Array.isArray(messages) || messages.length === 0) {
			return messages;
		}

		const fullConfig: ContextBudgetConfig = { ...DEFAULT_CONTEXT_BUDGET_CONFIG, ...config };
		const warningCeiling = fullConfig.warningThreshold * fullConfig.maxTokens;

		// 1. Identify the current turn's active tool responses at the tail
		let currentTurnToolStartIndex = messages.length;
		while (
			currentTurnToolStartIndex > 0 &&
			messages[currentTurnToolStartIndex - 1]?.role === 'tool'
		) {
			currentTurnToolStartIndex--;
		}

		// 2. Evaluate initial token count
		let currentTokens = estimateHistoryTokens(messages);
		if (currentTokens <= warningCeiling) {
			return messages;
		}

		// 3. Compact historical tool messages in reverse chronological order
		const outputMessages: ApiChatMessageData[] = [...messages];

		for (let i = currentTurnToolStartIndex - 1; i >= 0; i--) {
			const msg = outputMessages[i];
			if (!msg || msg.role !== 'tool') {
				continue;
			}

			// Compact string content
			if (typeof msg.content === 'string') {
				const compaction = compactToolOutput(msg.content, fullConfig);
				if (compaction.compacted) {
					outputMessages[i] = {
						...msg,
						content: compaction.text
					};
				}
			} else if (Array.isArray(msg.content)) {
				// Handle multi-part tool results if present
				let anyPartCompacted = false;
				const updatedParts = msg.content.map((part) => {
					if (part.text && typeof part.text === 'string') {
						const compaction = compactToolOutput(part.text, fullConfig);
						if (compaction.compacted) {
							anyPartCompacted = true;
							return { ...part, text: compaction.text };
						}
					}
					return part;
				});

				if (anyPartCompacted) {
					outputMessages[i] = {
						...msg,
						content: updatedParts
					};
				}
			}

			// Re-check token budget
			currentTokens = estimateHistoryTokens(outputMessages);
			if (currentTokens <= warningCeiling) {
				break;
			}
		}

		return outputMessages;
	}
}
