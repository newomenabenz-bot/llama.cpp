/**
 * Workbench Terminal Contracts & Specifications
 *
 * Types for shell process execution, streaming output chunks,
 * execution records, and terminal UI session state.
 */

import type { CommandRisk } from '../security/types';

export type TerminalCommandStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted';

export interface TerminalExecutionRecord {
	/** Unique execution identifier */
	id: string;
	/** Command line string invoked */
	command: string;
	/** Working directory of execution */
	cwd: string;
	/** Current status of the command */
	status: TerminalCommandStatus;
	/** Cumulative streamed output (stdout + stderr) */
	output: string;
	/** Parsed process exit code, if terminated */
	exitCode?: number;
	/** Elapsed execution duration in milliseconds */
	durationMs?: number;
	/** Epoch timestamp in ms when execution began */
	startedAt: number;
	/** Epoch timestamp in ms when execution completed or failed */
	completedAt?: number;
	/** Classified command risk level */
	risk?: CommandRisk;
	/** Error message if rejected by policy or failed at runtime */
	error?: string;
}

export interface TerminalExecuteOptions {
	/** Working directory override (defaults to workspace root) */
	cwd?: string;
	/** Abort signal to cancel running command */
	signal?: AbortSignal;
	/** Callback for real-time incremental output chunks */
	onChunk?: (chunk: string) => void;
}
