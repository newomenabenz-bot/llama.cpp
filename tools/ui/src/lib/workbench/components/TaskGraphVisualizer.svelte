<script lang="ts">
	import {
		CircleAlert,
		CircleCheck,
		CircleStop,
		Clock,
		FastForward,
		Layers,
		Loader2,
		Trash2,
		Wrench,
		ChevronDown,
		ChevronRight
	} from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { computeTaskProgress, topologicalSort } from '../task/dag';
	import { WorkbenchTaskController } from '../task/task-controller.service';
	import { taskGraphStore } from '../task/task-graph.svelte';
	import type { TaskGraph, TaskGraphProgress, TaskNode, TaskStepStatus } from '../task/types';

	interface Props {
		class?: string;
		forcedGraph?: TaskGraph | null;
		forceExpandAll?: boolean;
	}

	let { class: className = '', forcedGraph, forceExpandAll = false }: Props = $props();

	let activeGraph = $derived<TaskGraph | null>(
		forcedGraph !== undefined ? forcedGraph : taskGraphStore.activeGraph
	);

	let progress = $derived.by<TaskGraphProgress>(() => {
		if (!activeGraph) {
			return {
				completed: 0,
				failed: 0,
				inProgress: 0,
				pending: 0,
				percent: 0,
				skipped: 0,
				total: 0
			};
		}
		return computeTaskProgress(activeGraph.nodes);
	});

	let sortedNodeIds = $derived.by<string[]>(() => {
		if (!activeGraph) return [];
		try {
			return topologicalSort(activeGraph.nodes);
		} catch {
			return Object.keys(activeGraph.nodes);
		}
	});

	let sortedNodes = $derived.by<TaskNode[]>(() => {
		if (!activeGraph) return [];
		return sortedNodeIds
			.map((id) => activeGraph?.nodes[id])
			.filter((n): n is TaskNode => Boolean(n));
	});

	let expandedNodeIds = $state<Set<string>>(new Set());

	function toggleNodeExpanded(nodeId: string) {
		const next = new Set(expandedNodeIds);
		if (next.has(nodeId)) {
			next.delete(nodeId);
		} else {
			next.add(nodeId);
		}
		expandedNodeIds = next;
	}

	function handleAbort() {
		if (!activeGraph) return;
		WorkbenchTaskController.abortExecution(activeGraph.id);
		taskGraphStore.abortGraph('Execution aborted by user action');
	}

	function handleClear() {
		taskGraphStore.clearGraph();
	}

	function getNodeDuration(node: TaskNode): number | null {
		if (node.startedAt && node.completedAt && node.completedAt >= node.startedAt) {
			return node.completedAt - node.startedAt;
		}
		return null;
	}
</script>

<div
	class="flex flex-col h-full overflow-hidden bg-background text-foreground {className}"
	data-testid="task-graph-visualizer"
>
	{#if !activeGraph}
		<!-- Empty State -->
		<div
			class="flex flex-col items-center justify-center p-8 text-center text-muted-foreground h-full"
			data-testid="task-graph-empty-state"
		>
			<Layers class="size-10 opacity-20 mb-3" />
			<h4 class="text-xs font-semibold text-foreground/80">No active task plan</h4>
			<p class="text-[11px] text-muted-foreground/70 mt-1 max-w-xs leading-relaxed">
				Plan generation will appear here during autonomous execution.
			</p>
		</div>
	{:else}
		<!-- Header Section -->
		<div class="p-3 border-b border-border/40 bg-muted/10 space-y-2.5 shrink-0" data-testid="task-graph-header">
			<div class="flex items-center justify-between gap-2 flex-wrap">
				<div class="flex items-center gap-2 min-w-0">
					<Layers class="size-4 text-primary shrink-0" />
					<h3 class="text-xs font-semibold text-foreground truncate" data-testid="task-graph-title">
						{activeGraph.title}
					</h3>
					<Badge variant="outline" class="text-[10px] font-mono px-1 py-0 text-muted-foreground">
						{activeGraph.id.slice(0, 8)}
					</Badge>
				</div>

				<div class="flex items-center gap-2">
					<!-- Graph Status Pill -->
					<span
						class="px-2 py-0.5 rounded text-[11px] font-semibold border {activeGraph.status === 'running'
							? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30 animate-pulse'
							: activeGraph.status === 'completed'
								? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
								: activeGraph.status === 'failed'
									? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30'
									: activeGraph.status === 'aborted'
										? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
										: 'bg-zinc-500/10 text-zinc-600 dark:text-zinc-400 border-zinc-500/30'}"
						data-testid="graph-status-pill"
						data-status={activeGraph.status}
					>
						{activeGraph.status.toUpperCase()}
					</span>

					<!-- Action Buttons -->
					{#if activeGraph.status === 'running'}
						<Button
							variant="outline"
							size="sm"
							class="h-6 text-[11px] text-destructive hover:bg-destructive/10 px-2 flex items-center gap-1"
							onclick={handleAbort}
							data-testid="abort-task-graph"
						>
							<CircleStop class="size-3" />
							<span>Abort</span>
						</Button>
					{:else}
						<Button
							variant="ghost"
							size="sm"
							class="h-6 text-[11px] text-muted-foreground hover:text-foreground px-2 flex items-center gap-1"
							onclick={handleClear}
							data-testid="clear-task-graph"
						>
							<Trash2 class="size-3" />
							<span>Clear</span>
						</Button>
					{/if}
				</div>
			</div>

			<!-- Progress Gauge -->
			<div class="space-y-1" data-testid="task-graph-progress-bar">
				<div class="flex items-center justify-between text-[11px] text-muted-foreground">
					<span>
						Progress ({progress.completed} of {progress.total} completed)
					</span>
					<span class="font-mono font-semibold text-foreground">
						{progress.percent}%
					</span>
				</div>
				<div class="w-full h-1.5 bg-muted rounded-full overflow-hidden">
					<div
						class="h-full bg-primary transition-all duration-300 rounded-full"
						style="width: {progress.percent}%;"
					></div>
				</div>
			</div>
		</div>

		<!-- Node Flow / Tree View -->
		<div
			class="flex-1 overflow-y-auto p-3 space-y-2.5"
			data-testid="task-nodes-container"
		>
			{#each sortedNodes as node, index (node.id)}
				{@const isExpanded = forceExpandAll || expandedNodeIds.has(node.id)}
				{@const duration = getNodeDuration(node)}

				<div
					class="p-3 rounded-lg border transition-colors text-xs space-y-2 {node.status === 'in_progress'
						? 'border-blue-500/50 bg-blue-500/5 ring-1 ring-blue-500/30'
						: node.status === 'completed'
							? 'border-emerald-500/40 bg-emerald-500/5'
							: node.status === 'failed'
								? 'border-rose-500/50 bg-rose-500/5'
								: node.status === 'skipped'
									? 'border-amber-500/30 bg-amber-500/5 opacity-80'
									: 'border-border/60 bg-muted/20'}"
					data-testid="task-node-item"
					data-node-id={node.id}
					data-status={node.status}
				>
					<!-- Node Header Line -->
					<div class="flex items-center justify-between gap-2 flex-wrap">
						<div class="flex items-center gap-2 min-w-0">
							<span class="font-mono text-[10px] text-muted-foreground/80 shrink-0">
								#{index + 1}
							</span>

							<!-- Status Icon -->
							{#if node.status === 'in_progress'}
								<Loader2 class="size-3.5 text-blue-500 animate-spin shrink-0" />
							{:else if node.status === 'completed'}
								<CircleCheck class="size-3.5 text-emerald-500 shrink-0" />
							{:else if node.status === 'failed'}
								<CircleAlert class="size-3.5 text-rose-500 shrink-0" />
							{:else if node.status === 'skipped'}
								<FastForward class="size-3.5 text-amber-500/80 shrink-0" />
							{:else}
								<Clock class="size-3.5 text-muted-foreground/70 shrink-0" />
							{/if}

							<span class="font-semibold text-foreground truncate" data-testid="node-title-{node.id}">
								{node.title}
							</span>
						</div>

						<div class="flex items-center gap-1.5 shrink-0">
							{#if duration !== null}
								<span class="font-mono text-[10px] text-muted-foreground/70">
									{duration}ms
								</span>
							{/if}

							<!-- Node Status Badge -->
							<span
								class="px-1.5 py-0.2 rounded text-[10px] font-bold border {node.status === 'in_progress'
									? 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30 animate-pulse'
									: node.status === 'completed'
										? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
										: node.status === 'failed'
											? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30'
											: node.status === 'skipped'
												? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
												: 'bg-muted text-muted-foreground border-border/50'}"
								data-testid="node-status-badge-{node.id}"
								data-status={node.status}
							>
								{node.status.toUpperCase()}
							</span>
						</div>
					</div>

					<!-- Description if present -->
					{#if node.description}
						<p class="text-[11px] text-muted-foreground leading-relaxed pl-5">
							{node.description}
						</p>
					{/if}

					<!-- Dependencies Row -->
					{#if node.dependencies.length > 0}
						<div class="flex items-center gap-1.5 pl-5 flex-wrap">
							<span class="text-[10px] text-muted-foreground/70">Depends on:</span>
							{#each node.dependencies as depId}
								<Badge variant="outline" class="text-[10px] font-mono px-1 py-0">
									#{depId}
								</Badge>
							{/each}
						</div>
					{/if}

					<!-- Tool Call Information -->
					{#if node.toolCall}
						<div class="pl-5 pt-1">
							<div class="flex items-center justify-between gap-1 text-[11px]">
								<div class="flex items-center gap-1.5 font-mono text-muted-foreground">
									<Wrench class="size-3 text-primary/80" />
									<span class="font-semibold text-foreground/90">{node.toolCall.name}</span>
								</div>

								<button
									type="button"
									class="text-[10px] text-primary hover:underline flex items-center gap-0.5"
									onclick={() => toggleNodeExpanded(node.id)}
									data-testid="toggle-tool-args-{node.id}"
								>
									{#if isExpanded}
										<span>Hide arguments</span>
										<ChevronDown class="size-3" />
									{:else}
										<span>View arguments</span>
										<ChevronRight class="size-3" />
									{/if}
								</button>
							</div>

							{#if isExpanded}
								<pre
									class="mt-1.5 p-2 rounded bg-muted/40 border border-border/30 text-[10px] font-mono text-muted-foreground overflow-x-auto max-h-36"
									data-testid="tool-args-payload-{node.id}"
								>{JSON.stringify(node.toolCall.args, null, 2)}</pre>
							{/if}
						</div>
					{/if}

					<!-- Error Message on Failure or Skip -->
					{#if node.error}
						<div
							class="mt-1.5 p-2 rounded text-[11px] font-mono leading-relaxed border {node.status === 'failed'
								? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20'
								: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'}"
							data-testid="node-error-{node.id}"
						>
							{node.error}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
