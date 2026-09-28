/**
 * WorkspaceJournalStore - Reactive Svelte 5 Store for Pre-Mutation Snapshots & Rollback.
 *
 * Tracks captured pre-mutation file snapshots, exposes active selection,
 * provides reactive rollback status metrics, and drives undo actions.
 */

import { WorkbenchWorkspaceJournalService } from './journal.service';
import type { FileSnapshot, RollbackResult } from './journal.types';

export class WorkspaceJournalStore {
	snapshots = $state<FileSnapshot[]>(WorkbenchWorkspaceJournalService.getSnapshots());
	activeSnapshot = $state<FileSnapshot | null>(null);

	constructor() {
		WorkbenchWorkspaceJournalService.subscribe((list) => {
			this.snapshots = list;
			if (this.activeSnapshot) {
				this.activeSnapshot = list.find((s) => s.id === this.activeSnapshot?.id) ?? null;
			}
		});
	}

	/**
	 * Whether there are any un-reverted snapshots eligible for rollback.
	 */
	get canRollback(): boolean {
		return this.snapshots.some((s) => !s.reverted);
	}

	/**
	 * Count of un-reverted snapshots currently retained.
	 */
	get unRevertedCount(): number {
		return this.snapshots.filter((s) => !s.reverted).length;
	}

	/**
	 * Selects an active snapshot for inspection or diffing.
	 */
	selectSnapshot(snapshot: FileSnapshot | null): void {
		this.activeSnapshot = snapshot;
	}

	/**
	 * Rolls back a specific file snapshot by ID.
	 */
	async rollback(snapshotId: string): Promise<RollbackResult> {
		return WorkbenchWorkspaceJournalService.rollbackSnapshot(snapshotId);
	}

	/**
	 * Rolls back all snapshots captured for a specific task node.
	 */
	async rollbackTask(taskNodeId: string): Promise<RollbackResult[]> {
		return WorkbenchWorkspaceJournalService.rollbackTask(taskNodeId);
	}

	/**
	 * Clears the journal history.
	 */
	clear(): void {
		WorkbenchWorkspaceJournalService.clearJournal();
		this.activeSnapshot = null;
	}

	/**
	 * Resets store state.
	 */
	reset(): void {
		this.clear();
	}
}

export const workspaceJournalStore = new WorkspaceJournalStore();
