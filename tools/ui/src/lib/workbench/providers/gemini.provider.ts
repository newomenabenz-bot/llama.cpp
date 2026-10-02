/**
 * GeminiProvider - Native Google Gemini API adapter.
 *
 * Implements IModelProvider by dispatching chat completions to the Google Gemini
 * REST / SSE endpoints (streamGenerateContent and generateContent) with full
 * translation for messages, multimodal content, tool calls, and reasoning/thought separation.
 */

import type { IModelProvider, ProviderId, ProviderMetadata } from './types';
import type {
	IWorkbenchProvider,
	WorkbenchModel,
	ProviderChatRequest,
	ProviderChatChunk,
	ToolDefinition
} from './provider.types';
import {
	cleanJsonSchema,
	toGeminiFunctionDeclarations,
	fromGeminiFunctionCall,
	toGeminiFunctionResponse,
	WORKBENCH_CORE_TOOLS
} from './provider.types';
import type {
	ApiChatCompletionToolCall,
	ApiChatMessageContentPart,
	ApiChatMessageData,
	ChatMessageTimings,
	DatabaseMessage,
	DatabaseMessageExtra,
	OpenAIToolDefinition,
	SettingsChatServiceOptions
} from '$lib/types';
import { ContentPartType, MessageRole } from '$lib/enums';
import { ChatService } from '$lib/services/chat.service';
import { WorkbenchContextBudgetService } from '../context';

/**
 * Discovered model metadata from Google Generative Language API.
 */
export interface DiscoveredGeminiModel {
	id: string;
	name: string;
	description?: string;
	inputTokenLimit?: number;
	outputTokenLimit?: number;
	supportedGenerationMethods?: string[];
}

/**
 * Result structure returned by verifyAndFetchGeminiModels.
 */
export interface ModelDiscoveryResult {
	success: boolean;
	models: Array<{ id: string; displayName: string; description: string }>;
	error?: {
		status?: number;
		code?: string;
		message: string;
	};
}

/**
 * Gemini API inline part structure.
 */
export interface GeminiPart {
	text?: string;
	thought?: boolean;
	inlineData?: {
		mimeType: string;
		data: string;
	};
	functionCall?: {
		name: string;
		args: Record<string, unknown>;
		thought_signature?: string;
		thoughtSignature?: string;
	};
	functionResponse?: {
		name: string;
		response: Record<string, unknown>;
	};
	thought_signature?: string;
	thoughtSignature?: string;
}

/**
 * Gemini API content turn structure.
 */
export interface GeminiContent {
	role: 'user' | 'model';
	parts: GeminiPart[];
}

/**
 * Formatted Gemini payload structure.
 */
export interface FormattedGeminiPayload {
	contents: GeminiContent[];
	systemInstruction?: {
		parts: Array<{ text: string }>;
	};
}

export {
	cleanJsonSchema,
	toGeminiFunctionDeclarations,
	fromGeminiFunctionCall,
	toGeminiFunctionResponse,
	WORKBENCH_CORE_TOOLS
};

/**
 * Converts standard OpenAI / MCP tool definitions into Gemini functionDeclarations.
 */
export function formatGeminiTools(
	tools?: Array<ToolDefinition | OpenAIToolDefinition>
): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined {
	return toGeminiFunctionDeclarations(tools);
}

/**
 * Extract tool calls from any message shape (ApiChatMessageData or DatabaseMessage)
 */
export function extractToolCalls(
	msg: ApiChatMessageData | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })
): ApiChatCompletionToolCall[] {
	if (!msg) return [];

	// 1. Direct tool_calls array (ApiChatMessageData standard)
	if ('tool_calls' in msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
		return msg.tool_calls;
	}

	// 2. Direct toolCalls array
	const anyMsg = msg as unknown as Record<string, unknown>;
	if (Array.isArray(anyMsg.toolCalls) && anyMsg.toolCalls.length > 0) {
		return anyMsg.toolCalls as ApiChatCompletionToolCall[];
	}

	// 3. Serialized JSON string in msg.toolCalls (DatabaseMessage standard)
	if (typeof anyMsg.toolCalls === 'string' && anyMsg.toolCalls.trim()) {
		try {
			const parsed = JSON.parse(anyMsg.toolCalls);
			if (Array.isArray(parsed) && parsed.length > 0) {
				return parsed as ApiChatCompletionToolCall[];
			}
		} catch {
			// ignore parse error
		}
	}

	// 4. Serialized JSON string in msg.tool_calls
	if (typeof anyMsg.tool_calls === 'string' && anyMsg.tool_calls.trim()) {
		try {
			const parsed = JSON.parse(anyMsg.tool_calls);
			if (Array.isArray(parsed) && parsed.length > 0) {
				return parsed as ApiChatCompletionToolCall[];
			}
		} catch {
			// ignore parse error
		}
	}

	// 5. Check if msg.parts has Gemini functionCall parts
	if (Array.isArray(anyMsg.parts)) {
		const result: ApiChatCompletionToolCall[] = [];
		for (let i = 0; i < anyMsg.parts.length; i++) {
			const p = anyMsg.parts[i] as GeminiPart;
			if (p?.functionCall) {
				const sig =
					p.thought_signature ??
					p.thoughtSignature ??
					p.functionCall.thought_signature ??
					p.functionCall.thoughtSignature;
				result.push(
					fromGeminiFunctionCall(
						p.functionCall,
						i,
						typeof sig === 'string' ? sig : undefined
					)
				);
			}
		}
		if (result.length > 0) return result;
	}

	return [];
}

/**
 * Converts standard ApiChatMessageData or DatabaseMessage array into Gemini contents and systemInstruction.
 */
export function formatGeminiContents(
	messages: Array<ApiChatMessageData | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })>,
	systemMessageOverride?: string
): FormattedGeminiPayload {
	const systemTexts: string[] = [];

	if (systemMessageOverride && systemMessageOverride.trim()) {
		systemTexts.push(systemMessageOverride.trim());
	}

	const contents: GeminiContent[] = [];

	// Map tool_call_id to function name to resolve tool responses that omit the name
	const toolCallNames = new Map<string, string>();
	const pendingToolCallNames: string[] = [];

	for (const msg of messages) {
		const calls = extractToolCalls(msg);
		for (const tc of calls) {
			if (tc.id && tc.function?.name) {
				toolCallNames.set(tc.id, tc.function.name);
			}
		}
	}

	for (const msg of messages) {
		const role = (msg as { role?: string }).role;

		// 1. System messages -> mapped to systemInstruction
		if (role === MessageRole.SYSTEM || role === 'system') {
			let text = '';
			if (typeof msg.content === 'string') {
				text = msg.content.trim();
			} else if (Array.isArray(msg.content)) {
				text = msg.content
					.filter((p) => p.text)
					.map((p) => p.text)
					.join('\n')
					.trim();
			}
			if (text.length > 0) {
				systemTexts.push(text);
			}
			continue;
		}

		// 2. User messages
		if (role === MessageRole.USER || role === 'user') {
			const parts: GeminiPart[] = [];

			if (typeof msg.content === 'string') {
				const trimmed = msg.content.trim();
				if (trimmed.length > 0) {
					parts.push({ text: msg.content });
				}
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.type === ContentPartType.TEXT || part.text !== undefined) {
						if (part.text && part.text.trim().length > 0) {
							parts.push({ text: part.text });
						}
					} else if (part.type === ContentPartType.IMAGE_URL || part.image_url) {
						const url = part.image_url?.url || '';
						if (url.startsWith('data:')) {
							const match = url.match(/^data:([^;]+);base64,(.+)$/);
							if (match) {
								parts.push({
									inlineData: {
										mimeType: match[1],
										data: match[2]
									}
								});
							} else {
								parts.push({ text: `[Image: ${url}]` });
							}
						} else if (url) {
							parts.push({ text: `[Image: ${url}]` });
						}
					}
				}
			}

			if (parts.length > 0) {
				const last = contents[contents.length - 1];
				// Only merge into previous turn if the previous turn is a user turn AND is NOT a functionResponse turn
				const isLastToolResponse =
					last?.role === 'user' && last.parts.some((p) => p.functionResponse !== undefined);
				if (last && last.role === 'user' && !isLastToolResponse) {
					last.parts.push(...parts);
				} else {
					contents.push({ role: 'user', parts });
				}
			}
			continue;
		}

		// 3. Assistant / Model messages -> role: 'model'
		if (role === MessageRole.ASSISTANT || role === 'assistant' || role === 'model') {
			const parts: GeminiPart[] = [];

			// Text content (sanitize empty string)
			if (typeof msg.content === 'string') {
				const trimmed = msg.content.trim();
				if (trimmed.length > 0) {
					parts.push({ text: msg.content });
				}
			} else if (Array.isArray(msg.content)) {
				for (const part of msg.content) {
					if (part.text && part.text.trim().length > 0) {
						parts.push({ text: part.text });
					}
				}
			}

			// Tool calls
			const calls = extractToolCalls(msg);
			for (const tc of calls) {
				let args: Record<string, unknown> = {};
				const rawArgs = tc.function?.arguments;
				if (typeof rawArgs === 'string') {
					try {
						args = JSON.parse(rawArgs);
					} catch {
						args = {};
					}
				} else if (typeof rawArgs === 'object' && rawArgs !== null) {
					args = rawArgs as Record<string, unknown>;
				}

				const name = tc.function?.name || 'unknown_function';
				pendingToolCallNames.push(name);

				const sig =
					(tc as Record<string, unknown>).thought_signature ??
					(tc as Record<string, unknown>).thoughtSignature ??
					(tc.function as Record<string, unknown>)?.thought_signature ??
					(tc.function as Record<string, unknown>)?.thoughtSignature;

				const fnCall: {
					name: string;
					args: Record<string, unknown>;
					thought_signature?: string;
					thoughtSignature?: string;
				} = {
					name,
					args
				};

				const part: GeminiPart = {
					functionCall: fnCall
				};

				if (sig) {
					const strSig = String(sig);
					fnCall.thought_signature = strSig;
					fnCall.thoughtSignature = strSig;
					part.thought_signature = strSig;
					part.thoughtSignature = strSig;
				}

				parts.push(part);
			}

			if (parts.length > 0) {
				const last = contents[contents.length - 1];
				if (last && last.role === 'model') {
					last.parts.push(...parts);
				} else {
					contents.push({ role: 'model', parts });
				}
			}
			continue;
		}

		// 4. Tool messages -> role: 'user' with functionResponse part
		if (role === MessageRole.TOOL || role === 'tool') {
			const anyMsg = msg as unknown as Record<string, unknown>;
			const toolCallId = (anyMsg.tool_call_id || anyMsg.toolCallId) as string | undefined;
			let fnName =
				(anyMsg.name as string | undefined) ||
				(toolCallId ? toolCallNames.get(toolCallId) : undefined);

			if (!fnName && pendingToolCallNames.length > 0) {
				fnName = pendingToolCallNames.shift();
			}

			if (!fnName) {
				fnName = toolCallId || 'tool_response';
			}

			let responseObj: Record<string, unknown>;
			if (typeof msg.content === 'string') {
				try {
					const parsed = JSON.parse(msg.content);
					if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
						responseObj = parsed as Record<string, unknown>;
					} else {
						responseObj = { content: parsed };
					}
				} catch {
					responseObj = { content: msg.content };
				}
			} else if (
				typeof msg.content === 'object' &&
				msg.content !== null &&
				!Array.isArray(msg.content)
			) {
				responseObj = msg.content as Record<string, unknown>;
			} else {
				responseObj = { content: msg.content };
			}

			const part: GeminiPart = {
				functionResponse: {
					name: fnName,
					response: responseObj
				}
			};

			const last = contents[contents.length - 1];
			// Bundle parallel tool responses into a single user turn if last turn is user and has functionResponse
			if (last && last.role === 'user' && last.parts.some((p) => p.functionResponse !== undefined)) {
				last.parts.push(part);
			} else {
				contents.push({ role: 'user', parts: [part] });
			}
			continue;
		}
	}

	const result: FormattedGeminiPayload = { contents };

	if (systemTexts.length > 0) {
		result.systemInstruction = {
			parts: systemTexts.map((text) => ({ text }))
		};
	}

	return result;
}

/**
 * Executes a live handshake against the Google Generative Language API.
 * Verifies the key and returns active models or a structured API error response.
 */
export async function verifyAndFetchGeminiModels(
	apiKey: string,
	baseUrl: string = 'https://generativelanguage.googleapis.com',
	signal?: AbortSignal
): Promise<ModelDiscoveryResult> {
	if (!apiKey?.trim()) {
		return { success: false, models: [], error: { message: 'API key cannot be empty' } };
	}
	try {
		const cleanKey = apiKey.trim();
		const url = `${baseUrl.replace(/\/+$/, '')}/v1beta/models?key=${encodeURIComponent(cleanKey)}`;
		const res = await fetch(url, { signal });
		const data = (await res.json().catch(() => ({}))) as {
			models?: Array<{
				name: string;
				displayName?: string;
				description?: string;
				supportedGenerationMethods?: string[];
			}>;
			error?: {
				code?: number;
				status?: string;
				message?: string;
			};
		};

		if (!res.ok) {
			return {
				success: false,
				models: [],
				error: {
					status: res.status,
					code: data?.error?.status || 'API_ERROR',
					message:
						data?.error?.message ||
						`HTTP ${res.status}: Failed to authenticate with Google API`
				}
			};
		}

		const models = (data.models || [])
			.filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
			.map((m) => ({
				id: m.name.replace(/^models\//, ''),
				displayName: m.displayName || m.name.replace(/^models\//, ''),
				description: m.description || ''
			}));

		return { success: true, models };
	} catch (err: unknown) {
		const message =
			err instanceof Error
				? err.message
				: 'Network error: Unable to reach Google API endpoint';
		return {
			success: false,
			models: [],
			error: {
				message
			}
		};
	}
}

export class GeminiProvider implements IModelProvider, IWorkbenchProvider {
	readonly id: ProviderId;
	readonly displayName: string = 'Google Gemini';
	readonly name: string = 'Google Gemini';

	readonly metadata: ProviderMetadata;

	private apiKey?: string;
	private baseUrl: string = 'https://generativelanguage.googleapis.com';
	private defaultModel: string = 'gemini-2.5-flash';

	constructor(config: { apiKey?: string; baseUrl?: string; defaultModel?: string; id?: ProviderId } = {}) {
		this.id = config.id || 'google-gemini';
		this.metadata = {
			id: this.id,
			name: 'Google Gemini',
			description: 'Google DeepMind Gemini Models via REST & SSE',
			enabled: true,
			isDefault: false
		};
		if (config.apiKey) this.apiKey = config.apiKey;
		if (config.baseUrl) this.baseUrl = config.baseUrl;
		if (config.defaultModel) this.defaultModel = config.defaultModel;
	}

	setApiKey(key: string): void {
		this.apiKey = key.trim();
	}

	getApiKey(): string | undefined {
		if (this.apiKey) return this.apiKey;
		if (typeof localStorage !== 'undefined') {
			const stored = localStorage.getItem('gemini_api_key') || localStorage.getItem('geminiApiKey');
			if (stored) return stored.trim();
		}
		if (typeof process !== 'undefined' && process.env) {
			const envKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
			if (envKey) return envKey.trim();
		}
		return undefined;
	}

	setBaseUrl(url: string): void {
		this.baseUrl = url.replace(/\/+$/, '');
	}

	getBaseUrl(): string {
		return this.baseUrl;
	}

	setDefaultModel(model: string): void {
		this.defaultModel = model;
	}

	getDefaultModel(): string {
		return this.defaultModel;
	}

	isConfigured(): boolean {
		return Boolean(this.getApiKey());
	}

	async isAvailable(): Promise<boolean> {
		return this.isConfigured();
	}

	/**
	 * Executes a live handshake against the Google Generative Language API.
	 * Verifies the key and returns active models or detailed error payload.
	 */
	static async fetchAvailableModels(
		apiKey: string,
		baseUrl: string = 'https://generativelanguage.googleapis.com',
		signal?: AbortSignal
	): Promise<DiscoveredGeminiModel[]> {
		const cleanKey = apiKey.trim();
		if (!cleanKey) return [];

		const result = await verifyAndFetchGeminiModels(cleanKey, baseUrl, signal);
		if (!result.success) {
			throw new Error(result.error?.message || 'Failed to fetch Gemini models');
		}

		return result.models.map((m) => ({
			id: m.id,
			name: m.displayName || m.id,
			description: m.description
		}));
	}

	async fetchAvailableModels(signal?: AbortSignal): Promise<DiscoveredGeminiModel[]> {
		const key = this.getApiKey();
		if (!key) return [];
		return GeminiProvider.fetchAvailableModels(key, this.baseUrl, signal);
	}

	/**
	 * Verifies the key and returns active models or structured error payload.
	 */
	async verifyAndFetchModels(apiKey?: string, signal?: AbortSignal): Promise<ModelDiscoveryResult> {
		const key = apiKey || this.getApiKey();
		if (!key) {
			return {
				success: false,
				models: [],
				error: { message: 'Gemini API key is not configured' }
			};
		}
		return verifyAndFetchGeminiModels(key, this.baseUrl, signal);
	}

	/**
	 * Fetches available models from Google Generative Language API.
	 * Implements IWorkbenchProvider contract.
	 */
	async fetchModels(credentials?: Record<string, unknown> | string): Promise<Array<WorkbenchModel>> {
		let key: string | undefined;
		if (typeof credentials === 'string') {
			key = credentials;
		} else if (credentials && typeof credentials === 'object' && 'apiKey' in credentials) {
			key = String((credentials as Record<string, unknown>).apiKey || '');
		} else {
			key = this.getApiKey();
		}

		if (!key) {
			return [];
		}

		const discovery = await this.verifyAndFetchModels(key);
		if (!discovery.success || !discovery.models) {
			return [];
		}

		return discovery.models.map((m) => ({
			id: m.id,
			displayName: m.displayName || m.id,
			description: m.description,
			providerId: this.id
		}));
	}

	/**
	 * Dispatches chat completion request to Gemini.
	 */
	async sendMessage(
		messages: ApiChatMessageData[] | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })[],
		options: SettingsChatServiceOptions = {},
		conversationId?: string,
		signal?: AbortSignal
	): Promise<string | void> {
		if (signal?.aborted) {
			return;
		}

		const apiKey = this.getApiKey();
		if (!apiKey) {
			const error = new Error(
				'Gemini API key is not configured. Please provide an API key in settings.'
			);
			error.name = 'AuthenticationError';
			options.onError?.(error);
			throw error;
		}

		const model = options.model || this.defaultModel;
		options.onModel?.(model);

		const normalizedMessages = await ChatService.normalizeMessagesForApi(messages);
		const budgetedMessages = WorkbenchContextBudgetService.prepareMessagesForDispatch(
			normalizedMessages,
			{ maxTokens: 1000000 }
		);
		const { contents, systemInstruction } = formatGeminiContents(
			budgetedMessages,
			options.systemMessage
		);

		const requestBody: Record<string, unknown> = { contents };
		if (systemInstruction) {
			requestBody.systemInstruction = systemInstruction;
		}

		const geminiTools = formatGeminiTools(options.tools);
		if (geminiTools) {
			requestBody.tools = geminiTools;
		}

		const generationConfig: Record<string, unknown> = {};
		if (typeof options.temperature === 'number') {
			generationConfig.temperature = options.temperature;
		}
		if (typeof options.max_tokens === 'number') {
			generationConfig.maxOutputTokens = options.max_tokens;
		}
		if (typeof options.top_p === 'number') {
			generationConfig.topP = options.top_p;
		}
		if (typeof options.top_k === 'number') {
			generationConfig.topK = options.top_k;
		}
		if (options.enableThinking === false) {
			generationConfig.thinkingConfig = { thinkingBudget: 0 };
		} else if (options.enableThinking === true) {
			generationConfig.thinkingConfig = { thinkingBudget: 1024 };
		}

		if (Object.keys(generationConfig).length > 0) {
			requestBody.generationConfig = generationConfig;
		}

		const isStreaming = options.stream !== false;
		const endpoint = isStreaming ? 'streamGenerateContent' : 'generateContent';
		const queryParams = new URLSearchParams();
		if (isStreaming) {
			queryParams.set('alt', 'sse');
		}
		queryParams.set('key', apiKey);

		const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:${endpoint}?${queryParams.toString()}`;
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'x-goog-api-key': apiKey
		};

		if (isStreaming) {
			return this.executeSseStream(url, headers, requestBody, options, signal);
		} else {
			return this.sendNonStreaming(url, headers, requestBody, options, signal);
		}
	}

	/**
	 * Streams chat completion chunks via an AsyncIterableIterator.
	 * Implements IWorkbenchProvider contract.
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
			model: request.model || this.defaultModel,
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

	/**
	 * Executes streaming chat completion and processes SSE stream.
	 */
	private async executeSseStream(
		url: string,
		headers: Record<string, string>,
		body: Record<string, unknown>,
		options: SettingsChatServiceOptions = {},
		signal?: AbortSignal
	): Promise<void> {
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal
			});

			if (!response.ok) {
				let errorData: unknown = null;
				try {
					errorData = await response.json();
				} catch {
					try {
						errorData = { message: await response.text() };
					} catch {
						errorData = { message: response.statusText };
					}
				}
				const error = this.handleApiError(response.status, response.statusText, errorData);
				options.onError?.(error);
				throw error;
			}

			if (!response.body) {
				const error = new Error('Gemini streaming response body is null');
				options.onError?.(error);
				throw error;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder('utf-8');
			let buffer = '';
			let accumulatedContent = '';
			let accumulatedReasoning = '';
			const accumulatedToolCalls: ApiChatCompletionToolCall[] = [];
			let lastSeenThoughtSignature: string | undefined;
			let usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number } | null = null;

			const processChunk = (chunk: Record<string, unknown>) => {
				if (chunk.usageMetadata) {
					usageMetadata = chunk.usageMetadata as {
						promptTokenCount?: number;
						candidatesTokenCount?: number;
					};
				}

				const candidates = chunk.candidates;
				if (Array.isArray(candidates) && candidates.length > 0) {
					const candidate = candidates[0] as Record<string, unknown>;
					const content = candidate.content as Record<string, unknown> | undefined;
					const parts = content?.parts;

					// Extract candidate-level, content-level, or chunk-level thought signature
					const candSig =
						(candidate.thought_signature as string | undefined) ??
						(candidate.thoughtSignature as string | undefined) ??
						(content?.thought_signature as string | undefined) ??
						(content?.thoughtSignature as string | undefined) ??
						(chunk.thought_signature as string | undefined) ??
						(chunk.thoughtSignature as string | undefined);

					if (typeof candSig === 'string' && candSig.trim().length > 0) {
						lastSeenThoughtSignature = candSig.trim();
					}

					if (Array.isArray(parts)) {
						for (const rawPart of parts) {
							const part = rawPart as GeminiPart;
							const partSig =
								(part as Record<string, unknown>).thought_signature ??
								(part as Record<string, unknown>).thoughtSignature ??
								(part.functionCall as Record<string, unknown>)?.thought_signature ??
								(part.functionCall as Record<string, unknown>)?.thoughtSignature;

							if (typeof partSig === 'string' && partSig.trim().length > 0) {
								lastSeenThoughtSignature = partSig.trim();
							}

							// If we found a thought_signature (even on a standalone chunk/part), stitch it into any prior tool calls
							if (lastSeenThoughtSignature && accumulatedToolCalls.length > 0) {
								let stitched = false;
								for (const tc of accumulatedToolCalls) {
									if (!tc.thought_signature) {
										tc.thought_signature = lastSeenThoughtSignature;
										tc.thoughtSignature = lastSeenThoughtSignature;
										if (tc.function) {
											tc.function.thought_signature = lastSeenThoughtSignature;
											tc.function.thoughtSignature = lastSeenThoughtSignature;
										}
										stitched = true;
									}
								}
								if (stitched) {
									options.onToolCallChunk?.(JSON.stringify(accumulatedToolCalls));
									(options as { onToolCalls?: (calls: ApiChatCompletionToolCall[]) => void }).onToolCalls?.(accumulatedToolCalls);
								}
							}

							// Thought / reasoning part
							if (part.thought === true && typeof part.text === 'string') {
								accumulatedReasoning += part.text;
								options.onReasoningChunk?.(part.text);
							} else if (typeof part.text === 'string') {
								// Regular content part
								accumulatedContent += part.text;
								options.onChunk?.(part.text);
							} else if (part.functionCall) {
								// Function call part
								const toolCallIndex = accumulatedToolCalls.length;
								const toolCallId = `call_${part.functionCall.name}_${toolCallIndex}`;
								const sig =
									(typeof partSig === 'string' && partSig.trim().length > 0 && partSig.trim()) ||
									(typeof candSig === 'string' && candSig.trim().length > 0 && candSig.trim()) ||
									lastSeenThoughtSignature;

								const toolCall: ApiChatCompletionToolCall = fromGeminiFunctionCall(
									part.functionCall,
									toolCallId,
									typeof sig === 'string' ? sig : undefined
								);
								accumulatedToolCalls.push(toolCall);
								options.onToolCallChunk?.(JSON.stringify(accumulatedToolCalls));
								(options as { onToolCalls?: (calls: ApiChatCompletionToolCall[]) => void }).onToolCalls?.(accumulatedToolCalls);
							}
						}
					}
				}
			};

			try {
				while (true) {
					if (signal?.aborted) {
						break;
					}

					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split('\n');
					buffer = lines.pop() ?? '';

					for (const rawLine of lines) {
						const line = rawLine.trim();
						if (!line || line.startsWith(':')) continue;

						if (line.startsWith('data:')) {
							const jsonStr = line.slice(5).trim();
							if (jsonStr === '[DONE]') continue;

							try {
								const chunk = JSON.parse(jsonStr);
								processChunk(chunk);
							} catch {
								// Ignore malformed JSON chunk line
							}
						}
					}
				}

				// Flush any remaining buffer line
				if (buffer.trim().startsWith('data:')) {
					const jsonStr = buffer.trim().slice(5).trim();
					if (jsonStr && jsonStr !== '[DONE]') {
						try {
							const chunk = JSON.parse(jsonStr);
							processChunk(chunk);
						} catch {
							// Ignore flush parse error
						}
					}
				}

				if (lastSeenThoughtSignature) {
					for (const tc of accumulatedToolCalls) {
						if (!tc.thought_signature) {
							tc.thought_signature = lastSeenThoughtSignature;
							tc.thoughtSignature = lastSeenThoughtSignature;
							if (tc.function) {
								tc.function.thought_signature = lastSeenThoughtSignature;
								tc.function.thoughtSignature = lastSeenThoughtSignature;
							}
						}
					}
				}
			} finally {
				try {
					reader.releaseLock();
				} catch {
					// Ignore releaseLock error
				}
			}

			let timings: ChatMessageTimings | undefined;
			const finalUsage = usageMetadata as {
				promptTokenCount?: number;
				candidatesTokenCount?: number;
			} | null;
			if (finalUsage) {
				timings = {
					prompt_n: finalUsage.promptTokenCount,
					predicted_n: finalUsage.candidatesTokenCount
				};
				options.onTimings?.(timings);
			}

			const serializedToolCalls =
				accumulatedToolCalls.length > 0 ? JSON.stringify(accumulatedToolCalls) : undefined;

			options.onComplete?.(
				accumulatedContent,
				accumulatedReasoning || undefined,
				timings,
				serializedToolCalls
			);
		} catch (error) {
			if (
				(error instanceof Error && error.name === 'AbortError') ||
				signal?.aborted
			) {
				return;
			}
			const err = error instanceof Error ? error : new Error(String(error));
			options.onError?.(err);
			throw err;
		}
	}

	/**
	 * Non-streaming chat completion execution.
	 */
	private async sendNonStreaming(
		url: string,
		headers: Record<string, string>,
		body: Record<string, unknown>,
		options: SettingsChatServiceOptions = {},
		signal?: AbortSignal
	): Promise<string> {
		try {
			const response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(body),
				signal
			});

			if (!response.ok) {
				let errorData: unknown = null;
				try {
					errorData = await response.json();
				} catch {
					try {
						errorData = { message: await response.text() };
					} catch {
						errorData = { message: response.statusText };
					}
				}
				const error = this.handleApiError(response.status, response.statusText, errorData);
				options.onError?.(error);
				throw error;
			}

			const data = (await response.json()) as {
				candidates?: Array<{
					content?: {
						parts?: GeminiPart[];
					};
				}>;
				usageMetadata?: {
					promptTokenCount?: number;
					candidatesTokenCount?: number;
				};
			};

			let content = '';
			let reasoning = '';
			const toolCalls: ApiChatCompletionToolCall[] = [];

			if (data.candidates && data.candidates[0]?.content?.parts) {
				const candidate = data.candidates[0] as Record<string, unknown>;
				const contentObj = candidate.content as Record<string, unknown> | undefined;
				const candSig =
					(candidate.thought_signature as string | undefined) ??
					(candidate.thoughtSignature as string | undefined) ??
					(contentObj?.thought_signature as string | undefined) ??
					(contentObj?.thoughtSignature as string | undefined);

				let nonStreamSig: string | undefined =
					typeof candSig === 'string' && candSig.trim().length > 0 ? candSig.trim() : undefined;

				for (const rawPart of data.candidates[0].content.parts) {
					const part = rawPart as GeminiPart;
					const partSig =
						(part as Record<string, unknown>).thought_signature ??
						(part as Record<string, unknown>).thoughtSignature ??
						(part.functionCall as Record<string, unknown>)?.thought_signature ??
						(part.functionCall as Record<string, unknown>)?.thoughtSignature;

					if (typeof partSig === 'string' && partSig.trim().length > 0) {
						nonStreamSig = partSig.trim();
					}

					if (part.thought === true && typeof part.text === 'string') {
						reasoning += part.text;
					} else if (typeof part.text === 'string') {
						content += part.text;
					} else if (part.functionCall) {
						const toolCallIndex = toolCalls.length;
						const toolCallId = `call_${part.functionCall.name}_${toolCallIndex}`;
						const sig =
							(typeof partSig === 'string' && partSig.trim().length > 0 && partSig.trim()) ||
							nonStreamSig;
						const toolCall = fromGeminiFunctionCall(
							part.functionCall,
							toolCallId,
							typeof sig === 'string' ? sig : undefined
						);
						toolCalls.push(toolCall);
					}
				}

				if (nonStreamSig) {
					for (const tc of toolCalls) {
						if (!tc.thought_signature) {
							tc.thought_signature = nonStreamSig;
							tc.thoughtSignature = nonStreamSig;
							if (tc.function) {
								tc.function.thought_signature = nonStreamSig;
								tc.function.thoughtSignature = nonStreamSig;
							}
						}
					}
				}
			}

			let timings: ChatMessageTimings | undefined;
			if (data.usageMetadata) {
				timings = {
					prompt_n: data.usageMetadata.promptTokenCount,
					predicted_n: data.usageMetadata.candidatesTokenCount
				};
				options.onTimings?.(timings);
			}

			const serializedToolCalls =
				toolCalls.length > 0 ? JSON.stringify(toolCalls) : undefined;

			if (reasoning) {
				options.onReasoningChunk?.(reasoning);
			}
			if (content) {
				options.onChunk?.(content);
			}
			if (serializedToolCalls) {
				options.onToolCallChunk?.(serializedToolCalls);
				(options as { onToolCalls?: (calls: ApiChatCompletionToolCall[]) => void }).onToolCalls?.(toolCalls);
			}

			options.onComplete?.(content, reasoning || undefined, timings, serializedToolCalls);
			return content;
		} catch (error) {
			if (
				(error instanceof Error && error.name === 'AbortError') ||
				signal?.aborted
			) {
				return '';
			}
			const err = error instanceof Error ? error : new Error(String(error));
			options.onError?.(err);
			throw err;
		}
	}

	/**
	 * Maps HTTP and API errors to structured error types.
	 */
	private handleApiError(status: number, statusText: string, errorBody: unknown): Error {
		let message = '';
		let errorType = '';

		if (errorBody && typeof errorBody === 'object') {
			const record = errorBody as Record<string, unknown>;
			if (record.error && typeof record.error === 'object') {
				const errObj = record.error as Record<string, unknown>;
				message = String(errObj.message || JSON.stringify(errObj));
				errorType = String(errObj.status || '');
			} else if (record.message) {
				message = String(record.message);
			}
		}

		if (!message) {
			message = statusText || `HTTP ${status}`;
		}

		let error: Error;
		if (
			status === 429 ||
			errorType === 'RESOURCE_EXHAUSTED' ||
			message.toLowerCase().includes('quota')
		) {
			error = new Error(`Gemini rate limit / quota exceeded (${status}): ${message}`);
			error.name = 'RateLimitError';
		} else if (status === 400 || errorType === 'INVALID_ARGUMENT') {
			error = new Error(`Gemini bad request (${status}): ${message}`);
			error.name = 'BadRequestError';
		} else if (status === 401 || status === 403 || errorType === 'PERMISSION_DENIED') {
			error = new Error(`Gemini authentication error (${status}): ${message}`);
			error.name = 'AuthenticationError';
		} else {
			error = new Error(`Gemini API error (${status}): ${message}`);
			error.name = 'GeminiApiError';
		}

		return error;
	}
}
