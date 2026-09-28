/**
 * Fast deterministic token estimation for OMENA Autonomous Workbench.
 *
 * Employs calibrated 3.85 chars/token heuristic and structural framing overheads
 * for multimodal parts, tool declarations, and reasoning channels.
 */

import type { ApiChatMessageContentPart, ApiChatMessageData, DatabaseMessage } from '$lib/types';

export const CHARS_PER_TOKEN = 3.85;
export const BASE_MESSAGE_OVERHEAD_TOKENS = 4;
export const IMAGE_TOKEN_ESTIMATE = 256;
export const AUDIO_TOKEN_ESTIMATE = 128;

/**
 * Calculates estimated tokens for a plain text string.
 */
export function estimateTextTokens(text?: string | null): number {
	if (!text) return 0;
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimates token consumption for an individual message (API format or Database format).
 */
export function estimateMessageTokens(
	message: ApiChatMessageData | DatabaseMessage | Record<string, unknown>
): number {
	if (!message) return 0;

	let tokens = BASE_MESSAGE_OVERHEAD_TOKENS;

	// 1. Content estimation
	const content = (message as { content?: unknown }).content;
	if (typeof content === 'string') {
		tokens += estimateTextTokens(content);
	} else if (Array.isArray(content)) {
		for (const part of content as ApiChatMessageContentPart[]) {
			if (part.text) {
				tokens += estimateTextTokens(part.text);
			} else if (part.image_url) {
				tokens += IMAGE_TOKEN_ESTIMATE;
			} else if (part.input_audio) {
				tokens += AUDIO_TOKEN_ESTIMATE;
			} else if (part.input_video) {
				tokens += IMAGE_TOKEN_ESTIMATE;
			}
		}
	}

	// 2. Reasoning / Thinking channel
	const reasoning =
		(message as { reasoning_content?: string }).reasoning_content ??
		(message as { reasoningContent?: string }).reasoningContent ??
		(message as { thinking?: string }).thinking;

	if (reasoning && typeof reasoning === 'string') {
		tokens += estimateTextTokens(reasoning);
	}

	// 3. Tool Calls (proposals by assistant)
	const toolCalls =
		(message as { tool_calls?: unknown }).tool_calls ??
		(message as { toolCalls?: unknown }).toolCalls;

	if (Array.isArray(toolCalls)) {
		for (const tc of toolCalls) {
			const name = tc?.function?.name || '';
			const args =
				typeof tc?.function?.arguments === 'string'
					? tc.function.arguments
					: tc?.function?.arguments
						? JSON.stringify(tc.function.arguments)
						: '';
			tokens += estimateTextTokens(name) + estimateTextTokens(args) + 4;
		}
	} else if (typeof toolCalls === 'string' && toolCalls.trim().length > 0) {
		tokens += estimateTextTokens(toolCalls);
	}

	// 4. Tool Call ID (tool result framing)
	const toolCallId =
		(message as { tool_call_id?: string }).tool_call_id ??
		(message as { toolCallId?: string }).toolCallId;
	if (toolCallId) {
		tokens += estimateTextTokens(toolCallId);
	}

	// 5. Database Message Attachments (extra)
	const extra = (message as { extra?: unknown[] }).extra;
	if (Array.isArray(extra)) {
		for (const item of extra) {
			if (item && typeof item === 'object') {
				const itemContent = (item as { content?: string }).content;
				if (itemContent && typeof itemContent === 'string') {
					tokens += estimateTextTokens(itemContent);
				} else if ((item as { base64Url?: string }).base64Url) {
					tokens += IMAGE_TOKEN_ESTIMATE;
				} else if ((item as { base64Data?: string }).base64Data) {
					tokens += AUDIO_TOKEN_ESTIMATE;
				}
			}
		}
	}

	return tokens;
}

/**
 * Estimates the cumulative token consumption for an array of conversation messages.
 */
export function estimateHistoryTokens(
	messages: Array<ApiChatMessageData | DatabaseMessage | Record<string, unknown>>
): number {
	if (!Array.isArray(messages) || messages.length === 0) return 0;

	return messages.reduce((total, msg) => total + estimateMessageTokens(msg), 0);
}
