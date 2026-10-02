/**
 * Unit tests for Gemini thought_signature preservation in multi-turn function calling.
 * Verifies DIR-GEMINI-THOUGHT-SIG-12.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	extractToolCalls,
	formatGeminiContents,
	fromGeminiFunctionCall,
	GeminiProvider
} from '$lib/workbench/providers/gemini.provider';
import { MessageRole } from '$lib/enums';
import { agenticStore, toAgenticMessages } from '$lib/stores/agentic/index.svelte';
import type {
	ApiChatCompletionToolCall,
	ApiChatMessageData,
	DatabaseMessage,
	SettingsChatServiceOptions
} from '$lib/types';

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

describe('DIR-GEMINI-THOUGHT-SIG-12: Gemini Thought Signature Preservation', () => {
	let provider: GeminiProvider;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		provider = new GeminiProvider({ apiKey: 'test-thought-sig-key' });
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	describe('1. fromGeminiFunctionCall Translation', () => {
		it('preserves thought_signature on both toolCall root and function object', () => {
			const tc = fromGeminiFunctionCall(
				{
					name: 'get_info',
					args: { path: 'file.txt' },
					thought_signature: 'sig_encrypted_token_123'
				},
				'call_get_info_0'
			);

			expect(tc.thought_signature).toBe('sig_encrypted_token_123');
			expect(tc.thoughtSignature).toBe('sig_encrypted_token_123');
			expect(tc.function?.thought_signature).toBe('sig_encrypted_token_123');
			expect(tc.function?.thoughtSignature).toBe('sig_encrypted_token_123');
		});

		it('supports camelCase thoughtSignature attribute', () => {
			const tc = fromGeminiFunctionCall(
				{
					name: 'file_glob_search',
					args: { pattern: '*.ts' },
					thoughtSignature: 'sig_camel_case_token_456'
				},
				'call_glob_0'
			);

			expect(tc.thought_signature).toBe('sig_camel_case_token_456');
			expect(tc.thoughtSignature).toBe('sig_camel_case_token_456');
		});

		it('supports explicitly passed thoughtSignature parameter', () => {
			const tc = fromGeminiFunctionCall(
				{
					name: 'exec_command',
					args: { cmd: 'ls' }
				},
				'call_cmd_0',
				'sig_explicit_param_789'
			);

			expect(tc.thought_signature).toBe('sig_explicit_param_789');
			expect(tc.thoughtSignature).toBe('sig_explicit_param_789');
		});

		it('omits signature properties when none are provided', () => {
			const tc = fromGeminiFunctionCall(
				{
					name: 'simple_tool',
					args: { a: 1 }
				},
				'call_simple_0'
			);

			expect(tc.thought_signature).toBeUndefined();
			expect(tc.thoughtSignature).toBeUndefined();
			expect(tc.function?.thought_signature).toBeUndefined();
		});
	});

	describe('2. formatGeminiContents Multi-turn History Serialization', () => {
		it('retains thought_signature in model functionCall parts when serializing history', () => {
			const toolCalls: ApiChatCompletionToolCall[] = [
				{
					id: 'call_get_info_0',
					type: 'function',
					function: {
						name: 'get_info',
						arguments: JSON.stringify({ path: 'src/main.ts' }),
						thought_signature: 'token_alpha_999'
					},
					thought_signature: 'token_alpha_999'
				}
			];

			const messages: ApiChatMessageData[] = [
				{ role: MessageRole.USER, content: 'Read src/main.ts' },
				{
					role: MessageRole.ASSISTANT,
					content: '',
					tool_calls: toolCalls
				},
				{
					role: MessageRole.TOOL,
					tool_call_id: 'call_get_info_0',
					content: JSON.stringify({ content: 'console.log("hello");' })
				}
			];

			const payload = formatGeminiContents(messages);

			expect(payload.contents).toHaveLength(3);

			// Model turn at index 1
			const modelTurn = payload.contents[1];
			expect(modelTurn.role).toBe('model');
			expect(modelTurn.parts).toHaveLength(1);

			const fnPart = modelTurn.parts[0];
			// Verify signature on part
			expect(fnPart.thought_signature).toBe('token_alpha_999');
			expect(fnPart.thoughtSignature).toBe('token_alpha_999');

			// Verify functionCall contains only name and args (no unknown fields for Google protobuf)
			expect(fnPart.functionCall?.name).toBe('get_info');
			expect(fnPart.functionCall?.args).toEqual({ path: 'src/main.ts' });
			expect(fnPart.functionCall?.thought_signature).toBeUndefined();
			expect(fnPart.functionCall?.thoughtSignature).toBeUndefined();
		});

		it('retains thought_signature from serialized DatabaseMessage toolCalls string', () => {
			const dbMessages = [
				{
					id: 'msg-1',
					convId: 'conv-1',
					role: 'user',
					content: 'Search for models',
					timestamp: Date.now()
				},
				{
					id: 'msg-2',
					convId: 'conv-1',
					role: 'assistant',
					content: '',
					toolCalls: JSON.stringify([
						{
							id: 'call_search_0',
							type: 'function',
							function: {
								name: 'file_glob_search',
								arguments: '{"pattern":"*.gguf"}'
							},
							thought_signature: 'db_saved_sig_888'
						}
					]),
					timestamp: Date.now()
				},
				{
					id: 'msg-3',
					convId: 'conv-1',
					role: 'tool',
					toolCallId: 'call_search_0',
					content: '["model1.gguf"]',
					timestamp: Date.now()
				}
			] as unknown as DatabaseMessage[];

			const payload = formatGeminiContents(dbMessages);
			const modelTurn = payload.contents[1];

			expect(modelTurn.parts[0].thought_signature).toBe('db_saved_sig_888');
			expect(modelTurn.parts[0].thoughtSignature).toBe('db_saved_sig_888');
			expect(modelTurn.parts[0].functionCall?.thought_signature).toBeUndefined();
		});
	});

	describe('3. Multi-turn Streaming Handshake with Thinking Model', () => {
		it('extracts thought_signature from streaming response and echoes it back in turn 2', async () => {
			const expectedSignature = 'E38_opaque_cryptographic_thought_sig_gemini_2.5';

			// Turn 1 SSE: Model returns reasoning + functionCall with thought_signature
			const turn1SseChunks = [
				'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Analyzing directory layout..."}]}}]}\n\n',
				`data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_info","args":{"path":"README.md"}},"thought_signature":"${expectedSignature}"}]}}]}\n\n`,
				'data: [DONE]\n\n'
			];

			let interceptedTurn2Body: string | null = null;

			globalThis.fetch = vi.fn().mockImplementation((url, init) => {
				const bodyStr = typeof init?.body === 'string' ? init.body : '';
				if (!interceptedTurn2Body && bodyStr.includes('README.md') && bodyStr.includes('functionResponse')) {
					interceptedTurn2Body = bodyStr;
				}

				return Promise.resolve(
					new Response(createMockSseStream(turn1SseChunks), {
						status: 200,
						headers: { 'Content-Type': 'text/event-stream' }
					})
				);
			});

			let emittedToolCalls: ApiChatCompletionToolCall[] = [];

			const options: SettingsChatServiceOptions & {
				onToolCalls?: (calls: ApiChatCompletionToolCall[]) => void;
			} = {
				stream: true,
				onToolCalls: (calls) => {
					emittedToolCalls = calls;
				}
			};

			const initialMessages: ApiChatMessageData[] = [
				{ role: MessageRole.USER, content: 'Read README.md' }
			];

			// Execute Turn 1
			await provider.sendMessage(initialMessages, options);

			// Verify Turn 1 emitted tool calls with thought_signature
			expect(emittedToolCalls).toHaveLength(1);
			expect(emittedToolCalls[0].thought_signature).toBe(expectedSignature);
			expect(emittedToolCalls[0].function?.thought_signature).toBe(expectedSignature);

			// Prepare Turn 2 messages (User -> Assistant with emittedToolCalls -> Tool response)
			const turn2Messages: ApiChatMessageData[] = [
				{ role: MessageRole.USER, content: 'Read README.md' },
				{
					role: MessageRole.ASSISTANT,
					content: '',
					tool_calls: emittedToolCalls
				},
				{
					role: MessageRole.TOOL,
					tool_call_id: 'call_get_info_0',
					content: JSON.stringify({ text: '# Project README' })
				}
			];

			// Turn 2 mock response from Gemini
			const turn2SseChunks = [
				'data: {"candidates":[{"content":{"parts":[{"text":"The project README is: # Project README"}]}}]}\n\n',
				'data: [DONE]\n\n'
			];

			globalThis.fetch = vi.fn().mockImplementation((url, init) => {
				interceptedTurn2Body = typeof init?.body === 'string' ? init.body : '';
				return Promise.resolve(
					new Response(createMockSseStream(turn2SseChunks), {
						status: 200,
						headers: { 'Content-Type': 'text/event-stream' }
					})
				);
			});

			let finalResponseText = '';
			await provider.sendMessage(turn2Messages, {
				stream: true,
				onChunk: (chunk) => {
					finalResponseText += chunk;
				}
			});

			expect(finalResponseText).toContain('The project README is');
			expect(interceptedTurn2Body).toBeTruthy();

			// Parse intercepted Turn 2 request payload sent to Gemini API
			const sentPayload = JSON.parse(interceptedTurn2Body!);
			expect(sentPayload.contents).toHaveLength(3);

			const turn1ModelPart = sentPayload.contents[1].parts[0];
			expect(turn1ModelPart.thought_signature).toBe(expectedSignature);
			expect(turn1ModelPart.thoughtSignature).toBe(expectedSignature);
			expect(turn1ModelPart.functionCall.thought_signature).toBeUndefined();
		});
	});

	describe('4. Non-Streaming Chat with Thinking Model', () => {
		it('preserves thought_signature in non-streaming responses', async () => {
			const expectedSignature = 'non_stream_sig_gemini_2.0_flash_thinking';

			const mockResponseData = {
				candidates: [
					{
						content: {
							parts: [
								{ thought: true, text: 'Need to inspect config.json' },
								{
									functionCall: {
										name: 'get_info',
										args: { path: 'config.json' }
									},
									thought_signature: expectedSignature
								}
							]
						}
					}
				],
				usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 25 }
			};

			globalThis.fetch = vi.fn().mockResolvedValueOnce(
				new Response(JSON.stringify(mockResponseData), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			);

			let receivedCalls: ApiChatCompletionToolCall[] = [];
			const options: SettingsChatServiceOptions & {
				onToolCalls?: (calls: ApiChatCompletionToolCall[]) => void;
			} = {
				stream: false,
				onToolCalls: (calls) => {
					receivedCalls = calls;
				}
			};

			await provider.sendMessage([{ role: MessageRole.USER, content: 'Check config' }], options);

			expect(receivedCalls).toHaveLength(1);
			expect(receivedCalls[0].thought_signature).toBe(expectedSignature);
			expect(receivedCalls[0].function?.thought_signature).toBe(expectedSignature);
		});
	});

	describe('5. Split SSE Chunk Stitching & Standalone Signature Delivery', () => {
		it('stitches standalone thought_signature chunk to preceding functionCall in accumulatedToolCalls', async () => {
			const expectedSignature = 'split_stream_opaque_thought_sig_chunk_2';

			// Chunk 1 has functionCall without thought_signature
			// Chunk 2 has standalone thought_signature in parts
			const splitChunks = [
				'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"Thinking..."}]}}]}\n\n',
				'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"default_api:file_glob_search","args":{"pattern":"*.ts"}}}]}}]}\n\n',
				`data: {"candidates":[{"content":{"parts":[{"thought_signature":"${expectedSignature}"}]}}]}\n\n`,
				'data: [DONE]\n\n'
			];

			globalThis.fetch = vi.fn().mockResolvedValueOnce(
				new Response(createMockSseStream(splitChunks), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' }
				})
			);

			let receivedCalls: ApiChatCompletionToolCall[] = [];
			let chunkPayloads: string[] = [];

			const options: SettingsChatServiceOptions & {
				onToolCalls?: (calls: ApiChatCompletionToolCall[]) => void;
				onToolCallChunk?: (chunk: string) => void;
			} = {
				stream: true,
				onToolCalls: (calls) => {
					receivedCalls = calls;
				},
				onToolCallChunk: (chunk) => {
					chunkPayloads.push(chunk);
				}
			};

			await provider.sendMessage([{ role: MessageRole.USER, content: 'Find files' }], options);

			expect(receivedCalls).toHaveLength(1);
			expect(receivedCalls[0].function?.name).toBe('default_api:file_glob_search');
			expect(receivedCalls[0].thought_signature).toBe(expectedSignature);
			expect(receivedCalls[0].thoughtSignature).toBe(expectedSignature);
			expect(receivedCalls[0].function?.thought_signature).toBe(expectedSignature);

			// Verify the updated tool call chunk was re-emitted with the signature
			const lastEmitted = JSON.parse(chunkPayloads[chunkPayloads.length - 1]);
			expect(lastEmitted[0].thought_signature).toBe(expectedSignature);
		});

		it('attaches candidate-level thought_signature to functionCall tool calls', async () => {
			const candSig = 'candidate_level_sig_999';

			const chunks = [
				`data: {"candidates":[{"thought_signature":"${candSig}","content":{"parts":[{"functionCall":{"name":"default_api:file_glob_search","args":{"pattern":"*.json"}}}]}}]}\n\n`,
				'data: [DONE]\n\n'
			];

			globalThis.fetch = vi.fn().mockResolvedValueOnce(
				new Response(createMockSseStream(chunks), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' }
				})
			);

			let receivedCalls: ApiChatCompletionToolCall[] = [];
			const candOptions: SettingsChatServiceOptions & {
				onToolCalls?: (calls: ApiChatCompletionToolCall[]) => void;
			} = {
				stream: true,
				onToolCalls: (calls: ApiChatCompletionToolCall[]) => {
					receivedCalls = calls;
				}
			};
			await provider.sendMessage(
				[{ role: MessageRole.USER, content: 'Search' }],
				candOptions
			);

			expect(receivedCalls).toHaveLength(1);
			expect(receivedCalls[0].thought_signature).toBe(candSig);
			expect(receivedCalls[0].function?.thought_signature).toBe(candSig);
		});
	});

	describe('6. Multi-turn History Serialization at Position 9', () => {
		it('preserves thought_signature at position 9 across 10-turn conversation history', () => {
			const turn9Signature = 'sig_turn_9_encrypted_glob_search';

			// Simulate 10-turn conversation:
			// Turn 0: User, Turn 1: Assistant, Turn 2: User, Turn 3: Assistant,
			// Turn 4: User, Turn 5: Assistant, Turn 6: User, Turn 7: Assistant,
			// Turn 8: User, Turn 9: Assistant (calls default_api:file_glob_search)
			const messages: ApiChatMessageData[] = [
				{ role: MessageRole.USER, content: 'Turn 0: Hello' },
				{ role: MessageRole.ASSISTANT, content: 'Turn 1: Hi there' },
				{ role: MessageRole.USER, content: 'Turn 2: What is the weather?' },
				{ role: MessageRole.ASSISTANT, content: 'Turn 3: Sunny' },
				{ role: MessageRole.USER, content: 'Turn 4: Tell me a joke' },
				{ role: MessageRole.ASSISTANT, content: 'Turn 5: Why did the chicken cross the road?' },
				{ role: MessageRole.USER, content: 'Turn 6: Why?' },
				{ role: MessageRole.ASSISTANT, content: 'Turn 7: To get to the other side' },
				{ role: MessageRole.USER, content: 'Turn 8: Search for files in repository' },
				{
					role: MessageRole.ASSISTANT,
					content: '',
					tool_calls: [
						{
							id: 'call_glob_9',
							type: 'function',
							function: {
								name: 'default_api:file_glob_search',
								arguments: '{"pattern":"*.md"}',
								thought_signature: turn9Signature
							},
							thought_signature: turn9Signature
						}
					]
				},
				{
					role: MessageRole.TOOL,
					tool_call_id: 'call_glob_9',
					content: '["README.md", "CONTRIBUTING.md"]'
				}
			];

			const payload = formatGeminiContents(messages);

			// Verify contents has all turns alternating properly
			// Index 9 is the model turn containing functionCall default_api:file_glob_search
			expect(payload.contents[9].role).toBe('model');
			const pos9Part = payload.contents[9].parts[0];

			expect(pos9Part.functionCall?.name).toBe('default_api:file_glob_search');
			expect(pos9Part.thought_signature).toBe(turn9Signature);
			expect(pos9Part.thoughtSignature).toBe(turn9Signature);
			expect(pos9Part.functionCall?.thought_signature).toBeUndefined();
			expect(pos9Part.functionCall?.thoughtSignature).toBeUndefined();

			// Verify index 10 is user turn with functionResponse
			expect(payload.contents[10].role).toBe('user');
			expect(payload.contents[10].parts[0].functionResponse?.name).toBe('default_api:file_glob_search');
		});

		it('omits thought_signature when tool call has no signature', () => {
			const plainMessages: ApiChatMessageData[] = [
				{ role: MessageRole.USER, content: 'Plain query' },
				{
					role: MessageRole.ASSISTANT,
					content: '',
					tool_calls: [
						{
							id: 'call_plain_0',
							type: 'function',
							function: {
								name: 'default_api:file_glob_search',
								arguments: '{"pattern":"*.ts"}'
							}
						}
					]
				},
				{
					role: MessageRole.TOOL,
					tool_call_id: 'call_plain_0',
					content: '[]'
				}
			];

			const payload = formatGeminiContents(plainMessages);
			const modelTurnPart = payload.contents[1].parts[0];

			expect(modelTurnPart.functionCall?.name).toBe('default_api:file_glob_search');
			expect(modelTurnPart.thought_signature).toBeUndefined();
			expect(modelTurnPart.functionCall?.thought_signature).toBeUndefined();
		});
	});

	describe('7. Agentic Store Normalization & Conversion Preservation', () => {
		it('normalizeToolCalls preserves thought_signature on root and function', () => {
			const inputCalls: ApiChatCompletionToolCall[] = [
				{
					id: 'call_agentic_0',
					type: 'function',
					function: {
						name: 'default_api:file_glob_search',
						arguments: '{"pattern":"*"}',
						thought_signature: 'agentic_sig_abc_123'
					},
					thought_signature: 'agentic_sig_abc_123'
				}
			];

			const normalized = agenticStore.normalizeToolCalls(inputCalls);
			expect(normalized).toHaveLength(1);
			expect(normalized[0].thought_signature).toBe('agentic_sig_abc_123');
			expect(normalized[0].thoughtSignature).toBe('agentic_sig_abc_123');
			expect(normalized[0].function.thought_signature).toBe('agentic_sig_abc_123');
			expect(normalized[0].function.thoughtSignature).toBe('agentic_sig_abc_123');
		});

		it('toAgenticMessages preserves thought_signature when hydrating messages from database', () => {
			const apiMessages: ApiChatMessageData[] = [
				{
					role: MessageRole.ASSISTANT,
					content: '',
					tool_calls: [
						{
							id: 'call_hydrate_0',
							type: 'function',
							function: {
								name: 'default_api:file_glob_search',
								arguments: '{"pattern":"*"}',
								thought_signature: 'hydrate_sig_def_456'
							},
							thought_signature: 'hydrate_sig_def_456'
						}
					]
				}
			];

			const agenticMsgs = toAgenticMessages(apiMessages);
			expect(agenticMsgs).toHaveLength(1);
			const assistantMsg = agenticMsgs[0];
			if ('tool_calls' in assistantMsg && assistantMsg.tool_calls) {
				expect(assistantMsg.tool_calls).toHaveLength(1);
				expect(assistantMsg.tool_calls[0].thought_signature).toBe('hydrate_sig_def_456');
				expect(assistantMsg.tool_calls[0].thoughtSignature).toBe('hydrate_sig_def_456');
				expect(assistantMsg.tool_calls[0].function.thought_signature).toBe('hydrate_sig_def_456');
				expect(assistantMsg.tool_calls[0].function.thoughtSignature).toBe('hydrate_sig_def_456');
			} else {
				throw new Error('Expected assistant message with tool_calls');
			}
		});
	});
});
