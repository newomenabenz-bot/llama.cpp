/**
 * llama.provider.ts - Local Llama Provider adhering to IWorkbenchProvider and IModelProvider.
 *
 * Dispatches chat completions and tool calls to the native llama.cpp /v1/chat/completions endpoint
 * with full support for SSE streaming, Jinja tool schemas (--tools all), thinking control,
 * and unified chunk generation.
 */

import type {
	IModelProvider,
	IWorkbenchProvider,
	ProviderChatChunk,
	ProviderChatRequest,
	ProviderId,
	ProviderMetadata,
	WorkbenchModel
} from './provider.types';
import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types/database';
import type {
	ApiChatMessageData,
	ChatMessageTimings,
	OpenAIToolDefinition,
	SettingsChatServiceOptions
} from '$lib/types';
import { ChatService } from '$lib/services/chat.service';
import { modelsStore } from '$lib/stores/models/index.svelte';

export class LocalLlamaProvider implements IModelProvider, IWorkbenchProvider {
	readonly id: ProviderId = 'local-llama';
	readonly name: string = 'Local Llama Server';
	readonly displayName: string = 'Local Llama Server';

	readonly metadata: ProviderMetadata = {
		id: 'local-llama',
		name: 'Local Llama Server',
		description: 'Native llama-server instance hosting local GGUF models with Jinja tool execution',
		enabled: true,
		isDefault: true
	};

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

	/**
	 * Checks whether the provider is configured (local server requires no external key).
	 */
	isConfigured(): boolean {
		return true;
	}

	/**
	 * Fetches available models from llama-server.
	 */
	async fetchModels(): Promise<Array<WorkbenchModel>> {
		const models = modelsStore.models;
		if (models && models.length > 0) {
			return models.map((m) => ({
				id: m.model,
				displayName: m.name || m.model,
				description: `Local GGUF model (${m.model})`,
				contextLength: m.props?.context_length,
				isDefault: true,
				providerId: 'local-llama'
			}));
		}
		return [
			{
				id: 'default',
				displayName: 'Default Loaded GGUF Model',
				description: 'Primary model loaded in llama-server',
				isDefault: true,
				providerId: 'local-llama'
			}
		];
	}

	/**
	 * Streams chat completion chunks via an AsyncIterableIterator.
	 */
	async *streamChat(request: ProviderChatRequest): AsyncIterableIterator<ProviderChatChunk> {
		type ChunkQueueItem =
			| { type: 'chunk'; data: ProviderChatChunk }
			| { type: 'error'; error: Error }
			| { type: 'done' };

		const queue: ChunkQueueItem[] = [];
		let notify: (() => void) | null = null;

		const push = (item: ChunkQueueItem) => {
			queue.push(item);
			if (notify) {
				const fn = notify;
				notify = null;
				fn();
			}
		};

		// Convert ToolDefinition[] to OpenAIToolDefinition[] if provided
		const tools: OpenAIToolDefinition[] | undefined = request.tools
			? request.tools.map((t) =>
					'function' in t
						? (t as OpenAIToolDefinition)
						: {
								type: 'function' as const,
								function: {
									name: t.name,
									description: t.description,
									parameters: t.parameters as unknown as Record<string, unknown>
								}
							}
				)
			: undefined;

		const options: SettingsChatServiceOptions = {
			...request.options,
			model: request.model,
			temperature: request.temperature,
			max_tokens: request.maxTokens,
			tools,
			stream: true,
			onChunk: (text: string) => {
				push({ type: 'chunk', data: { content: text } });
			},
			onReasoningChunk: (chunk: string) => {
				push({ type: 'chunk', data: { reasoning: chunk } });
			},
			onToolCallChunk: (serializedCalls: string) => {
				try {
					const parsed = JSON.parse(serializedCalls);
					if (Array.isArray(parsed)) {
						push({ type: 'chunk', data: { toolCalls: parsed } });
					}
				} catch {
					// ignore json parse error
				}
			},
			onComplete: async (_finalContent?: string, _reasoningContent?: string, timings?: ChatMessageTimings) => {
				push({ type: 'chunk', data: { done: true, timings } });
				push({ type: 'done' });
			},
			onError: (err: Error) => {
				push({ type: 'error', error: err });
			}
		};

		this.sendMessage(request.messages, options, request.conversationId, request.signal).catch((err) => {
			push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
		});

		while (true) {
			while (queue.length > 0) {
				const item = queue.shift()!;
				if (item.type === 'chunk') {
					yield item.data;
				} else if (item.type === 'error') {
					throw item.error;
				} else if (item.type === 'done') {
					return;
				}
			}

			await new Promise<void>((resolve) => {
				notify = resolve;
			});
		}
	}
}
