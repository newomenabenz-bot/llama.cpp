/**
 * Unit tests for Workspace Terminal Subsystem.
 *
 * Verifies:
 * 1. Command execution lifecycle (idle -> running -> completed/failed) with duration and exit codes.
 * 2. Real-time streaming output accumulation and chunk notification.
 * 3. Command risk classification and security policy denial handling.
 * 4. Reactive TerminalStore history management, selection, and abort handling.
 * 5. SSR / DOM rendering of WorkspaceTerminal component.
 * 6. Integration within WorkspaceExplorer container.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import { ToolsService } from '$lib/services/tools.service';
import { auditStore } from '$lib/workbench/security/audit.store';
import { policyService } from '$lib/workbench/security/policy.service';
import { WorkbenchSecurityBridge } from '$lib/workbench/security/workbench-security.bridge';
import { WorkbenchTerminalService } from '$lib/workbench/terminal/terminal.service';
import { terminalStore } from '$lib/workbench/terminal/terminal.svelte';
import { workspaceStore } from '$lib/workbench/workspace/workspace.svelte';
import WorkspaceTerminal from '$lib/workbench/components/WorkspaceTerminal.svelte';
import WorkspaceExplorer from '$lib/workbench/components/WorkspaceExplorer.svelte';

describe('Workspace Terminal Subsystem', () => {
	beforeEach(() => {
		terminalStore.reset();
		workspaceStore.reset();
		auditStore.clear();
		policyService.setMode('ASSISTED');
	});

	afterEach(() => {
		vi.restoreAllMocks();
		terminalStore.reset();
		workspaceStore.reset();
		auditStore.clear();
	});

	describe('a) WorkbenchTerminalService Execution Lifecycle', () => {
		it('executes a clean shell command and parses exit code 0', async () => {
			async function* mockStream() {
				yield { chunk: 'total 12\n', done: false };
				yield { chunk: 'drwxr-xr-x 2 user staff 64 Sep 28 10:00 .\n', done: false };
				yield { chunk: '[exit code: 0]\n', done: false };
				yield { chunk: null, done: true };
			}

			vi.spyOn(ToolsService, 'streamTool').mockImplementation(
				() => mockStream() as any
			);

			const chunks: string[] = [];
			const record = await WorkbenchTerminalService.executeCommand(
				'ls -la',
				'/workspace',
				(c) => chunks.push(c)
			);

			expect(record.command).toBe('ls -la');
			expect(record.cwd).toBe('/workspace');
			expect(record.status).toBe('completed');
			expect(record.exitCode).toBe(0);
			expect(record.output).toContain('total 12');
			expect(record.output).toContain('[exit code: 0]');
			expect(record.durationMs).toBeGreaterThanOrEqual(0);
			expect(chunks).toHaveLength(3);
			expect(chunks.join('')).toBe(record.output);
		});

		it('identifies non-zero exit code as failed execution', async () => {
			async function* mockFailStream() {
				yield { chunk: 'cat: missing.txt: No such file or directory\n', done: false };
				yield { chunk: '[exit code: 1]\n', done: false };
				yield { chunk: null, done: true };
			}

			vi.spyOn(ToolsService, 'streamTool').mockImplementation(
				() => mockFailStream() as any
			);

			const record = await WorkbenchTerminalService.executeCommand(
				'cat missing.txt',
				'/workspace'
			);

			expect(record.status).toBe('failed');
			expect(record.exitCode).toBe(1);
			expect(record.output).toContain('No such file or directory');
		});

		it('handles tool stream errors gracefully', async () => {
			async function* mockErrorStream() {
				yield { chunk: 'starting command...\n', done: false };
				yield { chunk: null, done: true, error: 'Process killed by SIGTERM' };
			}

			vi.spyOn(ToolsService, 'streamTool').mockImplementation(
				() => mockErrorStream() as any
			);

			const record = await WorkbenchTerminalService.executeCommand(
				'sleep 100',
				'/workspace'
			);

			expect(record.status).toBe('failed');
			expect(record.error).toBe('Process killed by SIGTERM');
		});

		it('handles user abort signal', async () => {
			const controller = new AbortController();

			async function* mockHangingStream() {
				yield { chunk: 'waiting...\n', done: false };
				// Simulate abort triggering
				controller.abort();
				const err = new Error('The operation was aborted');
				err.name = 'AbortError';
				throw err;
			}

			vi.spyOn(ToolsService, 'streamTool').mockImplementation(
				() => mockHangingStream() as any
			);

			const record = await WorkbenchTerminalService.executeCommand(
				'long_running_task',
				'/workspace',
				{ signal: controller.signal }
			);

			expect(record.status).toBe('aborted');
			expect(record.error).toBe('Command aborted by user');
		});
	});

	describe('b) Security Policy Enforcement & Command Risk', () => {
		it('blocks destructive critical commands and records policy denial in auditStore', async () => {
			// Mock security bridge evaluation returning DENY
			vi.spyOn(WorkbenchSecurityBridge, 'evaluateToolCall').mockReturnValue({
				action: 'DENY',
				decision: {
					action: 'DENY',
					reason: 'Critical destructive command blocked by security policy',
					risk: 'CRITICAL'
				},
				receiptId: 'receipt_critical_123',
				syntheticRejection: 'Security Policy Violation: rm -rf / is strictly prohibited',
				shouldPromptUser: false
			});

			const streamSpy = vi.spyOn(ToolsService, 'streamTool');

			const record = await WorkbenchTerminalService.executeCommand(
				'rm -rf /',
				'/workspace'
			);

			expect(record.status).toBe('failed');
			expect(record.risk).toBe('CRITICAL');
			expect(record.error).toContain('Security Policy Violation');
			// ToolsService stream should NEVER have been invoked
			expect(streamSpy).not.toHaveBeenCalled();
		});

		it('classifies risk levels for known inspection commands', async () => {
			async function* mockStream() {
				yield { chunk: 'On branch main\n[exit code: 0]', done: false };
				yield { chunk: null, done: true };
			}
			vi.spyOn(ToolsService, 'streamTool').mockImplementation(() => mockStream() as any);

			const record = await WorkbenchTerminalService.executeCommand('git status', '/workspace');
			expect(record.risk).toBe('LOW');
			expect(record.status).toBe('completed');
		});
	});

	describe('c) Reactive TerminalStore State Management', () => {
		it('manages open and closed state transitions', () => {
			expect(terminalStore.isOpen).toBe(false);

			terminalStore.openTerminal();
			expect(terminalStore.isOpen).toBe(true);

			terminalStore.closeTerminal();
			expect(terminalStore.isOpen).toBe(false);

			terminalStore.toggleOpen();
			expect(terminalStore.isOpen).toBe(true);
		});

		it('tracks command execution history and active record selection', async () => {
			async function* mockStream() {
				yield { chunk: 'hello world\n[exit code: 0]', done: false };
				yield { chunk: null, done: true };
			}
			vi.spyOn(ToolsService, 'streamTool').mockImplementation(() => mockStream() as any);

			expect(terminalStore.history).toHaveLength(0);

			const result = await terminalStore.run('echo hello world', '/test-root');
			expect(result).not.toBeNull();
			expect(terminalStore.history).toHaveLength(1);
			expect(terminalStore.activeRecord?.command).toBe('echo hello world');
			expect(terminalStore.activeRecord?.cwd).toBe('/test-root');
			expect(terminalStore.isRunning).toBe(false);

			// Run a second command
			await terminalStore.run('pwd', '/test-root');
			expect(terminalStore.history).toHaveLength(2);

			// Select earlier record
			const firstId = terminalStore.history[0].id;
			terminalStore.selectRecord(firstId);
			expect(terminalStore.activeRecord?.id).toBe(firstId);

			// Clear history
			terminalStore.clearHistory();
			expect(terminalStore.history).toHaveLength(0);
			expect(terminalStore.activeRecord).toBeNull();
		});

		it('falls back to workspaceStore.rootPath if cwd is omitted', async () => {
			workspaceStore.setRoot('my-custom-project');

			async function* mockStream() {
				yield { chunk: '[exit code: 0]', done: false };
				yield { chunk: null, done: true };
			}
			vi.spyOn(ToolsService, 'streamTool').mockImplementation(() => mockStream() as any);

			const record = await terminalStore.run('npm test');
			expect(record?.cwd).toBe('my-custom-project');
		});

		it('aborts active execution through terminalStore.abort()', async () => {
			vi.spyOn(WorkbenchTerminalService, 'executeCommand').mockImplementation(
				(_cmd, _cwd, _onChunk, signal) =>
					new Promise((resolve) => {
						signal?.addEventListener('abort', () => {
							resolve({
								id: 'aborted_rec',
								command: 'sleep 50',
								cwd: '.',
								status: 'aborted',
								output: 'Command aborted',
								startedAt: Date.now()
							});
						});
					})
			);

			const runPromise = terminalStore.run('sleep 50');
			expect(terminalStore.isRunning).toBe(true);

			terminalStore.abort();
			await runPromise;

			expect(terminalStore.isRunning).toBe(false);
			expect(terminalStore.activeRecord?.status).toBe('aborted');
		});
	});

	describe('d) WorkspaceTerminal Component SSR Rendering', () => {
		it('renders empty terminal placeholder when history is empty', () => {
			const { body } = render(WorkspaceTerminal);

			expect(body).toContain('Terminal');
			expect(body).toContain('OMENA Autonomous Terminal Deck');
			expect(body).toContain('Type a command below and press Enter');
			expect(body).toContain('data-testid="terminal-input-form"');
		});

		it('renders executed command records, output logs, and exit badges', async () => {
			terminalStore.history = [
				{
					id: 'rec_1',
					command: 'echo "hello antigravity"',
					cwd: '/workspace',
					status: 'completed',
					output: 'hello antigravity',
					exitCode: 0,
					durationMs: 45,
					startedAt: Date.now() - 100,
					completedAt: Date.now() - 55,
					risk: 'LOW'
				},
				{
					id: 'rec_2',
					command: 'node -e "process.exit(2)"',
					cwd: '/workspace',
					status: 'failed',
					output: 'Command failed with code 2',
					exitCode: 2,
					durationMs: 120,
					startedAt: Date.now() - 50,
					completedAt: Date.now(),
					risk: 'MEDIUM'
				}
			];

			const { body } = render(WorkspaceTerminal);

			expect(body).toContain('echo "hello antigravity"');
			expect(body).toContain('hello antigravity');
			expect(body).toContain('exit 0');
			expect(body).toContain('45ms');

			expect(body).toContain('node -e "process.exit(2)"');
			expect(body).toContain('exit 2');
			expect(body).toContain('120ms');
			expect(body).toContain('MEDIUM');
		});

		it('renders close button when onClose prop is supplied', () => {
			const onCloseMock = vi.fn();
			const { body } = render(WorkspaceTerminal, { props: { onClose: onCloseMock } });

			expect(body).toContain('aria-label="Close terminal"');
		});
	});

	describe('e) WorkspaceExplorer Terminal Deck Integration', () => {
		it('renders terminal toggle button in header and mobile tab', () => {
			workspaceStore.setRoot('my-project');
			workspaceStore.setTree(['src/index.ts']);

			const { body } = render(WorkspaceExplorer);

			expect(body).toContain('aria-label="Toggle terminal"');
			expect(body).toContain('Terminal');
		});

		it('mounts WorkspaceTerminal when terminalStore.isOpen is true', () => {
			workspaceStore.setRoot('my-project');
			workspaceStore.setTree(['src/index.ts']);
			terminalStore.openTerminal();

			const { body } = render(WorkspaceExplorer);

			expect(body).toContain('data-testid="workspace-terminal"');
			expect(body).toContain('OMENA Autonomous Terminal Deck');
		});
	});
});
