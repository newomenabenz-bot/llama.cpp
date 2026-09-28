/**
 * Workspace Diff Contracts & Specifications
 *
 * Types for unified and split diff representations, change metrics,
 * and file diff payloads.
 */

export type DiffViewMode = 'unified' | 'split';

export interface DiffStats {
	/** Count of added lines */
	additions: number;
	/** Count of deleted lines */
	deletions: number;
	/** Count of paired modifications (min of adds and deletes) */
	modifications: number;
	/** True if original and modified content are identical */
	isClean: boolean;
}

export interface FileDiffPayload {
	/** Relative file path */
	filePath: string;
	/** Original pre-edit content */
	originalContent: string;
	/** Modified post-edit content */
	modifiedContent: string;
	/** Optional initial diff viewing mode */
	viewMode?: DiffViewMode;
}

export interface SplitDiffSide {
	lineNum?: number;
	text: string;
	kind: 'context' | 'add' | 'remove' | 'empty';
}

export interface SplitDiffRow {
	left: SplitDiffSide;
	right: SplitDiffSide;
}
