<script lang="ts">
	import {
		AlertTriangle,
		ChevronsDownUp,
		ChevronsUpDown,
		FileCode,
		FolderTree,
		Loader2,
		RefreshCw,
		Search,
		Terminal,
		X
	} from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { terminalStore } from '../terminal/terminal.svelte';
	import type { WorkspaceFileNode } from '../workspace/types';
	import { workspaceStore } from '../workspace/workspace.svelte';
	import { onMount } from 'svelte';
	import WorkspaceDiffViewer from './WorkspaceDiffViewer.svelte';
	import WorkspaceFileViewer from './WorkspaceFileViewer.svelte';
	import WorkspaceTerminal from './WorkspaceTerminal.svelte';
	import WorkspaceTreeNode from './WorkspaceTreeNode.svelte';

	interface Props {
		class?: string;
		onClose?: () => void;
		treeOnly?: boolean;
	}

	let { class: className = '', onClose, treeOnly = false }: Props = $props();

	let searchQuery = $state('');
	let activeTab = $state<'tree' | 'viewer' | 'terminal'>('tree');

	let isSelected = $derived(Boolean(workspaceStore.selectedPath));
	let isLoading = $derived(workspaceStore.isLoading);
	let rootPath = $derived(workspaceStore.rootPath);
	let treeNodes = $derived(workspaceStore.tree);
	let isTerminalOpen = $derived(terminalStore.isOpen);
	let isTerminalRunning = $derived(terminalStore.isRunning);

	// Automatically switch to viewer tab on small screens when a file is selected or diff is loaded
	$effect(() => {
		if (workspaceStore.diffPayload || workspaceStore.selectedPath) {
			activeTab = 'viewer';
		}
	});

	onMount(() => {
		if (workspaceStore.tree.length === 0 && !workspaceStore.isLoading) {
			void workspaceStore.refreshTree();
		}
	});

	function filterNodes(nodes: WorkspaceFileNode[], query: string): WorkspaceFileNode[] {
		if (!query.trim()) return nodes;
		const q = query.toLowerCase();

		const filtered: WorkspaceFileNode[] = [];
		for (const node of nodes) {
			if (node.type === 'directory') {
				const matchingChildren = node.children ? filterNodes(node.children, q) : [];
				if (node.name.toLowerCase().includes(q) || matchingChildren.length > 0) {
					filtered.push({
						...node,
						children: matchingChildren.length > 0 ? matchingChildren : node.children,
						isExpanded: true
					});
				}
			} else if (node.name.toLowerCase().includes(q) || node.path.toLowerCase().includes(q)) {
				filtered.push(node);
			}
		}
		return filtered;
	}

	let displayedTree = $derived(filterNodes(treeNodes, searchQuery));

	function handleRefresh() {
		void workspaceStore.refreshTree();
	}

	function handleExpandAll() {
		workspaceStore.expandAll();
	}

	function handleCollapseAll() {
		workspaceStore.collapseAll();
	}
</script>

<div
	class="workspace-explorer flex flex-col h-full bg-background select-none {className}"
	data-testid="workspace-explorer"
>
	<!-- Top Navigation / Title Bar -->
	<header
		class="flex items-center justify-between px-4 py-3 border-b border-border/40 bg-muted/20 shrink-0"
	>
		<div class="flex items-center gap-2 min-w-0">
			<div class="p-1 rounded bg-primary/10 text-primary shrink-0">
				<FolderTree class="size-4" />
			</div>
			<div class="flex items-center gap-1.5 min-w-0">
				<h3 class="text-sm font-semibold tracking-tight text-foreground truncate">
					Workspace
				</h3>
				<Badge variant="secondary" class="text-[10px] px-1.5 py-0 font-mono truncate max-w-40">
					{rootPath}
				</Badge>
			</div>
		</div>

		<div class="flex items-center gap-1 shrink-0">
			<Button
				size="icon"
				variant="ghost"
				class="size-7 text-muted-foreground hover:text-foreground"
				onclick={handleExpandAll}
				title="Expand all folders"
				aria-label="Expand all"
			>
				<ChevronsUpDown class="size-3.5" />
			</Button>

			<Button
				size="icon"
				variant="ghost"
				class="size-7 text-muted-foreground hover:text-foreground"
				onclick={handleCollapseAll}
				title="Collapse all folders"
				aria-label="Collapse all"
			>
				<ChevronsDownUp class="size-3.5" />
			</Button>

			<Button
				size="icon"
				variant="ghost"
				class="size-7 text-muted-foreground hover:text-foreground"
				onclick={handleRefresh}
				disabled={isLoading}
				title="Refresh workspace tree"
				aria-label="Refresh"
			>
				<RefreshCw class="size-3.5 {isLoading ? 'animate-spin text-primary' : ''}" />
			</Button>

			<Button
				size="icon"
				variant={isTerminalOpen ? 'secondary' : 'ghost'}
				class="size-7 {isTerminalOpen
					? 'text-emerald-500 bg-emerald-500/10'
					: 'text-muted-foreground hover:text-foreground'}"
				onclick={() => terminalStore.toggleOpen()}
				title={isTerminalOpen ? 'Hide terminal' : 'Open terminal'}
				aria-label="Toggle terminal"
			>
				<Terminal class="size-3.5 {isTerminalRunning ? 'animate-pulse text-amber-500' : ''}" />
			</Button>

			{#if onClose}
				<Button
					size="icon"
					variant="ghost"
					class="size-7 text-muted-foreground hover:text-foreground ml-1"
					onclick={onClose}
					title="Close workspace"
					aria-label="Close"
				>
					<X class="size-3.5" />
				</Button>
			{/if}
		</div>
	</header>

	<!-- Mobile / Compact View Switcher Tab Bar -->
	{#if !treeOnly}
		<div class="flex sm:hidden border-b border-border/40 bg-muted/10 shrink-0 px-2 pt-1 gap-1">
			<button
				type="button"
				class="flex-1 py-1.5 px-3 text-xs font-medium rounded-t-md transition-colors border-b-2 {activeTab ===
				'tree'
					? 'border-primary text-foreground bg-background'
					: 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => (activeTab = 'tree')}
			>
				Files ({treeNodes.length})
			</button>
			<button
				type="button"
				class="flex-1 py-1.5 px-3 text-xs font-medium rounded-t-md transition-colors border-b-2 {activeTab ===
				'viewer'
					? 'border-primary text-foreground bg-background'
					: 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => (activeTab = 'viewer')}
			>
				{#if workspaceStore.diffPayload}
					Diff ({workspaceStore.diffPayload.filePath.split('/').pop()})
				{:else}
					Preview {isSelected ? `(${workspaceStore.selectedPath?.split('/').pop()})` : ''}
				{/if}
			</button>
			<button
				type="button"
				class="flex-1 py-1.5 px-3 text-xs font-medium rounded-t-md transition-colors border-b-2 {activeTab ===
				'terminal'
					? 'border-primary text-foreground bg-background'
					: 'border-transparent text-muted-foreground hover:text-foreground'}"
				onclick={() => {
					activeTab = 'terminal';
					terminalStore.openTerminal();
				}}
			>
				Terminal {isTerminalRunning ? '●' : ''}
			</button>
		</div>
	{/if}

	<!-- Main Workspace Splitter Pane -->
	<div
		class="flex-1 {treeOnly ? 'flex flex-col' : 'grid grid-cols-1 sm:grid-cols-2'} overflow-hidden min-h-0 {!treeOnly && activeTab ===
		'terminal'
			? 'hidden sm:grid'
			: ''}"
	>
		<!-- Left: Tree Pane -->
		<div
			class="flex flex-col h-full overflow-hidden {treeOnly ? 'w-full' : 'border-r border-border/40'} {!treeOnly && activeTab === 'tree'
				? 'flex'
				: treeOnly ? 'flex' : 'hidden sm:flex'}"
		>
			<!-- Filter Search Bar -->
			<div class="p-2 border-b border-border/30 bg-background shrink-0">
				<div class="relative flex items-center">
					<Search class="absolute left-2.5 size-3.5 text-muted-foreground pointer-events-none" />
					<Input
						type="search"
						bind:value={searchQuery}
						placeholder="Filter files..."
						class="h-8 pl-8 pr-8 text-xs bg-muted/20"
					/>
					{#if searchQuery}
						<button
							type="button"
							class="absolute right-2 text-muted-foreground hover:text-foreground p-0.5 rounded transition-colors"
							onclick={() => (searchQuery = '')}
							aria-label="Clear filter"
						>
							<X class="size-3.5" />
						</button>
					{/if}
				</div>
			</div>

			<!-- Error Banner -->
			{#if workspaceStore.error}
				<div
					class="m-2 p-2.5 rounded-md bg-destructive/10 border border-destructive/30 text-destructive text-xs flex items-start gap-2 shrink-0"
					data-testid="workspace-error-banner"
				>
					<AlertTriangle class="size-4 shrink-0 mt-0.5" />
					<div class="flex-1 min-w-0">
						<p class="font-medium leading-tight">Failed to load workspace</p>
						<p class="text-[11px] text-destructive/80 mt-0.5 break-words">{workspaceStore.error}</p>
					</div>
					<Button
						variant="outline"
						size="sm"
						class="h-6 text-[10px] px-2 border-destructive/30 hover:bg-destructive/20 text-destructive shrink-0"
						onclick={handleRefresh}
					>
						Retry
					</Button>
				</div>
			{/if}

			<!-- Scrollable Tree Container -->
			<div
				class="flex-1 overflow-y-auto p-2 space-y-0.5"
				role="tree"
				aria-label="Workspace file tree"
			>
				{#if isLoading && treeNodes.length === 0}
					<div class="flex flex-col items-center justify-center h-48 gap-2 text-xs text-muted-foreground">
						<Loader2 class="size-5 animate-spin text-primary" />
						<span>Scanning workspace...</span>
					</div>
				{:else if displayedTree.length === 0}
					<div class="flex flex-col items-center justify-center h-48 text-center p-4 text-muted-foreground">
						<FileCode class="size-8 opacity-30 mb-2" />
						<p class="text-xs font-medium text-foreground/70">
							{searchQuery ? 'No matching files found' : (workspaceStore.error ? 'Workspace scan failed' : 'No workspace files detected')}
						</p>
						<p class="text-[11px] text-muted-foreground/60 mt-1">
							{searchQuery ? 'Try clearing your filter search' : 'Click refresh to scan the workspace'}
						</p>
					</div>
				{:else}
					{#each displayedTree as node (node.id)}
						<WorkspaceTreeNode {node} level={0} />
					{/each}
				{/if}
			</div>
		</div>

		<!-- Right: File Viewer / Diff Viewer Pane -->
		{#if !treeOnly}
			<div class="h-full overflow-hidden {activeTab === 'viewer' ? 'flex' : 'hidden sm:flex'}">
				{#if workspaceStore.diffPayload}
					<WorkspaceDiffViewer
						filePath={workspaceStore.diffPayload.filePath}
						originalContent={workspaceStore.diffPayload.originalContent}
						modifiedContent={workspaceStore.diffPayload.modifiedContent}
						initialMode={workspaceStore.diffPayload.viewMode ?? 'unified'}
						onClose={() => workspaceStore.clearDiff()}
						class="w-full h-full"
					/>
				{:else}
					<WorkspaceFileViewer class="w-full h-full" />
				{/if}
			</div>
		{/if}
	</div>

	<!-- Bottom Collapsible Terminal Pane -->
	{#if !treeOnly}
		{#if isTerminalOpen}
			<div
				class="h-60 border-t border-border/40 shrink-0 {activeTab === 'terminal'
					? 'flex flex-1 sm:flex-initial'
					: 'hidden sm:flex'}"
			>
				<WorkspaceTerminal class="w-full h-full" onClose={() => terminalStore.closeTerminal()} />
			</div>
		{:else if activeTab === 'terminal'}
			<div class="flex-1 flex sm:hidden">
				<WorkspaceTerminal
					class="w-full h-full"
					onClose={() => {
						terminalStore.closeTerminal();
						activeTab = 'tree';
					}}
				/>
			</div>
		{/if}
	{/if}
</div>
