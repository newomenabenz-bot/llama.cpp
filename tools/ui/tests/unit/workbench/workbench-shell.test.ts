/**
 * Unit tests for Workbench Shell Subsystem & WorkbenchSplitter Component.
 *
 * Verifies:
 * 1. WorkbenchShellStore initialization and default panel layout states.
 * 2. Mode switching between Chat and Workbench IDE modes.
 * 3. Panel visibility toggles and explicit visibility setters.
 * 4. Sizing ratio updates, clamping boundary enforcement (0 to 1), and invalid input safety.
 * 5. Automatic localStorage persistence and hydration recovery.
 * 6. SSR / DOM rendering of WorkbenchSplitter in horizontal and vertical directions.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import {
	DEFAULT_SHELL_STATE,
	WORKBENCH_SHELL_STORAGE_KEY,
	type WorkbenchShellState
} from '$lib/workbench/shell/types';
import { WorkbenchShellStore, workbenchShellStore } from '$lib/workbench/shell/shell.svelte';
import WorkbenchSplitter from '$lib/workbench/components/WorkbenchSplitter.svelte';

beforeAll(() => {
	// Polyfill localStorage in node unit test runner
	const store = new Map<string, string>();
	const polyfill: Storage = {
		clear: () => store.clear(),
		getItem: (k) => (store.has(k) ? store.get(k)! : null),
		key: (i) => Array.from(store.keys())[i] ?? null,
		get length() {
			return store.size;
		},
		removeItem: (k) => {
			store.delete(k);
		},
		setItem: (k, v) => {
			store.set(k, String(v));
		}
	};

	(globalThis as unknown as { localStorage: Storage }).localStorage = polyfill;
});

describe('Workbench Shell Subsystem', () => {
	beforeEach(() => {
		localStorage.clear();
		workbenchShellStore.reset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
		workbenchShellStore.reset();
	});

	describe('a) Shell Store Initialization & Defaults', () => {
		it('initializes with default Chat mode and panel proportions', () => {
			expect(workbenchShellStore.mode).toBe('chat');
			expect(workbenchShellStore.leftPanel).toEqual(DEFAULT_SHELL_STATE.leftPanel);
			expect(workbenchShellStore.rightPanel).toEqual(DEFAULT_SHELL_STATE.rightPanel);
			expect(workbenchShellStore.bottomPanel).toEqual(DEFAULT_SHELL_STATE.bottomPanel);
		});

		it('returns a full state snapshot via getState()', () => {
			const state = workbenchShellStore.getState();
			expect(state.mode).toBe('chat');
			expect(state.leftPanel.isVisible).toBe(true);
			expect(state.leftPanel.sizeRatio).toBe(0.2);
			expect(state.rightPanel.isVisible).toBe(true);
			expect(state.rightPanel.sizeRatio).toBe(0.45);
			expect(state.bottomPanel.isVisible).toBe(false);
			expect(state.bottomPanel.sizeRatio).toBe(0.3);
		});
	});

	describe('b) Mode Toggling & Storage Sync', () => {
		it('switches to workbench mode and commits to localStorage', () => {
			workbenchShellStore.setMode('workbench');
			expect(workbenchShellStore.mode).toBe('workbench');

			const storedRaw = localStorage.getItem(WORKBENCH_SHELL_STORAGE_KEY);
			expect(storedRaw).not.toBeNull();

			const parsed = JSON.parse(storedRaw!) as WorkbenchShellState;
			expect(parsed.mode).toBe('workbench');
		});

		it('switches back to chat mode and updates localStorage', () => {
			workbenchShellStore.setMode('workbench');
			workbenchShellStore.setMode('chat');
			expect(workbenchShellStore.mode).toBe('chat');

			const stored = JSON.parse(localStorage.getItem(WORKBENCH_SHELL_STORAGE_KEY)!) as WorkbenchShellState;
			expect(stored.mode).toBe('chat');
		});
	});

	describe('c) Panel Visibility Controls', () => {
		it('toggles left, right, and bottom panel visibility', () => {
			expect(workbenchShellStore.leftPanel.isVisible).toBe(true);
			workbenchShellStore.togglePanel('left');
			expect(workbenchShellStore.leftPanel.isVisible).toBe(false);

			expect(workbenchShellStore.bottomPanel.isVisible).toBe(false);
			workbenchShellStore.togglePanel('bottom');
			expect(workbenchShellStore.bottomPanel.isVisible).toBe(true);

			expect(workbenchShellStore.rightPanel.isVisible).toBe(true);
			workbenchShellStore.togglePanel('right');
			expect(workbenchShellStore.rightPanel.isVisible).toBe(false);

			// Check persistence
			const stored = JSON.parse(localStorage.getItem(WORKBENCH_SHELL_STORAGE_KEY)!) as WorkbenchShellState;
			expect(stored.leftPanel.isVisible).toBe(false);
			expect(stored.bottomPanel.isVisible).toBe(true);
			expect(stored.rightPanel.isVisible).toBe(false);
		});

		it('explicitly sets panel visibility via setPanelVisibility()', () => {
			workbenchShellStore.setPanelVisibility('bottom', true);
			expect(workbenchShellStore.bottomPanel.isVisible).toBe(true);

			workbenchShellStore.setPanelVisibility('bottom', false);
			expect(workbenchShellStore.bottomPanel.isVisible).toBe(false);
		});
	});

	describe('d) Sizing Ratio Updates & Clamping', () => {
		it('updates panel ratios correctly within valid range', () => {
			workbenchShellStore.setPanelRatio('left', 0.28);
			expect(workbenchShellStore.leftPanel.sizeRatio).toBe(0.28);

			workbenchShellStore.setPanelRatio('right', 0.5);
			expect(workbenchShellStore.rightPanel.sizeRatio).toBe(0.5);

			workbenchShellStore.setPanelRatio('bottom', 0.35);
			expect(workbenchShellStore.bottomPanel.sizeRatio).toBe(0.35);

			const stored = JSON.parse(localStorage.getItem(WORKBENCH_SHELL_STORAGE_KEY)!) as WorkbenchShellState;
			expect(stored.leftPanel.sizeRatio).toBe(0.28);
			expect(stored.rightPanel.sizeRatio).toBe(0.5);
			expect(stored.bottomPanel.sizeRatio).toBe(0.35);
		});

		it('clamps negative ratios to 0', () => {
			workbenchShellStore.setPanelRatio('left', -0.5);
			expect(workbenchShellStore.leftPanel.sizeRatio).toBe(0);

			const stored = JSON.parse(localStorage.getItem(WORKBENCH_SHELL_STORAGE_KEY)!) as WorkbenchShellState;
			expect(stored.leftPanel.sizeRatio).toBe(0);
		});

		it('clamps excessive ratios > 1 to 1', () => {
			workbenchShellStore.setPanelRatio('right', 1.75);
			expect(workbenchShellStore.rightPanel.sizeRatio).toBe(1);

			const stored = JSON.parse(localStorage.getItem(WORKBENCH_SHELL_STORAGE_KEY)!) as WorkbenchShellState;
			expect(stored.rightPanel.sizeRatio).toBe(1);
		});

		it('handles non-finite values (NaN / Infinity) by clamping to 0 or 1', () => {
			workbenchShellStore.setPanelRatio('left', NaN);
			expect(workbenchShellStore.leftPanel.sizeRatio).toBe(0);

			workbenchShellStore.setPanelRatio('left', Infinity);
			expect(workbenchShellStore.leftPanel.sizeRatio).toBe(0);
		});
	});

	describe('e) Storage Hydration & Recovery', () => {
		it('hydrates initial state from pre-existing localStorage record', () => {
			const customState: WorkbenchShellState = {
				mode: 'workbench',
				leftPanel: { isVisible: false, sizeRatio: 0.15 },
				rightPanel: { isVisible: true, sizeRatio: 0.55 },
				bottomPanel: { isVisible: true, sizeRatio: 0.4 }
			};
			localStorage.setItem(WORKBENCH_SHELL_STORAGE_KEY, JSON.stringify(customState));

			const newStore = new WorkbenchShellStore();
			expect(newStore.mode).toBe('workbench');
			expect(newStore.leftPanel.isVisible).toBe(false);
			expect(newStore.leftPanel.sizeRatio).toBe(0.15);
			expect(newStore.rightPanel.isVisible).toBe(true);
			expect(newStore.rightPanel.sizeRatio).toBe(0.55);
			expect(newStore.bottomPanel.isVisible).toBe(true);
			expect(newStore.bottomPanel.sizeRatio).toBe(0.4);
		});

		it('gracefully falls back to defaults when storage data is invalid JSON', () => {
			localStorage.setItem(WORKBENCH_SHELL_STORAGE_KEY, 'invalid-json{{');

			const newStore = new WorkbenchShellStore();
			expect(newStore.mode).toBe(DEFAULT_SHELL_STATE.mode);
			expect(newStore.leftPanel.sizeRatio).toBe(DEFAULT_SHELL_STATE.leftPanel.sizeRatio);
		});
	});

	describe('f) WorkbenchSplitter Component SSR Rendering', () => {
		it('renders horizontal splitter with correct cursor, role, and accessibility', () => {
			const { body } = render(WorkbenchSplitter, {
				props: {
					direction: 'horizontal',
					ariaLabel: 'Resize code panel'
				}
			});

			expect(body).toContain('data-testid="workbench-splitter"');
			expect(body).toContain('data-direction="horizontal"');
			expect(body).toContain('role="separator"');
			expect(body).toContain('aria-orientation="horizontal"');
			expect(body).toContain('aria-label="Resize code panel"');
			expect(body).toContain('cursor-col-resize');
		});

		it('renders vertical splitter with row resize cursor and vertical orientation', () => {
			const { body } = render(WorkbenchSplitter, {
				props: {
					direction: 'vertical'
				}
			});

			expect(body).toContain('data-testid="workbench-splitter"');
			expect(body).toContain('data-direction="vertical"');
			expect(body).toContain('aria-orientation="vertical"');
			expect(body).toContain('aria-label="Resize rows"');
			expect(body).toContain('cursor-row-resize');
		});

		it('renders disabled state with pointer-events-none and aria-disabled', () => {
			const { body } = render(WorkbenchSplitter, {
				props: {
					disabled: true
				}
			});

			expect(body).toContain('aria-disabled="true"');
			expect(body).toContain('pointer-events-none');
		});
	});
});
