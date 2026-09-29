import type { DatabaseMessage, DatabaseMessageExtra } from '$lib/types/database';
import type { ApiChatMessageData } from '$lib/types/api';
import type { SettingsChatServiceOptions } from '$lib/types/settings';

export * from './provider.types';
import type { ProviderId } from './provider.types';

/**
 * Universal interface for model providers.
 * All backend engines (llama-server, Gemini Native/REST, OpenAI, etc.) must implement this contract.
 */
export interface IModelProvider {
	/** Unique provider identifier */
	readonly id: ProviderId;
	/** Human-readable provider name */
	readonly name: string;
	/** Optional provider metadata */
	readonly metadata?: ProviderMetadata;

	/**
	 * Dispatches a chat completion request to the provider.
	 *
	 * @param messages - Normal message history (or DatabaseMessage array with extras)
	 * @param options - Generation options, sampling hyperparameters, and streaming callbacks
	 * @param conversationId - Optional conversation ID for session/stream tracking
	 * @param signal - Optional AbortSignal for user cancellation
	 * @returns Final response string when non-streaming, or void when streaming
	 */
	sendMessage(
		messages: ApiChatMessageData[] | (DatabaseMessage & { extra?: DatabaseMessageExtra[] })[],
		options?: SettingsChatServiceOptions,
		conversationId?: string,
		signal?: AbortSignal
	): Promise<string | void>;

	/**
	 * Stops real-time reasoning/thinking for an in-flight completion (if supported).
	 */
	stopReasoning?(completionId: string, model?: string | null): Promise<boolean>;

	/**
	 * Health check / availability probe for the provider.
	 */
	isAvailable?(): Promise<boolean>;

	/**
	 * Checks if the provider is fully configured (e.g. has API key if required).
	 */
	isConfigured?(): boolean;
}

/**
 * Provider descriptor for UI selection and capability discovery.
 */
export interface ProviderMetadata {
	id: ProviderId;
	name: string;
	description?: string;
	enabled: boolean;
	isDefault?: boolean;
}

/**
 * Configuration options for GeminiProvider.
 */
export interface GeminiConfig {
	apiKey?: string;
	baseUrl?: string;
	defaultModel?: string;
}
