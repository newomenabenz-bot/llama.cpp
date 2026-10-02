<script lang="ts">
	import {
		ChevronDown,
		ChevronRight,
		File,
		FileCode,
		Folder,
		FolderOpen
	} from '@lucide/svelte';
	import type { WorkspaceFileNode } from '../workspace/types';
	import { workspaceStore } from '../workspace/workspace.svelte';
	import WorkspaceTreeNode from './WorkspaceTreeNode.svelte';

	interface Props {
		node: WorkspaceFileNode;
		level?: number;
	}

	let { level = 0, node }: Props = $props();

	let isDirectory = $derived(node.type === 'directory');
	let isSelected = $derived(workspaceStore.selectedPath === node.path);
	let isExpanded = $derived(Boolean(node.isExpanded));

	const CODE_EXTENSIONS = new Set([
		'ts', 'js', 'svelte', 'json', 'html', 'css', 'scss',
		'py', 'rs', 'go', 'cpp', 'c', 'h', 'md', 'yaml', 'yml',
		'sql', 'sh', 'bash', 'ps1', 'toml'
	]);

	let isCodeFile = $derived(node.extension ? CODE_EXTENSIONS.has(node.extension) : false);

	function handleClick(e: MouseEvent) {
		e.stopPropagation();
		if (isDirectory) {
			workspaceStore.toggleFolder(node.path);
		} else {
			void workspaceStore.selectFile(node.path);
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			if (isDirectory) {
				workspaceStore.toggleFolder(node.path);
			} else {
				void workspaceStore.selectFile(node.path);
			}
		}
	}
</script>

<div class="workspace-tree-item flex flex-col">
	<div
		role="treeitem"
		tabindex="0"
		aria-selected={isSelected}
		aria-expanded={isDirectory ? isExpanded : undefined}
		class={[
			'flex items-center gap-1.5 py-1 px-2 rounded-md cursor-pointer select-none text-xs transition-colors',
			'hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
			isSelected
				? 'bg-accent text-accent-foreground font-medium shadow-xs'
				: 'text-foreground/80 hover:text-foreground'
		]}
		style="padding-left: {level * 14 + 6}px;"
		onclick={handleClick}
		onkeydown={handleKeyDown}
		data-path={node.path}
		data-type={node.type}
	>
		<!-- Directory Chevron or Spacing -->
		{#if isDirectory}
			<span class="size-3.5 shrink-0 flex items-center justify-center text-muted-foreground/80">
				{#if isExpanded}
					<ChevronDown class="size-3.5" />
				{:else}
					<ChevronRight class="size-3.5" />
				{/if}
			</span>
			<span class="size-4 shrink-0 flex items-center justify-center text-amber-500/90 dark:text-amber-400/90">
				{#if isExpanded}
					<FolderOpen class="size-3.5" />
				{:else}
					<Folder class="size-3.5" />
				{/if}
			</span>
		{:else}
			<span class="size-3.5 shrink-0"></span>
			<span class="size-4 shrink-0 flex items-center justify-center text-muted-foreground">
				{#if isCodeFile}
					<FileCode class="size-3.5 text-blue-500/90 dark:text-blue-400/90" />
				{:else}
					<File class="size-3.5" />
				{/if}
			</span>
		{/if}

		<span class="min-w-0 truncate text-xs" title={node.path}>
			{node.name}
		</span>
	</div>

	<!-- Render recursive children if expanded -->
	{#if isDirectory && isExpanded}
		{#if node.children && node.children.length > 0}
			{#each node.children as child (child.id || `${child.type}:${child.path}`)}
				<WorkspaceTreeNode node={child} level={level + 1} />
			{/each}
		{:else}
			<div
				style="padding-left: {(level + 1) * 14 + 6}px;"
				class="py-0.5 text-[11px] text-muted-foreground/60 italic select-none"
			>
				(empty folder)
			</div>
		{/if}
	{/if}
</div>
