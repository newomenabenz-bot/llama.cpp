/**
 * Policy Service - Core Security & Sandbox Policy Evaluation Engine.
 *
 * Enforces execution modes (SAFE, ASSISTED, AUTONOMOUS), path sandboxing,
 * shell command risk tiering, and turn limits.
 */

import type { CommandRisk, ExecutionMode, PolicyContext, PolicyDecision } from './types';
import { validatePathWithinWorkspace } from './path-sandbox';
import { classifyCommandRisk } from './command-guard';

const READ_TOOLS = new Set([
	'read_file',
	'file_glob_search',
	'grep_search',
	'get_info',
	'get_datetime',
	'browser_info',
	'read_media'
]);

const MUTATING_TOOLS = new Set(['write_file', 'edit_file']);

export class PolicyService {
	private currentMode: ExecutionMode = 'SAFE';

	constructor(initialMode: ExecutionMode = 'SAFE') {
		this.currentMode = initialMode;
	}

	getMode(): ExecutionMode {
		return this.currentMode;
	}

	setMode(mode: ExecutionMode): void {
		this.currentMode = mode;
	}

	/**
	 * Evaluates a tool call proposal against the active policy context.
	 */
	evaluateToolCall(
		toolName: string,
		args: Record<string, unknown> = {},
		context?: Partial<PolicyContext>
	): PolicyDecision {
		const mode: ExecutionMode = context?.mode ?? this.currentMode;
		const workspaceRoot = context?.workspaceRoot;
		const turn = context?.turn ?? 0;
		const maxAutonomousTurns = context?.maxAutonomousTurns ?? 25;
		const sessionApproved = context?.sessionApprovedTools ?? new Set<string>();

		// 1. Path extraction and sandbox boundary validation (for path-accepting tools)
		const targetPath = typeof args.path === 'string' ? args.path : undefined;
		let pathCheckResult: { allowed: boolean; reason?: string } | undefined;

		if (targetPath && workspaceRoot) {
			pathCheckResult = validatePathWithinWorkspace(targetPath, workspaceRoot);
		}

		// 2. Shell command classification (for shell execution)
		const shellCommand =
			toolName === 'exec_shell_command' && typeof args.command === 'string'
				? args.command
				: undefined;

		let commandRisk: CommandRisk = 'LOW';
		let commandRiskReason: string | undefined;

		if (shellCommand) {
			const classification = classifyCommandRisk(shellCommand);
			commandRisk = classification.risk;
			commandRiskReason = classification.reason;
		}

		// =========================================================================
		// MODE: AUTONOMOUS
		// =========================================================================
		if (mode === 'AUTONOMOUS') {
			// A. Max turn guard
			if (turn >= maxAutonomousTurns) {
				return {
					action: 'PROMPT',
					reason: `Autonomous turn limit (${maxAutonomousTurns}) reached; user confirmation required to continue`,
					risk: 'MEDIUM',
					targetPath,
					sanitizedCommand: shellCommand
				};
			}

			// B. Path boundary enforcement (Hard deny on outside workspace access)
			if (pathCheckResult && !pathCheckResult.allowed) {
				return {
					action: 'DENY',
					reason: `Path traversal outside workspace boundary is blocked in AUTONOMOUS mode: ${pathCheckResult.reason}`,
					risk: 'HIGH',
					targetPath,
					sanitizedCommand: shellCommand
				};
			}

			// C. Shell command guard
			if (toolName === 'exec_shell_command') {
				if (commandRisk === 'CRITICAL') {
					return {
						action: 'DENY',
						reason: `CRITICAL risk command blocked by autonomous policy: ${commandRiskReason}`,
						risk: 'CRITICAL',
						targetPath,
						sanitizedCommand: shellCommand
					};
				}

				if (commandRisk === 'HIGH') {
					return {
						action: 'PROMPT',
						reason: `HIGH risk shell command requires confirmation: ${commandRiskReason}`,
						risk: 'HIGH',
						targetPath,
						sanitizedCommand: shellCommand
					};
				}

				return {
					action: 'ALLOW',
					reason: 'Autonomous safe shell execution permitted',
					risk: commandRisk,
					targetPath,
					sanitizedCommand: shellCommand
				};
			}

			// D. In-sandbox mutating & read tools
			if (MUTATING_TOOLS.has(toolName)) {
				return {
					action: 'ALLOW',
					reason: 'Autonomous in-sandbox file mutation permitted',
					risk: 'LOW',
					targetPath
				};
			}

			return {
				action: 'ALLOW',
				reason: 'Autonomous operation permitted',
				risk: 'LOW',
				targetPath
			};
		}

		// =========================================================================
		// MODE: ASSISTED
		// =========================================================================
		if (mode === 'ASSISTED') {
			// Read tools: automatically allow
			if (READ_TOOLS.has(toolName)) {
				return {
					action: 'ALLOW',
					reason: 'Read operation allowed in ASSISTED mode',
					risk: 'LOW',
					targetPath
				};
			}

			// Path traversal outside workspace always prompts
			if (pathCheckResult && !pathCheckResult.allowed) {
				return {
					action: 'PROMPT',
					reason: `Operation outside workspace boundary requires confirmation: ${pathCheckResult.reason}`,
					risk: 'HIGH',
					targetPath,
					sanitizedCommand: shellCommand
				};
			}

			// Mutating tools: prompt once per session
			if (MUTATING_TOOLS.has(toolName)) {
				const isSessionApproved =
					sessionApproved.has(toolName) || sessionApproved.has('mutating_tools');

				if (isSessionApproved) {
					return {
						action: 'ALLOW',
						reason: 'In-workspace file mutation authorized for this session',
						risk: 'LOW',
						targetPath
					};
				}

				return {
					action: 'PROMPT',
					reason: 'File mutation requires initial session authorization in ASSISTED mode',
					risk: 'MEDIUM',
					targetPath
				};
			}

			// Shell execution
			if (toolName === 'exec_shell_command') {
				if (commandRisk === 'CRITICAL') {
					return {
						action: 'PROMPT',
						reason: `CRITICAL risk command requires explicit authorization: ${commandRiskReason}`,
						risk: 'CRITICAL',
						targetPath,
						sanitizedCommand: shellCommand
					};
				}

				if (commandRisk === 'LOW') {
					const isSessionApproved = sessionApproved.has('exec_shell_command');
					if (isSessionApproved) {
						return {
							action: 'ALLOW',
							reason: 'Safe shell command authorized for this session',
							risk: 'LOW',
							targetPath,
							sanitizedCommand: shellCommand
						};
					}
				}

				return {
					action: 'PROMPT',
					reason: `${commandRisk} risk shell execution requires confirmation in ASSISTED mode`,
					risk: commandRisk,
					targetPath,
					sanitizedCommand: shellCommand
				};
			}

			return {
				action: 'ALLOW',
				reason: 'Standard operation permitted in ASSISTED mode',
				risk: 'LOW',
				targetPath
			};
		}

		// =========================================================================
		// MODE: SAFE (Default)
		// =========================================================================
		// Read tools
		if (READ_TOOLS.has(toolName)) {
			if (pathCheckResult && !pathCheckResult.allowed) {
				return {
					action: 'PROMPT',
					reason: `Read operation outside workspace boundary requires confirmation: ${pathCheckResult.reason}`,
					risk: 'MEDIUM',
					targetPath
				};
			}

			return {
				action: 'ALLOW',
				reason: 'Safe read operation permitted',
				risk: 'LOW',
				targetPath
			};
		}

		// Mutating tools: always prompt in SAFE mode
		if (MUTATING_TOOLS.has(toolName)) {
			return {
				action: 'PROMPT',
				reason: 'File mutation requires confirmation in SAFE mode',
				risk: 'MEDIUM',
				targetPath
			};
		}

		// Shell execution: always prompt in SAFE mode
		if (toolName === 'exec_shell_command') {
			return {
				action: 'PROMPT',
				reason: `Shell execution (${commandRisk} risk) requires confirmation in SAFE mode`,
				risk: commandRisk,
				targetPath,
				sanitizedCommand: shellCommand
			};
		}

		// Default fallback for unknown tools in SAFE mode
		return {
			action: 'PROMPT',
			reason: 'Tool execution requires user confirmation in SAFE mode',
			risk: 'MEDIUM',
			targetPath
		};
	}
}

export const policyService = new PolicyService('SAFE');
