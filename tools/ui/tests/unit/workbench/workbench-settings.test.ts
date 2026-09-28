/**
 * Unit tests for WorkbenchSettingsService and runtime provider switching.
 *
 * Verifies:
 * - Default provider selection ('llama-server')
 * - Persistent storage of provider selection, API key, and model overrides
 * - Credential trimming and safe sanitization
 * - Reactive synchronization with ProviderService
 * - Dynamic ChatService routing to GeminiProvider when 'gemini' is active
 * - Listener subscriptions for reactive UI updates
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Install minimal in-memory localStorage for Node test runner
beforeAll(() => {
	const store = new Map<string, string>();
	const polyfill: Storage = {
		clear: () => store.clear(),
		getItem: (k) => (store.has(k) ? store.get(k)! : null),
		key: (i) => Array.from(store.keys())[i] ?? null,
		get length() {
			return store.size;
		},
		removeItem: (k) => {
			store.delete(k);
		},
		setItem: (k, v) => {
			store.set(k, String(v));
		}
	};

	(globalThis as unknown as { localStorage: Storage }).localStorage = polyfill;
});

import {
	WORKBENCH_STORAGE_KEYS,
	WorkbenchSettingsService
} from '$lib/workbench/settings/workbench-settings.service';
import { ProviderService } from '$lib/workbench/providers/provider.service';
import { GeminiProvider } from '$lib/workbench/providers/gemini.provider';
import { LlamaServerProvider } from '$lib/workbench/providers/llama-server.provider';
import { ChatService } from '$lib/services/chat.service';
import { MessageRole } from '$lib/enums';

describe('WorkbenchSettingsService Persistence', () => {
	beforeEach(() => {
		localStorage.clear();
		ProviderService.reset();
	});

	afterEach(() => {
		localStorage.clear();
		ProviderService.reset();
		vi.restoreAllMocks();
	});

	it('defaults active provider to llama-server when storage is empty', () => {
		expect(WorkbenchSettingsService.getActiveProviderId()).toBe('llama-server');
		expect(ProviderService.getActiveProviderId()).toBe('llama-server');
	});

	it('persists active provider to localStorage and updates ProviderService', () => {
		WorkbenchSettingsService.setActiveProviderId('gemini');

		expect(localStorage.getItem(WORKBENCH_STORAGE_KEYS.ACTIVE_PROVIDER)).toBe('gemini');
		expect(WorkbenchSettingsService.getActiveProviderId()).toBe('gemini');
		expect(ProviderService.getActiveProviderId()).toBe('gemini');
		expect(ProviderService.getActiveProvider().id).toBe('gemini');

		WorkbenchSettingsService.setActiveProviderId('llama-server');

		expect(localStorage.getItem(WORKBENCH_STORAGE_KEYS.ACTIVE_PROVIDER)).toBe('llama-server');
		expect(WorkbenchSettingsService.getActiveProviderId()).toBe('llama-server');
		expect(ProviderService.getActiveProviderId()).toBe('llama-server');
		expect(ProviderService.getActiveProvider().id).toBe('llama-server');
	});

	it('falls back to llama-server if stored value is invalid', () => {
		localStorage.setItem(WORKBENCH_STORAGE_KEYS.ACTIVE_PROVIDER, 'invalid-engine');

		expect(WorkbenchSettingsService.getActiveProviderId()).toBe('llama-server');
	});

	it('stores, trims, and cleans Gemini API keys', () => {
		WorkbenchSettingsService.setGeminiApiKey('   AIzaSyTestKey12345   ');

		expect(WorkbenchSettingsService.getGeminiApiKey()).toBe('AIzaSyTestKey12345');
		expect(localStorage.getItem(WORKBENCH_STORAGE_KEYS.GEMINI_API_KEY)).toBe(
			'AIzaSyTestKey12345'
		);

		// Setting empty string removes key
		WorkbenchSettingsService.setGeminiApiKey('   ');
		expect(WorkbenchSettingsService.getGeminiApiKey()).toBe('');
		expect(localStorage.getItem(WORKBENCH_STORAGE_KEYS.GEMINI_API_KEY)).toBeNull();
	});

	it('reads legacy API key fallback if workbench key is unset', () => {
		localStorage.setItem('gemini_api_key', 'legacy-key-999');

		expect(WorkbenchSettingsService.getGeminiApiKey()).toBe('legacy-key-999');
	});

	it('manages Gemini model selection with fallback to gemini-2.5-flash', () => {
		expect(WorkbenchSettingsService.getGeminiModel()).toBe('gemini-2.5-flash');

		WorkbenchSettingsService.setGeminiModel('gemini-2.5-pro');
		expect(WorkbenchSettingsService.getGeminiModel()).toBe('gemini-2.5-pro');
		expect(localStorage.getItem(WORKBENCH_STORAGE_KEYS.GEMINI_MODEL)).toBe('gemini-2.5-pro');

		// Empty string falls back to default
		WorkbenchSettingsService.setGeminiModel('');
		expect(WorkbenchSettingsService.getGeminiModel()).toBe('gemini-2.5-flash');
	});

	it('synchronizes credentials and model directly to GeminiProvider instance', () => {
		WorkbenchSettingsService.setGeminiApiKey('AIzaSyDirectSyncKey');
		WorkbenchSettingsService.setGeminiModel('gemini-2.5-pro');

		const gemini = ProviderService.getProvider('gemini') as GeminiProvider;
		expect(gemini).toBeDefined();
		expect(gemini.getApiKey()).toBe('AIzaSyDirectSyncKey');
		expect(gemini.getDefaultModel()).toBe('gemini-2.5-pro');
		expect(gemini.isConfigured()).toBe(true);
	});

	it('notifies subscribers on any settings mutation', () => {
		const listener = vi.fn();
		const unsubscribe = WorkbenchSettingsService.subscribe(listener);

		expect(listener).toHaveBeenCalledWith(
			expect.objectContaining({
				activeProviderId: 'llama-server',
				geminiApiKey: '',
				geminiModel: 'gemini-2.5-flash',
				executionMode: 'SAFE'
			})
		);

		WorkbenchSettingsService.setActiveProviderId('gemini');
		expect(listener).toHaveBeenLastCalledWith(
			expect.objectContaining({
				activeProviderId: 'gemini',
				geminiApiKey: '',
				geminiModel: 'gemini-2.5-flash',
				executionMode: 'SAFE'
			})
		);

		unsubscribe();
		WorkbenchSettingsService.setActiveProviderId('llama-server');
		expect(listener).toHaveBeenCalledTimes(2);
	});
});

describe('Runtime Provider Switching via ChatService', () => {
	beforeEach(() => {
		localStorage.clear();
		ProviderService.reset();
	});

	afterEach(() => {
		localStorage.clear();
		ProviderService.reset();
		vi.restoreAllMocks();
	});

	it('routes ChatService.sendMessage to LlamaServerProvider by default', async () => {
		const llamaSpy = vi
			.spyOn(LlamaServerProvider.prototype, 'sendMessage')
			.mockResolvedValue('llama response');

		const geminiSpy = vi
			.spyOn(GeminiProvider.prototype, 'sendMessage')
			.mockResolvedValue('gemini response');

		const result = await ChatService.sendMessage(
			[{ role: MessageRole.USER, content: 'Hello' }],
			{ stream: false }
		);

		expect(llamaSpy).toHaveBeenCalledTimes(1);
		expect(geminiSpy).not.toHaveBeenCalled();
		expect(result).toBe('llama response');
	});

	it('routes ChatService.sendMessage to GeminiProvider when switched in settings', async () => {
		WorkbenchSettingsService.setActiveProviderId('gemini');
		WorkbenchSettingsService.setGeminiApiKey('AIzaSyActiveRouteKey');

		const llamaSpy = vi
			.spyOn(LlamaServerProvider.prototype, 'sendMessage')
			.mockResolvedValue('llama response');

		const geminiSpy = vi
			.spyOn(GeminiProvider.prototype, 'sendMessage')
			.mockResolvedValue('gemini response');

		const result = await ChatService.sendMessage(
			[{ role: MessageRole.USER, content: 'Hello Gemini' }],
			{ stream: false }
		);

		expect(geminiSpy).toHaveBeenCalledTimes(1);
		expect(llamaSpy).not.toHaveBeenCalled();
		expect(result).toBe('gemini response');
	});

	it('dynamically switches routing back to llama-server when toggled back', async () => {
		WorkbenchSettingsService.setActiveProviderId('gemini');

		const llamaSpy = vi
			.spyOn(LlamaServerProvider.prototype, 'sendMessage')
			.mockResolvedValue('llama response');

		const geminiSpy = vi
			.spyOn(GeminiProvider.prototype, 'sendMessage')
			.mockResolvedValue('gemini response');

		// Switch back to llama-server
		WorkbenchSettingsService.setActiveProviderId('llama-server');

		await ChatService.sendMessage(
			[{ role: MessageRole.USER, content: 'Back to local' }],
			{ stream: false }
		);

		expect(llamaSpy).toHaveBeenCalledTimes(1);
		expect(geminiSpy).not.toHaveBeenCalled();
	});
});

import { render } from 'svelte/server';
import ProviderSettings from '$lib/workbench/components/ProviderSettings.svelte';

describe('ProviderSettings DOM Rendering', () => {
	beforeEach(() => {
		localStorage.clear();
		ProviderService.reset();
	});

	afterEach(() => {
		localStorage.clear();
		ProviderService.reset();
	});

	it('renders Model Provider header, selector buttons, and badges', () => {
		const { body } = render(ProviderSettings);
		expect(body).toContain('Model Provider');
		expect(body).toContain('llama-server (Local)');
		expect(body).toContain('Google Gemini');
		expect(body).toContain('Local llama-server');
	});

	it('renders Gemini API key input and model options when Gemini is active', () => {
		localStorage.setItem(WORKBENCH_STORAGE_KEYS.ACTIVE_PROVIDER, 'gemini');
		localStorage.setItem(WORKBENCH_STORAGE_KEYS.GEMINI_API_KEY, 'AIzaSyMockKey');

		const { body } = render(ProviderSettings);
		expect(body).toContain('Gemini API Key');
		expect(body).toContain('Default Gemini Model');
		expect(body).toContain('gemini-2.5-flash');
		expect(body).toContain('Key Configured');
	});
});

