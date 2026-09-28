/**
 * Workbench Security Bridge.
 *
 * Interception bridge connecting PolicyService, upstream permission gates,
 * and the reactive auditStore. Enforces runtime security policy without modifying
 * upstream gate logic.
 */

import { ToolPermissionDecision } from '$lib/enums';
import { policyService } from './policy.service';
import { auditStore } from './audit.store';
import { WorkbenchSettingsService } from '../settings/workbench-settings.service';
import type { PolicyAction, PolicyDecision } from './types';

export interface SecurityBridgeEvaluation {
	action: PolicyAction;
	decision: PolicyDecision;
	receiptId: string;
	syntheticRejection?: string;
	shouldPromptUser: boolean;
}

export interface AuthorizeAndExecuteOptions<T> {
	toolName: string;
	args: Record<string, unknown>;
	conversationId: string;
	serverLabel: string;
	signal?: AbortSignal;
	turn?: number;
	customWorkspaceRoot?: string;
	requestPermission: (
		toolName: string,
		serverLabel: string,
		signal?: AbortSignal
	) => Promise<ToolPermissionDecision>;
	execute: () => Promise<T>;
}

export interface AuthorizeAndExecuteResult<T> {
	allowed: boolean;
	executed: boolean;
	result?: T;
	denialReason?: string;
	receiptId: string;
}

export class WorkbenchSecurityBridge {
	// Session approvals per conversation for ASSISTED mode
	private static sessionApprovedMap = new Map<string, Set<string>>();

	static getSessionApprovedTools(conversationId: string): Set<string> {
		let set = this.sessionApprovedMap.get(conversationId);
		if (!set) {
			set = new Set<string>();
			this.sessionApprovedMap.set(conversationId, set);
		}
		return set;
	}

	static recordSessionApproval(conversationId: string, toolName: string): void {
		const set = this.getSessionApprovedTools(conversationId);
		set.add(toolName);
		if (toolName === 'write_file' || toolName === 'edit_file') {
			set.add('mutating_tools');
		}
	}

	static clearSessionApprovals(conversationId?: string): void {
		if (conversationId) {
			this.sessionApprovedMap.delete(conversationId);
		} else {
			this.sessionApprovedMap.clear();
		}
	}

	/**
	 * Pre-evaluates a tool call proposal against current policy settings.
	 */
	static evaluateToolCall(
		toolName: string,
		args: Record<string, unknown>,
		conversationId?: string,
		turn?: number,
		customWorkspaceRoot?: string
	): SecurityBridgeEvaluation {
		const mode = WorkbenchSettingsService.getExecutionMode();
		const workspaceRoot =
			customWorkspaceRoot && customWorkspaceRoot.trim().length > 0
				? customWorkspaceRoot.trim()
				: WorkbenchSettingsService.getWorkspaceRoot();

		const sessionApproved = conversationId
			? this.getSessionApprovedTools(conversationId)
			: new Set<string>();

		const decision = policyService.evaluateToolCall(toolName, args, {
			mode,
			workspaceRoot,
			conversationId,
			turn,
			sessionApprovedTools: sessionApproved
		});

		// Record initial receipt in auditStore
		const receipt = auditStore.recordReceipt({
			toolName,
			args,
			mode,
			decision: decision.action,
			reason: decision.reason,
			risk: decision.risk,
			status: decision.action === 'DENY' ? 'DENIED' : 'PENDING'
		});

		let syntheticRejection: string | undefined;
		if (decision.action === 'DENY') {
			syntheticRejection = `Security Policy Violation (${mode} mode): ${decision.reason}`;
		}

		return {
			action: decision.action,
			decision,
			receiptId: receipt.id,
			syntheticRejection,
			shouldPromptUser: decision.action === 'PROMPT'
		};
	}

	/**
	 * High-level orchestration method that evaluates policy, prompts if required,
	 * executes the tool, and logs execution receipts.
	 */
	static async authorizeAndExecuteTool<T>(
		options: AuthorizeAndExecuteOptions<T>
	): Promise<AuthorizeAndExecuteResult<T>> {
		const {
			toolName,
			args,
			conversationId,
			serverLabel,
			signal,
			turn,
			customWorkspaceRoot,
			requestPermission,
			execute
		} = options;

		// 1. Evaluate policy
		const evalResult = this.evaluateToolCall(
			toolName,
			args,
			conversationId,
			turn,
			customWorkspaceRoot
		);

		// 2. HARD DENY: Bypass execution & prompt, return synthetic rejection
		if (evalResult.action === 'DENY') {
			return {
				allowed: false,
				executed: false,
				denialReason: evalResult.syntheticRejection,
				receiptId: evalResult.receiptId
			};
		}

		// 3. PROMPT: Delegate to upstream permission gate
		if (evalResult.action === 'PROMPT') {
			const permission = await requestPermission(toolName, serverLabel, signal);

			if (permission === ToolPermissionDecision.DENY || signal?.aborted) {
				auditStore.updateReceiptStatus(evalResult.receiptId, 'DENIED');
				return {
					allowed: false,
					executed: false,
					denialReason: 'Tool execution was denied by the user.',
					receiptId: evalResult.receiptId
				};
			}

			// In ASSISTED mode, record session approval for subsequent calls
			this.recordSessionApproval(conversationId, toolName);
		}

		// 4. Execute tool
		const startTime = performance.now();
		try {
			const result = await execute();
			const duration = performance.now() - startTime;
			auditStore.updateReceiptStatus(evalResult.receiptId, 'SUCCESS', duration);

			return {
				allowed: true,
				executed: true,
				result,
				receiptId: evalResult.receiptId
			};
		} catch (error) {
			const duration = performance.now() - startTime;
			auditStore.updateReceiptStatus(evalResult.receiptId, 'ERROR', duration);
			throw error;
		}
	}

	/**
	 * Updates the audit status of a previously evaluated tool execution.
	 */
	static recordExecutionOutcome(
		receiptId: string,
		success: boolean,
		executionTimeMs?: number
	): void {
		auditStore.updateReceiptStatus(
			receiptId,
			success ? 'SUCCESS' : 'ERROR',
			executionTimeMs
		);
	}

	/**
	 * Records a user denial for an evaluated receipt.
	 */
	static recordUserDenial(receiptId: string): void {
		auditStore.updateReceiptStatus(receiptId, 'DENIED');
	}
}
