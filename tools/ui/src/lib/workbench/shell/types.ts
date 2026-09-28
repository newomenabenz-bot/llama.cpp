/**
 * Workbench Shell Contracts & Specifications
 *
 * Types for dual-mode shell (Chat vs. Workbench IDE), panel states,
 * sizing ratios, and layout persistence.
 */

export type WorkbenchViewMode = 'chat' | 'workbench';

export type WorkbenchPanelId = 'left' | 'right' | 'bottom';

export interface WorkbenchPanelState {
	/** Whether the panel is open/visible */
	isVisible: boolean;
	/** Fractional size ratio of the parent container (between 0 and 1) */
	sizeRatio: number;
}

export interface WorkbenchShellState {
	/** Active shell mode: standard Chat vs multi-pane Workbench IDE */
	mode: WorkbenchViewMode;
	/** Left file tree explorer panel */
	leftPanel: WorkbenchPanelState;
	/** Right file viewer / diff inspector panel */
	rightPanel: WorkbenchPanelState;
	/** Bottom terminal execution console panel */
	bottomPanel: WorkbenchPanelState;
}

export const WORKBENCH_SHELL_STORAGE_KEY = 'LlamaUi.workbench.shell';

export const DEFAULT_SHELL_STATE: WorkbenchShellState = {
	mode: 'chat',
	leftPanel: {
		isVisible: true,
		sizeRatio: 0.2
	},
	rightPanel: {
		isVisible: true,
		sizeRatio: 0.45
	},
	bottomPanel: {
		isVisible: false,
		sizeRatio: 0.3
	}
};
