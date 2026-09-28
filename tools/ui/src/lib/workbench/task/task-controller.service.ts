/**
 * Workbench Task Controller - Autonomous Task Graph Execution Orchestrator.
 *
 * Drives execution of Directed Acyclic Graph (DAG) task nodes, enforces runtime safety
 * envelopes (turn budgets, timeouts, consecutive failure ceilings), integrates with
 * WorkbenchSecurityBridge, and handles cancellation / abort propagation.
 */

import { ToolsService } from '$lib/services/tools.service';
import { WorkbenchSecurityBridge } from '../security';
import { WorkbenchWorkspaceJournalService } from '../workspace/journal.service';
import { isGraphComplete, isGraphFailed, getRunnableNodes } from './dag';
import { WorkbenchTaskGraphService } from './task-graph.service';
import { taskGraphStore } from './task-graph.svelte';
import {
	DEFAULT_TASK_EXECUTION_CONFIG,
	type TaskExecutionConfig,
	type TaskExecutionEvent,
	type TaskGraph,
	type TaskToolExecutor
} from './types';

export class WorkbenchTaskController {
	private static activeControllers = new Map<string, AbortController>();
	private static eventListeners = new Set<(event: TaskExecutionEvent) => void>();

	/**
	 * Subscribes a listener to task execution events. Returns an unsubscribe function.
	 */
	static subscribeEvents(listener: (event: TaskExecutionEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	private static emitEvent(event: TaskExecutionEvent): void {
		for (const listener of this.eventListeners) {
			try {
				listener(event);
			} catch (err) {
				console.warn('[WorkbenchTaskController] Event listener error:', err);
			}
		}
	}

	/**
	 * Aborts execution of an active task graph.
	 */
	static abortExecution(graphId: string): void {
		const controller = this.activeControllers.get(graphId);
		if (controller) {
			controller.abort();
			this.activeControllers.delete(graphId);
		}
	}

	/**
	 * Checks if a specific task graph is currently being executed by the controller.
	 */
	static isExecuting(graphId: string): boolean {
		return this.activeControllers.has(graphId);
	}

	/**
	 * Orchestrates execution of a TaskGraph until all nodes complete, fail, or safety limits are reached.
	 */
	static async executeGraph(
		graph: TaskGraph,
		config?: Partial<TaskExecutionConfig>,
		signal?: AbortSignal,
		toolExecutor?: TaskToolExecutor
	): Promise<TaskGraph> {
		const effectiveConfig: TaskExecutionConfig = {
			...DEFAULT_TASK_EXECUTION_CONFIG,
			...config
		};

		// Create dedicated AbortController linked to external signal
		const internalController = new AbortController();
		this.activeControllers.set(graph.id, internalController);

		const abortListener = () => internalController.abort();
		if (signal) {
			if (signal.aborted) {
				internalController.abort();
			} else {
				signal.addEventListener('abort', abortListener, { once: true });
			}
		}

		let currentGraph: TaskGraph = {
			...graph,
			status: 'running',
			updatedAt: Date.now()
		};
		taskGraphStore.setGraph(currentGraph);

		const startTime = Date.now();
		let turnCount = 0;
		let consecutiveFailures = 0;

		try {
			while (true) {
				// 1. Check abort cancellation
				if (internalController.signal.aborted) {
					currentGraph = WorkbenchTaskGraphService.abortGraph(
						currentGraph,
						'Task execution was aborted by user or system'
					);
					taskGraphStore.setGraph(currentGraph);
					this.emitEvent({
						error: 'Execution aborted',
						graphId: currentGraph.id,
						timestamp: Date.now(),
						type: 'graph_aborted'
					});
					return currentGraph;
				}

				// 2. Check execution timeout
				const elapsed = Date.now() - startTime;
				if (elapsed > effectiveConfig.timeoutMs) {
					const errorMsg = `Task execution timed out after ${effectiveConfig.timeoutMs}ms`;
					currentGraph = WorkbenchTaskGraphService.abortGraph(currentGraph, errorMsg);
					taskGraphStore.setGraph(currentGraph);
					this.emitEvent({
						error: errorMsg,
						graphId: currentGraph.id,
						timestamp: Date.now(),
						type: 'graph_aborted'
					});
					return currentGraph;
				}

				// 3. Check consecutive failure ceiling
				if (consecutiveFailures >= effectiveConfig.maxConsecutiveFailures) {
					const errorMsg = `Task execution halted: reached consecutive failure ceiling (${effectiveConfig.maxConsecutiveFailures})`;
					currentGraph = WorkbenchTaskGraphService.abortGraph(currentGraph, errorMsg);
					currentGraph.status = 'failed';
					taskGraphStore.setGraph(currentGraph);
					this.emitEvent({
						error: errorMsg,
						graphId: currentGraph.id,
						timestamp: Date.now(),
						type: 'graph_aborted'
					});
					return currentGraph;
				}

				// 4. Check maximum turn ceiling
				if (turnCount >= effectiveConfig.maxTurns) {
					const errorMsg = `Task execution paused: reached maximum turn budget (${effectiveConfig.maxTurns})`;
					currentGraph = WorkbenchTaskGraphService.abortGraph(currentGraph, errorMsg);
					taskGraphStore.setGraph(currentGraph);
					this.emitEvent({
						error: errorMsg,
						graphId: currentGraph.id,
						timestamp: Date.now(),
						type: 'graph_aborted'
					});
					return currentGraph;
				}

				// 5. Query runnable nodes
				const runnableNodes = getRunnableNodes(currentGraph.nodes);

				if (runnableNodes.length === 0) {
					// No more runnable nodes: evaluate final graph status
					if (isGraphComplete(currentGraph.nodes)) {
						currentGraph = {
							...currentGraph,
							status: 'completed',
							updatedAt: Date.now()
						};
						taskGraphStore.setGraph(currentGraph);
						this.emitEvent({
							graphId: currentGraph.id,
							timestamp: Date.now(),
							type: 'graph_completed'
						});
					} else if (isGraphFailed(currentGraph.nodes)) {
						currentGraph = {
							...currentGraph,
							status: 'failed',
							updatedAt: Date.now()
						};
						taskGraphStore.setGraph(currentGraph);
					}
					break;
				}

				// 6. Execute eligible runnable nodes sequentially
				for (const node of runnableNodes) {
					if (internalController.signal.aborted) break;
					if (consecutiveFailures >= effectiveConfig.maxConsecutiveFailures) break;
					if (Date.now() - startTime > effectiveConfig.timeoutMs) break;
					if (turnCount >= effectiveConfig.maxTurns) break;

					turnCount++;

					// Transition node to 'in_progress'
					currentGraph = WorkbenchTaskGraphService.startNode(currentGraph, node.id);
					taskGraphStore.setGraph(currentGraph);
					this.emitEvent({
						graphId: currentGraph.id,
						nodeId: node.id,
						timestamp: Date.now(),
						type: 'node_started'
					});

					// Execute task action / tool call
					if (node.toolCall) {
						const { name: toolName, args: toolArgs } = node.toolCall;

						// Evaluate security policy
						const securityEval = WorkbenchSecurityBridge.evaluateToolCall(
							toolName,
							toolArgs,
							currentGraph.conversationId,
							turnCount
						);

						if (securityEval.action === 'DENY') {
							const denialError =
								securityEval.syntheticRejection ||
								`Tool "${toolName}" was denied by security policy: ${securityEval.decision.reason ?? 'Blocked by policy'}`;
							currentGraph = WorkbenchTaskGraphService.failNode(
								currentGraph,
								node.id,
								denialError
							);
							consecutiveFailures++;
							taskGraphStore.setGraph(currentGraph);
							this.emitEvent({
								error: denialError,
								graphId: currentGraph.id,
								nodeId: node.id,
								timestamp: Date.now(),
								type: 'node_failed'
							});
							if (consecutiveFailures >= effectiveConfig.maxConsecutiveFailures) {
								break;
							}
							continue;
						}

						// Mutating tool snapshot capture (write_file, edit_file)
						const isMutatingTool =
							toolName === 'write_file' ||
							toolName === 'edit_file' ||
							toolName === 'server_write_file' ||
							toolName === 'server_edit_file';

						const targetFilePath =
							typeof toolArgs?.path === 'string'
								? toolArgs.path
								: typeof toolArgs?.filePath === 'string'
									? toolArgs.filePath
									: undefined;

						if (isMutatingTool && targetFilePath) {
							try {
								await WorkbenchWorkspaceJournalService.capturePreMutation(
									targetFilePath,
									{
										conversationId: currentGraph.conversationId,
										taskNodeId: node.id
									}
								);
							} catch (journalErr) {
								console.warn(
									'[WorkbenchTaskController] Pre-mutation snapshot capture warning:',
									journalErr
								);
							}
						}

						try {
							let toolResult: unknown;

							if (toolExecutor) {
								toolResult = await toolExecutor(
									toolName,
									toolArgs,
									internalController.signal
								);
							} else {
								const executionResult = await ToolsService.executeTool(
									toolName,
									toolArgs,
									internalController.signal
								);
								if (executionResult.isError) {
									throw new Error(executionResult.content || 'Tool execution error');
								}
								toolResult = executionResult.content;
							}

							currentGraph = WorkbenchTaskGraphService.completeNode(
								currentGraph,
								node.id,
								toolResult
							);
							consecutiveFailures = 0;
							taskGraphStore.setGraph(currentGraph);
							this.emitEvent({
								graphId: currentGraph.id,
								nodeId: node.id,
								timestamp: Date.now(),
								type: 'node_completed'
							});
						} catch (execError) {
							// Rollback task mutations on failure if configured or requested
							if (effectiveConfig.autoRollbackOnFailure) {
								try {
									await WorkbenchWorkspaceJournalService.rollbackTask(node.id);
								} catch (rollbackErr) {
									console.warn(
										'[WorkbenchTaskController] Auto-rollback on failure warning:',
										rollbackErr
									);
								}
							}

							const errorMsg =
								execError instanceof Error ? execError.message : String(execError);
							currentGraph = WorkbenchTaskGraphService.failNode(currentGraph, node.id, errorMsg);
							consecutiveFailures++;
							taskGraphStore.setGraph(currentGraph);
							this.emitEvent({
								error: errorMsg,
								graphId: currentGraph.id,
								nodeId: node.id,
								timestamp: Date.now(),
								type: 'node_failed'
							});
							if (consecutiveFailures >= effectiveConfig.maxConsecutiveFailures) {
								break;
							}
						}
					} else {
						// Pure task step without specific tool call: marks completed directly
						currentGraph = WorkbenchTaskGraphService.completeNode(currentGraph, node.id, {
							completed: true
						});
						consecutiveFailures = 0;
						taskGraphStore.setGraph(currentGraph);
						this.emitEvent({
							graphId: currentGraph.id,
							nodeId: node.id,
							timestamp: Date.now(),
							type: 'node_completed'
						});
					}
				}
			}
		} finally {
			this.activeControllers.delete(graph.id);
			if (signal) {
				signal.removeEventListener('abort', abortListener);
			}
		}

		return currentGraph;
	}
}
