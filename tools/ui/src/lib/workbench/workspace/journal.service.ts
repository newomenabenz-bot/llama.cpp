/**
 * WorkbenchWorkspaceJournalService - Pre-Mutation Snapshot & Rollback Subsystem.
 *
 * Captures file states prior to executing mutating tools (write_file, edit_file),
 * maintains an in-memory ring buffer of file snapshots, executes atomic rollbacks,
 * and synchronizes with workspace file buffers.
 */

import { BuiltInTool } from '$lib/enums';
import { ToolsService } from '$lib/services/tools.service';
import {
	DEFAULT_JOURNAL_CONFIG,
	type FileSnapshot,
	type JournalCaptureOptions,
	type JournalConfig,
	type RollbackResult
} from './journal.types';
import { normalizeWorkspacePath } from './workspace-tree';
import { workspaceStore } from './workspace.svelte';

export type JournalToolExecutor = (
	toolName: string,
	args: Record<string, unknown>
) => Promise<unknown>;

export class WorkbenchWorkspaceJournalService {
	private static snapshots: FileSnapshot[] = [];
	private static listeners = new Set<(snapshots: FileSnapshot[]) => void>();
	private static customToolExecutor: JournalToolExecutor | null = null;
	private static config: Required<JournalConfig> = { ...DEFAULT_JOURNAL_CONFIG };

	/**
	 * Configures custom tool executor (primarily for unit tests).
	 */
	static setToolExecutor(executor: JournalToolExecutor | null): void {
		this.customToolExecutor = executor;
	}

	/**
	 * Updates journal configuration (e.g. ring buffer size).
	 */
	static setConfig(config: Partial<JournalConfig>): void {
		this.config = {
			...this.config,
			...config
		};
	}

	/**
	 * Subscribes a listener to journal updates. Returns unsubscribe function.
	 */
	static subscribe(listener: (snapshots: FileSnapshot[]) => void): () => void {
		this.listeners.add(listener);
		listener(this.getSnapshots());
		return () => {
			this.listeners.delete(listener);
		};
	}

	private static notifySubscribers(): void {
		const list = this.getSnapshots();
		for (const listener of this.listeners) {
			try {
				listener(list);
			} catch (err) {
				console.warn('[WorkbenchWorkspaceJournalService] Listener error:', err);
			}
		}
	}

	/**
	 * Captures a file snapshot before a mutating tool execution.
	 *
	 * Reads existing file content if available; records originalContent: null
	 * and mutationType: 'create' if the file does not yet exist.
	 */
	static async capturePreMutation(
		filePath: string,
		metadata?: JournalCaptureOptions
	): Promise<FileSnapshot> {
		const normalized = normalizeWorkspacePath(filePath) || filePath.trim();
		let originalContent: string | null = null;
		let mutationType: 'create' | 'modify' = 'create';

		// 1. Try reading from workspaceStore buffer cache first
		const cached = workspaceStore.getFileContent(normalized);
		if (typeof cached === 'string') {
			originalContent = cached;
			mutationType = 'modify';
		} else {
			// 2. Fetch from filesystem via tool service or custom executor
			try {
				let result: unknown;
				if (this.customToolExecutor) {
					result = await this.customToolExecutor('read_file', { path: normalized });
				} else {
					result = await ToolsService.executeTool(BuiltInTool.SERVER_READ_FILE, {
						path: normalized
					});
				}

				if (result && typeof result === 'object') {
					const toolRes = result as { content?: string; isError?: boolean };
					if (!toolRes.isError && typeof toolRes.content === 'string') {
						originalContent = toolRes.content;
						mutationType = 'modify';
					} else if (typeof (result as { content?: string }).content === 'string') {
						originalContent = (result as { content: string }).content;
						mutationType = 'modify';
					}
				} else if (typeof result === 'string') {
					originalContent = result;
					mutationType = 'modify';
				}
			} catch {
				// Reading failed - file likely does not exist yet (create mutation)
				originalContent = null;
				mutationType = 'create';
			}
		}

		const snapshot: FileSnapshot = {
			conversationId: metadata?.conversationId,
			filePath: normalized,
			id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
			mutationType,
			originalContent,
			reverted: false,
			taskNodeId: metadata?.taskNodeId,
			timestamp: Date.now()
		};

		// Push to ring buffer
		this.snapshots.push(snapshot);
		if (this.snapshots.length > this.config.maxSnapshots) {
			this.snapshots.shift();
		}

		this.notifySubscribers();
		return snapshot;
	}

	/**
	 * Rolls back a specific file snapshot by ID.
	 *
	 * Restores original content or clears newly created content, updates reverted state,
	 * and invalidates workspace file buffer cache.
	 */
	static async rollbackSnapshot(snapshotId: string): Promise<RollbackResult> {
		const snapshot = this.snapshots.find((s) => s.id === snapshotId);
		if (!snapshot) {
			return {
				error: `Snapshot "${snapshotId}" not found in journal`,
				filePath: '',
				snapshotId,
				success: false
			};
		}

		if (snapshot.reverted) {
			return {
				filePath: snapshot.filePath,
				snapshotId,
				success: true
			};
		}

		try {
			const restoreContent = snapshot.originalContent ?? '';

			if (this.customToolExecutor) {
				await this.customToolExecutor('write_file', {
					content: restoreContent,
					path: snapshot.filePath
				});
			} else {
				const res = await ToolsService.executeTool(BuiltInTool.SERVER_WRITE_FILE, {
					content: restoreContent,
					path: snapshot.filePath
				});
				if (res.isError) {
					throw new Error(res.content || 'Rollback write_file execution failed');
				}
			}

			snapshot.reverted = true;

			// Invalidate / update workspace buffer
			if (snapshot.originalContent !== null) {
				workspaceStore.cacheFileContent(snapshot.filePath, snapshot.originalContent);
			} else {
				// Created file rolled back to empty - clear from buffers
				const buffers = new Map(workspaceStore.fileBuffers);
				buffers.delete(snapshot.filePath);
				workspaceStore.fileBuffers = buffers;
			}

			this.notifySubscribers();

			return {
				filePath: snapshot.filePath,
				snapshotId,
				success: true
			};
		} catch (err) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			return {
				error: errorMsg,
				filePath: snapshot.filePath,
				snapshotId,
				success: false
			};
		}
	}

	/**
	 * Rolls back all snapshots associated with a specific taskNodeId in reverse chronological order.
	 */
	static async rollbackTask(taskNodeId: string): Promise<RollbackResult[]> {
		const matching = this.snapshots.filter((s) => s.taskNodeId === taskNodeId && !s.reverted);
		// Reverse chronological order (latest snapshot first)
		matching.sort((a, b) => b.timestamp - a.timestamp);

		const results: RollbackResult[] = [];
		for (const snapshot of matching) {
			const res = await this.rollbackSnapshot(snapshot.id);
			results.push(res);
		}

		return results;
	}

	/**
	 * Retrieves all active journal snapshots.
	 */
	static getSnapshots(): FileSnapshot[] {
		return [...this.snapshots];
	}

	/**
	 * Retrieves a single snapshot by ID.
	 */
	static getSnapshot(snapshotId: string): FileSnapshot | undefined {
		return this.snapshots.find((s) => s.id === snapshotId);
	}

	/**
	 * Retrieves all snapshots captured for a specific file path.
	 */
	static getSnapshotsForFile(filePath: string): FileSnapshot[] {
		const normalized = normalizeWorkspacePath(filePath) || filePath.trim();
		return this.snapshots.filter((s) => s.filePath === normalized);
	}

	/**
	 * Clears all snapshots from the journal ring buffer.
	 */
	static clearJournal(): void {
		this.snapshots = [];
		this.notifySubscribers();
	}
}
