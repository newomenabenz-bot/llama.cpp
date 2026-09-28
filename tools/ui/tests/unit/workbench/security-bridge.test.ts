/**
 * Workbench Security Bridge & Runtime Interception Unit Test Suite.
 *
 * Verifies:
 * 1. Policy Interception (SAFE, ASSISTED, AUTONOMOUS mode evaluation)
 * 2. Synthetic Policy Rejection Generation (feedback formatting for LLM)
 * 3. Interactive Gate Delegation (prompting, session approvals, denials)
 * 4. High-Level Authorization Pipeline (authorizeAndExecuteTool)
 * 5. Audit Receipt Lifecycle (PENDING -> SUCCESS / ERROR / DENIED)
 * 6. Settings Integration & Session Isolation
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolPermissionDecision } from '$lib/enums';
import {
	auditStore,
	WorkbenchSecurityBridge
} from '$lib/workbench/security';
import {
	WorkbenchSettingsService
} from '$lib/workbench/settings/workbench-settings.service';

describe('Workbench Security Bridge Unit Tests', () => {
	const testWorkspace = 'C:/Users/Administrator/Documents/antigravity/my-project';
	const conversationId = 'conv-test-sec-bridge-123';

	beforeEach(() => {
		WorkbenchSettingsService.resetToDefaults();
		WorkbenchSettingsService.setExecutionMode('SAFE');
		WorkbenchSettingsService.setWorkspaceRoot(testWorkspace);
		WorkbenchSecurityBridge.clearSessionApprovals();
		auditStore.clear();
	});

	describe('1. Mode-Driven Tool Pre-Evaluation (evaluateToolCall)', () => {
		describe('SAFE Mode', () => {
			beforeEach(() => {
				WorkbenchSettingsService.setExecutionMode('SAFE');
			});

			it('auto-allows safe in-workspace read tools', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'read_file',
					{ path: 'src/lib/index.ts' },
					conversationId
				);

				expect(evalResult.action).toBe('ALLOW');
				expect(evalResult.shouldPromptUser).toBe(false);
				expect(evalResult.syntheticRejection).toBeUndefined();
			});

			it('prompts on mutating file operations within workspace', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'write_file',
					{ path: 'src/lib/app.ts', content: 'export const x = 1;' },
					conversationId
				);

				expect(evalResult.action).toBe('PROMPT');
				expect(evalResult.shouldPromptUser).toBe(true);
				expect(evalResult.decision.reason).toContain('File mutation requires confirmation in SAFE mode');
				expect(evalResult.syntheticRejection).toBeUndefined();
			});

			it('prompts on shell command execution with risk assessment', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'exec_shell_command',
					{ command: 'ls -la' },
					conversationId
				);

				expect(evalResult.action).toBe('PROMPT');
				expect(evalResult.shouldPromptUser).toBe(true);
				expect(evalResult.decision.reason).toContain('Shell execution (LOW risk) requires confirmation in SAFE mode');
			});

			it('prompts on read operations targeting paths outside workspace boundary', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'read_file',
					{ path: '../../etc/passwd' },
					conversationId
				);

				expect(evalResult.action).toBe('PROMPT');
				expect(evalResult.decision.reason).toContain('Read operation outside workspace boundary requires confirmation');
			});
		});

		describe('ASSISTED Mode', () => {
			beforeEach(() => {
				WorkbenchSettingsService.setExecutionMode('ASSISTED');
			});

			it('auto-approves read-only tools without prompting', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'read_file',
					{ path: 'src/lib/index.ts' },
					conversationId
				);

				expect(evalResult.action).toBe('ALLOW');
				expect(evalResult.shouldPromptUser).toBe(false);
				expect(evalResult.syntheticRejection).toBeUndefined();
			});

			it('auto-approves server info and date tools', () => {
				const evalInfo = WorkbenchSecurityBridge.evaluateToolCall(
					'server_get_info',
					{},
					conversationId
				);
				expect(evalInfo.action).toBe('ALLOW');

				const evalDate = WorkbenchSecurityBridge.evaluateToolCall(
					'browser_get_datetime',
					{},
					conversationId
				);
				expect(evalDate.action).toBe('ALLOW');
			});

			it('prompts on initial mutating file operation, then auto-approves once approved for session', () => {
				// Turn 1: initial mutating tool -> PROMPT
				const firstEval = WorkbenchSecurityBridge.evaluateToolCall(
					'write_file',
					{ path: 'src/lib/file.ts', content: 'test' },
					conversationId
				);
				expect(firstEval.action).toBe('PROMPT');
				expect(firstEval.shouldPromptUser).toBe(true);

				// Record session approval for the conversation
				WorkbenchSecurityBridge.recordSessionApproval(conversationId, 'write_file');

				// Turn 2: subsequent mutating tool -> ALLOW
				const secondEval = WorkbenchSecurityBridge.evaluateToolCall(
					'write_file',
					{ path: 'src/lib/file2.ts', content: 'test2' },
					conversationId
				);
				expect(secondEval.action).toBe('ALLOW');
				expect(secondEval.shouldPromptUser).toBe(false);
			});

			it('prompts on initial low-risk shell command, then auto-approves once approved for session', () => {
				const firstEval = WorkbenchSecurityBridge.evaluateToolCall(
					'exec_shell_command',
					{ command: 'echo "testing 123"' },
					conversationId
				);
				expect(firstEval.action).toBe('PROMPT');

				WorkbenchSecurityBridge.recordSessionApproval(conversationId, 'exec_shell_command');

				const secondEval = WorkbenchSecurityBridge.evaluateToolCall(
					'exec_shell_command',
					{ command: 'echo "testing 123"' },
					conversationId
				);
				expect(secondEval.action).toBe('ALLOW');
			});

			it('prompts on medium-risk shell commands (e.g. npm install, git clone)', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'exec_shell_command',
					{ command: 'npm install lodash' },
					conversationId
				);
				expect(evalResult.action).toBe('PROMPT');
				expect(evalResult.shouldPromptUser).toBe(true);
				expect(evalResult.decision.risk).toBe('MEDIUM');
			});

			it('prompts with CRITICAL risk for destructive commands even if shell was approved', () => {
				WorkbenchSecurityBridge.recordSessionApproval(conversationId, 'exec_shell_command');

				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'exec_shell_command',
					{ command: 'rm -rf /' },
					conversationId
				);
				expect(evalResult.action).toBe('PROMPT');
				expect(evalResult.decision.risk).toBe('CRITICAL');
				expect(evalResult.decision.reason).toContain('CRITICAL risk command requires explicit authorization');
			});

			it('prompts on path traversal attempting to access outside workspace', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'write_file',
					{ path: 'C:/Windows/System32/config/test.txt', content: 'hack' },
					conversationId
				);
				expect(evalResult.action).toBe('PROMPT');
				expect(evalResult.decision.reason).toContain('outside workspace boundary');
			});
		});

		describe('AUTONOMOUS Mode', () => {
			beforeEach(() => {
				WorkbenchSettingsService.setExecutionMode('AUTONOMOUS');
			});

			it('auto-approves file writes within workspace boundary', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'write_file',
					{ path: 'src/lib/autonomous.ts', content: '// created autonomously' },
					conversationId,
					1
				);
				expect(evalResult.action).toBe('ALLOW');
				expect(evalResult.shouldPromptUser).toBe(false);
			});

			it('auto-approves medium-risk shell commands (e.g. build, test)', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'exec_shell_command',
					{ command: 'npm run build' },
					conversationId,
					2
				);
				expect(evalResult.action).toBe('ALLOW');
			});

			it('prompts on high-risk shell commands (e.g. git push --force)', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'exec_shell_command',
					{ command: 'git push --force origin main' },
					conversationId,
					3
				);
				expect(evalResult.action).toBe('PROMPT');
			});

			it('hard-denies critical destructive commands and returns synthetic violation feedback', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'exec_shell_command',
					{ command: 'mkfs.ext4 /dev/sda1' },
					conversationId,
					4
				);
				expect(evalResult.action).toBe('DENY');
				expect(evalResult.shouldPromptUser).toBe(false);
				expect(evalResult.syntheticRejection).toContain('Security Policy Violation (AUTONOMOUS mode)');
				expect(evalResult.syntheticRejection).toContain('CRITICAL risk command blocked by autonomous policy');
			});

			it('hard-denies path traversal targeting host secrets and returns synthetic feedback', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'read_file',
					{ path: '../../../etc/shadow' },
					conversationId,
					5
				);
				expect(evalResult.action).toBe('DENY');
				expect(evalResult.shouldPromptUser).toBe(false);
				expect(evalResult.syntheticRejection).toContain('Security Policy Violation (AUTONOMOUS mode)');
				expect(evalResult.syntheticRejection).toContain('Path traversal outside workspace boundary is blocked');
			});

			it('prompts for human review when turn limit is reached', () => {
				const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
					'write_file',
					{ path: 'src/lib/step.ts', content: 'test' },
					conversationId,
					25 // Reaches default limit of 25
				);
				expect(evalResult.action).toBe('PROMPT');
				expect(evalResult.decision.reason).toContain('Autonomous turn limit (25) reached');
			});
		});
	});

	describe('2. Pipeline Orchestration (authorizeAndExecuteTool)', () => {
		it('executes tool immediately when policy evaluates to ALLOW', async () => {
			WorkbenchSettingsService.setExecutionMode('ASSISTED');
			const mockExecute = vi.fn().mockResolvedValue('file contents here');
			const mockRequestPermission = vi.fn();

			const result = await WorkbenchSecurityBridge.authorizeAndExecuteTool({
				toolName: 'read_file',
				args: { path: 'README.md' },
				conversationId,
				serverLabel: 'Built-in Server',
				requestPermission: mockRequestPermission,
				execute: mockExecute
			});

			expect(result.allowed).toBe(true);
			expect(result.executed).toBe(true);
			expect(result.result).toBe('file contents here');
			expect(mockRequestPermission).not.toHaveBeenCalled();
			expect(mockExecute).toHaveBeenCalledTimes(1);

			// Verify receipt status in auditStore
			const receipt = auditStore.getReceipt(result.receiptId);
			expect(receipt).toBeDefined();
			expect(receipt?.status).toBe('SUCCESS');
			expect(receipt?.executionTimeMs).toBeGreaterThanOrEqual(0);
		});

		it('bypasses execution and gate when policy evaluates to DENY', async () => {
			WorkbenchSettingsService.setExecutionMode('AUTONOMOUS');
			const mockExecute = vi.fn();
			const mockRequestPermission = vi.fn();

			const result = await WorkbenchSecurityBridge.authorizeAndExecuteTool({
				toolName: 'exec_shell_command',
				args: { command: 'rm -rf /' },
				conversationId,
				serverLabel: 'Built-in Server',
				requestPermission: mockRequestPermission,
				execute: mockExecute
			});

			expect(result.allowed).toBe(false);
			expect(result.executed).toBe(false);
			expect(result.denialReason).toContain('Security Policy Violation');
			expect(result.denialReason).toContain('CRITICAL risk command blocked');
			expect(mockRequestPermission).not.toHaveBeenCalled();
			expect(mockExecute).not.toHaveBeenCalled();

			const receipt = auditStore.getReceipt(result.receiptId);
			expect(receipt?.status).toBe('DENIED');
		});

		it('prompts user and executes when user grants permission', async () => {
			WorkbenchSettingsService.setExecutionMode('SAFE');
			const mockExecute = vi.fn().mockResolvedValue('write success');
			const mockRequestPermission = vi.fn().mockResolvedValue(ToolPermissionDecision.ONCE);

			const result = await WorkbenchSecurityBridge.authorizeAndExecuteTool({
				toolName: 'write_file',
				args: { path: 'src/test.ts', content: 'hello' },
				conversationId,
				serverLabel: 'Built-in Server',
				requestPermission: mockRequestPermission,
				execute: mockExecute
			});

			expect(mockRequestPermission).toHaveBeenCalledWith('write_file', 'Built-in Server', undefined);
			expect(result.allowed).toBe(true);
			expect(result.executed).toBe(true);
			expect(result.result).toBe('write success');

			const receipt = auditStore.getReceipt(result.receiptId);
			expect(receipt?.status).toBe('SUCCESS');
		});

		it('denies execution when user rejects permission', async () => {
			WorkbenchSettingsService.setExecutionMode('SAFE');
			const mockExecute = vi.fn();
			const mockRequestPermission = vi.fn().mockResolvedValue(ToolPermissionDecision.DENY);

			const result = await WorkbenchSecurityBridge.authorizeAndExecuteTool({
				toolName: 'write_file',
				args: { path: 'src/test.ts', content: 'hello' },
				conversationId,
				serverLabel: 'Built-in Server',
				requestPermission: mockRequestPermission,
				execute: mockExecute
			});

			expect(mockRequestPermission).toHaveBeenCalled();
			expect(mockExecute).not.toHaveBeenCalled();
			expect(result.allowed).toBe(false);
			expect(result.executed).toBe(false);
			expect(result.denialReason).toBe('Tool execution was denied by the user.');

			const receipt = auditStore.getReceipt(result.receiptId);
			expect(receipt?.status).toBe('DENIED');
		});

		it('handles execution exceptions and marks receipt status as ERROR', async () => {
			WorkbenchSettingsService.setExecutionMode('ASSISTED');
			const mockExecute = vi.fn().mockRejectedValue(new Error('Disk I/O failure'));
			const mockRequestPermission = vi.fn();

			await expect(
				WorkbenchSecurityBridge.authorizeAndExecuteTool({
					toolName: 'read_file',
					args: { path: 'corrupt.bin' },
					conversationId,
					serverLabel: 'Built-in Server',
					requestPermission: mockRequestPermission,
					execute: mockExecute
				})
			).rejects.toThrow('Disk I/O failure');

			const receipts = auditStore.getReceipts();
			const lastReceipt = receipts[receipts.length - 1];
			expect(lastReceipt.status).toBe('ERROR');
			expect(lastReceipt.executionTimeMs).toBeGreaterThanOrEqual(0);
		});
	});

	describe('3. Audit Receipt Tracking & Outcome Recording', () => {
		it('tracks manual execution outcomes with recordExecutionOutcome', () => {
			const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
				'read_file',
				{ path: 'test.txt' },
				conversationId
			);

			WorkbenchSecurityBridge.recordExecutionOutcome(evalResult.receiptId, true, 42);

			const receipt = auditStore.getReceipt(evalResult.receiptId);
			expect(receipt?.status).toBe('SUCCESS');
			expect(receipt?.executionTimeMs).toBe(42);
		});

		it('tracks user denials with recordUserDenial', () => {
			const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
				'write_file',
				{ path: 'test.txt', content: 'abc' },
				conversationId
			);

			WorkbenchSecurityBridge.recordUserDenial(evalResult.receiptId);

			const receipt = auditStore.getReceipt(evalResult.receiptId);
			expect(receipt?.status).toBe('DENIED');
		});
	});

	describe('4. Settings Integration & Conversation Isolation', () => {
		it('isolates session approvals between conversations', () => {
			WorkbenchSettingsService.setExecutionMode('ASSISTED');

			WorkbenchSecurityBridge.recordSessionApproval('conv-1', 'write_file');

			const conv1Eval = WorkbenchSecurityBridge.evaluateToolCall(
				'write_file',
				{ path: 'file1.txt', content: '1' },
				'conv-1'
			);
			expect(conv1Eval.action).toBe('ALLOW');

			const conv2Eval = WorkbenchSecurityBridge.evaluateToolCall(
				'write_file',
				{ path: 'file2.txt', content: '2' },
				'conv-2'
			);
			expect(conv2Eval.action).toBe('PROMPT');
		});

		it('clears session approvals for specific conversation or globally', () => {
			WorkbenchSecurityBridge.recordSessionApproval('conv-a', 'write_file');
			WorkbenchSecurityBridge.recordSessionApproval('conv-b', 'write_file');

			WorkbenchSecurityBridge.clearSessionApprovals('conv-a');

			expect(WorkbenchSecurityBridge.getSessionApprovedTools('conv-a').size).toBe(0);
			expect(WorkbenchSecurityBridge.getSessionApprovedTools('conv-b').has('write_file')).toBe(true);

			WorkbenchSecurityBridge.clearSessionApprovals();
			expect(WorkbenchSecurityBridge.getSessionApprovedTools('conv-b').size).toBe(0);
		});

		it('correctly persists and retrieves execution modes', () => {
			WorkbenchSettingsService.setExecutionMode('AUTONOMOUS');
			expect(WorkbenchSettingsService.getExecutionMode()).toBe('AUTONOMOUS');

			WorkbenchSettingsService.setExecutionMode('ASSISTED');
			expect(WorkbenchSettingsService.getExecutionMode()).toBe('ASSISTED');

			WorkbenchSettingsService.setExecutionMode('SAFE');
			expect(WorkbenchSettingsService.getExecutionMode()).toBe('SAFE');
		});

		it('correctly persists and retrieves workspace root paths', () => {
			WorkbenchSettingsService.setWorkspaceRoot('D:/custom/workspace');
			expect(WorkbenchSettingsService.getWorkspaceRoot()).toBe('D:/custom/workspace');

			WorkbenchSettingsService.setWorkspaceRoot('');
			// Falls back to process.cwd() or empty string
			expect(typeof WorkbenchSettingsService.getWorkspaceRoot()).toBe('string');
		});
	});
});
