/**
 * Workspace Journal Contracts & Schema Definitions for Pre-Mutation Snapshots & Rollbacks.
 *
 * Defines snapshot records, mutation types, rollback outcomes, and journal options.
 */

export type MutationType = 'create' | 'modify' | 'delete';

export interface FileSnapshot {
	id: string; // Unique snapshot identifier (e.g. `snap_${Date.now()}_${rand}`)
	filePath: string; // Target file path (normalized)
	originalContent: string | null; // Null if file did not exist prior to mutation
	mutationType: MutationType;
	taskNodeId?: string; // Associated task node ID if part of a TaskGraph
	conversationId?: string;
	timestamp: number;
	reverted: boolean;
}

export interface RollbackResult {
	success: boolean;
	snapshotId: string;
	filePath: string;
	error?: string;
}

export interface JournalCaptureOptions {
	taskNodeId?: string;
	conversationId?: string;
}

export interface JournalConfig {
	maxSnapshots?: number;
}

export const DEFAULT_JOURNAL_CONFIG: Required<JournalConfig> = {
	maxSnapshots: 100
};
