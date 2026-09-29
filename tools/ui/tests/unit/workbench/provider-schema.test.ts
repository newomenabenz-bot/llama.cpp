/**
 * provider-schema.test.ts - Unit tests for provider interfaces and tool schema harmonization.
 *
 * Covers:
 * - Schema sanitization (cleanJsonSchema): stripping meta-keys, required property filtering, recursion
 * - Gemini function declaration conversion (toGeminiFunctionDeclarations): ToolDefinition and OpenAIToolDefinition
 * - Function call translation (fromGeminiFunctionCall)
 * - Function response translation (toGeminiFunctionResponse)
 * - OpenAI tool schema conversions (toOpenAITools and fromOpenAITools)
 * - Workbench core tools registry (WORKBENCH_CORE_TOOLS)
 * - Provider contract adherence (GeminiProvider and LocalLlamaProvider implementing IWorkbenchProvider)
 * - ProviderService alias resolution ('local-llama' <-> 'llama-server', 'google-gemini' <-> 'gemini')
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cleanJsonSchema,
	fromGeminiFunctionCall,
	fromOpenAITools,
	toGeminiFunctionDeclarations,
	toGeminiFunctionResponse,
	toOpenAITools,
	WORKBENCH_CORE_TOOLS,
	type IWorkbenchProvider,
	type ToolDefinition
} from '$lib/workbench/providers/provider.types';
import { GeminiProvider } from '$lib/workbench/providers/gemini.provider';
import { LocalLlamaProvider } from '$lib/workbench/providers/llama.provider';
import { ProviderService } from '$lib/workbench/providers/provider.service';
import type { OpenAIToolDefinition } from '$lib/types';

describe('Tool Schema Harmonization & Translations', () => {
	describe('cleanJsonSchema', () => {
		it('returns default object schema for non-object inputs', () => {
			// @ts-expect-error testing invalid inputs
			expect(cleanJsonSchema(null)).toEqual({ type: 'object', properties: {} });
			// @ts-expect-error testing invalid inputs
			expect(cleanJsonSchema(undefined)).toEqual({ type: 'object', properties: {} });
			// @ts-expect-error testing invalid inputs
			expect(cleanJsonSchema('string')).toEqual({ type: 'object', properties: {} });
		});

		it('strips meta-keys ($schema, $id, definitions, $defs)', () => {
			const input = {
				$schema: 'http://json-schema.org/draft-07/schema#',
				$id: 'https://example.com/schema.json',
				definitions: { Helper: { type: 'string' } },
				$defs: { LocalHelper: { type: 'number' } },
				type: 'object',
				properties: {
					name: { type: 'string' }
				}
			};

			const cleaned = cleanJsonSchema(input);
			expect(cleaned).not.toHaveProperty('$schema');
			expect(cleaned).not.toHaveProperty('$id');
			expect(cleaned).not.toHaveProperty('definitions');
			expect(cleaned).not.toHaveProperty('$defs');
			expect(cleaned).toHaveProperty('type', 'object');
			expect(cleaned).toHaveProperty('properties');
		});

		it('strips required properties that do not exist in properties', () => {
			const input = {
				type: 'object',
				properties: {
					validProp: { type: 'string' }
				},
				required: ['validProp', 'ghostProp', 'nonExistentProp']
			};

			const cleaned = cleanJsonSchema(input);
			expect(cleaned.required).toEqual(['validProp']);
		});

		it('removes required array entirely if no valid properties remain', () => {
			const input = {
				type: 'object',
				properties: {
					foo: { type: 'string' }
				},
				required: ['bar', 'baz']
			};

			const cleaned = cleanJsonSchema(input);
			expect(cleaned.required).toBeUndefined();
		});

		it('handles nested objects and arrays recursively', () => {
			const input = {
				type: 'object',
				properties: {
					user: {
						$schema: 'meta',
						type: 'object',
						properties: {
							id: { type: 'string' },
							tags: {
								type: 'array',
								items: {
									$defs: {},
									type: 'string'
								}
							}
						},
						required: ['id', 'missingField']
					}
				}
			};

			const cleaned = cleanJsonSchema(input);
			const userProp = (cleaned.properties as Record<string, Record<string, unknown>>).user;
			expect(userProp).not.toHaveProperty('$schema');
			expect(userProp.required).toEqual(['id']);

			const tagsProp = (userProp.properties as Record<string, Record<string, unknown>>).tags;
			const itemsProp = tagsProp.items as Record<string, unknown>;
			expect(itemsProp).not.toHaveProperty('$defs');
			expect(itemsProp.type).toBe('string');
		});

		it('infers type "object" if properties are present but type is omitted', () => {
			const input = {
				properties: {
					path: { type: 'string' }
				}
			};

			const cleaned = cleanJsonSchema(input);
			expect(cleaned.type).toBe('object');
		});
	});

	describe('toGeminiFunctionDeclarations', () => {
		it('returns undefined for empty or missing tools', () => {
			expect(toGeminiFunctionDeclarations(undefined)).toBeUndefined();
			expect(toGeminiFunctionDeclarations([])).toBeUndefined();
		});

		it('converts OpenAIToolDefinition format to Gemini functionDeclarations', () => {
			const openAiTools: OpenAIToolDefinition[] = [
				{
					type: 'function',
					function: {
						name: 'calc_sum',
						description: 'Calculates the sum of two numbers',
						parameters: {
							$schema: 'draft-07',
							type: 'object',
							properties: {
								a: { type: 'number' },
								b: { type: 'number' }
							},
							required: ['a', 'b', 'unused']
						}
					}
				}
			];

			const res = toGeminiFunctionDeclarations(openAiTools);
			expect(res).toBeDefined();
			expect(res?.[0].functionDeclarations).toHaveLength(1);

			const decl = res![0].functionDeclarations[0];
			expect(decl.name).toBe('calc_sum');
			expect(decl.description).toBe('Calculates the sum of two numbers');
			expect((decl.parameters as Record<string, unknown>).required).toEqual(['a', 'b']);
		});

		it('converts ToolDefinition format to Gemini functionDeclarations', () => {
			const toolDefs: ToolDefinition[] = [
				{
					name: 'search_files',
					description: 'Find workspace files',
					parameters: {
						type: 'object',
						properties: {
							query: { type: 'string' }
						},
						required: ['query']
					}
				}
			];

			const res = toGeminiFunctionDeclarations(toolDefs);
			expect(res).toBeDefined();
			const decl = res![0].functionDeclarations[0];
			expect(decl.name).toBe('search_files');
			expect(decl.description).toBe('Find workspace files');
		});
	});

	describe('fromGeminiFunctionCall', () => {
		it('translates function call with args into ApiChatCompletionToolCall', () => {
			const geminiCall = {
				name: 'read_file',
				args: { path: 'src/main.ts', offset: 10 }
			};

			const toolCall = fromGeminiFunctionCall(geminiCall, 0);
			expect(toolCall.id).toBe('call_read_file_0');
			expect(toolCall.type).toBe('function');
			expect(toolCall.function?.name).toBe('read_file');
			expect(JSON.parse(toolCall.function?.arguments || '{}')).toEqual({
				path: 'src/main.ts',
				offset: 10
			});
		});

		it('uses explicit string ID when provided', () => {
			const geminiCall = {
				name: 'exec_shell_command',
				args: { command: 'ls -la' }
			};

			const toolCall = fromGeminiFunctionCall(geminiCall, 'custom_exec_id');
			expect(toolCall.id).toBe('custom_exec_id');
		});
	});

	describe('toGeminiFunctionResponse', () => {
		it('converts string tool result to functionResponse', () => {
			const result = toGeminiFunctionResponse({
				toolCallId: 'call_1',
				toolName: 'read_file',
				result: 'File content line 1\nFile content line 2'
			});

			expect(result.functionResponse.name).toBe('read_file');
			expect(result.functionResponse.response).toEqual({
				output: 'File content line 1\nFile content line 2'
			});
		});

		it('parses JSON string tool result into structured response object', () => {
			const result = toGeminiFunctionResponse({
				toolCallId: 'call_2',
				toolName: 'file_glob_search',
				result: JSON.stringify({ files: ['a.ts', 'b.ts'], count: 2 })
			});

			expect(result.functionResponse.name).toBe('file_glob_search');
			expect(result.functionResponse.response).toEqual({
				files: ['a.ts', 'b.ts'],
				count: 2
			});
		});

		it('sets error flag on failure result', () => {
			const result = toGeminiFunctionResponse({
				toolCallId: 'call_3',
				toolName: 'exec_shell_command',
				result: 'Command failed with exit code 1',
				isError: true
			});

			expect(result.functionResponse.response.error).toBe(true);
			expect(result.functionResponse.response.output).toBe('Command failed with exit code 1');
		});
	});

	describe('toOpenAITools & fromOpenAITools', () => {
		it('performs bidirectional conversion between ToolDefinition and OpenAIToolDefinition', () => {
			const originalTools: ToolDefinition[] = [
				WORKBENCH_CORE_TOOLS.read_file,
				WORKBENCH_CORE_TOOLS.write_file
			];

			const openAiTools = toOpenAITools(originalTools);
			expect(openAiTools).toHaveLength(2);
			expect(openAiTools[0].type).toBe('function');
			expect(openAiTools[0].function.name).toBe('read_file');

			const roundtrip = fromOpenAITools(openAiTools);
			expect(roundtrip).toHaveLength(2);
			expect(roundtrip[0].name).toBe('read_file');
			expect(roundtrip[1].name).toBe('write_file');
		});
	});

	describe('WORKBENCH_CORE_TOOLS', () => {
		it('defines file_glob_search tool with required pattern parameter', () => {
			const tool = WORKBENCH_CORE_TOOLS.file_glob_search;
			expect(tool).toBeDefined();
			expect(tool.name).toBe('file_glob_search');
			expect(tool.parameters.properties?.pattern).toBeDefined();
			expect(tool.parameters.required).toContain('pattern');
		});

		it('defines read_file tool with required path parameter', () => {
			const tool = WORKBENCH_CORE_TOOLS.read_file;
			expect(tool).toBeDefined();
			expect(tool.name).toBe('read_file');
			expect(tool.parameters.properties?.path).toBeDefined();
			expect(tool.parameters.required).toContain('path');
		});

		it('defines write_file tool with required path and content parameters', () => {
			const tool = WORKBENCH_CORE_TOOLS.write_file;
			expect(tool).toBeDefined();
			expect(tool.name).toBe('write_file');
			expect(tool.parameters.properties?.path).toBeDefined();
			expect(tool.parameters.properties?.content).toBeDefined();
			expect(tool.parameters.required).toEqual(['path', 'content']);
		});

		it('defines exec_shell_command tool with required command parameter', () => {
			const tool = WORKBENCH_CORE_TOOLS.exec_shell_command;
			expect(tool).toBeDefined();
			expect(tool.name).toBe('exec_shell_command');
			expect(tool.parameters.properties?.command).toBeDefined();
			expect(tool.parameters.required).toContain('command');
		});
	});
});

describe('Provider Contract Adherence (IWorkbenchProvider)', () => {
	it('GeminiProvider implements IWorkbenchProvider contract', () => {
		const provider: IWorkbenchProvider = new GeminiProvider();
		expect(provider.id).toBe('google-gemini');
		expect(provider.displayName).toBe('Google Gemini');
		expect(typeof provider.fetchModels).toBe('function');
		expect(typeof provider.streamChat).toBe('function');
	});

	it('LocalLlamaProvider implements IWorkbenchProvider contract', () => {
		const provider: IWorkbenchProvider = new LocalLlamaProvider();
		expect(provider.id).toBe('local-llama');
		expect(provider.displayName).toBe('Local Llama Server');
		expect(typeof provider.fetchModels).toBe('function');
		expect(typeof provider.streamChat).toBe('function');
	});

	it('LocalLlamaProvider.fetchModels returns WorkbenchModel array', async () => {
		const provider = new LocalLlamaProvider();
		const models = await provider.fetchModels();
		expect(Array.isArray(models)).toBe(true);
		expect(models.length).toBeGreaterThan(0);
		expect(models[0].providerId).toBe('local-llama');
	});

	it('GeminiProvider.fetchModels returns empty array when unconfigured', async () => {
		const provider = new GeminiProvider({ apiKey: '' });
		const models = await provider.fetchModels();
		expect(models).toEqual([]);
	});
});

describe('ProviderService Alias Harmonization', () => {
	beforeEach(() => {
		ProviderService.reset();
	});

	it('resolves both "local-llama" and "llama-server" to the llama provider', () => {
		const p1 = ProviderService.getProvider('local-llama');
		const p2 = ProviderService.getProvider('llama-server');
		expect(p1).toBeDefined();
		expect(p2).toBeDefined();
		expect(p1).toBe(p2);
	});

	it('resolves both "google-gemini" and "gemini" to the gemini provider', () => {
		const p1 = ProviderService.getProvider('google-gemini');
		const p2 = ProviderService.getProvider('gemini');
		expect(p1).toBeDefined();
		expect(p2).toBeDefined();
		expect(p1).toBe(p2);
	});

	it('allows setting active provider with either alias', () => {
		ProviderService.setActiveProvider('local-llama');
		expect(['local-llama', 'llama-server']).toContain(ProviderService.getActiveProviderId());

		ProviderService.setActiveProvider('google-gemini');
		expect(['google-gemini', 'gemini']).toContain(ProviderService.getActiveProviderId());
	});
});
