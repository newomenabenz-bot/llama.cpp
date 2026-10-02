/**
 * ServerStorageSyncService - Server-backed persistence synchronization.
 *
 * Persists chat sessions and workbench/app settings to the server filesystem
 * under `/home/ubuntu/.llama-workbench/data/` (`conversations.json`, `settings.json`)
 * enabling seamless real-time cross-device synchronization and persistence across
 * devices, browsers, and private tabs.
 */

import { browser } from '$app/environment';
import { BuiltInTool } from '$lib/enums';
import type {
	DatabaseConversation,
	DatabaseMessage,
	ExportedConversation
} from '$lib/types/database';
import { settingsStore } from '../stores/settings/index.svelte';
import type { ExecutionMode } from '../workbench/security/types';
import { WorkbenchSettingsService } from '../workbench/settings/workbench-settings.service';
import { DatabaseService } from './database.service';
import { SettingsService } from './settings.service';
import { ToolsService } from './tools.service';

export const SERVER_STORAGE_PATHS = {
	CONVERSATIONS_FILE: '/home/ubuntu/.llama-workbench/data/conversations.json',
	DATA_DIR: '/home/ubuntu/.llama-workbench/data',
	SETTINGS_FILE: '/home/ubuntu/.llama-workbench/data/settings.json'
} as const;

export interface ServerConversationsPayload {
	conversations: ExportedConversation[];
	updatedAt: number;
	version: number;
}

export interface ServerSettingsPayload {
	appConfig?: Record<string, unknown>;
	updatedAt: number;
	userOverrides?: string[];
	version: number;
	workbench?: {
		activeProviderId?: 'llama-server' | 'gemini';
		executionMode?: ExecutionMode;
		geminiApiKey?: string;
		geminiModel?: string;
		geminiSelectedModel?: string;
		workspaceRoot?: string;
	};
}

export class ServerStorageSyncService {
	private static hasPulledConversations = false;
	private static isPullingConversations = false;
	private static isPushingConversations = false;
	private static pushConversationsTimer: ReturnType<typeof setTimeout> | null = null;

	private static hasPulledSettings = false;
	private static isPullingSettings = false;
	private static isPushingSettings = false;
	private static pushSettingsTimer: ReturnType<typeof setTimeout> | null = null;

	private static initialized = false;
	private static isApplyingServerSettings = false;

	private static isClientRuntime(): boolean {
		if (typeof process !== 'undefined' && (process.env?.VITEST || process.env?.NODE_ENV === 'test')) {
			return true;
		}
		return Boolean(browser || typeof window !== 'undefined');
	}

	/**
	 * Initializes the server storage synchronization subsystem.
	 * Registers database mutation listeners, settings listeners, window focus/visibility listeners,
	 * and periodic sync.
	 */
	static initSync(): void {
		if (!this.isClientRuntime() || this.initialized) return;
		this.initialized = true;

		// 1. Listen for database mutations (new/updated messages, conversations)
		DatabaseService.onMutation(() => {
			this.schedulePushConversations(1500);
		});

		// 2. Listen for workbench settings changes
		WorkbenchSettingsService.subscribe(() => {
			if (!this.isApplyingServerSettings) {
				this.schedulePushSettings(1500);
			}
		});

		// 3. Sync on window focus / visibility change
		if (typeof window !== 'undefined') {
			window.addEventListener('focus', () => {
				void this.pullConversations();
				void this.pullSettings();
			});

			document.addEventListener('visibilitychange', () => {
				if (document.visibilityState === 'visible') {
					void this.pullConversations();
					void this.pullSettings();
				}
			});
		}

		// 4. Periodic background sync every 60 seconds
		setInterval(() => {
			void this.pullConversations();
			void this.pullSettings();
		}, 60_000);
	}

	/**
	 * Pulls conversations from the server and hydrates local IndexedDB.
	 */
	static async pullConversations(): Promise<boolean> {
		if (!this.isClientRuntime() || this.isPullingConversations) return false;
		this.isPullingConversations = true;

		try {
			const res = await ToolsService.executeTool(
				BuiltInTool.SERVER_READ_FILE,
				{ path: SERVER_STORAGE_PATHS.CONVERSATIONS_FILE },
				undefined,
				SERVER_STORAGE_PATHS.DATA_DIR
			);

			if (res.isError || !res.content) {
				this.hasPulledConversations = true;
				return false;
			}

			const payload = JSON.parse(res.content) as ServerConversationsPayload;
			if (payload && Array.isArray(payload.conversations) && payload.conversations.length > 0) {
				await DatabaseService.syncWithServer(payload.conversations);
				this.hasPulledConversations = true;
				return true;
			}

			this.hasPulledConversations = true;
			return false;
		} catch (err) {
			console.warn('[ServerStorageSyncService] pullConversations failed:', err);
			this.hasPulledConversations = true;
			return false;
		} finally {
			this.isPullingConversations = false;
		}
	}

	/**
	 * Pushes all current conversations and messages from IndexedDB to the server.
	 */
	static async pushConversations(): Promise<boolean> {
		if (!this.isClientRuntime() || this.isPushingConversations) return false;
		// If we haven't pulled yet, don't overwrite server state
		if (!this.hasPulledConversations) return false;

		this.isPushingConversations = true;
		try {
			const convs = await DatabaseService.getAllConversations();
			const convIds = convs.map((c) => c.id).filter(Boolean);

			if (convIds.length === 0) {
				// Don't wipe server data if local happens to be momentarily empty
				return false;
			}

			const convMap = await DatabaseService.getConversationsWithMessages(convIds);
			const conversationsList: ExportedConversation[] = Array.from(convMap.values());

			const payload: ServerConversationsPayload = {
				conversations: conversationsList,
				updatedAt: Date.now(),
				version: 1
			};

			const content = JSON.stringify(payload, null, 2);
			const res = await ToolsService.executeTool(
				BuiltInTool.SERVER_WRITE_FILE,
				{
					content,
					path: SERVER_STORAGE_PATHS.CONVERSATIONS_FILE
				},
				undefined,
				SERVER_STORAGE_PATHS.DATA_DIR
			);

			return !res.isError;
		} catch (err) {
			console.warn('[ServerStorageSyncService] pushConversations failed:', err);
			return false;
		} finally {
			this.isPushingConversations = false;
		}
	}

	/**
	 * Schedules a debounced push of conversations to the server.
	 */
	static schedulePushConversations(delayMs: number = 1500): void {
		if (this.pushConversationsTimer) {
			clearTimeout(this.pushConversationsTimer);
		}
		this.pushConversationsTimer = setTimeout(() => {
			this.pushConversationsTimer = null;
			void this.pushConversations();
		}, delayMs);
	}

	/**
	 * Pulls settings from the server and hydrates local storage & stores.
	 */
	static async pullSettings(): Promise<boolean> {
		if (!this.isClientRuntime() || this.isPullingSettings) return false;
		this.isPullingSettings = true;

		try {
			const res = await ToolsService.executeTool(
				BuiltInTool.SERVER_READ_FILE,
				{ path: SERVER_STORAGE_PATHS.SETTINGS_FILE },
				undefined,
				SERVER_STORAGE_PATHS.DATA_DIR
			);

			if (res.isError || !res.content) {
				this.hasPulledSettings = true;
				return false;
			}

			const payload = JSON.parse(res.content) as ServerSettingsPayload;
			if (payload) {
				this.isApplyingServerSettings = true;
				try {
					if (payload.workbench) {
						const wb = payload.workbench;
						if (wb.activeProviderId) {
							WorkbenchSettingsService.setActiveProviderId(wb.activeProviderId);
						}
						if (wb.geminiApiKey && wb.geminiApiKey.trim()) {
							WorkbenchSettingsService.setGeminiApiKey(wb.geminiApiKey.trim());
						}
						if (wb.geminiModel) {
							WorkbenchSettingsService.setGeminiModel(wb.geminiModel);
						}
						if (wb.geminiSelectedModel) {
							WorkbenchSettingsService.saveSelectedGeminiModel(wb.geminiSelectedModel);
						}
						if (wb.executionMode) {
							WorkbenchSettingsService.setExecutionMode(wb.executionMode);
						}
						if (wb.workspaceRoot) {
							WorkbenchSettingsService.setWorkspaceRoot(wb.workspaceRoot);
						}
					}

					if (payload.appConfig && typeof payload.appConfig === 'object') {
						const current = SettingsService.loadConfig();
						const mergedConfig = { ...current.config, ...payload.appConfig };
						const mergedOverrides = Array.from(
							new Set([...current.userOverrides, ...(payload.userOverrides || [])])
						);
						SettingsService.saveConfig(mergedConfig, mergedOverrides);
						if (settingsStore && settingsStore.config) {
							for (const [key, value] of Object.entries(payload.appConfig)) {
								(settingsStore.config as Record<string, unknown>)[key] = value;
							}
						}
					}
				} finally {
					this.isApplyingServerSettings = false;
				}
				this.hasPulledSettings = true;
				return true;
			}

			this.hasPulledSettings = true;
			return false;
		} catch (err) {
			console.warn('[ServerStorageSyncService] pullSettings failed:', err);
			this.hasPulledSettings = true;
			return false;
		} finally {
			this.isPullingSettings = false;
		}
	}

	/**
	 * Pushes current workbench and app settings to the server.
	 */
	static async pushSettings(): Promise<boolean> {
		if (!this.isClientRuntime() || this.isPushingSettings) return false;
		if (!this.hasPulledSettings) return false;

		this.isPushingSettings = true;
		try {
			const { config, userOverrides } = SettingsService.loadConfig();
			const payload: ServerSettingsPayload = {
				appConfig: config,
				updatedAt: Date.now(),
				userOverrides,
				version: 1,
				workbench: {
					activeProviderId: WorkbenchSettingsService.getActiveProviderId(),
					executionMode: WorkbenchSettingsService.getExecutionMode(),
					geminiApiKey: WorkbenchSettingsService.getGeminiApiKey(),
					geminiModel: WorkbenchSettingsService.getGeminiModel(),
					geminiSelectedModel: WorkbenchSettingsService.getSelectedGeminiModel(),
					workspaceRoot: WorkbenchSettingsService.getWorkspaceRoot()
				}
			};

			const content = JSON.stringify(payload, null, 2);
			const res = await ToolsService.executeTool(
				BuiltInTool.SERVER_WRITE_FILE,
				{
					content,
					path: SERVER_STORAGE_PATHS.SETTINGS_FILE
				},
				undefined,
				SERVER_STORAGE_PATHS.DATA_DIR
			);

			return !res.isError;
		} catch (err) {
			console.warn('[ServerStorageSyncService] pushSettings failed:', err);
			return false;
		} finally {
			this.isPushingSettings = false;
		}
	}

	/**
	 * Schedules a debounced push of settings to the server.
	 */
	static schedulePushSettings(delayMs: number = 1500): void {
		if (this.pushSettingsTimer) {
			clearTimeout(this.pushSettingsTimer);
		}
		this.pushSettingsTimer = setTimeout(() => {
			this.pushSettingsTimer = null;
			void this.pushSettings();
		}, delayMs);
	}
}
