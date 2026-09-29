/**
 * WorkbenchTerminalService - Shell Process Execution & Stream Processor
 *
 * Orchestrates shell execution, policy verification, real-time stdout/stderr
 * streaming, exit code extraction, and audit receipt tracking.
 */

import { ToolsService } from '$lib/services/tools.service';
import { parseExecShellCommandExitStatus } from '$lib/utils';
import { auditStore } from '../security/audit.store';
import { classifyCommandRisk } from '../security/command-guard';
import { WorkbenchSecurityBridge } from '../security/workbench-security.bridge';
import type { TerminalExecutionRecord, TerminalExecuteOptions } from './types';

export class WorkbenchTerminalService {
	/**
	 * Executes a shell command with security policy validation, streaming output,
	 * exit status parsing, and audit receipt logging.
	 */
	static async executeCommand(
		command: string,
		cwd: string,
		optionsOrChunk?: TerminalExecuteOptions | ((chunk: string) => void),
		maybeSignal?: AbortSignal
	): Promise<TerminalExecutionRecord> {
		const onChunk =
			typeof optionsOrChunk === 'function' ? optionsOrChunk : optionsOrChunk?.onChunk;
		const signal =
			typeof optionsOrChunk === 'object' && optionsOrChunk?.signal
				? optionsOrChunk.signal
				: maybeSignal;

		const startedAt = Date.now();
		const recordId = `term_${startedAt}_${Math.random().toString(36).substring(2, 8)}`;

		// 1. Classify command risk
		const classification = classifyCommandRisk(command);

		const record: TerminalExecutionRecord = {
			id: recordId,
			command,
			cwd,
			status: 'running',
			output: '',
			startedAt,
			risk: classification.risk
		};

		// 2. Evaluate security policy via WorkbenchSecurityBridge
		const evalResult = WorkbenchSecurityBridge.evaluateToolCall(
			'exec_shell_command',
			{ command },
			undefined,
			undefined,
			cwd
		);

		// If policy denies execution or command is CRITICAL host self-destruction, abort immediately
		if (evalResult.action === 'DENY' || classification.risk === 'CRITICAL') {
			const denialReason =
				evalResult.syntheticRejection ||
				`Command denied by security policy (${classification.risk} risk): ${classification.reason}`;
			record.status = 'failed';
			record.error = denialReason;
			record.output = denialReason;
			record.completedAt = Date.now();
			record.durationMs = 0;
			record.exitCode = 1;

			auditStore.updateReceiptStatus(evalResult.receiptId, 'DENIED', 0);
			if (onChunk) {
				onChunk(denialReason);
			}
			return record;
		}

		// 3. Execute command stream via ToolsService
		try {
			const stream = ToolsService.streamTool('exec_shell_command', { command }, signal, cwd);

			for await (const event of stream) {
				if (event.chunk) {
					record.output += event.chunk;
					if (onChunk) {
						onChunk(event.chunk);
					}
				}

				if (event.error) {
					record.error = event.error;
				}
			}

			record.completedAt = Date.now();
			record.durationMs = record.completedAt - startedAt;

			// 4. Parse process exit status from accumulated output
			const exitStatus = parseExecShellCommandExitStatus(record.output);
			if (exitStatus !== undefined) {
				record.exitCode = exitStatus.code;
			}

			if (record.error || (record.exitCode !== undefined && record.exitCode !== 0)) {
				record.status = 'failed';
				auditStore.updateReceiptStatus(evalResult.receiptId, 'ERROR', record.durationMs);
			} else {
				record.status = 'completed';
				auditStore.updateReceiptStatus(evalResult.receiptId, 'SUCCESS', record.durationMs);
			}
		} catch (err: unknown) {
			record.completedAt = Date.now();
			record.durationMs = record.completedAt - startedAt;

			const isAborted =
				signal?.aborted || (err instanceof Error && err.name === 'AbortError');

			if (isAborted) {
				record.status = 'aborted';
				record.error = 'Command aborted by user';
			} else {
				record.status = 'failed';
				record.error = err instanceof Error ? err.message : String(err);
				record.exitCode = record.exitCode ?? 1;
				record.output = record.output
					? `${record.output}\n[Process execution failed: ${record.error}]`
					: `[Process execution failed: ${record.error}]`;
			}

			auditStore.updateReceiptStatus(evalResult.receiptId, 'ERROR', record.durationMs);
		}

		return record;
	}
}
