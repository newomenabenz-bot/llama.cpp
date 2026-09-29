/**
 * GeminiProvider - Native Google Gemini API adapter.
 *
 * Implements IModelProvider by dispatching chat completions to the Google Gemini
 * REST / SSE endpoints (streamGenerateContent and generateContent) with full
 * translation for messages, multimodal content, tool calls, and reasoning/thought separation.
 */

import type { IModelProvider, ProviderId, ProviderMetadata } from './types';
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
	};
	functionResponse?: {
		name: string;
		response: Record<string, unknown>;
	};
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

/**
 * Clean JSON schema parameters for Gemini function declaration compatibility.
 */
export function cleanJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
	if (!schema || typeof schema !== 'object') {
		return { type: 'object', properties: {} };
	}

	const cleaned: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(schema)) {
		// Strip schema meta-keys that Gemini rejects
		if (key === '$schema' || key === '$id' || key === 'definitions' || key === '$defs') {
			continue;
		}

		if (key === 'properties' && value && typeof value === 'object') {
			const props: Record<string, unknown> = {};
			for (const [pKey, pVal] of Object.entries(value as Record<string, unknown>)) {
				props[pKey] = cleanJsonSchema(pVal as Record<string, unknown>);
			}
			cleaned.properties = props;
		} else if (key === 'items' && value && typeof value === 'object') {
			cleaned.items = cleanJsonSchema(value as Record<string, unknown>);
		} else {
			cleaned[key] = value;
		}
	}

	if (!cleaned.type && cleaned.properties) {
		cleaned.type = 'object';
	}

	// Filter required properties that do not exist in properties
	if (Array.isArray(cleaned.required)) {
		if (cleaned.properties && typeof cleaned.properties === 'object') {
			const propKeys = new Set(Object.keys(cleaned.properties as Record<string, unknown>));
			cleaned.required = (cleaned.required as unknown[]).filter(
				(r): r is string => typeof r === 'string' && propKeys.has(r)
			);
		}
		if ((cleaned.required as string[]).length === 0) {
			delete cleaned.required;
		}
	}

	return cleaned;
}

/**
 * Converts standard OpenAI / MCP tool definitions into Gemini functionDeclarations.
 */
export function formatGeminiTools(
	tools?: OpenAIToolDefinition[]
): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined {
	if (!tools || !Array.isArray(tools) || tools.length === 0) {
		return undefined;
	}

	const functionDeclarations = tools
		.filter((t) => t.type === 'function' && t.function?.name)
		.map((t) => ({
			name: t.function.name,
			description: t.function.description || '',
			parameters: cleanJsonSchema(t.function.parameters)
		}));

	if (functionDeclarations.length === 0) {
		return undefined;
	}

	return [{ functionDeclarations }];
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
				parts.push({
					functionCall: {
						name,
						args
					}
				});
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

export class GeminiProvider implements IModelProvider {
	readonly id: ProviderId = 'gemini';
	readonly name: string = 'Google Gemini';

	readonly metadata: ProviderMetadata = {
		id: 'gemini',
		name: 'Google Gemini',
		description: 'Google DeepMind Gemini Models via REST & SSE',
		enabled: true,
		isDefault: false
	};

	private apiKey?: string;
	private baseUrl: string = 'https://generativelanguage.googleapis.com';
	private defaultModel: string = 'gemini-2.5-flash';

	constructor(config: { apiKey?: string; baseUrl?: string; defaultModel?: string } = {}) {
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
			return this.streamChat(url, headers, requestBody, options, signal);
		} else {
			return this.sendNonStreaming(url, headers, requestBody, options, signal);
		}
	}

	/**
	 * Executes streaming chat completion and processes SSE stream.
	 */
	async streamChat(
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
			let usageMetadata: { promptTokenCount?: number; candidatesTokenCount?: number } | null = null;

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

								if (chunk.usageMetadata) {
									usageMetadata = chunk.usageMetadata;
								}

								const candidates = chunk.candidates;
								if (Array.isArray(candidates) && candidates.length > 0) {
									const candidate = candidates[0];
									const parts = candidate.content?.parts;

									if (Array.isArray(parts)) {
										for (const part of parts) {
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
												const toolCall: ApiChatCompletionToolCall = {
													id: toolCallId,
													type: 'function',
													function: {
														name: part.functionCall.name,
														arguments: JSON.stringify(part.functionCall.args || {})
													}
												};
												accumulatedToolCalls.push(toolCall);
												options.onToolCallChunk?.(JSON.stringify(accumulatedToolCalls));
												(options as { onToolCalls?: (calls: ApiChatCompletionToolCall[]) => void }).onToolCalls?.(accumulatedToolCalls);
											}
										}
									}
								}
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
							if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata;
							const candidates = chunk.candidates;
							if (Array.isArray(candidates) && candidates.length > 0) {
								const parts = candidates[0].content?.parts;
								if (Array.isArray(parts)) {
									for (const part of parts) {
										if (part.thought === true && typeof part.text === 'string') {
											accumulatedReasoning += part.text;
											options.onReasoningChunk?.(part.text);
										} else if (typeof part.text === 'string') {
											accumulatedContent += part.text;
											options.onChunk?.(part.text);
										}
									}
								}
							}
						} catch {
							// Ignore flush parse error
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
			if (usageMetadata) {
				timings = {
					prompt_n: usageMetadata.promptTokenCount,
					predicted_n: usageMetadata.candidatesTokenCount
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
				for (const part of data.candidates[0].content.parts) {
					if (part.thought === true && typeof part.text === 'string') {
						reasoning += part.text;
					} else if (typeof part.text === 'string') {
						content += part.text;
					} else if (part.functionCall) {
						const toolCallIndex = toolCalls.length;
						const toolCallId = `call_${part.functionCall.name}_${toolCallIndex}`;
						toolCalls.push({
							id: toolCallId,
							type: 'function',
							function: {
								name: part.functionCall.name,
								arguments: JSON.stringify(part.functionCall.args || {})
							}
						});
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
