/**
 * TerminalStore - Reactive Svelte 5 Rune Store for Terminal Deck
 *
 * Manages execution history, active command streaming, running status,
 * and visibility state for the Workbench terminal console.
 */

import { workspaceStore } from '../workspace/workspace.svelte';
import { WorkbenchTerminalService } from './terminal.service';
import type { TerminalExecutionRecord } from './types';

export class TerminalStore {
	history = $state<TerminalExecutionRecord[]>([]);
	activeRecord = $state<TerminalExecutionRecord | null>(null);
	isRunning = $state<boolean>(false);
	isOpen = $state<boolean>(false);

	private abortController: AbortController | null = null;

	/**
	 * Toggles terminal deck visibility.
	 */
	toggleOpen(): void {
		this.isOpen = !this.isOpen;
	}

	/**
	 * Opens the terminal deck.
	 */
	openTerminal(): void {
		this.isOpen = true;
	}

	/**
	 * Closes the terminal deck.
	 */
	closeTerminal(): void {
		this.isOpen = false;
	}

	/**
	 * Selects an execution record from history to inspect.
	 */
	selectRecord(id: string): void {
		const found = this.history.find((rec) => rec.id === id);
		if (found) {
			this.activeRecord = found;
		}
	}

	/**
	 * Clears terminal history and active selection.
	 */
	clearHistory(): void {
		this.history = [];
		this.activeRecord = null;
	}

	/**
	 * Aborts the actively executing command.
	 */
	abort(): void {
		if (this.isRunning && this.abortController) {
			this.abortController.abort();
		}
	}

	/**
	 * Executes a shell command, streams its output, and records execution history.
	 */
	async run(command: string, customCwd?: string): Promise<TerminalExecutionRecord | null> {
		const trimmed = command.trim();
		if (!trimmed || this.isRunning) {
			return null;
		}

		const cwd = customCwd && customCwd.trim().length > 0
			? customCwd.trim()
			: (workspaceStore.rootPath || '.');

		this.isRunning = true;
		this.abortController = new AbortController();

		// Create an initial live record so the UI renders immediately
		const startedAt = Date.now();
		const inFlightRecord: TerminalExecutionRecord = {
			id: `term_${startedAt}_${Math.random().toString(36).substring(2, 8)}`,
			command: trimmed,
			cwd,
			status: 'running',
			output: '',
			startedAt
		};

		this.activeRecord = inFlightRecord;
		this.history = [...this.history, inFlightRecord];

		try {
			const finalRecord = await WorkbenchTerminalService.executeCommand(
				trimmed,
				cwd,
				(chunk) => {
					// Update live output in both activeRecord and history entry
					inFlightRecord.output += chunk;
					this.activeRecord = { ...inFlightRecord };
					this.history = this.history.map((r) =>
						r.id === inFlightRecord.id ? { ...inFlightRecord } : r
					);
				},
				this.abortController.signal
			);

			// Merge final attributes creating a fresh immutable object to trigger Svelte 5 each reactivity
			const completedRecord: TerminalExecutionRecord = {
				...inFlightRecord,
				status: finalRecord.status,
				exitCode: finalRecord.exitCode,
				durationMs: finalRecord.durationMs,
				completedAt: finalRecord.completedAt,
				risk: finalRecord.risk,
				error: finalRecord.error,
				output:
					finalRecord.output ||
					(finalRecord.status === 'failed'
						? finalRecord.error || 'Command execution failed'
						: inFlightRecord.output)
			};

			this.activeRecord = completedRecord;
			this.history = this.history.map((r) =>
				r.id === inFlightRecord.id ? completedRecord : r
			);

			return completedRecord;
		} catch (err: unknown) {
			const errMsg = err instanceof Error ? err.message : String(err);
			const failedRecord: TerminalExecutionRecord = {
				...inFlightRecord,
				status: 'failed',
				error: errMsg,
				output: inFlightRecord.output
					? `${inFlightRecord.output}\n[Process execution failed: ${errMsg}]`
					: `[Process execution failed: ${errMsg}]`,
				completedAt: Date.now(),
				durationMs: Date.now() - startedAt,
				exitCode: 1
			};

			this.activeRecord = failedRecord;
			this.history = this.history.map((r) =>
				r.id === inFlightRecord.id ? failedRecord : r
			);

			return failedRecord;
		} finally {
			this.isRunning = false;
			this.abortController = null;
		}
	}

	/**
	 * Resets store state.
	 */
	reset(): void {
		if (this.isRunning && this.abortController) {
			this.abortController.abort();
		}
		this.history = [];
		this.activeRecord = null;
		this.isRunning = false;
		this.isOpen = false;
		this.abortController = null;
	}
}

export const terminalStore = new TerminalStore();
