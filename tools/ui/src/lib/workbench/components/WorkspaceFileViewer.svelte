<script lang="ts">
	import { FileCode, Loader2, X } from '@lucide/svelte';
	import SyntaxHighlightedCode from '$lib/components/app/content/SyntaxHighlightedCode.svelte';
	import { Button } from '$lib/components/ui/button';
	import { Badge } from '$lib/components/ui/badge';
	import { getLanguageFromFilename } from '$lib/utils/syntax-highlight-language';
	import { workspaceStore } from '../workspace/workspace.svelte';

	interface Props {
		class?: string;
	}

	let { class: className = '' }: Props = $props();

	let selectedPath = $derived(workspaceStore.selectedPath);
	let isLoading = $derived(workspaceStore.isLoadingFile);
	let fileContent = $derived(selectedPath ? workspaceStore.getFileContent(selectedPath) : undefined);

	let detectedLanguage = $derived(
		selectedPath ? getLanguageFromFilename(selectedPath) : 'plaintext'
	);

	let stats = $derived.by(() => {
		if (fileContent === undefined || fileContent === null) return { chars: 0, lines: 0 };
		const lines = fileContent.split('\n').length;
		const chars = fileContent.length;
		return { chars, lines };
	});

	function handleClose() {
		void workspaceStore.selectFile(null);
	}
</script>

<div
	class="workspace-file-viewer flex flex-col h-full overflow-hidden border-t sm:border-t-0 sm:border-l border-border/40 bg-background {className}"
	data-testid="workspace-file-viewer"
>
	{#if selectedPath}
		<!-- Header -->
		<div
			class="flex items-center justify-between px-3 py-2 border-b border-border/40 bg-muted/30 shrink-0"
		>
			<div class="flex items-center gap-2 min-w-0">
				<FileCode class="size-4 text-blue-500/90 shrink-0" />
				<span class="text-xs font-mono font-medium truncate" title={selectedPath}>
					{selectedPath}
				</span>
				<Badge variant="outline" class="text-[10px] px-1 py-0 uppercase">
					{detectedLanguage}
				</Badge>
			</div>

			<div class="flex items-center gap-2 shrink-0">
				{#if fileContent !== undefined}
					<span class="text-[11px] text-muted-foreground tabular-nums">
						{stats.lines} lines &middot; {stats.chars} chars
					</span>
				{/if}

				<Button
					size="icon"
					variant="ghost"
					class="size-6 text-muted-foreground hover:text-foreground"
					onclick={handleClose}
					aria-label="Close file viewer"
				>
					<X class="size-3.5" />
				</Button>
			</div>
		</div>

		<!-- Body -->
		<div class="flex-1 overflow-auto p-2 bg-background min-h-0">
			{#if isLoading}
				<div class="flex flex-col items-center justify-center h-48 gap-2 text-xs text-muted-foreground">
					<Loader2 class="size-5 animate-spin text-primary" />
					<span>Loading file content...</span>
				</div>
			{:else if fileContent !== undefined}
				<div class="rounded-md overflow-hidden border border-border/20">
					<SyntaxHighlightedCode
						code={fileContent}
						language={detectedLanguage}
						maxHeight="calc(100vh - 14rem)"
						class="text-xs font-mono"
					/>
				</div>
			{:else}
				<div class="flex items-center justify-center h-48 text-xs text-muted-foreground/70 italic">
					Unable to read file content or file is empty.
				</div>
			{/if}
		</div>
	{:else}
		<!-- Empty State -->
		<div class="flex flex-col items-center justify-center h-full p-6 text-center text-muted-foreground">
			<FileCode class="size-10 mb-2 opacity-30" />
			<p class="text-xs font-medium text-foreground/70">No file selected</p>
			<p class="text-[11px] text-muted-foreground/60 max-w-xs mt-1">
				Select a file from the workspace tree to inspect its contents with syntax highlighting.
			</p>
		</div>
	{/if}
</div>
