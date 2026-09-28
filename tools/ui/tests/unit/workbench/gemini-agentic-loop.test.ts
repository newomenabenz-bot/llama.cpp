/**
 * Multi-turn Agentic Loop Integration & Protocol Alignment Tests for GeminiProvider.
 *
 * Verifies:
 * 1. Full multi-turn simulation:
 *    User message -> Gemini proposes tool -> Mock tool executes ->
 *    Gemini receives tool result -> Gemini produces final text.
 * 2. Multiple / parallel tool call sequence formatting and bundling into a single user turn.
 * 3. Support for DatabaseMessage representation with serialized toolCalls string.
 * 4. Error recovery when tools return error payloads, plain strings, or user denial.
 * 5. Formatting of realistic tool declarations from ToolsStore into valid Gemini functionDeclarations.
 * 6. Sanitization of empty text strings in parts.
 * 7. Deterministic tool call ID generation and onToolCalls emission.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cleanJsonSchema,
	extractToolCalls,
	formatGeminiContents,
	formatGeminiTools,
	GeminiProvider
} from '$lib/workbench/providers/gemini.provider';
import { MessageRole } from '$lib/enums';
import type {
	ApiChatCompletionToolCall,
	ApiChatMessageData,
	DatabaseMessage,
	OpenAIToolDefinition,
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

describe('Gemini Agentic Loop Protocol Alignment', () => {
	let provider: GeminiProvider;
	let originalFetch: typeof globalThis.fetch;

	beforeEach(() => {
		originalFetch = globalThis.fetch;
		provider = new GeminiProvider({ apiKey: 'test-agentic-key' });
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	describe('1. Full Multi-Turn Simulation', () => {
		it('executes a complete multi-turn tool calling conversation cycle', async () => {
			// --- Turn 1: User asks to list files; Gemini returns a tool call ---
			const turn1SseChunks = [
				'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"I need to list files in src."}]}}]}\n\n',
				'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"file_glob_search","args":{"path":"src","type":"file"}}}]}}]}\n\n',
				'data: [DONE]\n\n'
			];

			globalThis.fetch = vi.fn().mockResolvedValueOnce(
				new Response(createMockSseStream(turn1SseChunks), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' }
				})
			);

			let receivedToolChunk = '';
			let receivedToolCalls: ApiChatCompletionToolCall[] = [];
			let receivedReasoning = '';

			const turn1Options: SettingsChatServiceOptions & {
				onToolCalls?: (calls: ApiChatCompletionToolCall[]) => void;
			} = {
				stream: true,
				onReasoningChunk: (chunk) => {
					receivedReasoning += chunk;
				},
				onToolCallChunk: (chunk) => {
					receivedToolChunk = chunk;
				},
				onToolCalls: (calls) => {
					receivedToolCalls = calls;
				}
			};

			const initialMessages: ApiChatMessageData[] = [
				{ role: MessageRole.USER, content: 'List files in src' }
			];

			await provider.sendMessage(initialMessages, turn1Options);

			expect(receivedReasoning).toBe('I need to list files in src.');
			expect(receivedToolChunk).toBeTruthy();
			expect(receivedToolCalls).toHaveLength(1);
			expect(receivedToolCalls[0]).toEqual({
				id: 'call_file_glob_search_0',
				type: 'function',
				function: {
					name: 'file_glob_search',
					arguments: JSON.stringify({ path: 'src', type: 'file' })
				}
			});

			// --- Mock Tool Execution ---
			const toolExecutionResult = {
				entries: ['index.ts', 'app.svelte', 'types.ts'],
				count: 3
			};

			// --- Turn 2: Feed tool result back to Gemini; Gemini outputs final response ---
			const turn2Messages: ApiChatMessageData[] = [
				{ role: MessageRole.USER, content: 'List files in src' },
				{
					role: MessageRole.ASSISTANT,
					content: '',
					tool_calls: receivedToolCalls
				},
				{
					role: MessageRole.TOOL,
					tool_call_id: 'call_file_glob_search_0',
					content: JSON.stringify(toolExecutionResult)
				}
			];

			// Verify request body formatting for Turn 2
			const formattedPayload = formatGeminiContents(turn2Messages);
			expect(formattedPayload.contents).toHaveLength(3);

			// Turn 0: User prompt
			expect(formattedPayload.contents[0]).toEqual({
				role: 'user',
				parts: [{ text: 'List files in src' }]
			});

			// Turn 1: Model functionCall (empty text sanitized out)
			expect(formattedPayload.contents[1]).toEqual({
				role: 'model',
				parts: [
					{
						functionCall: {
							name: 'file_glob_search',
							args: { path: 'src', type: 'file' }
						}
					}
				]
			});

			// Turn 2: User functionResponse
			expect(formattedPayload.contents[2]).toEqual({
				role: 'user',
				parts: [
					{
						functionResponse: {
							name: 'file_glob_search',
							response: toolExecutionResult
						}
					}
				]
			});

			// Simulate Turn 2 response from Gemini
			const turn2SseChunks = [
				'data: {"candidates":[{"content":{"parts":[{"text":"Found 3 files: index.ts, app.svelte, and types.ts."}]}}]}\n\n',
				'data: [DONE]\n\n'
			];

			globalThis.fetch = vi.fn().mockResolvedValueOnce(
				new Response(createMockSseStream(turn2SseChunks), {
					status: 200,
					headers: { 'Content-Type': 'text/event-stream' }
				})
			);

			let finalOutput = '';
			const turn2Options: SettingsChatServiceOptions = {
				stream: true,
				onChunk: (chunk) => {
					finalOutput += chunk;
				}
			};

			await provider.sendMessage(turn2Messages, turn2Options);
			expect(finalOutput).toBe('Found 3 files: index.ts, app.svelte, and types.ts.');
		});
	});

	describe('2. Parallel & Sequential Tool Calling Protocols', () => {
		it('bundles parallel tool call responses into a single user turn with multiple functionResponse parts', () => {
			const messages: ApiChatMessageData[] = [
				{ role: MessageRole.USER, content: 'Check status and time' },
				{
					role: MessageRole.ASSISTANT,
					content: '',
					tool_calls: [
						{
							id: 'call_git_0',
							type: 'function',
							function: { name: 'exec_shell_command', arguments: '{"command":"git status"}' }
						},
						{
							id: 'call_time_1',
							type: 'function',
							function: { name: 'get_datetime', arguments: '{}' }
						}
					]
				},
				{
					role: MessageRole.TOOL,
					tool_call_id: 'call_git_0',
					content: JSON.stringify({ stdout: 'On branch master\nnothing to commit' })
				},
				{
					role: MessageRole.TOOL,
					tool_call_id: 'call_time_1',
					content: JSON.stringify({ iso: '2026-09-28T10:00:00Z' })
				}
			];

			const formatted = formatGeminiContents(messages);

			// Must be exactly 3 turns: [user prompt, model 2x functionCalls, user 2x functionResponses]
			expect(formatted.contents).toHaveLength(3);
			expect(formatted.contents[1].role).toBe('model');
			expect(formatted.contents[1].parts).toHaveLength(2);
			expect(formatted.contents[1].parts[0].functionCall?.name).toBe('exec_shell_command');
			expect(formatted.contents[1].parts[1].functionCall?.name).toBe('get_datetime');

			// Turn 2 must bundle both responses in a single user turn
			expect(formatted.contents[2].role).toBe('user');
			expect(formatted.contents[2].parts).toHaveLength(2);
			expect(formatted.contents[2].parts[0]).toEqual({
				functionResponse: {
					name: 'exec_shell_command',
					response: { stdout: 'On branch master\nnothing to commit' }
				}
			});
			expect(formatted.contents[2].parts[1]).toEqual({
				functionResponse: {
					name: 'get_datetime',
					response: { iso: '2026-09-28T10:00:00Z' }
				}
			});
		});

		it('does not merge regular user text messages into a tool response turn', () => {
			const messages: ApiChatMessageData[] = [
				{ role: MessageRole.USER, content: 'Initial question' },
				{
					role: MessageRole.ASSISTANT,
					content: '',
					tool_calls: [
						{
							id: 'c1',
							type: 'function',
							function: { name: 'tool_one', arguments: '{}' }
						}
					]
				},
				{
					role: MessageRole.TOOL,
					tool_call_id: 'c1',
					content: '{"result":"ok"}'
				},
				{
					role: MessageRole.USER,
					content: 'Follow-up question from user'
				}
			];

			const formatted = formatGeminiContents(messages);

			// Expect 4 separate turns: user -> model (call) -> user (tool response) -> user (follow-up text)
			expect(formatted.contents).toHaveLength(4);
			expect(formatted.contents[2].role).toBe('user');
			expect(formatted.contents[2].parts[0].functionResponse).toBeDefined();
			expect(formatted.contents[3].role).toBe('user');
			expect(formatted.contents[3].parts[0].text).toBe('Follow-up question from user');
		});
	});

	describe('3. DatabaseMessage Compatibility', () => {
		it('extracts tool calls from Dexie DatabaseMessage with JSON-serialized toolCalls string', () => {
			const dbMessage = {
				id: 'msg-123',
				convId: 'conv-456',
				role: MessageRole.ASSISTANT,
				content: 'I will read the file.',
				toolCalls: JSON.stringify([
					{
						id: 'call_read_0',
						type: 'function',
						function: { name: 'read_file', arguments: '{"path":"README.md"}' }
					}
				]),
				timestamp: Date.now()
			} as unknown as DatabaseMessage;

			const extracted = extractToolCalls(dbMessage);
			expect(extracted).toHaveLength(1);
			expect(extracted[0].id).toBe('call_read_0');
			expect(extracted[0].function?.name).toBe('read_file');

			const toolReply = {
				id: 'msg-124',
				convId: 'conv-456',
				role: MessageRole.TOOL,
				content: '# Project Documentation',
				toolCallId: 'call_read_0',
				timestamp: Date.now() + 100
			} as unknown as DatabaseMessage;

			const formatted = formatGeminiContents([dbMessage, toolReply]);
			expect(formatted.contents).toHaveLength(2);
			expect(formatted.contents[0].role).toBe('model');
			expect(formatted.contents[0].parts).toHaveLength(2); // text + functionCall
			expect(formatted.contents[0].parts[0].text).toBe('I will read the file.');
			expect(formatted.contents[0].parts[1].functionCall?.name).toBe('read_file');

			expect(formatted.contents[1].role).toBe('user');
			expect(formatted.contents[1].parts[0]).toEqual({
				functionResponse: {
					name: 'read_file',
					response: { content: '# Project Documentation' }
				}
			});
		});
	});

	describe('4. Error Recovery & User Denial Handling', () => {
		it('cleanly formats tool error objects into functionResponse payload', () => {
			const messages: ApiChatMessageData[] = [
				{
					role: MessageRole.ASSISTANT,
					content: '',
					tool_calls: [
						{
							id: 'c_err',
							type: 'function',
							function: { name: 'read_file', arguments: '{"path":"nonexistent.txt"}' }
						}
					]
				},
				{
					role: MessageRole.TOOL,
					tool_call_id: 'c_err',
					content: JSON.stringify({ error: 'File not found: nonexistent.txt', code: 'ENOENT' })
				}
			];

			const formatted = formatGeminiContents(messages);
			expect(formatted.contents).toHaveLength(2);
			expect(formatted.contents[1].role).toBe('user');
			expect(formatted.contents[1].parts[0]).toEqual({
				functionResponse: {
					name: 'read_file',
					response: {
						error: 'File not found: nonexistent.txt',
						code: 'ENOENT'
					}
				}
			});
		});

		it('cleanly formats user permission denials (plain string) into functionResponse payload', () => {
			const messages: ApiChatMessageData[] = [
				{
					role: MessageRole.ASSISTANT,
					content: '',
					tool_calls: [
						{
							id: 'c_denied',
							type: 'function',
							function: { name: 'exec_shell_command', arguments: '{"command":"rm -rf /"}' }
						}
					]
				},
				{
					role: MessageRole.TOOL,
					tool_call_id: 'c_denied',
					content: 'Tool execution was denied by the user.'
				}
			];

			const formatted = formatGeminiContents(messages);
			expect(formatted.contents).toHaveLength(2);
			expect(formatted.contents[1].role).toBe('user');
			expect(formatted.contents[1].parts[0]).toEqual({
				functionResponse: {
					name: 'exec_shell_command',
					response: {
						content: 'Tool execution was denied by the user.'
					}
				}
			});
		});
	});

	describe('5. ToolsStore Schema Formatting for Gemini', () => {
		it('formats real-world server and browser tools into valid Gemini functionDeclarations', () => {
			const tools: OpenAIToolDefinition[] = [
				{
					type: 'function',
					function: {
						name: 'exec_shell_command',
						description: 'Execute a shell command with real-time output',
						parameters: {
							$schema: 'http://json-schema.org/draft-07/schema#',
							type: 'object',
							properties: {
								command: { type: 'string', description: 'Command to run' },
								timeout: { type: 'number', description: 'Timeout in ms', default: 30000 }
							},
							required: ['command']
						}
					}
				},
				{
					type: 'function',
					function: {
						name: 'get_datetime',
						description: 'Get the current ISO timestamp',
						parameters: {
							type: 'object',
							properties: {}
						}
					}
				}
			];

			const formatted = formatGeminiTools(tools);
			expect(formatted).toBeDefined();
			expect(formatted![0].functionDeclarations).toHaveLength(2);

			const execDecl = formatted![0].functionDeclarations[0];
			expect(execDecl.name).toBe('exec_shell_command');
			expect(execDecl.description).toBe('Execute a shell command with real-time output');
			expect(execDecl.parameters).toEqual({
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Command to run' },
					timeout: { type: 'number', description: 'Timeout in ms', default: 30000 }
				},
				required: ['command']
			});

			const dateDecl = formatted![0].functionDeclarations[1];
			expect(dateDecl.name).toBe('get_datetime');
			expect(dateDecl.parameters).toEqual({
				type: 'object',
				properties: {}
			});
		});

		it('strips empty required arrays and invalid required fields', () => {
			const cleaned = cleanJsonSchema({
				type: 'object',
				properties: {
					name: { type: 'string' }
				},
				required: ['non_existent_key']
			});

			// 'non_existent_key' is not in properties, so required becomes empty and is removed
			expect(cleaned.required).toBeUndefined();
		});
	});

	describe('6. Empty Text Sanitization', () => {
		it('does not emit empty text parts for assistant messages that only issue tool calls', () => {
			const messages: ApiChatMessageData[] = [
				{
					role: MessageRole.ASSISTANT,
					content: '   ', // whitespace only
					tool_calls: [
						{
							id: 'c1',
							type: 'function',
							function: { name: 'test_tool', arguments: '{}' }
						}
					]
				}
			];

			const formatted = formatGeminiContents(messages);
			expect(formatted.contents).toHaveLength(1);
			expect(formatted.contents[0].parts).toHaveLength(1);
			expect(formatted.contents[0].parts[0].functionCall).toBeDefined();
			expect(formatted.contents[0].parts[0].text).toBeUndefined();
		});

		it('omits empty user messages without content', () => {
			const messages: ApiChatMessageData[] = [
				{ role: MessageRole.USER, content: '' },
				{ role: MessageRole.USER, content: 'Valid message' }
			];

			const formatted = formatGeminiContents(messages);
			expect(formatted.contents).toHaveLength(1);
			expect(formatted.contents[0].parts).toEqual([{ text: 'Valid message' }]);
		});
	});
});
