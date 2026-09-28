<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import {
		Activity,
		AlertOctagon,
		AlertTriangle,
		Brain,
		CheckCircle2,
		ChevronDown,
		ChevronRight,
		CircleDot,
		FileCode,
		Layers,
		Loader2,
		Play,
		Scissors,
		ShieldAlert,
		ShieldCheck,
		Sparkles,
		Terminal,
		Trash2,
		Wrench,
		Zap
	} from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { agenticStore } from '$lib/stores/agentic/index.svelte';
	import { conversationsStore } from '$lib/stores/conversations/index.svelte';
	import { serverStore } from '$lib/stores/server.svelte';
	import { settingsStore } from '$lib/stores/settings/index.svelte';
	import { WorkbenchContextBudgetService } from '../context/context-budget.service';
	import { WorkbenchAgentCheckpointService } from '../persistence/checkpoint.service';
	import type { AgentExecutionState } from '../persistence/types';
	import { auditStore } from '../security/audit.store';
	import { policyService } from '../security/policy.service';
	import type { AuditReceipt, CommandRisk, ExecutionMode } from '../security/types';
	import { WorkbenchSettingsService } from '../settings/workbench-settings.service';
	import { taskGraphStore } from '../task/task-graph.svelte';
	import type { TaskGraph } from '../task/types';
	import TaskGraphVisualizer from './TaskGraphVisualizer.svelte';

	interface Props {
		class?: string;
		forcedState?: AgentExecutionState;
		forcedMode?: ExecutionMode;
		forcedTurn?: number;
		forcedMaxTurns?: number;
		forcedTokens?: number;
		forcedContextLimit?: number;
		forcedReceipts?: AuditReceipt[];
		forceExpandAll?: boolean;
		initialDeckTab?: 'audit' | 'plan';
		forcedActiveGraph?: TaskGraph | null;
	}

	let {
		class: className = '',
		forceExpandAll = false,
		forcedActiveGraph,
		forcedContextLimit,
		forcedMaxTurns,
		forcedMode,
		forcedReceipts,
		forcedState,
		forcedTokens,
		forcedTurn,
		initialDeckTab = 'audit'
	}: Props = $props();

	// svelte-ignore state_referenced_locally
	let activeDeckTab = $state<'audit' | 'plan'>(initialDeckTab);
	let activeGraph = $derived<TaskGraph | null>(
		forcedActiveGraph !== undefined ? forcedActiveGraph : taskGraphStore.activeGraph
	);

	let planProgress = $derived.by(() => {
		if (!activeGraph) return null;
		const nodes = Object.values(activeGraph.nodes);
		const total = nodes.length;
		const completed = nodes.filter((n) => n.status === 'completed').length;
		return { completed, total };
	});

	let storeReceipts = $state<AuditReceipt[]>(auditStore.getReceipts());
	let receipts = $derived(forcedReceipts ?? storeReceipts);
	let expandedReceiptIds = $state<Set<string>>(new Set());
	let unsubscribeAudit: (() => void) | null = null;

	function refreshReceipts() {
		storeReceipts = auditStore.getReceipts();
	}

	onMount(() => {
		refreshReceipts();
		unsubscribeAudit = auditStore.subscribe(refreshReceipts);
	});

	onDestroy(() => {
		if (unsubscribeAudit) {
			unsubscribeAudit();
		}
	});

	let activeConversationId = $derived(conversationsStore.activeConversation?.id ?? '');

	// 1. Reactive State Machine derivation
	let currentState = $derived.by<AgentExecutionState>(() => {
		if (forcedState) return forcedState;
		const convId = activeConversationId;
		if (!convId) return 'IDLE';

		const checkpoint = WorkbenchAgentCheckpointService.getCheckpoint(convId);
		if (checkpoint?.state === 'HALTED') return 'HALTED';
		if (
			checkpoint?.state === 'AWAITING_PERMISSION' ||
			agenticStore.getPendingPermissionRequest(convId)
		) {
			return 'AWAITING_PERMISSION';
		}

		if (agenticStore.isRunning(convId)) {
			if (agenticStore.getStreamingToolCall(convId)) {
				return 'PROPOSING_ACTION';
			}
			if (agenticStore.getExecutingToolCallId(convId)) {
				return 'EXECUTING_TOOLS';
			}
			return checkpoint?.state || 'THINKING';
		}

		return checkpoint?.state || 'IDLE';
	});

	// 2. Reactive Policy Mode derivation
	let currentMode = $derived.by<ExecutionMode>(() => {
		if (forcedMode) return forcedMode;
		try {
			return WorkbenchSettingsService.getExecutionMode();
		} catch {
			return policyService.getMode();
		}
	});

	// 3. Turn Progress derivation
	let currentTurn = $derived.by<number>(() => {
		if (forcedTurn !== undefined) return forcedTurn;
		const convId = activeConversationId;
		const storeTurn = convId ? agenticStore.getCurrentTurn(convId) : 0;
		if (storeTurn > 0) return storeTurn;

		const checkpoint = convId ? WorkbenchAgentCheckpointService.getCheckpoint(convId) : null;
		return checkpoint?.turn ?? 0;
	});

	let maxTurns = $derived.by<number>(() => {
		if (forcedMaxTurns !== undefined) return forcedMaxTurns;
		try {
			return agenticStore.getConfig(settingsStore.config).maxTurns || 25;
		} catch {
			return 25;
		}
	});

	let turnPercent = $derived(
		maxTurns > 0 ? Math.min(100, Math.round((currentTurn / maxTurns) * 100)) : 0
	);

	// 4. Token & Context Budget Metrics
	let contextLimit = $derived.by<number>(() => {
		if (forcedContextLimit !== undefined) return forcedContextLimit;
		return (
			serverStore.props?.default_generation_settings?.n_ctx ||
			serverStore.props?.total_context_window ||
			32768
		);
	});

	let estimatedTokens = $derived.by<number>(() => {
		if (forcedTokens !== undefined) return forcedTokens;
		const activeMessages = conversationsStore.activeMessages;
		if (!activeMessages || activeMessages.length === 0) return 0;
		const status = WorkbenchContextBudgetService.getBudgetStatus(
			activeMessages as unknown as import('$lib/types').ApiChatMessageData[],
			{ maxTokens: contextLimit }
		);
		return status.totalTokens;
	});

	let tokenRatio = $derived(contextLimit > 0 ? estimatedTokens / contextLimit : 0);
	let tokenPercent = $derived(Math.min(100, Math.round(tokenRatio * 100)));

	let tokenStatus = $derived.by<'NORMAL' | 'WARNING' | 'CRITICAL'>(() => {
		if (tokenRatio > 0.9) return 'CRITICAL';
		if (tokenRatio >= 0.75) return 'WARNING';
		return 'NORMAL';
	});

	// Detect if historical tool compaction is active
	let isCompactionActive = $derived.by<boolean>(() => {
		if (tokenRatio >= 0.75) return true;
		const messages = conversationsStore.activeMessages;
		if (!messages) return false;
		return messages.some((m) => typeof m.content === 'string' && m.content.includes('[Tool output compacted:'));
	});

	function toggleReceiptExpanded(id: string) {
		const next = new Set(expandedReceiptIds);
		if (next.has(id)) {
			next.delete(id);
		} else {
			next.add(id);
		}
		expandedReceiptIds = next;
	}

	function handleClearLog() {
		auditStore.clear();
		refreshReceipts();
	}

	function formatTime(timestamp: number): string {
		try {
			const d = new Date(timestamp);
			return d.toTimeString().split(' ')[0] ?? '';
		} catch {
			return '';
		}
	}

	function getOutcomeType(receipt: AuditReceipt): 'ALLOWED' | 'DENIED' | 'REJECTED' {
		if (receipt.status === 'DENIED' || receipt.decision === 'DENY') {
			return 'DENIED';
		}
		if (receipt.status === 'ERROR') {
			return 'REJECTED';
		}
		return 'ALLOWED';
	}
</script>

<div
	class="agent-observability-deck flex flex-col h-full bg-background select-none overflow-hidden {className}"
	data-testid="agent-observability-deck"
>
	<!-- Top Summary Header Bar -->
	<div class="px-4 py-3 border-b border-border/40 bg-muted/20 shrink-0 space-y-3">
		<div class="flex items-center justify-between gap-2 flex-wrap">
			<div class="flex items-center gap-2">
				<Activity class="size-4 text-primary" />
				<h3 class="text-xs font-semibold uppercase tracking-wider text-foreground">
					Agent Observability
				</h3>
			</div>

			<div class="flex items-center gap-2 flex-wrap">
				<!-- State Machine Status Pill -->
				<div
					class="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border transition-all duration-200 {currentState ===
					'THINKING'
						? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30'
						: currentState === 'PROPOSING_ACTION'
							? 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30'
							: currentState === 'EXECUTING_TOOLS'
								? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
								: currentState === 'AWAITING_PERMISSION'
									? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30 animate-pulse'
									: currentState === 'HALTED'
										? 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30'
										: currentState === 'COMPLETED'
											? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
											: 'bg-muted text-muted-foreground border-border/60'}"
					data-testid="state-machine-pill"
					data-state={currentState}
				>
					{#if currentState === 'THINKING'}
						<Loader2 class="size-3 animate-spin" />
						<span>THINKING</span>
					{:else if currentState === 'PROPOSING_ACTION'}
						<Sparkles class="size-3" />
						<span>PROPOSING_ACTION</span>
					{:else if currentState === 'EXECUTING_TOOLS'}
						<Wrench class="size-3" />
						<span>EXECUTING_TOOLS</span>
					{:else if currentState === 'AWAITING_PERMISSION'}
						<ShieldAlert class="size-3" />
						<span>AWAITING_PERMISSION</span>
					{:else if currentState === 'HALTED'}
						<AlertOctagon class="size-3" />
						<span>HALTED</span>
					{:else if currentState === 'COMPLETED'}
						<CheckCircle2 class="size-3" />
						<span>COMPLETED</span>
					{:else}
						<CircleDot class="size-3" />
						<span>IDLE</span>
					{/if}
				</div>

				<!-- Policy Mode Badge -->
				<div
					class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-semibold border {currentMode ===
					'AUTONOMOUS'
						? 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30'
						: currentMode === 'ASSISTED'
							? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
							: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30'}"
					data-testid="policy-mode-badge"
					data-mode={currentMode}
				>
					{#if currentMode === 'AUTONOMOUS'}
						<Zap class="size-3" />
						<span>AUTONOMOUS</span>
					{:else if currentMode === 'ASSISTED'}
						<ShieldAlert class="size-3" />
						<span>ASSISTED</span>
					{:else}
						<ShieldCheck class="size-3" />
						<span>SAFE</span>
					{/if}
				</div>
			</div>
		</div>

		<!-- Turn Meter -->
		<div class="space-y-1" data-testid="turn-meter">
			<div class="flex items-center justify-between text-xs text-muted-foreground">
				<span class="font-medium text-foreground">Turn Progress</span>
				<span class="font-mono text-[11px]">
					Turn {currentTurn} of {maxTurns} ({turnPercent}%)
				</span>
			</div>
			<div class="w-full h-1.5 bg-muted rounded-full overflow-hidden">
				<div
					class="h-full bg-primary transition-all duration-300 rounded-full"
					style="width: {turnPercent}%;"
				></div>
			</div>
		</div>

		<!-- Context & Token Budget Section -->
		<div class="p-2.5 rounded-lg border border-border/40 bg-background/60 space-y-2">
			<div class="flex items-center justify-between text-xs">
				<div class="flex items-center gap-1.5">
					<span class="font-semibold text-foreground">Context Window</span>
					<!-- Compaction Indicator -->
					<span
						class="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[10px] font-medium {isCompactionActive
							? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20'
							: 'text-muted-foreground/70'}"
						data-testid="compaction-indicator"
						data-compaction-active={isCompactionActive}
					>
						{#if isCompactionActive}
							<Scissors class="size-2.5" />
							<span>Compaction Active</span>
						{:else}
							<span>Compaction Standby</span>
						{/if}
					</span>
				</div>

				<!-- Token Budget Status Tag -->
				<span
					class="px-1.5 py-0.5 rounded text-[10px] font-bold border {tokenStatus === 'CRITICAL'
						? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30'
						: tokenStatus === 'WARNING'
							? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
							: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'}"
					data-testid="token-budget-status"
					data-status={tokenStatus}
				>
					{tokenStatus}
				</span>
			</div>

			<!-- Visual Token Progress Bar -->
			<div class="space-y-1">
				<div class="w-full h-2 bg-muted rounded-full overflow-hidden">
					<div
						class="h-full transition-all duration-300 rounded-full {tokenStatus === 'CRITICAL'
							? 'bg-rose-500'
							: tokenStatus === 'WARNING'
								? 'bg-amber-500'
								: 'bg-emerald-500'}"
						style="width: {tokenPercent}%;"
					></div>
				</div>
				<div class="flex items-center justify-between text-[11px] font-mono text-muted-foreground">
					<span>{estimatedTokens.toLocaleString()} tokens</span>
					<span>{contextLimit.toLocaleString()} n_ctx ({tokenPercent}%)</span>
				</div>
			</div>
		</div>

		{#if planProgress}
			<!-- Task Plan Progress Summary Banner -->
			<div
				class="px-2.5 py-1.5 rounded-lg border border-primary/20 bg-primary/5 flex items-center justify-between text-xs"
				data-testid="task-plan-summary-banner"
			>
				<div class="flex items-center gap-1.5">
					<Layers class="size-3.5 text-primary" />
					<span class="font-medium text-foreground">Task Plan:</span>
					<span class="text-muted-foreground">
						{planProgress.completed} of {planProgress.total} steps completed
					</span>
				</div>
				{#if activeGraph}
					<Badge variant="outline" class="text-[10px] font-mono px-1 py-0">
						{activeGraph.status.toUpperCase()}
					</Badge>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Bottom Content Section with Tab Switcher -->
	<div class="flex-1 flex flex-col min-h-0 overflow-hidden" data-testid="deck-content-section">
		<div class="flex items-center justify-between px-3 py-1.5 border-b border-border/30 bg-muted/10 shrink-0 gap-2">
			<!-- Tab Switcher -->
			<div class="flex items-center gap-1 bg-muted/40 p-0.5 rounded-md text-xs" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={activeDeckTab === 'audit'}
					class="px-2.5 py-1 rounded text-xs font-medium transition-all {activeDeckTab === 'audit'
						? 'bg-background text-foreground shadow-sm'
						: 'text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeDeckTab = 'audit')}
					data-testid="deck-tab-audit"
				>
					<div class="flex items-center gap-1.5">
						<ShieldCheck class="size-3 text-muted-foreground" />
						<span>Audit Log ({receipts.length})</span>
					</div>
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={activeDeckTab === 'plan'}
					class="px-2.5 py-1 rounded text-xs font-medium transition-all {activeDeckTab === 'plan'
						? 'bg-background text-foreground shadow-sm'
						: 'text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeDeckTab = 'plan')}
					data-testid="deck-tab-plan"
				>
					<div class="flex items-center gap-1.5">
						<Layers class="size-3 text-muted-foreground" />
						<span>Plan Graph ({activeGraph ? Object.keys(activeGraph.nodes).length : 0})</span>
					</div>
				</button>
			</div>

			<!-- Right side header actions -->
			{#if activeDeckTab === 'audit' && receipts.length > 0}
				<Button
					variant="ghost"
					size="sm"
					class="h-6 text-[11px] text-muted-foreground hover:text-destructive px-2 flex items-center gap-1"
					onclick={handleClearLog}
					data-testid="clear-audit-log"
				>
					<Trash2 class="size-3" />
					<span>Clear Log</span>
				</Button>
			{/if}
		</div>

		<!-- Tab Panels -->
		{#if activeDeckTab === 'audit'}
			<div class="flex-1 flex flex-col min-h-0 overflow-hidden" data-testid="audit-trail-section">
				<!-- Receipts List -->
				<div class="flex-1 overflow-y-auto p-3 space-y-2" data-testid="audit-receipts-container">
			{#if receipts.length === 0}
				<div class="flex flex-col items-center justify-center h-48 text-center p-6 text-muted-foreground">
					<ShieldCheck class="size-8 opacity-25 mb-2" />
					<p class="text-xs font-medium text-foreground/75">No audit events recorded</p>
					<p class="text-[11px] text-muted-foreground/60 mt-1 max-w-xs">
						Tool executions, policy evaluations, and risk classifications will appear here in real time.
					</p>
				</div>
			{:else}
				{#each receipts as receipt (receipt.id)}
					{@const isExpanded = forceExpandAll || expandedReceiptIds.has(receipt.id)}
					{@const outcome = getOutcomeType(receipt)}

					<div
						class="p-2.5 rounded-lg border border-border/40 bg-card hover:border-border transition-colors text-xs space-y-2"
						data-testid="audit-receipt-item"
						data-receipt-id={receipt.id}
					>
						<!-- Receipt Header Line -->
						<div class="flex items-center justify-between gap-1.5 flex-wrap">
							<div class="flex items-center gap-2 min-w-0">
								<button
									type="button"
									class="p-0.5 rounded hover:bg-muted text-muted-foreground"
									onclick={() => toggleReceiptExpanded(receipt.id)}
									aria-label={isExpanded ? 'Collapse receipt details' : 'Expand receipt details'}
									data-testid="expand-receipt-{receipt.id}"
								>
									{#if isExpanded}
										<ChevronDown class="size-3.5" />
									{:else}
										<ChevronRight class="size-3.5" />
									{/if}
								</button>

								<span class="font-mono text-[10px] text-muted-foreground">
									{formatTime(receipt.timestamp)}
								</span>

								<span class="font-mono font-semibold text-foreground truncate max-w-36">
									{receipt.toolName}
								</span>
							</div>

							<!-- Risk & Outcome Badges -->
							<div class="flex items-center gap-1.5 shrink-0">
								<!-- Risk Pill -->
								<span
									class="px-1.5 py-0.2 rounded text-[10px] font-bold border {receipt.risk ===
									'CRITICAL'
										? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30'
										: receipt.risk === 'HIGH'
											? 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/20'
											: receipt.risk === 'MEDIUM'
												? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
												: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20'}"
									data-testid="risk-pill"
									data-risk={receipt.risk}
								>
									{receipt.risk}
								</span>

								<!-- Outcome Badge -->
								<span
									class="px-1.5 py-0.2 rounded text-[10px] font-bold border {outcome === 'DENIED'
										? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30'
										: outcome === 'REJECTED'
											? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30'
											: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'}"
									data-testid="outcome-badge"
									data-outcome={outcome}
								>
									{outcome}
								</span>

								<!-- Execution Duration -->
								{#if receipt.executionTimeMs !== undefined}
									<span class="font-mono text-[10px] text-muted-foreground/80">
										{receipt.executionTimeMs}ms
									</span>
								{/if}
							</div>
						</div>

						<!-- Expandable Details: Arguments & Reason -->
						{#if isExpanded}
							<div
								class="pt-2 border-t border-border/30 space-y-1.5 text-[11px]"
								data-testid="receipt-json-payload"
							>
								{#if receipt.reason}
									<div class="text-muted-foreground">
										<span class="font-medium text-foreground">Reason:</span> {receipt.reason}
									</div>
								{/if}

								{#if receipt.args && Object.keys(receipt.args).length > 0}
									<div>
										<span class="font-medium text-foreground">Arguments:</span>
										<pre
											class="mt-1 p-2 rounded bg-muted/40 text-[10px] font-mono overflow-x-auto select-text text-foreground/90 max-h-40">{JSON.stringify(
												receipt.args,
												null,
												2
											)}</pre>
									</div>
								{/if}

								<div class="text-[10px] font-mono text-muted-foreground/70">
									Decision: {receipt.decision} | Mode: {receipt.mode} | ID: {receipt.id}
								</div>
							</div>
						{/if}
					</div>
				{/each}
			{/if}
		</div>
	</div>
	{:else}
		<div class="flex-1 flex flex-col min-h-0 overflow-hidden" data-testid="plan-graph-section">
			<TaskGraphVisualizer
				forcedGraph={activeGraph}
				{forceExpandAll}
			/>
		</div>
	{/if}
	</div>
</div>
