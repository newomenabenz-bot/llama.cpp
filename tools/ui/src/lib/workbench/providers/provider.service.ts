/**
 * ProviderService - Registry and routing service for model providers.
 *
 * Manages available IModelProvider implementations, provides active provider
 * selection, and allows seamless switching between upstream llama-server and
 * external providers (e.g., Gemini) without modifying UI callers.
 */

import type { IModelProvider, ProviderId } from './types';
import { LlamaServerProvider } from './llama-server.provider';
import { GeminiProvider } from './gemini.provider';

export class ProviderService {
	private static providers: Map<ProviderId, IModelProvider> = new Map();
	private static activeProviderId: ProviderId = 'llama-server';
	private static hydrated = false;

	/**
	 * Registers a model provider instance.
	 */
	static registerProvider(provider: IModelProvider): void {
		this.providers.set(provider.id, provider);
	}

	/**
	 * Retrieves a registered provider by its identifier.
	 */
	static getProvider(id: ProviderId): IModelProvider | undefined {
		this.ensureDefaults();
		const resolvedId = id === 'google-gemini' ? 'gemini' : id;
		return this.providers.get(resolvedId);
	}

	/**
	 * Returns all registered providers.
	 */
	static getAllProviders(): IModelProvider[] {
		this.ensureDefaults();
		return Array.from(this.providers.values());
	}

	/**
	 * Retrieves the currently active provider.
	 * Defaults to LlamaServerProvider if no provider is explicitly selected.
	 */
	static getActiveProvider(): IModelProvider {
		this.ensureDefaults();
		const provider = this.providers.get(this.activeProviderId);
		if (!provider) {
			const fallback = new LlamaServerProvider();
			this.providers.set(fallback.id, fallback);
			return fallback;
		}
		return provider;
	}

	/**
	 * Sets the active provider by identifier.
	 *
	 * @throws {Error} If the specified provider is not registered.
	 */
	static setActiveProvider(id: ProviderId): void {
		this.ensureDefaults();
		const resolvedId = id === 'google-gemini' ? 'gemini' : id;
		if (!this.providers.has(resolvedId)) {
			throw new Error(`Provider "${id}" is not registered`);
		}
		this.activeProviderId = resolvedId;
	}

	/**
	 * Returns the ID of the currently active provider.
	 */
	static getActiveProviderId(): ProviderId {
		this.ensureDefaults();
		return this.activeProviderId;
	}

	/**
	 * Resets provider service state (useful in test suites).
	 */
	static reset(): void {
		this.providers.clear();
		this.activeProviderId = 'llama-server';
		this.hydrated = false;
	}

	/**
	 * Ensures default providers (llama-server and gemini) are registered and hydrated from storage.
	 */
	private static ensureDefaults(): void {
		if (!this.providers.has('llama-server')) {
			const defaultProvider = new LlamaServerProvider();
			this.providers.set(defaultProvider.id, defaultProvider);
		}
		if (!this.providers.has('gemini')) {
			const geminiProvider = new GeminiProvider();
			this.providers.set(geminiProvider.id, geminiProvider);
		}
		if (!this.hydrated) {
			this.hydrated = true;
			this.hydrateFromStorage();
		}
	}

	/**
	 * Hydrates active provider and API key from workbench localStorage state.
	 */
	private static hydrateFromStorage(): void {
		if (typeof localStorage === 'undefined') return;
		try {
			const savedProvider = localStorage.getItem('workbench_active_provider');
			if (savedProvider && this.providers.has(savedProvider as ProviderId)) {
				this.activeProviderId = savedProvider as ProviderId;
			}
			const gemini = this.providers.get('gemini');
			if (gemini && gemini instanceof GeminiProvider) {
				const apiKey =
					localStorage.getItem('workbench_gemini_api_key') ||
					localStorage.getItem('gemini_api_key') ||
					localStorage.getItem('geminiApiKey');
				if (apiKey) {
					gemini.setApiKey(apiKey);
				}
				const model = localStorage.getItem('workbench_gemini_model');
				if (model) {
					gemini.setDefaultModel(model);
				}
			}
		} catch {
			// Ignore storage access error during init
		}
	}
}
