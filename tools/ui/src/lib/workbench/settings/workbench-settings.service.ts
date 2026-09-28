/**
 * WorkbenchSettingsService - Local persistence & synchronization for OMENA workbench settings.
 *
 * Manages provider selection (llama-server vs Google Gemini), API credentials, and
 * model overrides. Automatically synchronizes updates with ProviderService.
 */

import { ProviderService } from '../providers/provider.service';
import { GeminiProvider } from '../providers/gemini.provider';
import type { ExecutionMode } from '../security/types';
import { policyService } from '../security/policy.service';

export const WORKBENCH_STORAGE_KEYS = {
	ACTIVE_PROVIDER: 'workbench_active_provider',
	GEMINI_API_KEY: 'workbench_gemini_api_key',
	GEMINI_MODEL: 'workbench_gemini_model',
	EXECUTION_MODE: 'workbench_execution_mode',
	WORKSPACE_ROOT: 'workbench_workspace_root'
} as const;

export const DEFAULT_GEMINI_MODELS = [
	{
		id: 'gemini-2.5-flash',
		name: 'Gemini 2.5 Flash',
		description: 'Fastest multimodal model with native reasoning'
	},
	{
		id: 'gemini-2.5-pro',
		name: 'Gemini 2.5 Pro',
		description: 'Most capable model for complex coding and deep reasoning'
	},
	{
		id: 'gemini-1.5-flash',
		name: 'Gemini 1.5 Flash',
		description: 'High-speed lightweight multimodal workhorse'
	},
	{
		id: 'gemini-1.5-pro',
		name: 'Gemini 1.5 Pro',
		description: 'Extended context reasoning model'
	}
] as const;

export interface WorkbenchSettings {
	activeProviderId: 'llama-server' | 'gemini';
	geminiApiKey: string;
	geminiModel: string;
	executionMode: ExecutionMode;
	workspaceRoot: string;
}

type SettingsListener = (settings: WorkbenchSettings) => void;

export class WorkbenchSettingsService {
	private static listeners = new Set<SettingsListener>();
	private static inMemoryProviderId: 'llama-server' | 'gemini' = 'llama-server';
	private static inMemoryApiKey = '';
	private static inMemoryModel = 'gemini-2.5-flash';
	private static inMemoryMode: ExecutionMode = 'SAFE';
	private static inMemoryWorkspaceRoot = '';

	/**
	 * Returns the currently active provider ID ('llama-server' | 'gemini').
	 * Defaults to 'llama-server' if not explicitly configured.
	 */
	static getActiveProviderId(): 'llama-server' | 'gemini' {
		if (typeof localStorage !== 'undefined') {
			try {
				const stored = localStorage.getItem(WORKBENCH_STORAGE_KEYS.ACTIVE_PROVIDER);
				if (stored === 'gemini' || stored === 'llama-server') {
					return stored;
				}
			} catch {
				// Fallback on storage errors
			}
		}

		return this.inMemoryProviderId;
	}

	/**
	 * Sets and persists the active provider ID, then syncs with ProviderService.
	 */
	static setActiveProviderId(id: 'llama-server' | 'gemini'): void {
		this.inMemoryProviderId = id;
		if (typeof localStorage !== 'undefined') {
			try {
				localStorage.setItem(WORKBENCH_STORAGE_KEYS.ACTIVE_PROVIDER, id);
			} catch (e) {
				console.warn('[WorkbenchSettingsService] Failed to save active provider:', e);
			}
		}

		this.syncToProviderService();
		this.notifyListeners();
	}

	/**
	 * Retrieves the configured Gemini API key from localStorage or environment fallbacks.
	 */
	static getGeminiApiKey(): string {
		if (typeof localStorage !== 'undefined') {
			try {
				const key = localStorage.getItem(WORKBENCH_STORAGE_KEYS.GEMINI_API_KEY);
				if (key && key.trim()) {
					return key.trim();
				}

				// Legacy key fallbacks
				const legacyKey =
					localStorage.getItem('gemini_api_key') || localStorage.getItem('geminiApiKey');
				if (legacyKey && legacyKey.trim()) {
					return legacyKey.trim();
				}
			} catch {
				// Fallback on storage errors
			}
		} else if (this.inMemoryApiKey && this.inMemoryApiKey.trim()) {
			return this.inMemoryApiKey.trim();
		}

		if (typeof process !== 'undefined' && process.env) {
			const envKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
			if (envKey && envKey.trim()) {
				return envKey.trim();
			}
		}

		return '';
	}

	/**
	 * Sets and persists the Gemini API key, then syncs credentials to ProviderService.
	 */
	static setGeminiApiKey(key: string): void {
		const cleanKey = key.trim();
		this.inMemoryApiKey = cleanKey;

		if (typeof localStorage !== 'undefined') {
			try {
				if (cleanKey) {
					localStorage.setItem(WORKBENCH_STORAGE_KEYS.GEMINI_API_KEY, cleanKey);
				} else {
					localStorage.removeItem(WORKBENCH_STORAGE_KEYS.GEMINI_API_KEY);
				}
			} catch (e) {
				console.warn('[WorkbenchSettingsService] Failed to save Gemini API key:', e);
			}
		}

		this.syncToProviderService();
		this.notifyListeners();
	}

	/**
	 * Retrieves the configured Gemini default model.
	 */
	static getGeminiModel(): string {
		if (typeof localStorage !== 'undefined') {
			try {
				const model = localStorage.getItem(WORKBENCH_STORAGE_KEYS.GEMINI_MODEL);
				if (model && model.trim()) {
					return model.trim();
				}
			} catch {
				// Fallback on storage errors
			}

			return 'gemini-2.5-flash';
		}

		return this.inMemoryModel;
	}

	/**
	 * Sets and persists the Gemini model override.
	 */
	static setGeminiModel(model: string): void {
		const cleanModel = model.trim() || 'gemini-2.5-flash';
		this.inMemoryModel = cleanModel;

		if (typeof localStorage !== 'undefined') {
			try {
				localStorage.setItem(WORKBENCH_STORAGE_KEYS.GEMINI_MODEL, cleanModel);
			} catch (e) {
				console.warn('[WorkbenchSettingsService] Failed to save Gemini model:', e);
			}
		}

		this.syncToProviderService();
		this.notifyListeners();
	}

	/**
	 * Returns the currently active execution mode ('SAFE' | 'ASSISTED' | 'AUTONOMOUS').
	 * Defaults to 'SAFE'.
	 */
	static getExecutionMode(): ExecutionMode {
		if (typeof localStorage !== 'undefined') {
			try {
				const stored = localStorage.getItem(WORKBENCH_STORAGE_KEYS.EXECUTION_MODE);
				if (stored === 'SAFE' || stored === 'ASSISTED' || stored === 'AUTONOMOUS') {
					return stored;
				}
			} catch {
				// Fallback on storage errors
			}

			return 'SAFE';
		}

		return this.inMemoryMode;
	}

	/**
	 * Sets and persists the execution mode.
	 */
	static setExecutionMode(mode: ExecutionMode): void {
		this.inMemoryMode = mode;
		if (typeof localStorage !== 'undefined') {
			try {
				localStorage.setItem(WORKBENCH_STORAGE_KEYS.EXECUTION_MODE, mode);
			} catch (e) {
				console.warn('[WorkbenchSettingsService] Failed to save execution mode:', e);
			}
		}

		policyService.setMode(mode);
		this.notifyListeners();
	}

	/**
	 * Returns the configured workspace root directory path.
	 */
	static getWorkspaceRoot(): string {
		if (typeof localStorage !== 'undefined') {
			try {
				const stored = localStorage.getItem(WORKBENCH_STORAGE_KEYS.WORKSPACE_ROOT);
				if (stored && stored.trim()) {
					return stored.trim();
				}
			} catch {
				// Fallback on storage errors
			}
		} else if (this.inMemoryWorkspaceRoot && this.inMemoryWorkspaceRoot.trim()) {
			return this.inMemoryWorkspaceRoot.trim();
		}

		if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
			try {
				return process.cwd();
			} catch {
				// Fallback if process.cwd fails
			}
		}

		return '';
	}

	/**
	 * Sets and persists the workspace root directory path.
	 */
	static setWorkspaceRoot(root: string): void {
		const clean = root.trim();
		this.inMemoryWorkspaceRoot = clean;
		if (typeof localStorage !== 'undefined') {
			try {
				if (clean) {
					localStorage.setItem(WORKBENCH_STORAGE_KEYS.WORKSPACE_ROOT, clean);
				} else {
					localStorage.removeItem(WORKBENCH_STORAGE_KEYS.WORKSPACE_ROOT);
				}
			} catch (e) {
				console.warn('[WorkbenchSettingsService] Failed to save workspace root:', e);
			}
		}

		this.notifyListeners();
	}

	/**
	 * Resets all workbench settings to default values.
	 */
	static resetToDefaults(): void {
		this.inMemoryProviderId = 'llama-server';
		this.inMemoryApiKey = '';
		this.inMemoryModel = 'gemini-2.5-flash';
		this.inMemoryMode = 'SAFE';
		this.inMemoryWorkspaceRoot = '';
		policyService.setMode('SAFE');

		if (typeof localStorage !== 'undefined') {
			try {
				localStorage.removeItem(WORKBENCH_STORAGE_KEYS.ACTIVE_PROVIDER);
				localStorage.removeItem(WORKBENCH_STORAGE_KEYS.GEMINI_API_KEY);
				localStorage.removeItem(WORKBENCH_STORAGE_KEYS.GEMINI_MODEL);
				localStorage.removeItem(WORKBENCH_STORAGE_KEYS.EXECUTION_MODE);
				localStorage.removeItem(WORKBENCH_STORAGE_KEYS.WORKSPACE_ROOT);
			} catch {
				// ignore
			}
		}

		this.syncToProviderService();
		this.notifyListeners();
	}

	/**
	 * Returns a snapshot of all workbench settings.
	 */
	static getAllSettings(): WorkbenchSettings {
		return {
			activeProviderId: this.getActiveProviderId(),
			geminiApiKey: this.getGeminiApiKey(),
			geminiModel: this.getGeminiModel(),
			executionMode: this.getExecutionMode(),
			workspaceRoot: this.getWorkspaceRoot()
		};
	}

	/**
	 * Synchronizes current workbench settings with the registered providers in ProviderService.
	 */
	static syncToProviderService(): void {
		const activeId = this.getActiveProviderId();
		try {
			ProviderService.setActiveProvider(activeId);
		} catch (e) {
			console.warn('[WorkbenchSettingsService] Failed to switch active provider:', e);
		}

		const gemini = ProviderService.getProvider('gemini');
		if (gemini && gemini instanceof GeminiProvider) {
			const key = this.getGeminiApiKey();
			if (key) {
				gemini.setApiKey(key);
			}
			const model = this.getGeminiModel();
			if (model) {
				gemini.setDefaultModel(model);
			}
		}
	}

	/**
	 * Registers a listener that is notified whenever workbench settings change.
	 */
	static subscribe(listener: SettingsListener): () => void {
		this.listeners.add(listener);
		listener(this.getAllSettings());

		return () => {
			this.listeners.delete(listener);
		};
	}

	private static notifyListeners(): void {
		const snapshot = this.getAllSettings();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch (e) {
				console.error('[WorkbenchSettingsService] Error in settings listener:', e);
			}
		}
	}
}

// Initial sync on module load
if (typeof window !== 'undefined') {
	try {
		WorkbenchSettingsService.syncToProviderService();
	} catch {
		// Ignore during SSR or initial setup
	}
}
