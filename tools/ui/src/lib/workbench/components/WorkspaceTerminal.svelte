<script lang="ts">
	import {
		AlertTriangle,
		Check,
		Loader2,
		Square,
		Terminal,
		Trash2,
		X,
		XCircle
	} from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { terminalStore } from '../terminal/terminal.svelte';
	import { workspaceStore } from '../workspace/workspace.svelte';

	interface Props {
		class?: string;
		onClose?: () => void;
	}

	let { class: className = '', onClose }: Props = $props();

	let inputCommand = $state('');
	let historyIndex = $state<number>(-1);
	let outputContainer: HTMLDivElement | null = $state(null);

	let isRunning = $derived(terminalStore.isRunning);
	let history = $derived(terminalStore.history);
	let activeRecord = $derived(terminalStore.activeRecord);
	let activeCwd = $derived(activeRecord?.cwd || workspaceStore.rootPath || '.');

	// Auto-scroll output container to bottom when history or output changes
	$effect(() => {
		if (outputContainer && (history.length > 0 || isRunning)) {
			outputContainer.scrollTop = outputContainer.scrollHeight;
		}
	});

	function handleSubmit(e?: Event) {
		if (e) e.preventDefault();
		const cmd = inputCommand.trim();
		if (!cmd || isRunning) return;

		inputCommand = '';
		historyIndex = -1;
		void terminalStore.run(cmd, activeCwd);
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'ArrowUp') {
			if (history.length === 0) return;
			e.preventDefault();
			if (historyIndex === -1) {
				historyIndex = history.length - 1;
			} else if (historyIndex > 0) {
				historyIndex--;
			}
			inputCommand = history[historyIndex]?.command || '';
		} else if (e.key === 'ArrowDown') {
			if (historyIndex === -1) return;
			e.preventDefault();
			if (historyIndex < history.length - 1) {
				historyIndex++;
				inputCommand = history[historyIndex]?.command || '';
			} else {
				historyIndex = -1;
				inputCommand = '';
			}
		}
	}

	function handleClear() {
		terminalStore.clearHistory();
		historyIndex = -1;
	}

	function handleAbort() {
		terminalStore.abort();
	}
</script>

<div
	class="workspace-terminal flex flex-col h-full bg-zinc-950 text-zinc-100 font-mono text-xs select-none overflow-hidden {className}"
	data-testid="workspace-terminal"
>
	<!-- Terminal Header Bar -->
	<header
		class="flex items-center justify-between px-3 py-1.5 border-b border-zinc-800 bg-zinc-900/80 shrink-0 gap-2"
	>
		<div class="flex items-center gap-2 min-w-0">
			<div class="p-1 rounded bg-emerald-500/10 text-emerald-400 shrink-0">
				<Terminal class="size-3.5" />
			</div>

			<span class="text-xs font-semibold tracking-tight text-zinc-200">Terminal</span>

			<Badge
				variant="secondary"
				class="text-[10px] px-1.5 py-0 font-mono bg-zinc-800 text-zinc-300 border-zinc-700 truncate max-w-44"
			>
				{activeCwd}
			</Badge>

			<!-- Live Status Indicator -->
			{#if isRunning}
				<div class="flex items-center gap-1 text-[11px] text-amber-400 animate-pulse">
					<Loader2 class="size-3 animate-spin" />
					<span>Running...</span>
				</div>
			{:else if activeRecord}
				{#if activeRecord.status === 'completed'}
					<div class="flex items-center gap-1 text-[10px] text-emerald-400">
						<Check class="size-3" />
						{#if activeRecord.durationMs !== undefined}
							<span>{activeRecord.durationMs}ms</span>
						{/if}
					</div>
				{:else if activeRecord.status === 'failed'}
					<div class="flex items-center gap-1 text-[10px] text-rose-400">
						<XCircle class="size-3" />
						<span>Failed</span>
					</div>
				{:else if activeRecord.status === 'aborted'}
					<div class="flex items-center gap-1 text-[10px] text-amber-400">
						<AlertTriangle class="size-3" />
						<span>Aborted</span>
					</div>
				{/if}
			{/if}
		</div>

		<!-- Action Buttons -->
		<div class="flex items-center gap-1 shrink-0">
			{#if isRunning}
				<Button
					size="sm"
					variant="destructive"
					class="h-6 px-2 text-[11px] gap-1 bg-rose-600 hover:bg-rose-700 text-white"
					onclick={handleAbort}
					title="Abort active command"
					aria-label="Abort command"
				>
					<Square class="size-2.5 fill-current" />
					<span>Stop</span>
				</Button>
			{/if}

			<Button
				size="icon"
				variant="ghost"
				class="size-6 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
				onclick={handleClear}
				disabled={history.length === 0 && !activeRecord}
				title="Clear terminal history"
				aria-label="Clear terminal"
			>
				<Trash2 class="size-3" />
			</Button>

			{#if onClose}
				<Button
					size="icon"
					variant="ghost"
					class="size-6 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 ml-1"
					onclick={onClose}
					title="Close terminal"
					aria-label="Close terminal"
				>
					<X class="size-3" />
				</Button>
			{/if}
		</div>
	</header>

	<!-- Output Log Stream Container -->
	<div
		bind:this={outputContainer}
		class="flex-1 overflow-y-auto p-3 space-y-3 leading-relaxed select-text min-h-0 text-zinc-200"
		role="log"
		aria-live="polite"
		aria-label="Terminal output log"
	>
		{#if history.length === 0}
			<div class="flex flex-col items-center justify-center h-full text-center p-6 text-zinc-500 select-none">
				<Terminal class="size-8 opacity-25 mb-2" />
				<p class="text-xs font-medium text-zinc-400">OMENA Autonomous Terminal Deck</p>
				<p class="text-[11px] text-zinc-500 mt-1">
					Type a command below and press Enter to execute in the workspace.
				</p>
			</div>
		{:else}
			{#each history as record (record.id)}
				<div class="terminal-record">
					<!-- Command Header Line -->
					<div class="flex items-center gap-1.5 text-zinc-400 select-none flex-wrap">
						<span class="text-emerald-400 font-bold">$</span>
						<span class="font-semibold text-zinc-100">{record.command}</span>

						{#if record.status === 'running'}
							<Loader2 class="size-3 animate-spin text-amber-400 ml-1" />
						{:else if record.exitCode !== undefined}
							<Badge
								variant="outline"
								class="text-[9px] px-1 py-0 ml-1 font-mono {record.exitCode === 0
									? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
									: 'text-rose-400 border-rose-500/30 bg-rose-500/10'}"
							>
								exit {record.exitCode}
							</Badge>
						{:else if record.status === 'failed'}
							<Badge
								variant="outline"
								class="text-[9px] px-1 py-0 ml-1 font-mono text-rose-400 border-rose-500/30 bg-rose-500/10"
							>
								failed
							</Badge>
						{/if}

						{#if record.durationMs !== undefined}
							<span class="text-[10px] text-zinc-500 ml-0.5">{record.durationMs}ms</span>
						{/if}

						{#if record.risk && record.risk !== 'LOW'}
							<Badge
								variant="outline"
								class="text-[9px] px-1 py-0 ml-1 font-mono {record.risk === 'CRITICAL'
									? 'text-rose-400 border-rose-500/30 bg-rose-500/10'
									: record.risk === 'HIGH'
										? 'text-amber-400 border-amber-500/30 bg-amber-500/10'
										: 'text-blue-400 border-blue-500/30 bg-blue-500/10'}"
							>
								{record.risk}
							</Badge>
						{/if}
					</div>

					<!-- Streamed Output Body -->
					{#if record.output}
						<div
							class="mt-1 pl-3 border-l-2 border-zinc-800 text-zinc-300 font-mono text-xs whitespace-pre-wrap break-all overflow-x-auto"
						>
							{record.output}
						</div>
					{:else if record.error}
						<div
							class="mt-1 pl-3 border-l-2 border-rose-900/40 text-rose-400 font-mono text-xs whitespace-pre-wrap break-all overflow-x-auto"
						>
							{record.error}
						</div>
					{:else if record.status === 'running'}
						<div class="mt-1 pl-3 border-l-2 border-zinc-800 text-zinc-500 italic text-[11px]">
							Streaming output...
						</div>
					{/if}
				</div>
			{/each}
		{/if}
	</div>

	<!-- Interactive Input Prompt -->
	<form
		onsubmit={handleSubmit}
		class="flex items-center gap-2 px-3 py-2 border-t border-zinc-800 bg-zinc-900/90 shrink-0"
		data-testid="terminal-input-form"
	>
		<span class="text-emerald-400 font-bold font-mono pl-1 select-none">$</span>
		<Input
			type="text"
			bind:value={inputCommand}
			onkeydown={handleKeyDown}
			placeholder={isRunning
				? 'Process is executing...'
				: 'Enter shell command (e.g., git status, ls -la)...'}
			disabled={isRunning}
			class="flex-1 h-7 text-xs font-mono bg-transparent text-zinc-100 placeholder:text-zinc-500 border-none focus-visible:ring-0 focus-visible:ring-offset-0 px-1 shadow-none"
			aria-label="Terminal command input"
		/>

		{#if !isRunning}
			<Button
				type="submit"
				size="sm"
				variant="ghost"
				class="h-6 px-2 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
				disabled={!inputCommand.trim()}
				aria-label="Execute command"
			>
				Run
			</Button>
		{/if}
	</form>
</div>
