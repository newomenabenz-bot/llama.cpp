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
				},
				this.abortController.signal
			);

			// Merge final attributes
			inFlightRecord.status = finalRecord.status;
			inFlightRecord.exitCode = finalRecord.exitCode;
			inFlightRecord.durationMs = finalRecord.durationMs;
			inFlightRecord.completedAt = finalRecord.completedAt;
			inFlightRecord.risk = finalRecord.risk;
			inFlightRecord.error = finalRecord.error;
			inFlightRecord.output = finalRecord.output;

			this.activeRecord = { ...inFlightRecord };
			// Trigger reactivity for history array
			this.history = [...this.history];

			return inFlightRecord;
		} catch (err: unknown) {
			inFlightRecord.status = 'failed';
			inFlightRecord.error = err instanceof Error ? err.message : String(err);
			inFlightRecord.completedAt = Date.now();
			inFlightRecord.durationMs = inFlightRecord.completedAt - startedAt;

			this.activeRecord = { ...inFlightRecord };
			this.history = [...this.history];

			return inFlightRecord;
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
