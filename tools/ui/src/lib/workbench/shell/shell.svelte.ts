/**
 * WorkbenchShellStore - Reactive Svelte 5 Rune Store for Dual-Mode Shell
 *
 * Coordinates layout mode (Chat vs. Workbench), panel visibility,
 * resize split ratios, and automatic localStorage persistence.
 */

import { browser } from '$app/environment';
import {
	DEFAULT_SHELL_STATE,
	WORKBENCH_SHELL_STORAGE_KEY,
	type WorkbenchPanelId,
	type WorkbenchPanelState,
	type WorkbenchShellState,
	type WorkbenchViewMode
} from './types';

export class WorkbenchShellStore {
	mode = $state<WorkbenchViewMode>(DEFAULT_SHELL_STATE.mode);
	leftPanel = $state<WorkbenchPanelState>({ ...DEFAULT_SHELL_STATE.leftPanel });
	rightPanel = $state<WorkbenchPanelState>({ ...DEFAULT_SHELL_STATE.rightPanel });
	bottomPanel = $state<WorkbenchPanelState>({ ...DEFAULT_SHELL_STATE.bottomPanel });

	constructor() {
		this.loadFromStorage();
	}

	/**
	 * Switches between standard Chat mode and multi-pane Workbench IDE mode.
	 */
	setMode(mode: WorkbenchViewMode): void {
		if (this.mode !== mode) {
			this.mode = mode;
			this.saveToStorage();
		}
	}

	/**
	 * Toggles the visibility of a designated workbench panel.
	 */
	togglePanel(panelId: WorkbenchPanelId): void {
		switch (panelId) {
			case 'left':
				this.leftPanel = {
					...this.leftPanel,
					isVisible: !this.leftPanel.isVisible
				};
				break;
			case 'right':
				this.rightPanel = {
					...this.rightPanel,
					isVisible: !this.rightPanel.isVisible
				};
				break;
			case 'bottom':
				this.bottomPanel = {
					...this.bottomPanel,
					isVisible: !this.bottomPanel.isVisible
				};
				break;
		}
		this.saveToStorage();
	}

	/**
	 * Explicitly sets panel visibility.
	 */
	setPanelVisibility(panelId: WorkbenchPanelId, isVisible: boolean): void {
		switch (panelId) {
			case 'left':
				this.leftPanel = { ...this.leftPanel, isVisible };
				break;
			case 'right':
				this.rightPanel = { ...this.rightPanel, isVisible };
				break;
			case 'bottom':
				this.bottomPanel = { ...this.bottomPanel, isVisible };
				break;
		}
		this.saveToStorage();
	}

	/**
	 * Updates panel size ratio, strictly clamped between 0 and 1.
	 */
	setPanelRatio(panelId: WorkbenchPanelId, ratio: number): void {
		const raw = Number.isFinite(ratio) ? ratio : 0;
		const clamped = Math.max(0, Math.min(1, raw));

		switch (panelId) {
			case 'left':
				this.leftPanel = { ...this.leftPanel, sizeRatio: clamped };
				break;
			case 'right':
				this.rightPanel = { ...this.rightPanel, sizeRatio: clamped };
				break;
			case 'bottom':
				this.bottomPanel = { ...this.bottomPanel, sizeRatio: clamped };
				break;
		}
		this.saveToStorage();
	}

	/**
	 * Returns current state snapshot.
	 */
	getState(): WorkbenchShellState {
		return {
			mode: this.mode,
			leftPanel: { ...this.leftPanel },
			rightPanel: { ...this.rightPanel },
			bottomPanel: { ...this.bottomPanel }
		};
	}

	/**
	 * Loads shell state from localStorage, validating schema.
	 */
	loadFromStorage(): void {
		if (!browser && typeof localStorage === 'undefined') {
			return;
		}

		try {
			const raw = localStorage.getItem(WORKBENCH_SHELL_STORAGE_KEY);
			if (!raw) return;

			const parsed = JSON.parse(raw) as Partial<WorkbenchShellState>;
			if (parsed.mode === 'chat' || parsed.mode === 'workbench') {
				this.mode = parsed.mode;
			}

			if (parsed.leftPanel && typeof parsed.leftPanel.isVisible === 'boolean') {
				this.leftPanel = {
					isVisible: parsed.leftPanel.isVisible,
					sizeRatio: Math.max(0, Math.min(1, Number(parsed.leftPanel.sizeRatio) || DEFAULT_SHELL_STATE.leftPanel.sizeRatio))
				};
			}

			if (parsed.rightPanel && typeof parsed.rightPanel.isVisible === 'boolean') {
				this.rightPanel = {
					isVisible: parsed.rightPanel.isVisible,
					sizeRatio: Math.max(0, Math.min(1, Number(parsed.rightPanel.sizeRatio) || DEFAULT_SHELL_STATE.rightPanel.sizeRatio))
				};
			}

			if (parsed.bottomPanel && typeof parsed.bottomPanel.isVisible === 'boolean') {
				this.bottomPanel = {
					isVisible: parsed.bottomPanel.isVisible,
					sizeRatio: Math.max(0, Math.min(1, Number(parsed.bottomPanel.sizeRatio) || DEFAULT_SHELL_STATE.bottomPanel.sizeRatio))
				};
			}
		} catch (err) {
			console.warn('[WorkbenchShellStore] Failed to load shell state from storage:', err);
		}
	}

	/**
	 * Commits current state to localStorage.
	 */
	saveToStorage(): void {
		if (!browser && typeof localStorage === 'undefined') {
			return;
		}

		try {
			const payload: WorkbenchShellState = this.getState();
			localStorage.setItem(WORKBENCH_SHELL_STORAGE_KEY, JSON.stringify(payload));
		} catch (err) {
			console.warn('[WorkbenchShellStore] Failed to save shell state to storage:', err);
		}
	}

	/**
	 * Resets store to default configuration and updates storage.
	 */
	reset(): void {
		this.mode = DEFAULT_SHELL_STATE.mode;
		this.leftPanel = { ...DEFAULT_SHELL_STATE.leftPanel };
		this.rightPanel = { ...DEFAULT_SHELL_STATE.rightPanel };
		this.bottomPanel = { ...DEFAULT_SHELL_STATE.bottomPanel };
		this.saveToStorage();
	}
}

export const workbenchShellStore = new WorkbenchShellStore();
