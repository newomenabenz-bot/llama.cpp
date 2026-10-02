/**
 * Unit tests for Initialization Resilience and Splash Screen Lockout Elimination
 * Directive: DIR-INIT-RESILIENCE-10
 *
 * Verifies:
 * 1. apiFetch enforces request timeouts and converts timeout errors to 'Request timed out'.
 * 2. serverStore.fetch guarantees this.loading resets within 3000ms max even on hanging /props.
 * 3. serverStore detectRole correctly handles router mode with default router properties.
 * 4. modelsStore immediately finishes loading when router models are empty.
 * 5. Gemini cached models are prioritized when activeProvider is gemini.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Polyfill minimal localStorage for Node test runner
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

import { apiFetch } from '$lib/utils/api-fetch';
import { serverStore } from '$lib/stores/server.svelte';
import { modelsStore } from '$lib/stores/models/index.svelte';
import { PropsService } from '$lib/services/props.service';
import { ModelsService } from '$lib/services/models.service';
import { ServerRole } from '$lib/enums';
import { WorkbenchSettingsService } from '$lib/workbench/settings/workbench-settings.service';

describe('Initialization Resilience (DIR-INIT-RESILIENCE-10)', () => {
	beforeEach(() => {
		vi.useRealTimers();
		localStorage.clear();
		WorkbenchSettingsService.resetToDefaults();
		serverStore.clear();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		localStorage.clear();
		WorkbenchSettingsService.resetToDefaults();
		serverStore.clear();
	});

	describe('apiFetch Timeouts', () => {
		it('aborts hanging fetch requests and converts to Request timed out', async () => {
			// Mock global fetch to simulate a hanging connection
			vi.stubGlobal(
				'fetch',
				vi.fn((_url: string, init?: RequestInit) => {
					return new Promise((_resolve, reject) => {
						if (init?.signal) {
							init.signal.addEventListener('abort', () => {
								reject(new DOMException('Request timed out', 'TimeoutError'));
							});
						}
					});
				})
			);

			// Fast timeout of 50ms for testing
			await expect(apiFetch('/v1/models', { timeout: 50 })).rejects.toThrow('Request timed out');
		});

		it('returns data when fetch completes within timeout window', async () => {
			const mockResponse = { data: [{ id: 'test-model' }] };
			vi.stubGlobal(
				'fetch',
				vi.fn(async () => ({
					ok: true,
					json: async () => mockResponse
				}))
			);

			const result = await apiFetch<typeof mockResponse>('/v1/models', { timeout: 1000 });
			expect(result).toEqual(mockResponse);
		});
	});

	describe('serverStore Loading Timeout & Router Defaults', () => {
		it('guarantees loading = false within 3000ms even if PropsService hangs', async () => {
			vi.useFakeTimers();

			// Mock PropsService.fetch to hang indefinitely
			vi.spyOn(PropsService, 'fetch').mockImplementation(
				() => new Promise(() => {}) // never resolves
			);

			const fetchPromise = serverStore.fetch();
			expect(serverStore.loading).toBe(true);

			// Advance time by 3000ms
			vi.advanceTimersByTime(3000);

			// loading must be released to prevent user lockout
			expect(serverStore.loading).toBe(false);

			// Cleanup
			serverStore.clear();
			void fetchPromise;
		});

		it('configures default router properties and marks ready when role is router', async () => {
			vi.spyOn(PropsService, 'fetch').mockResolvedValue({
				role: ServerRole.ROUTER
			} as unknown as ApiLlamaCppServerProps);

			await serverStore.fetch();

			expect(serverStore.isRouterMode).toBe(true);
			expect(serverStore.props?.default_generation_settings?.n_ctx).toBe(4096);
			expect(serverStore.error).toBeNull();
			expect(serverStore.loading).toBe(false);
		});
	});

	describe('modelsStore Empty Router State & Gemini Prioritization', () => {
		it('immediately finishes loading when router models response is empty without querying modalities', async () => {
			// Set serverStore to router mode
			vi.spyOn(PropsService, 'fetch').mockResolvedValue({
				role: ServerRole.ROUTER
			} as unknown as ApiLlamaCppServerProps);
			await serverStore.fetch();

			// Mock ModelsService.listRouter to return empty data
			vi.spyOn(ModelsService, 'listRouter').mockResolvedValue({
				data: []
			} as unknown as ApiRouterModelsListResponse);

			const fetchModalitiesSpy = vi.spyOn(modelsStore.props, 'fetchModalitiesForLoadedModels');

			await modelsStore.fetch(true);

			expect(modelsStore.loading).toBe(false);
			expect(modelsStore.models).toEqual([]);
			expect(fetchModalitiesSpy).not.toHaveBeenCalled();
		});

		it('prioritizes syncing cached Gemini models when activeProvider is gemini', async () => {
			WorkbenchSettingsService.setActiveProviderId('gemini');
			WorkbenchSettingsService.saveCachedGeminiModels([
				{ id: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' },
				{ id: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash' }
			]);
			WorkbenchSettingsService.saveSelectedGeminiModel('gemini-2.5-pro');

			await modelsStore.fetch(true);

			expect(modelsStore.models.length).toBe(2);
			expect(modelsStore.selectedModelName).toBe('gemini-2.5-pro');
			expect(modelsStore.loading).toBe(false);
		});
	});
});
