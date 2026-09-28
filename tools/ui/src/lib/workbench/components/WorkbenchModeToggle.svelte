<script lang="ts">
	import { Code2, MessageSquare } from '@lucide/svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { workbenchShellStore } from '../shell/shell.svelte';

	interface Props {
		class?: string;
	}

	let { class: className = '' }: Props = $props();

	let mode = $derived(workbenchShellStore.mode);
	let isWorkbench = $derived(mode === 'workbench');

	function toggleMode() {
		workbenchShellStore.setMode(isWorkbench ? 'chat' : 'workbench');
	}
</script>

<Tooltip.Provider>
	<div
		class="workbench-mode-toggle inline-flex items-center {className}"
		data-testid="workbench-mode-toggle"
	>
		<Tooltip.Root>
			<Tooltip.Trigger>
				{#snippet child({ props })}
					<button
						type="button"
						{...props}
						onclick={toggleMode}
						class="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full border transition-all duration-150 shadow-xs select-none {isWorkbench
							? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/20'
							: 'bg-muted/40 text-muted-foreground border-border/60 hover:text-foreground hover:bg-muted/80'}"
						aria-label={isWorkbench ? 'Switch to Chat View' : 'Switch to Workbench IDE'}
						data-mode={mode}
					>
						{#if isWorkbench}
							<Code2 class="size-3.5 text-amber-500" />
							<span class="text-[11px] font-semibold tracking-tight">Workbench</span>
						{:else}
							<MessageSquare class="size-3.5" />
							<span class="text-[11px] font-medium">Chat</span>
						{/if}
					</button>
				{/snippet}
			</Tooltip.Trigger>
			<Tooltip.Content side="bottom" class="text-xs">
				{isWorkbench ? 'Switch to Chat View' : 'Switch to Workbench IDE'}
			</Tooltip.Content>
		</Tooltip.Root>
	</div>
</Tooltip.Provider>
