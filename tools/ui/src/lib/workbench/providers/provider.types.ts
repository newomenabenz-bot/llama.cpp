/**
 * provider.types.ts - Formalized provider interfaces and normalized tool schemas.
 *
 * Defines the unified contract (IWorkbenchProvider) for model backends
 * (Google Gemini and local llama-server) and provides transparent mapping
 * between Gemini functionDeclarations and OpenAI tools JSON schemas.
 */

import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types/database';
import type {
	ApiChatCompletionToolCall,
	ApiChatMessageData,
	ChatMessageTimings,
	OpenAIToolDefinition
} from '$lib/types';
import type { SettingsChatServiceOptions } from '$lib/types/settings';
export type { IModelProvider, ProviderMetadata } from './types';

/**
 * Normalized provider identifiers.
 */
export type ProviderId = 'local-llama' | 'google-gemini' | 'llama-server' | 'gemini' | string;

/**
 * Standardized model representation across all providers.
 */
export interface WorkbenchModel {
	id: string;
	displayName: string;
	description?: string;
	contextLength?: number;
	isDefault?: boolean;
	providerId?: ProviderId;
}

/**
 * Normalized JSON Schema parameter property.
 */
export interface ToolParameterProperty {
	type: string;
	description?: string;
	enum?: string[];
	items?: ToolParameterProperty | Record<string, unknown>;
	properties?: Record<string, ToolParameterProperty | Record<string, unknown>>;
	required?: string[];
	[key: string]: unknown;
}

/**
 * Normalized tool parameter schema.
 */
export interface ToolParametersSchema {
	type: 'object' | string;
	properties?: Record<string, ToolParameterProperty | Record<string, unknown>>;
	required?: string[];
	[key: string]: unknown;
}

/**
 * Standardized tool definition.
 */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: ToolParametersSchema;
}

/**
 * Standardized tool execution call.
 */
export interface ToolCall {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string; // JSON string
	};
}

/**
 * Standardized tool execution result.
 */
export interface ToolCallResult {
	toolCallId: string;
	toolName: string;
	result: Record<string, unknown> | string;
	isError?: boolean;
}

/**
 * Standardized chat generation request.
 */
export interface ProviderChatRequest {
	messages: Array<ApiChatMessageData | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })>;
	model?: string;
	temperature?: number;
	maxTokens?: number;
	tools?: Array<ToolDefinition | OpenAIToolDefinition>;
	signal?: AbortSignal;
	options?: SettingsChatServiceOptions;
	conversationId?: string;
}

/**
 * Streaming completion chunk yielded by streamChat.
 */
export interface ProviderChatChunk {
	content?: string;
	reasoning?: string;
	toolCalls?: ApiChatCompletionToolCall[];
	done?: boolean;
	timings?: ChatMessageTimings;
}

/**
 * Formalized provider interface contract.
 */
export interface IWorkbenchProvider {
	readonly id: ProviderId;
	readonly displayName: string;

	/**
	 * Fetches available models for the provider.
	 */
	fetchModels(credentials?: Record<string, unknown> | string): Promise<Array<WorkbenchModel>>;

	/**
	 * Executes a streaming chat completion yielding normalized chunks.
	 */
	streamChat(request: ProviderChatRequest): AsyncIterableIterator<ProviderChatChunk>;
}

/**
 * Core Workbench Tool Definitions for filesystem and devops automation.
 */
export const WORKBENCH_CORE_TOOLS: Record<string, ToolDefinition> = {
	file_glob_search: {
		name: 'file_glob_search',
		description: 'Search for files matching a glob pattern within the workspace directory',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Directory path to search in (relative to workspace or absolute)'
				},
				pattern: {
					type: 'string',
					description: 'Glob pattern to match files against (e.g. "**/*.ts", "src/*")'
				},
				max_depth: {
					type: 'number',
					description: 'Maximum folder traversal depth'
				},
				limit: {
					type: 'number',
					description: 'Maximum number of results to return'
				}
			},
			required: ['pattern']
		}
	},
	read_file: {
		name: 'read_file',
		description: 'Read the contents of a file in the workspace',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Relative or absolute file path to read'
				},
				offset: {
					type: 'number',
					description: 'Line offset to start reading from (1-indexed)'
				},
				limit: {
					type: 'number',
					description: 'Maximum number of lines to read'
				}
			},
			required: ['path']
		}
	},
	write_file: {
		name: 'write_file',
		description: 'Write or overwrite text content to a file in the workspace',
		parameters: {
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'File path to write to'
				},
				content: {
					type: 'string',
					description: 'Text content to write into the file'
				}
			},
			required: ['path', 'content']
		}
	},
	exec_shell_command: {
		name: 'exec_shell_command',
		description: 'Execute a shell command within the workspace sandbox',
		parameters: {
			type: 'object',
			properties: {
				command: {
					type: 'string',
					description: 'The shell command line string to execute'
				},
				cwd: {
					type: 'string',
					description: 'Working directory for command execution'
				}
			},
			required: ['command']
		}
	}
};

/**
 * Sanitizes JSON schema for Gemini function declaration compatibility.
 * Recursively strips schema meta-keys ($schema, $id, definitions, $defs)
 * and ensures required fields match actual declared property names.
 */
export function cleanJsonSchema(schema: Record<string, unknown>): Record<string, unknown> {
	if (!schema || typeof schema !== 'object') {
		return { type: 'object', properties: {} };
	}

	const cleaned: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(schema)) {
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
 * Converts standard ToolDefinition or OpenAIToolDefinition array into Gemini functionDeclarations.
 */
export function toGeminiFunctionDeclarations(
	tools?: Array<ToolDefinition | OpenAIToolDefinition>
): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | undefined {
	if (!tools || !Array.isArray(tools) || tools.length === 0) {
		return undefined;
	}

	const declarations: Array<Record<string, unknown>> = [];

	for (const tool of tools) {
		if ('function' in tool && tool.function?.name) {
			// OpenAIToolDefinition
			declarations.push({
				name: tool.function.name,
				description: tool.function.description || '',
				parameters: cleanJsonSchema(
					(tool.function.parameters as Record<string, unknown>) || { type: 'object', properties: {} }
				)
			});
		} else if ('name' in tool && tool.name) {
			// ToolDefinition
			declarations.push({
				name: tool.name,
				description: tool.description || '',
				parameters: cleanJsonSchema(
					(tool.parameters as unknown as Record<string, unknown>) || { type: 'object', properties: {} }
				)
			});
		}
	}

	if (declarations.length === 0) {
		return undefined;
	}

	return [{ functionDeclarations: declarations }];
}

/**
 * Translates a Gemini functionCall part into a standard ApiChatCompletionToolCall.
 */
export function fromGeminiFunctionCall(
	call: { name: string; args?: Record<string, unknown> },
	callIndexOrId: number | string = 0
): ApiChatCompletionToolCall {
	const id = typeof callIndexOrId === 'string' ? callIndexOrId : `call_${call.name}_${callIndexOrId}`;
	return {
		id,
		type: 'function',
		function: {
			name: call.name,
			arguments: JSON.stringify(call.args || {})
		}
	};
}

/**
 * Translates a ToolCallResult into Gemini's expected functionResponse part.
 */
export function toGeminiFunctionResponse(result: ToolCallResult): {
	functionResponse: { name: string; response: Record<string, unknown> };
} {
	let responseObj: Record<string, unknown>;
	if (typeof result.result === 'string') {
		try {
			const parsed = JSON.parse(result.result);
			responseObj = typeof parsed === 'object' && parsed !== null ? parsed : { output: result.result };
		} catch {
			responseObj = { output: result.result };
		}
	} else if (result.result && typeof result.result === 'object') {
		responseObj = result.result;
	} else {
		responseObj = { output: String(result.result ?? '') };
	}

	if (result.isError) {
		responseObj.error = true;
	}

	return {
		functionResponse: {
			name: result.toolName,
			response: responseObj
		}
	};
}

/**
 * Converts ToolDefinition[] to OpenAIToolDefinition[].
 */
export function toOpenAITools(tools: ToolDefinition[]): OpenAIToolDefinition[] {
	return tools.map((t) => ({
		type: 'function',
		function: {
			name: t.name,
			description: t.description,
			parameters: cleanJsonSchema(t.parameters as unknown as Record<string, unknown>)
		}
	}));
}

/**
 * Converts OpenAIToolDefinition[] to ToolDefinition[].
 */
export function fromOpenAITools(tools: OpenAIToolDefinition[]): ToolDefinition[] {
	return tools
		.filter((t) => t.type === 'function' && t.function?.name)
		.map((t) => ({
			name: t.function.name,
			description: t.function.description || '',
			parameters: cleanJsonSchema(t.function.parameters) as ToolParametersSchema
		}));
}
