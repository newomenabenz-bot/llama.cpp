/**
 * Unit tests for Agent Observability Deck & Execution Monitoring
 *
 * Verifies:
 * 1. DOM rendering of State Machine status pills across all 6 core states:
 *    ('IDLE', 'THINKING', 'PROPOSING_ACTION', 'EXECUTING_TOOLS', 'AWAITING_PERMISSION', 'HALTED').
 * 2. Policy Mode badges across SAFE, ASSISTED, and AUTONOMOUS configurations.
 * 3. Turn Meter gauge and ratio progression.
 * 4. Token budget meters across NORMAL (<75%), WARNING (75%-90%), and CRITICAL (>90%) thresholds.
 * 5. Compaction state indicator detection.
 * 6. Audit trail receipts rendering with timestamps, risk tiers, outcome badges, and execution timing.
 * 7. Receipt expansion of tool parameter payloads and policy decision rationale.
 * 8. Audit log clearing and empty-state recovery.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { auditStore } from '$lib/workbench/security/audit.store';
import { WorkbenchSettingsService } from '$lib/workbench/settings/workbench-settings.service';
import type { AgentExecutionState } from '$lib/workbench/persistence/types';
import AgentObservabilityDeck from '$lib/workbench/components/AgentObservabilityDeck.svelte';

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

describe('Agent Observability Deck Subsystem', () => {
	beforeEach(() => {
		localStorage.clear();
		auditStore.clear();
		WorkbenchSettingsService.resetToDefaults();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		localStorage.clear();
		auditStore.clear();
		WorkbenchSettingsService.resetToDefaults();
	});

	describe('a) State Machine Status Pill Rendering', () => {
		const testStates: AgentExecutionState[] = [
			'IDLE',
			'THINKING',
			'PROPOSING_ACTION',
			'EXECUTING_TOOLS',
			'AWAITING_PERMISSION',
			'HALTED'
		];

		testStates.forEach((state) => {
			it(`renders the correct pill and data attribute for state: ${state}`, () => {
				const { body } = render(AgentObservabilityDeck, {
					props: { forcedState: state }
				});

				expect(body).toContain('data-testid="state-machine-pill"');
				expect(body).toContain(`data-state="${state}"`);
				expect(body).toContain(state);
			});
		});
	});

	describe('b) Policy Mode Badges', () => {
		it('renders SAFE mode badge with blue styling', () => {
			const { body } = render(AgentObservabilityDeck, {
				props: { forcedMode: 'SAFE' }
			});

			expect(body).toContain('data-testid="policy-mode-badge"');
			expect(body).toContain('data-mode="SAFE"');
			expect(body).toContain('SAFE');
		});

		it('renders ASSISTED mode badge with amber styling', () => {
			const { body } = render(AgentObservabilityDeck, {
				props: { forcedMode: 'ASSISTED' }
			});

			expect(body).toContain('data-testid="policy-mode-badge"');
			expect(body).toContain('data-mode="ASSISTED"');
			expect(body).toContain('ASSISTED');
		});

		it('renders AUTONOMOUS mode badge with purple styling', () => {
			const { body } = render(AgentObservabilityDeck, {
				props: { forcedMode: 'AUTONOMOUS' }
			});

			expect(body).toContain('data-testid="policy-mode-badge"');
			expect(body).toContain('data-mode="AUTONOMOUS"');
			expect(body).toContain('AUTONOMOUS');
		});
	});

	describe('c) Turn Meter Progression', () => {
		it('displays turn metrics and progress bar correctly', () => {
			const { body } = render(AgentObservabilityDeck, {
				props: { forcedMaxTurns: 25, forcedTurn: 5 }
			});

			expect(body).toContain('data-testid="turn-meter"');
			expect(body).toContain('Turn 5 of 25 (20%)');
			expect(body).toContain('style="width: 20%;"');
		});

		it('handles zero or initial turns cleanly', () => {
			const { body } = render(AgentObservabilityDeck, {
				props: { forcedMaxTurns: 30, forcedTurn: 0 }
			});

			expect(body).toContain('Turn 0 of 30 (0%)');
			expect(body).toContain('style="width: 0%;"');
		});
	});

	describe('d) Context Token Meter & Budget Status', () => {
		it('renders NORMAL status tag when token consumption is under 75%', () => {
			const { body } = render(AgentObservabilityDeck, {
				props: { forcedContextLimit: 10000, forcedTokens: 5000 }
			});

			expect(body).toContain('data-testid="token-budget-status"');
			expect(body).toContain('data-status="NORMAL"');
			expect(body).toContain('NORMAL');
			expect(body).toContain('5,000 tokens');
			expect(body).toContain('10,000 n_ctx (50%)');
			expect(body).toContain('data-compaction-active="false"');
			expect(body).toContain('Compaction Standby');
		});

		it('renders WARNING status tag and activates compaction indicator at 75%-90%', () => {
			const { body } = render(AgentObservabilityDeck, {
				props: { forcedContextLimit: 10000, forcedTokens: 8000 }
			});

			expect(body).toContain('data-testid="token-budget-status"');
			expect(body).toContain('data-status="WARNING"');
			expect(body).toContain('WARNING');
			expect(body).toContain('8,000 tokens');
			expect(body).toContain('data-compaction-active="true"');
			expect(body).toContain('Compaction Active');
		});

		it('renders CRITICAL status tag when token consumption exceeds 90%', () => {
			const { body } = render(AgentObservabilityDeck, {
				props: { forcedContextLimit: 10000, forcedTokens: 9500 }
			});

			expect(body).toContain('data-testid="token-budget-status"');
			expect(body).toContain('data-status="CRITICAL"');
			expect(body).toContain('CRITICAL');
			expect(body).toContain('9,500 tokens');
			expect(body).toContain('data-compaction-active="true"');
		});
	});

	describe('e) Audit Trail & Receipts Display', () => {
		it('renders empty-state notice when audit store is empty', () => {
			const { body } = render(AgentObservabilityDeck);

			expect(body).toContain('No audit events recorded');
			expect(body).toContain('data-testid="audit-trail-section"');
		});

		it('renders list of execution receipts with risk and outcome pills', () => {
			auditStore.recordReceipt({
				args: { path: 'src/index.ts' },
				decision: 'ALLOW',
				executionTimeMs: 14,
				mode: 'SAFE',
				reason: 'Path within workspace boundary',
				risk: 'LOW',
				status: 'SUCCESS',
				toolName: 'read_file'
			});

			auditStore.recordReceipt({
				args: { command: 'rm -rf /' },
				decision: 'DENY',
				executionTimeMs: 2,
				mode: 'SAFE',
				reason: 'Blocked dangerous command pattern',
				risk: 'CRITICAL',
				status: 'DENIED',
				toolName: 'exec_shell'
			});

			const { body } = render(AgentObservabilityDeck);

			expect(body).toContain('data-testid="audit-receipt-item"');
			expect(body).toContain('read_file');
			expect(body).toContain('exec_shell');

			// Risk pills
			expect(body).toContain('data-risk="LOW"');
			expect(body).toContain('data-risk="CRITICAL"');

			// Outcome badges
			expect(body).toContain('data-outcome="ALLOWED"');
			expect(body).toContain('data-outcome="DENIED"');

			// Execution times
			expect(body).toContain('14ms');
			expect(body).toContain('2ms');
		});

		it('verifies that receipt expansion displays parameter payloads and policy rationale', () => {
			auditStore.recordReceipt({
				args: { query: 'test search query', limit: 10 },
				decision: 'ALLOW',
				executionTimeMs: 45,
				mode: 'ASSISTED',
				reason: 'Read operation approved for session',
				risk: 'LOW',
				status: 'SUCCESS',
				toolName: 'grep_search'
			});

			const { body } = render(AgentObservabilityDeck, {
				props: { forceExpandAll: true }
			});

			expect(body).toContain('data-testid="receipt-json-payload"');
			expect(body).toContain('grep_search');
			expect(body).toContain('test search query');
			expect(body).toContain('Read operation approved for session');
			expect(body).toContain('Decision: ALLOW');
			expect(body).toContain('Mode: ASSISTED');
		});

		it('supports clearing the audit store and updating receipt display', () => {
			auditStore.recordReceipt({
				args: {},
				decision: 'ALLOW',
				mode: 'SAFE',
				reason: 'test',
				risk: 'LOW',
				status: 'SUCCESS',
				toolName: 'browser_info'
			});

			expect(auditStore.size()).toBe(1);

			auditStore.clear();

			expect(auditStore.size()).toBe(0);

			const { body } = render(AgentObservabilityDeck);
			expect(body).toContain('No audit events recorded');
		});
	});
});
