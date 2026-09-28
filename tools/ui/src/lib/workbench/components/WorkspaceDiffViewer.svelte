<script lang="ts">
	import {
		Check,
		Columns,
		GitCompare,
		Minus,
		Plus,
		Rows,
		X
	} from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { prefixFor, WorkbenchDiffService } from '../diff/diff.service';
	import type { DiffViewMode } from '../diff/types';

	interface Props {
		filePath?: string;
		originalContent: string;
		modifiedContent: string;
		initialMode?: DiffViewMode;
		class?: string;
		onClose?: () => void;
	}

	let {
		class: className = '',
		filePath = 'file.diff',
		initialMode = 'unified',
		modifiedContent = '',
		onClose,
		originalContent = ''
	}: Props = $props();

	let currentMode = $state<DiffViewMode | null>(null);
	let mode = $derived(currentMode ?? initialMode);

	let diffLines = $derived(WorkbenchDiffService.computeDiff(originalContent, modifiedContent));
	let stats = $derived(WorkbenchDiffService.getDiffStats(diffLines));
	let splitRows = $derived(WorkbenchDiffService.computeSplitRows(diffLines));
</script>

<div
	class="workspace-diff-viewer flex flex-col h-full bg-background select-none overflow-hidden {className}"
	data-testid="workspace-diff-viewer"
>
	<!-- Diff Header Bar -->
	<header
		class="flex items-center justify-between px-3 py-2 border-b border-border/40 bg-muted/20 shrink-0 gap-2"
	>
		<div class="flex items-center gap-2 min-w-0">
			<div class="p-1 rounded bg-amber-500/10 text-amber-500 shrink-0">
				<GitCompare class="size-4" />
			</div>

			<span class="text-xs font-mono font-medium truncate" title={filePath}>
				{filePath}
			</span>

			<!-- Stats Pills -->
			{#if stats.isClean}
				<Badge
					variant="outline"
					class="text-[10px] px-1.5 py-0 border-emerald-500/40 text-emerald-500 bg-emerald-500/10"
				>
					<Check class="size-3 mr-0.5" />
					Clean
				</Badge>
			{:else}
				<div class="flex items-center gap-1 shrink-0 font-mono text-[10px]">
					<Badge
						variant="outline"
						class="px-1.5 py-0 border-emerald-500/40 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
					>
						+{stats.additions}
					</Badge>
					<Badge
						variant="outline"
						class="px-1.5 py-0 border-rose-500/40 text-rose-600 dark:text-rose-400 bg-rose-500/10"
					>
						-{stats.deletions}
					</Badge>
				</div>
			{/if}
		</div>

		<!-- View Mode Switcher -->
		<div class="flex items-center gap-1 shrink-0">
			<div class="flex items-center rounded-lg border border-border/40 bg-muted/40 p-0.5">
				<Button
					size="sm"
					variant={mode === 'unified' ? 'secondary' : 'ghost'}
					class="h-6 px-2 text-xs gap-1 font-normal"
					onclick={() => (currentMode = 'unified')}
					aria-label="Unified diff"
				>
					<Rows class="size-3" />
					<span>Unified</span>
				</Button>
				<Button
					size="sm"
					variant={mode === 'split' ? 'secondary' : 'ghost'}
					class="h-6 px-2 text-xs gap-1 font-normal"
					onclick={() => (currentMode = 'split')}
					aria-label="Split diff"
				>
					<Columns class="size-3" />
					<span>Split</span>
				</Button>
			</div>

			{#if onClose}
				<Button
					size="icon"
					variant="ghost"
					class="size-6 text-muted-foreground hover:text-foreground ml-1"
					onclick={onClose}
					aria-label="Close diff"
				>
					<X class="size-3.5" />
				</Button>
			{/if}
		</div>
	</header>

	<!-- Diff Content Body -->
	<div class="flex-1 overflow-auto bg-background min-h-0">
		{#if stats.isClean}
			<div class="flex flex-col items-center justify-center h-48 text-center p-6 text-muted-foreground">
				<Check class="size-8 text-emerald-500/60 mb-2" />
				<p class="text-xs font-medium text-foreground/80">Files are identical</p>
				<p class="text-[11px] text-muted-foreground/60 mt-1">
					No line differences detected between original and modified content.
				</p>
			</div>
		{:else if mode === 'unified'}
			<!-- Unified Mode (Single 4-column scrollable block) -->
			<div class="diff-block">
				{#each diffLines as line, i (i)}
					<div class="diff-line diff-{line.kind}">
						<span class="diff-old-num">{line.oldLine ?? ''}</span>
						<span class="diff-marker">{prefixFor(line.kind)}</span>
						<span class="diff-new-num">{line.newLine ?? ''}</span>
						<span class="diff-text">{line.text || ' '}</span>
					</div>
				{/each}
			</div>
		{:else}
			<!-- Split Mode (Side-by-side synchronized 2-column comparison) -->
			<div class="split-diff-container">
				<!-- Sticky Column Headers -->
				<div class="split-diff-header grid grid-cols-2 border-b border-border/40 bg-muted/40 font-mono text-[11px]">
					<div class="px-3 py-1 flex items-center gap-1 border-r border-border/30 text-rose-500 font-medium">
						<Minus class="size-3" />
						<span>Original</span>
					</div>
					<div class="px-3 py-1 flex items-center gap-1 text-emerald-500 font-medium">
						<Plus class="size-3" />
						<span>Modified</span>
					</div>
				</div>

				<!-- Side-by-side rows -->
				<div class="split-diff-body">
					{#each splitRows as row, i (i)}
						<div class="split-diff-row grid grid-cols-2">
							<!-- Left Pane (Original / Remove) -->
							<div class="split-side split-left diff-{row.left.kind} flex border-r border-border/30">
								<span class="split-gutter">{row.left.lineNum ?? ''}</span>
								<span class="split-text">{row.left.text || ' '}</span>
							</div>

							<!-- Right Pane (Modified / Add) -->
							<div class="split-side split-right diff-{row.right.kind} flex">
								<span class="split-gutter">{row.right.lineNum ?? ''}</span>
								<span class="split-text">{row.right.text || ' '}</span>
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</div>

<style>
	/* ---------------- Unified Diff Grid ---------------- */
	.diff-block {
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.65;
	}

	.diff-line {
		display: grid;
		grid-template-columns: 3.25rem 1.5rem 3.25rem 1fr;
		align-items: stretch;
	}

	.diff-old-num,
	.diff-new-num {
		text-align: right;
		padding-right: 0.5rem;
		user-select: none;
		color: color-mix(in oklch, var(--muted-foreground) 70%, transparent);
		font-variant-numeric: tabular-nums;
	}

	.diff-marker {
		text-align: center;
		color: color-mix(in oklch, var(--muted-foreground) 70%, transparent);
		user-select: none;
	}

	.diff-text {
		padding-left: 0.4rem;
		padding-right: 0.5rem;
		white-space: pre;
		overflow-x: auto;
		min-width: 0;
	}

	.diff-line.diff-add {
		background-color: #f0fff4;
		color: #22863a;
	}
	.diff-line.diff-add .diff-new-num,
	.diff-line.diff-add .diff-marker {
		color: #22863a;
	}

	.diff-line.diff-remove {
		background-color: #ffeef0;
		color: #b31d28;
	}
	.diff-line.diff-remove .diff-old-num,
	.diff-line.diff-remove .diff-marker {
		color: #b31d28;
	}

	.diff-line.diff-add .diff-old-num,
	.diff-line.diff-remove .diff-new-num {
		opacity: 0;
	}

	:global(.dark) .diff-line.diff-add {
		background-color: #033a16;
		color: #aff5b4;
	}
	:global(.dark) .diff-line.diff-add .diff-new-num,
	:global(.dark) .diff-line.diff-add .diff-marker {
		color: #aff5b4;
	}
	:global(.dark) .diff-line.diff-remove {
		background-color: #67060c;
		color: #ffdcd7;
	}
	:global(.dark) .diff-line.diff-remove .diff-old-num,
	:global(.dark) .diff-line.diff-remove .diff-marker {
		color: #ffdcd7;
	}

	/* ---------------- Split Diff Grid ---------------- */
	.split-diff-container {
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.65;
		min-width: 100%;
	}

	.split-diff-row {
		border-bottom: 1px solid color-mix(in oklch, var(--border) 15%, transparent);
	}

	.split-side {
		min-width: 0;
		overflow-x: auto;
	}

	.split-gutter {
		width: 3.25rem;
		text-align: right;
		padding-right: 0.5rem;
		user-select: none;
		flex-shrink: 0;
		color: color-mix(in oklch, var(--muted-foreground) 70%, transparent);
		font-variant-numeric: tabular-nums;
	}

	.split-text {
		padding-left: 0.4rem;
		padding-right: 0.5rem;
		white-space: pre;
		overflow-x: auto;
		min-width: 0;
		flex: 1;
	}

	.split-side.diff-add {
		background-color: #f0fff4;
		color: #22863a;
	}
	.split-side.diff-add .split-gutter {
		color: #22863a;
	}

	.split-side.diff-remove {
		background-color: #ffeef0;
		color: #b31d28;
	}
	.split-side.diff-remove .split-gutter {
		color: #b31d28;
	}

	.split-side.diff-empty {
		background-color: color-mix(in oklch, var(--muted) 20%, transparent);
	}

	:global(.dark) .split-side.diff-add {
		background-color: #033a16;
		color: #aff5b4;
	}
	:global(.dark) .split-side.diff-add .split-gutter {
		color: #aff5b4;
	}

	:global(.dark) .split-side.diff-remove {
		background-color: #67060c;
		color: #ffdcd7;
	}
	:global(.dark) .split-side.diff-remove .split-gutter {
		color: #ffdcd7;
	}
</style>
