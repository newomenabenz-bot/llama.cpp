/**
 * Unit tests for GeminiProvider and ProviderService.
 *
 * Verifies:
 * - ProviderService registration and default routing
 * - formatGeminiContents message translation across all roles (system, user, assistant, tool)
 * - formatGeminiTools schema cleaning and function declaration conversion
 * - SSE stream parsing with separation of reasoning/thought chunks and regular content
 * - Function call detection and conversion to ApiChatCompletionToolCall
 * - Non-streaming completions
 * - Error mapping for 400, 401/403, and 429 status codes
 * - AbortSignal cancellation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cleanJsonSchema,
	formatGeminiContents,
	formatGeminiTools,
	GeminiProvider
} from '$lib/workbench/providers/gemini.provider';
import { ProviderService } from '$lib/workbench/providers/provider.service';
import { ContentPartType, MessageRole } from '$lib/enums';
import type {
	ApiChatMessageData,
	OpenAIToolDefinition,
	SettingsChatServiceOptions
} from '$lib/types';

// Helper to create a Web ReadableStream for SSE chunk testing
function createMockSseStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		}
	});
}

describe('ProviderService', () => {
	beforeEach(() => {
		// Reset to default provider
		ProviderService.setActiveProvider('llama-server');
	});

	it('defaults to llama-server as the active provider', () => {
		expect(ProviderService.getActiveProviderId()).toBe('llama-server');
		const active = ProviderService.getActiveProvider();
		expect(active.id).toBe('llama-server');
	});

	it('has GeminiProvider registered and retrievable', () => {
		const gemini = ProviderService.getProvider('gemini');
		expect(gemini).toBeDefined();
		expect(gemini?.id).toBe('gemini');
		expect(gemini?.name).toBe('Google Gemini');
	});

	it('allows dynamic switching between llama-server and gemini', () => {
		ProviderService.setActiveProvider('gemini');
		expect(ProviderService.getActiveProviderId()).toBe('gemini');
		expect(ProviderService.getActiveProvider().id).toBe('gemini');

		ProviderService.setActiveProvider('llama-server');
		expect(ProviderService.getActiveProviderId()).toBe('llama-server');
		expect(ProviderService.getActiveProvider().id).toBe('llama-server');
	});

	it('throws an error when setting an unregistered provider', () => {
		expect(() => ProviderService.setActiveProvider('unknown-provider')).toThrow(
			'Provider "unknown-provider" is not registered'
		);
	});
});

describe('Gemini Message & Schema Translation', () => {
	it('translates system messages into systemInstruction', () => {
		const messages: ApiChatMessageData[] = [
			{ role: MessageRole.SYSTEM, content: 'You are an autonomous AI coding assistant.' },
			{ role: MessageRole.USER, content: 'Hello' }
		];

		const result = formatGeminiContents(messages);

		expect(result.systemInstruction).toBeDefined();
		expect(result.systemInstruction?.parts).toEqual([
			{ text: 'You are an autonomous AI coding assistant.' }
		]);
		expect(result.contents).toHaveLength(1);
		expect(result.contents[0].role).toBe('user');
	});

	it('appends systemMessageOverride into systemInstruction', () => {
		const messages: ApiChatMessageData[] = [{ role: MessageRole.USER, content: 'Hello' }];

		const result = formatGeminiContents(messages, 'Global system instructions.');

		expect(result.systemInstruction).toBeDefined();
		expect(result.systemInstruction?.parts).toEqual([{ text: 'Global system instructions.' }]);
	});

	it('translates plain text user and assistant messages', () => {
		const messages: ApiChatMessageData[] = [
			{ role: MessageRole.USER, content: 'How are you?' },
			{ role: MessageRole.ASSISTANT, content: 'I am doing well, thank you!' }
		];

		const result = formatGeminiContents(messages);

		expect(result.contents).toHaveLength(2);
		expect(result.contents[0]).toEqual({
			role: 'user',
			parts: [{ text: 'How are you?' }]
		});
		expect(result.contents[1]).toEqual({
			role: 'model',
			parts: [{ text: 'I am doing well, thank you!' }]
		});
	});

	it('translates multimodal user messages with base64 data URLs', () => {
		const messages: ApiChatMessageData[] = [
			{
				role: MessageRole.USER,
				content: [
					{ type: ContentPartType.TEXT, text: 'Analyze this image:' },
					{
						type: ContentPartType.IMAGE_URL,
						image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE=' }
					}
				]
			}
		];

		const result = formatGeminiContents(messages);

		expect(result.contents).toHaveLength(1);
		expect(result.contents[0].parts).toEqual([
			{ text: 'Analyze this image:' },
			{ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAE=' } }
		]);
	});

	it('translates assistant tool calls into Gemini functionCall parts', () => {
		const messages: ApiChatMessageData[] = [
			{ role: MessageRole.USER, content: 'What is the weather?' },
			{
				role: MessageRole.ASSISTANT,
				content: '',
				tool_calls: [
					{
						id: 'call_weather_1',
						type: 'function',
						function: {
							name: 'get_current_weather',
							arguments: JSON.stringify({ location: 'Tokyo', unit: 'celsius' })
						}
					}
				]
			}
		];

		const result = formatGeminiContents(messages);

		expect(result.contents).toHaveLength(2);
		expect(result.contents[1].role).toBe('model');
		expect(result.contents[1].parts).toEqual([
			{
				functionCall: {
					name: 'get_current_weather',
					args: { location: 'Tokyo', unit: 'celsius' }
				}
			}
		]);
	});

	it('translates tool responses into Gemini functionResponse parts matching earlier tool calls', () => {
		const messages: ApiChatMessageData[] = [
			{ role: MessageRole.USER, content: 'What is the weather?' },
			{
				role: MessageRole.ASSISTANT,
				content: '',
				tool_calls: [
					{
						id: 'call_weather_1',
						type: 'function',
						function: {
							name: 'get_current_weather',
							arguments: '{"location":"Tokyo"}'
						}
					}
				]
			},
			{
				role: MessageRole.TOOL,
				tool_call_id: 'call_weather_1',
				content: JSON.stringify({ temperature: 22, condition: 'Sunny' })
			}
		];

		const result = formatGeminiContents(messages);

		expect(result.contents).toHaveLength(3);
		expect(result.contents[2].role).toBe('user');
		expect(result.contents[2].parts).toEqual([
			{
				functionResponse: {
					name: 'get_current_weather',
					response: { temperature: 22, condition: 'Sunny' }
				}
			}
		]);
	});

	it('merges consecutive tool responses into a single user turn', () => {
		const messages: ApiChatMessageData[] = [
			{
				role: MessageRole.ASSISTANT,
				content: '',
				tool_calls: [
					{ id: 'c1', type: 'function', function: { name: 'tool_a', arguments: '{}' } },
					{ id: 'c2', type: 'function', function: { name: 'tool_b', arguments: '{}' } }
				]
			},
			{ role: MessageRole.TOOL, tool_call_id: 'c1', content: '{"resA":1}' },
			{ role: MessageRole.TOOL, tool_call_id: 'c2', content: '{"resB":2}' }
		];

		const result = formatGeminiContents(messages);

		expect(result.contents).toHaveLength(2);
		expect(result.contents[1].role).toBe('user');
		expect(result.contents[1].parts).toHaveLength(2);
		expect(result.contents[1].parts[0]).toEqual({
			functionResponse: { name: 'tool_a', response: { resA: 1 } }
		});
		expect(result.contents[1].parts[1]).toEqual({
			functionResponse: { name: 'tool_b', response: { resB: 2 } }
		});
	});

	it('cleans JSON schema and formats tools for Gemini functionDeclarations', () => {
		const tools: OpenAIToolDefinition[] = [
			{
				type: 'function',
				function: {
					name: 'search_codebase',
					description: 'Search repository files',
					parameters: {
						$schema: 'http://json-schema.org/draft-07/schema#',
						type: 'object',
						properties: {
							query: { type: 'string', description: 'The search term' }
						},
						required: ['query']
					}
				}
			}
		];

		const formatted = formatGeminiTools(tools);

		expect(formatted).toBeDefined();
		expect(formatted).toHaveLength(1);
		expect(formatted![0].functionDeclarations).toHaveLength(1);

		const decl = formatted![0].functionDeclarations[0];
		expect(decl.name).toBe('search_codebase');
		expect(decl.description).toBe('Search repository files');
		expect(decl.parameters).toEqual({
			type: 'object',
			properties: {
				query: { type: 'string', description: 'The search term' }
			},
			required: ['query']
		});
		// $schema must be stripped
		expect((decl.parameters as Record<string, unknown>).$schema).toBeUndefined();
	});

	it('returns undefined for empty tools array', () => {
		expect(formatGeminiTools([])).toBeUndefined();
		expect(formatGeminiTools(undefined)).toBeUndefined();
	});
});

describe('GeminiProvider SSE Stream Parsing', () => {
	let provider: GeminiProvider;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		provider = new GeminiProvider({ apiKey: 'test-api-key-12345' });
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('parses regular content chunks and dispatches onChunk and onComplete', async () => {
		const sseData = [
			'data: {"candidates":[{"content":{"parts":[{"text":"Hello, "}]}}]}\n\n',
			'data: {"candidates":[{"content":{"parts":[{"text":"world!"}]}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}\n\n',
			'data: [DONE]\n\n'
		];

		const mockResponse = new Response(createMockSseStream(sseData), {
			status: 200,
			headers: { 'Content-Type': 'text/event-stream' }
		});

		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		const chunks: string[] = [];
		let completedResponse = '';
		let timingsCaptured: unknown = null;

		const options: SettingsChatServiceOptions = {
			stream: true,
			onChunk: (chunk) => chunks.push(chunk),
			onComplete: (response, reasoning, timings) => {
				completedResponse = response;
				timingsCaptured = timings;
			}
		};

		await provider.sendMessage([{ role: MessageRole.USER, content: 'Hi' }], options);

		expect(chunks).toEqual(['Hello, ', 'world!']);
		expect(completedResponse).toBe('Hello, world!');
		expect(timingsCaptured).toEqual({ prompt_n: 5, predicted_n: 3 });
	});

	it('separates reasoning/thought chunks and dispatches to onReasoningChunk', async () => {
		const sseData = [
			'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking step 1... "}]}}]}\n\n',
			'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking step 2."}]}}]}\n\n',
			'data: {"candidates":[{"content":{"parts":[{"text":"The answer is 42."}]}}]}\n\n'
		];

		const mockResponse = new Response(createMockSseStream(sseData), {
			status: 200,
			headers: { 'Content-Type': 'text/event-stream' }
		});

		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		const thoughtChunks: string[] = [];
		const contentChunks: string[] = [];
		let finalContent = '';
		let finalReasoning = '';

		const options: SettingsChatServiceOptions = {
			stream: true,
			onReasoningChunk: (chunk) => thoughtChunks.push(chunk),
			onChunk: (chunk) => contentChunks.push(chunk),
			onComplete: (content, reasoning) => {
				finalContent = content;
				finalReasoning = reasoning || '';
			}
		};

		await provider.sendMessage(
			[{ role: MessageRole.USER, content: 'What is the answer?' }],
			options
		);

		expect(thoughtChunks).toEqual(['Thinking step 1... ', 'Thinking step 2.']);
		expect(contentChunks).toEqual(['The answer is 42.']);
		expect(finalReasoning).toBe('Thinking step 1... Thinking step 2.');
		expect(finalContent).toBe('The answer is 42.');
	});

	it('parses functionCall parts and dispatches to onToolCallChunk', async () => {
		const sseData = [
			'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"run_terminal_command","args":{"command":"ls -la"}}}]}}]}\n\n'
		];

		const mockResponse = new Response(createMockSseStream(sseData), {
			status: 200,
			headers: { 'Content-Type': 'text/event-stream' }
		});

		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		let toolCallChunk = '';
		let completedToolCalls = '';

		const options: SettingsChatServiceOptions = {
			stream: true,
			onToolCallChunk: (chunk) => {
				toolCallChunk = chunk;
			},
			onComplete: (_res, _reasoning, _timings, toolCalls) => {
				completedToolCalls = toolCalls || '';
			}
		};

		await provider.sendMessage([{ role: MessageRole.USER, content: 'Run ls' }], options);

		expect(toolCallChunk).toBeTruthy();
		const parsed = JSON.parse(toolCallChunk);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].type).toBe('function');
		expect(parsed[0].function.name).toBe('run_terminal_command');
		expect(JSON.parse(parsed[0].function.arguments)).toEqual({ command: 'ls -la' });
		expect(completedToolCalls).toBe(toolCallChunk);
	});
});

describe('GeminiProvider Non-Streaming Completion', () => {
	let provider: GeminiProvider;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		provider = new GeminiProvider({ apiKey: 'test-api-key-12345' });
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('handles non-streaming requests with complete response and callbacks', async () => {
		const jsonBody = {
			candidates: [
				{
					content: {
						parts: [
							{ thought: true, text: 'Thinking...' },
							{ text: 'Non-streaming result.' }
						]
					}
				}
			],
			usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 8 }
		};

		const mockResponse = new Response(JSON.stringify(jsonBody), {
			status: 200,
			headers: { 'Content-Type': 'application/json' }
		});

		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		let completedResponse = '';
		let completedReasoning = '';

		const result = await provider.sendMessage([{ role: MessageRole.USER, content: 'Hello' }], {
			stream: false,
			onComplete: (resp, reasoning) => {
				completedResponse = resp;
				completedReasoning = reasoning || '';
			}
		});

		expect(result).toBe('Non-streaming result.');
		expect(completedResponse).toBe('Non-streaming result.');
		expect(completedReasoning).toBe('Thinking...');
	});
});

describe('GeminiProvider Error Handling', () => {
	let provider: GeminiProvider;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		provider = new GeminiProvider({ apiKey: 'test-api-key-12345' });
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it('throws AuthenticationError immediately when API key is missing', async () => {
		const unconfiguredProvider = new GeminiProvider({ apiKey: '' });
		let errorReported: Error | null = null;

		await expect(
			unconfiguredProvider.sendMessage([{ role: MessageRole.USER, content: 'Hi' }], {
				onError: (err) => {
					errorReported = err;
				}
			})
		).rejects.toThrow('Gemini API key is not configured');

		expect((errorReported as Error | null)?.name).toBe('AuthenticationError');
	});

	it('maps HTTP 400 invalid argument to BadRequestError', async () => {
		const errorPayload = {
			error: {
				code: 400,
				message: 'Invalid model name specified',
				status: 'INVALID_ARGUMENT'
			}
		};

		const mockResponse = new Response(JSON.stringify(errorPayload), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});

		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		let errorReported: Error | null = null;

		await expect(
			provider.sendMessage([{ role: MessageRole.USER, content: 'Test' }], {
				stream: true,
				onError: (err) => {
					errorReported = err;
				}
			})
		).rejects.toThrow('Gemini bad request (400)');

		expect((errorReported as Error | null)?.name).toBe('BadRequestError');
	});

	it('maps HTTP 403 permission denied to AuthenticationError', async () => {
		const errorPayload = {
			error: {
				code: 403,
				message: 'API key not valid. Please pass a valid API key.',
				status: 'PERMISSION_DENIED'
			}
		};

		const mockResponse = new Response(JSON.stringify(errorPayload), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});

		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		let errorReported: Error | null = null;

		await expect(
			provider.sendMessage([{ role: MessageRole.USER, content: 'Test' }], {
				stream: true,
				onError: (err) => {
					errorReported = err;
				}
			})
		).rejects.toThrow('Gemini authentication error (403)');

		expect((errorReported as Error | null)?.name).toBe('AuthenticationError');
	});

	it('maps HTTP 429 quota exhaustion to RateLimitError', async () => {
		const errorPayload = {
			error: {
				code: 429,
				message: 'Resource has been exhausted (e.g. check quota).',
				status: 'RESOURCE_EXHAUSTED'
			}
		};

		const mockResponse = new Response(JSON.stringify(errorPayload), {
			status: 429,
			headers: { 'Content-Type': 'application/json' }
		});

		globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

		let errorReported: Error | null = null;

		await expect(
			provider.sendMessage([{ role: MessageRole.USER, content: 'Test' }], {
				stream: true,
				onError: (err) => {
					errorReported = err;
				}
			})
		).rejects.toThrow('Gemini rate limit / quota exceeded (429)');

		expect((errorReported as Error | null)?.name).toBe('RateLimitError');
	});

	it('handles AbortSignal cleanly without throwing unhandled rejection', async () => {
		const abortController = new AbortController();
		abortController.abort();

		let errorReported = false;

		const result = await provider.sendMessage(
			[{ role: MessageRole.USER, content: 'Test' }],
			{
				stream: true,
				onError: () => {
					errorReported = true;
				}
			},
			'conv_abort_test',
			abortController.signal
		);

		expect(result).toBeUndefined();
		expect(errorReported).toBe(false);
	});
});
