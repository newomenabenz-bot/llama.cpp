/**
 * Unit tests for ServerStorageSyncService & Database Mutation Synchronization.
 *
 * Verifies:
 * 1. DatabaseService.onMutation triggers on database changes.
 * 2. DatabaseService.syncWithServer imports server-side snapshots.
 * 3. ServerStorageSyncService pulls and hydrates conversations and settings.
 * 4. ServerStorageSyncService pushes conversations and settings snapshots to server storage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuiltInTool } from '$lib/enums';
import { DatabaseService } from '$lib/services/database.service';
import {
	ServerStorageSyncService,
	SERVER_STORAGE_PATHS
} from '$lib/services/server-storage-sync.service';
import { ToolsService } from '$lib/services/tools.service';
import { WorkbenchSettingsService } from '$lib/workbench/settings/workbench-settings.service';
import type { DatabaseConversation, DatabaseMessage } from '$lib/types/database';

describe('Server Storage Sync Subsystem', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		if (typeof localStorage !== 'undefined') {
			localStorage.clear();
		}
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (typeof localStorage !== 'undefined') {
			localStorage.clear();
		}
	});

	describe('a) Storage Paths Configuration', () => {
		it('points to correct server directory and JSON file paths', () => {
			expect(SERVER_STORAGE_PATHS.DATA_DIR).toBe('/home/ubuntu/.llama-workbench/data');
			expect(SERVER_STORAGE_PATHS.CONVERSATIONS_FILE).toBe(
				'/home/ubuntu/.llama-workbench/data/conversations.json'
			);
			expect(SERVER_STORAGE_PATHS.SETTINGS_FILE).toBe(
				'/home/ubuntu/.llama-workbench/data/settings.json'
			);
		});
	});

	describe('b) DatabaseService Mutation Notifications', () => {
		it('registers and invokes mutation listeners when onMutation is called', () => {
			let called = false;
			const unsubscribe = DatabaseService.onMutation(() => {
				called = true;
			});

			expect(typeof unsubscribe).toBe('function');
			// Notify directly via internal or mutation trigger
			DatabaseService['notifyMutation']();
			expect(called).toBe(true);

			// Unsubscribe cleans up listener
			called = false;
			unsubscribe();
			DatabaseService['notifyMutation']();
			expect(called).toBe(false);
		});
	});

	describe('c) Server Snapshot Pull & Hydration', () => {
		it('reads conversations.json from server and calls DatabaseService.syncWithServer', async () => {
			const mockConv: DatabaseConversation = {
				currNode: 'msg-1',
				id: 'test-conv-001',
				lastModified: 1727850000000,
				name: 'Test Conversation'
			};
			const mockMsg: DatabaseMessage = {
				children: [],
				content: 'Hello from server sync',
				convId: 'test-conv-001',
				id: 'msg-1',
				parent: null,
				role: 'user' as any,
				timestamp: 1727850000000,
				type: 'user'
			};

			const serverPayload = {
				conversations: [{ conv: mockConv, messages: [mockMsg] }],
				updatedAt: 1727850000000,
				version: 1
			};

			vi.spyOn(ToolsService, 'executeTool').mockResolvedValue({
				content: JSON.stringify(serverPayload),
				isError: false
			});

			const syncSpy = vi
				.spyOn(DatabaseService, 'syncWithServer')
				.mockResolvedValue({ importedCount: 1, updatedCount: 0 });

			const result = await ServerStorageSyncService.pullConversations();
			expect(result).toBe(true);
			expect(syncSpy).toHaveBeenCalledTimes(1);
			expect(syncSpy).toHaveBeenCalledWith(serverPayload.conversations);
		});

		it('gracefully handles missing server file when pulling', async () => {
			vi.spyOn(ToolsService, 'executeTool').mockResolvedValue({
				content: 'cannot stat file',
				isError: true
			});

			const result = await ServerStorageSyncService.pullConversations();
			expect(result).toBe(false);
		});
	});

	describe('d) Server Settings Pull & Push', () => {
		it('hydrates WorkbenchSettingsService when pulling settings.json', async () => {
			const serverSettingsPayload = {
				appConfig: { systemPrompt: 'You are a helpful assistant' },
				updatedAt: 1727850000000,
				version: 1,
				workbench: {
					activeProviderId: 'gemini' as const,
					executionMode: 'AUTONOMOUS' as const,
					geminiApiKey: 'AIzaSy-TestKey-999',
					geminiModel: 'gemini-2.5-flash',
					workspaceRoot: '/home/ubuntu'
				}
			};

			vi.spyOn(ToolsService, 'executeTool').mockResolvedValue({
				content: JSON.stringify(serverSettingsPayload),
				isError: false
			});

			const result = await ServerStorageSyncService.pullSettings();
			expect(result).toBe(true);
			expect(WorkbenchSettingsService.getActiveProviderId()).toBe('gemini');
			expect(WorkbenchSettingsService.getGeminiApiKey()).toBe('AIzaSy-TestKey-999');
			expect(WorkbenchSettingsService.getExecutionMode()).toBe('AUTONOMOUS');
		});

		it('pushes settings to server using SERVER_WRITE_FILE tool', async () => {
			WorkbenchSettingsService.setActiveProviderId('gemini');
			WorkbenchSettingsService.setGeminiApiKey('AIzaSy-TestKey-123');

			let capturedParams: Record<string, unknown> | null = null;
			vi.spyOn(ToolsService, 'executeTool').mockImplementation(
				async (tool: string, params: Record<string, unknown>) => {
					if (tool === BuiltInTool.SERVER_WRITE_FILE) {
						capturedParams = params;
						return { content: 'file written successfully', isError: false };
					}
					return { content: '', isError: false };
				}
			);

			// Simulate that initial pull completed
			ServerStorageSyncService['hasPulledSettings'] = true;

			const success = await ServerStorageSyncService.pushSettings();
			expect(success).toBe(true);
			expect(capturedParams).not.toBeNull();
			expect((capturedParams as any)?.path).toBe(SERVER_STORAGE_PATHS.SETTINGS_FILE);

			const writtenContent = JSON.parse((capturedParams as any)?.content as string);
			expect(writtenContent.workbench.activeProviderId).toBe('gemini');
			expect(writtenContent.workbench.geminiApiKey).toBe('AIzaSy-TestKey-123');
		});
	});
});
