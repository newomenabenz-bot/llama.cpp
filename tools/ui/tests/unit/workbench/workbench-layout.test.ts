/**
 * Unit tests for Workbench Layout Assembly & Mode Switcher
 *
 * Verifies:
 * 1. SSR / DOM rendering of WorkbenchModeToggle across Chat and Workbench modes.
 * 2. Mode toggling behavior and reactive synchronization with WorkbenchShellStore.
 * 3. Multi-pane WorkbenchLayout container structure, header controls, and panel toggles.
 * 4. Conditional rendering of Left (Explorer), Right (Inspector), and Bottom (Terminal) panes.
 * 5. Mobile tab switcher layout and responsiveness fallback.
 * 6. Code inspector state transitions (placeholder vs file viewer vs diff viewer).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { workbenchShellStore } from '$lib/workbench/shell/shell.svelte';
import { workspaceStore } from '$lib/workbench/workspace/workspace.svelte';
import { terminalStore } from '$lib/workbench/terminal/terminal.svelte';
import WorkbenchModeToggle from '$lib/workbench/components/WorkbenchModeToggle.svelte';
import WorkbenchLayout from '$lib/workbench/components/WorkbenchLayout.svelte';

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

describe('Workbench Layout & Mode Switcher Subsystem', () => {
	beforeEach(() => {
		localStorage.clear();
		workbenchShellStore.reset();
		workspaceStore.reset();
		terminalStore.clearHistory();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
		workbenchShellStore.reset();
		workspaceStore.reset();
	});

	describe('a) WorkbenchModeToggle Component', () => {
		it('renders correctly in default "chat" mode', () => {
			workbenchShellStore.setMode('chat');
			const { body } = render(WorkbenchModeToggle);

			expect(body).toContain('workbench-mode-toggle');
			expect(body).toContain('data-mode="chat"');
			expect(body).toContain('Switch to Workbench IDE');
			expect(body).toContain('Chat');
		});

		it('renders correctly in "workbench" mode', () => {
			workbenchShellStore.setMode('workbench');
			const { body } = render(WorkbenchModeToggle);

			expect(body).toContain('workbench-mode-toggle');
			expect(body).toContain('data-mode="workbench"');
			expect(body).toContain('Switch to Chat View');
			expect(body).toContain('Workbench');
		});

		it('supports passing custom class names', () => {
			const { body } = render(WorkbenchModeToggle, { props: { class: 'custom-toggle-class' } });
			expect(body).toContain('custom-toggle-class');
		});
	});

	describe('b) WorkbenchLayout Multi-Pane Assembly', () => {
		it('renders the root workbench layout container and header controls', () => {
			const { body } = render(WorkbenchLayout);

			expect(body).toContain('data-testid="workbench-layout"');
			expect(body).toContain('data-testid="workbench-header"');
			expect(body).toContain('data-testid="toggle-left-panel"');
			expect(body).toContain('data-testid="toggle-bottom-panel"');
			expect(body).toContain('data-testid="toggle-right-panel"');
			expect(body).toContain('data-testid="reset-layout"');
		});

		it('renders the desktop multi-pane view with left, center, and right panes by default', () => {
			workbenchShellStore.setPanelVisibility('left', true);
			workbenchShellStore.setPanelVisibility('right', true);
			workbenchShellStore.setPanelVisibility('bottom', false);

			const { body } = render(WorkbenchLayout);

			expect(body).toContain('data-testid="workbench-desktop-view"');
			expect(body).toContain('data-testid="workbench-main-row"');
			expect(body).toContain('data-testid="workbench-left-pane"');
			expect(body).toContain('data-testid="workbench-center-pane"');
			expect(body).toContain('data-testid="workbench-right-pane"');
			expect(body).not.toContain('data-testid="workbench-bottom-pane"');
		});

		it('hides the left pane when leftPanel is marked not visible', () => {
			workbenchShellStore.setPanelVisibility('left', false);
			const { body } = render(WorkbenchLayout);

			expect(body).not.toContain('data-testid="workbench-left-pane"');
			expect(body).toContain('data-testid="workbench-center-pane"');
		});

		it('hides the right pane when rightPanel is marked not visible', () => {
			workbenchShellStore.setPanelVisibility('right', false);
			const { body } = render(WorkbenchLayout);

			expect(body).not.toContain('data-testid="workbench-right-pane"');
			expect(body).toContain('data-testid="workbench-center-pane"');
		});

		it('renders the bottom terminal pane when bottomPanel is marked visible', () => {
			workbenchShellStore.setPanelVisibility('bottom', true);
			const { body } = render(WorkbenchLayout);

			expect(body).toContain('data-testid="workbench-bottom-pane"');
			expect(body).toContain('workspace-terminal');
		});

		it('renders the bottom terminal pane when terminalStore.isOpen is true', () => {
			workbenchShellStore.setPanelVisibility('bottom', false);
			terminalStore.openTerminal();

			const { body } = render(WorkbenchLayout);

			expect(body).toContain('data-testid="workbench-bottom-pane"');
			expect(body).toContain('workspace-terminal');
		});

		it('renders splitters adjacent to active panels', () => {
			workbenchShellStore.setPanelVisibility('left', true);
			workbenchShellStore.setPanelVisibility('right', true);
			workbenchShellStore.setPanelVisibility('bottom', true);

			const { body } = render(WorkbenchLayout);

			expect(body).toContain('aria-label="Resize File Explorer"');
			expect(body).toContain('aria-label="Resize Code Inspector"');
			expect(body).toContain('aria-label="Resize Terminal"');
		});
	});

	describe('c) Right Pane Inspector State Transitions', () => {
		it('renders empty code inspector placeholder when no file or diff is selected', () => {
			workbenchShellStore.setPanelVisibility('right', true);
			workspaceStore.selectedPath = null;
			workspaceStore.diffPayload = null;

			const { body } = render(WorkbenchLayout);

			expect(body).toContain('Code Inspector');
			expect(body).toContain('Select any file in the workspace explorer');
		});

		it('renders WorkspaceFileViewer when a file path is selected in workspaceStore', () => {
			workbenchShellStore.setPanelVisibility('right', true);
			workspaceStore.selectedPath = 'src/test.ts';
			workspaceStore.fileBuffers.set('src/test.ts', 'console.log("hello");');

			const { body } = render(WorkbenchLayout);

			expect(body).toContain('workspace-file-viewer');
			expect(body).toContain('File Viewer');
			expect(body).toContain('test.ts');
		});

		it('renders WorkspaceDiffViewer when diffPayload is present in workspaceStore', () => {
			workbenchShellStore.setPanelVisibility('right', true);
			workspaceStore.setDiff({
				filePath: 'src/app.ts',
				originalContent: 'const a = 1;',
				modifiedContent: 'const a = 2;',
				viewMode: 'unified'
			});

			const { body } = render(WorkbenchLayout);

			expect(body).toContain('workspace-diff-viewer');
			expect(body).toContain('Diff Inspector');
			expect(body).toContain('app.ts');
		});
	});

	describe('d) Mobile / Small Viewport Fallback Navigation', () => {
		it('renders mobile tab navigation container and buttons', () => {
			const { body } = render(WorkbenchLayout);

			expect(body).toContain('data-testid="workbench-mobile-view"');
			expect(body).toContain('data-testid="mobile-tab-files"');
			expect(body).toContain('data-testid="mobile-tab-chat"');
			expect(body).toContain('data-testid="mobile-tab-inspector"');
			expect(body).toContain('data-testid="mobile-tab-terminal"');
		});
	});

	describe('e) Store Interactivity & Layout Resets', () => {
		it('toggles left panel visibility via store actions', () => {
			expect(workbenchShellStore.leftPanel.isVisible).toBe(true);
			workbenchShellStore.togglePanel('left');
			expect(workbenchShellStore.leftPanel.isVisible).toBe(false);
			workbenchShellStore.togglePanel('left');
			expect(workbenchShellStore.leftPanel.isVisible).toBe(true);
		});

		it('toggles right panel visibility via store actions', () => {
			expect(workbenchShellStore.rightPanel.isVisible).toBe(true);
			workbenchShellStore.togglePanel('right');
			expect(workbenchShellStore.rightPanel.isVisible).toBe(false);
			workbenchShellStore.togglePanel('right');
			expect(workbenchShellStore.rightPanel.isVisible).toBe(true);
		});

		it('toggles bottom panel visibility via store actions', () => {
			expect(workbenchShellStore.bottomPanel.isVisible).toBe(false);
			workbenchShellStore.togglePanel('bottom');
			expect(workbenchShellStore.bottomPanel.isVisible).toBe(true);
			workbenchShellStore.togglePanel('bottom');
			expect(workbenchShellStore.bottomPanel.isVisible).toBe(false);
		});

		it('resets shell store to default sizing and modes', () => {
			workbenchShellStore.setMode('workbench');
			workbenchShellStore.setPanelRatio('left', 0.4);
			workbenchShellStore.setPanelRatio('right', 0.55);
			workbenchShellStore.setPanelVisibility('bottom', true);

			workbenchShellStore.reset();

			expect(workbenchShellStore.mode).toBe('chat');
			expect(workbenchShellStore.leftPanel.sizeRatio).toBe(0.2);
			expect(workbenchShellStore.rightPanel.sizeRatio).toBe(0.45);
			expect(workbenchShellStore.bottomPanel.isVisible).toBe(false);
		});
	});

	describe('f) Agent Observability Deck Integration', () => {
		it('renders persistent agent status summary pill in command header', () => {
			const { body } = render(WorkbenchLayout);

			expect(body).toContain('data-testid="header-agent-status-pill"');
			expect(body).toContain('Agent: Idle');
		});

		it('renders right pane inspector tab switcher with File View, Changes / Diff, and Agent Activity', () => {
			workbenchShellStore.setPanelVisibility('right', true);
			const { body } = render(WorkbenchLayout);

			expect(body).toContain('data-testid="inspector-tab-file"');
			expect(body).toContain('data-testid="inspector-tab-diff"');
			expect(body).toContain('data-testid="inspector-tab-activity"');
			expect(body).toContain('File View');
			expect(body).toContain('Changes / Diff');
			expect(body).toContain('Agent Activity');
		});

		it('renders AgentObservabilityDeck when activity inspector tab is active', () => {
			workbenchShellStore.setPanelVisibility('right', true);
			const { body } = render(WorkbenchLayout, {
				props: { initialInspectorTab: 'activity' }
			});

			expect(body).toContain('data-testid="agent-observability-deck"');
			expect(body).toContain('Agent Observability');
			expect(body).toContain('Audit Log');
		});

		it('renders mobile activity tab in mobile view switcher', () => {
			const { body } = render(WorkbenchLayout);

			expect(body).toContain('data-testid="mobile-tab-activity"');
			expect(body).toContain('Activity');
		});
	});
});
