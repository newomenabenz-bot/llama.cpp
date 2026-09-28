/**
 * LlamaServerProvider - Default upstream adapter for llama-server.
 *
 * Implements IModelProvider by dispatching chat completions to the native
 * llama.cpp /v1/chat/completions endpoint with full support for SSE streaming,
 * tool calls, thinking/reasoning control, and resumable streams.
 */

import type { IModelProvider, ProviderId } from './types';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types/database';
import type { ApiChatMessageData } from '$lib/types/api';
import type { SettingsChatServiceOptions } from '$lib/types/settings';
import { ChatService } from '$lib/services/chat.service';

export class LlamaServerProvider implements IModelProvider {
	readonly id: ProviderId = 'llama-server';
	readonly name: string = 'Llama.cpp Server';

	/**
	 * Dispatches chat completion to llama-server.
	 */
	async sendMessage(
		messages: ApiChatMessageData[] | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })[],
		options: SettingsChatServiceOptions = {},
		conversationId?: string,
		signal?: AbortSignal
	): Promise<string | void> {
		return ChatService.sendLlamaServerMessage(messages, options, conversationId, signal);
	}

	/**
	 * Halts active reasoning via llama-server's /v1/chat/completions/control endpoint.
	 */
	async stopReasoning(completionId: string, model?: string | null): Promise<boolean> {
		return ChatService.stopReasoning(completionId, model);
	}

	/**
	 * Checks whether llama-server slots are idle.
	 */
	async isAvailable(): Promise<boolean> {
		return ChatService.areAllSlotsIdle();
	}
}
