<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import {
		Activity,
		Code2,
		Columns,
		FileCode,
		FolderTree,
		GitCompare,
		Maximize2,
		MessageSquare,
		Minimize2,
		PanelBottom,
		PanelLeft,
		PanelRight,
		RotateCcw,
		Sparkles,
		Terminal,
		X
	} from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { agenticStore } from '$lib/stores/agentic/index.svelte';
	import { conversationsStore } from '$lib/stores/conversations/index.svelte';
	import { modelsStore } from '$lib/stores/models/index.svelte';
	import { WorkbenchAgentCheckpointService } from '../persistence/checkpoint.service';
	import { WorkbenchRecoveryCoordinator } from '../persistence/recovery.coordinator';
	import { WorkbenchSettingsService } from '../settings/workbench-settings.service';
	import { terminalStore } from '../terminal/terminal.svelte';
	import { workbenchShellStore } from '../shell/shell.svelte';
	import { workspaceStore } from '../workspace/workspace.svelte';
	import AgentObservabilityDeck from './AgentObservabilityDeck.svelte';
	import WorkbenchModeToggle from './WorkbenchModeToggle.svelte';
	import WorkbenchSplitter from './WorkbenchSplitter.svelte';
	import WorkspaceDiffViewer from './WorkspaceDiffViewer.svelte';
	import WorkspaceExplorer from './WorkspaceExplorer.svelte';
	import WorkspaceFileViewer from './WorkspaceFileViewer.svelte';
	import WorkspaceTerminal from './WorkspaceTerminal.svelte';

	interface Props {
		chat?: Snippet;
		class?: string;
		initialInspectorTab?: 'file' | 'diff' | 'activity';
	}

	let { chat, class: className = '', initialInspectorTab }: Props = $props();

	let layoutContainerEl = $state<HTMLDivElement | null>(null);
	let activeMobileTab = $state<'files' | 'chat' | 'inspector' | 'activity' | 'terminal'>('chat');
	let userSelectedInspectorTab = $state<'file' | 'diff' | 'activity' | null>(null);
	let activeInspectorTab = $derived(
		userSelectedInspectorTab ?? initialInspectorTab ?? (workspaceStore.diffPayload ? 'diff' : 'file')
	);

	let leftVisible = $derived(workbenchShellStore.leftPanel.isVisible);
	let rightVisible = $derived(workbenchShellStore.rightPanel.isVisible);
	let bottomVisible = $derived(
		workbenchShellStore.bottomPanel.isVisible || terminalStore.isOpen
	);

	let leftRatio = $derived(workbenchShellStore.leftPanel.sizeRatio);
	let rightRatio = $derived(workbenchShellStore.rightPanel.sizeRatio);
	let bottomRatio = $derived(workbenchShellStore.bottomPanel.sizeRatio);

	let leftWidthPercent = $derived(Math.max(10, Math.min(50, Math.round(leftRatio * 100))));
	let rightWidthPercent = $derived(Math.max(15, Math.min(60, Math.round(rightRatio * 100))));
	let bottomHeightPercent = $derived(Math.max(15, Math.min(60, Math.round(bottomRatio * 100))));

	let isTerminalRunning = $derived(terminalStore.isRunning);
	let hasActiveDiff = $derived(Boolean(workspaceStore.diffPayload));
	let hasSelectedFile = $derived(Boolean(workspaceStore.selectedPath));
	let rootPath = $derived(workspaceStore.rootPath);
	let activeConvId = $derived(conversationsStore.activeConversation?.id ?? '');

	let recoveryRevision = $state(0);

	$effect(() => {
		const unsubscribe = WorkbenchRecoveryCoordinator.subscribe(() => {
			recoveryRevision += 1;
		});
		return unsubscribe;
	});

	// Persistent status summary derivation
	let agentStatusSummary = $derived.by(() => {
		void recoveryRevision;
		const convId = activeConvId;
		if (!convId)
			return {
				bgClass: 'bg-muted/40 text-muted-foreground border-border/50',
				label: 'Agent: Idle'
			};

		const checkpoint = WorkbenchAgentCheckpointService.getCheckpoint(convId);
		if (checkpoint?.state === 'HALTED') {
			return {
				bgClass: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
				label: 'Agent: Halted'
			};
		}
		if (
			checkpoint?.state === 'AWAITING_PERMISSION' ||
			agenticStore.getPendingPermissionRequest(convId)
		) {
			return {
				bgClass: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/30 animate-pulse',
				label: 'Agent: Permission'
			};
		}
		if (agenticStore.isRunning(convId)) {
			if (agenticStore.getStreamingToolCall(convId)) {
				return {
					bgClass: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/30',
					label: 'Agent: Proposing'
				};
			}
			if (agenticStore.getExecutingToolCallId(convId)) {
				return {
					bgClass: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
					label: 'Agent: Executing'
				};
			}
			return {
				bgClass: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30',
				label: 'Agent: Thinking'
			};
		}
		if (checkpoint?.state === 'COMPLETED') {
			return {
				bgClass: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
				label: 'Agent: Completed'
			};
		}
		return {
			bgClass: 'bg-muted/40 text-muted-foreground border-border/50',
			label: 'Agent: Idle'
		};
	});

	let settingsRevision = $state(0);

	$effect(() => {
		const unsubscribe = WorkbenchSettingsService.subscribe(() => {
			untrack(() => {
				settingsRevision += 1;
			});
		});
		return unsubscribe;
	});

	// Active model derivation
	let activeProvider = $derived.by(() => {
		void settingsRevision;
		return WorkbenchSettingsService.getActiveProviderId();
	});

	let activeModelDisplay = $derived.by(() => {
		void settingsRevision;
		if (activeProvider === 'gemini') {
			return (
				modelsStore.selectedModelName ||
				WorkbenchSettingsService.getSelectedGeminiModel() ||
				WorkbenchSettingsService.getGeminiModel() ||
				'gemini-2.5-flash'
			);
		}
		return modelsStore.selectedModelName || 'Default Model';
	});

	// Auto switch inspector tab when file or diff updates
	$effect(() => {
		if (workspaceStore.diffPayload) {
			activeInspectorTab = 'diff';
			if (typeof window !== 'undefined' && window.innerWidth < 1024) {
				activeMobileTab = 'inspector';
			}
		} else if (workspaceStore.selectedPath && activeInspectorTab !== 'activity') {
			activeInspectorTab = 'file';
			if (typeof window !== 'undefined' && window.innerWidth < 1024) {
				activeMobileTab = 'inspector';
			}
		}
	});

	function handleLeftResize(delta: number) {
		if (!layoutContainerEl) return;
		const containerWidth = layoutContainerEl.clientWidth;
		if (containerWidth <= 0) return;

		const deltaRatio = delta / containerWidth;
		const newRatio = Math.max(
			0.1,
			Math.min(0.45, workbenchShellStore.leftPanel.sizeRatio + deltaRatio)
		);
		workbenchShellStore.setPanelRatio('left', newRatio);
	}

	function handleRightResize(delta: number) {
		if (!layoutContainerEl) return;
		const containerWidth = layoutContainerEl.clientWidth;
		if (containerWidth <= 0) return;

		const deltaRatio = -delta / containerWidth;
		const newRatio = Math.max(
			0.15,
			Math.min(0.6, workbenchShellStore.rightPanel.sizeRatio + deltaRatio)
		);
		workbenchShellStore.setPanelRatio('right', newRatio);
	}

	function handleBottomResize(delta: number) {
		if (!layoutContainerEl) return;
		const containerHeight = layoutContainerEl.clientHeight;
		if (containerHeight <= 0) return;

		const deltaRatio = -delta / containerHeight;
		const newRatio = Math.max(
			0.15,
			Math.min(0.65, workbenchShellStore.bottomPanel.sizeRatio + deltaRatio)
		);
		workbenchShellStore.setPanelRatio('bottom', newRatio);
	}

	function toggleLeftPanel() {
		workbenchShellStore.togglePanel('left');
	}

	function toggleRightPanel() {
		workbenchShellStore.togglePanel('right');
	}

	function toggleBottomPanel() {
		if (bottomVisible) {
			workbenchShellStore.setPanelVisibility('bottom', false);
			terminalStore.closeTerminal();
		} else {
			workbenchShellStore.setPanelVisibility('bottom', true);
			terminalStore.openTerminal();
		}
	}

	function closeBottomPanel() {
		workbenchShellStore.setPanelVisibility('bottom', false);
		terminalStore.closeTerminal();
	}

	function resetLayout() {
		workbenchShellStore.reset();
	}

	function openActivityDeck() {
		userSelectedInspectorTab = 'activity';
		workbenchShellStore.setPanelVisibility('right', true);
		activeMobileTab = 'activity';
	}
</script>

<Tooltip.Provider>
	<div
		class="workbench-layout flex flex-col w-full h-[calc(100dvh-1rem)] md:h-[calc(100dvh-1rem-var(--chat-tabs-offset,0px))] overflow-hidden bg-background {className}"
		data-testid="workbench-layout"
	>
		<!-- Workbench Header / Command Bar -->
		<header
			class="workbench-header flex items-center justify-between px-3 h-10 border-b border-border/50 bg-muted/20 shrink-0 select-none"
			data-testid="workbench-header"
		>
			<!-- Left: Workbench brand & pane toggles -->
			<div class="flex items-center gap-2">
				<div class="flex items-center gap-1.5 text-xs font-semibold text-foreground tracking-tight mr-1">
					<Code2 class="size-4 text-amber-500" />
					<span class="hidden sm:inline">Workbench</span>
				</div>

				<Badge variant="outline" class="text-[10px] font-mono px-1.5 py-0 max-w-32 truncate hidden md:inline-flex">
					{rootPath}
				</Badge>

				<!-- Persistent Agent Activity Status Pill -->
				<button
					type="button"
					onclick={openActivityDeck}
					class="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border transition-colors hover:bg-muted/80 cursor-pointer {agentStatusSummary.bgClass}"
					data-testid="header-agent-status-pill"
					title="Open Agent Observability Deck"
				>
					<Activity class="size-3 text-primary shrink-0" />
					<span class="text-[10px] font-semibold">{agentStatusSummary.label}</span>
				</button>

				<!-- Active Model Header Pill -->
				<div
					class="flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border border-border/60 bg-muted/30 text-foreground"
					data-testid="header-active-model-pill"
					title="Active Model: {activeModelDisplay}"
				>
					<Sparkles class="size-3 text-amber-500 shrink-0" />
					<span class="text-[10px] font-semibold max-w-28 sm:max-w-40 truncate">{activeModelDisplay}</span>
				</div>

				<div class="h-4 w-px bg-border/60 mx-1 hidden sm:block"></div>

				<!-- Panel Toggles -->
				<div class="flex items-center gap-1">
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									size="icon"
									variant={leftVisible ? 'secondary' : 'ghost'}
									class="size-7 {leftVisible ? 'bg-primary/10 text-primary' : 'text-muted-foreground'}"
									onclick={toggleLeftPanel}
									aria-label="Toggle File Explorer (Left)"
									data-testid="toggle-left-panel"
								>
									<PanelLeft class="size-3.5" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="bottom" class="text-xs">
							{leftVisible ? 'Hide File Explorer' : 'Show File Explorer'}
						</Tooltip.Content>
					</Tooltip.Root>

					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									size="icon"
									variant={bottomVisible ? 'secondary' : 'ghost'}
									class="size-7 {bottomVisible ? 'bg-emerald-500/10 text-emerald-500' : 'text-muted-foreground'}"
									onclick={toggleBottomPanel}
									aria-label="Toggle Terminal (Bottom)"
									data-testid="toggle-bottom-panel"
								>
									<Terminal class="size-3.5 {isTerminalRunning ? 'animate-pulse text-amber-500' : ''}" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="bottom" class="text-xs">
							{bottomVisible ? 'Hide Terminal' : 'Show Terminal'}
						</Tooltip.Content>
					</Tooltip.Root>

					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									size="icon"
									variant={rightVisible ? 'secondary' : 'ghost'}
									class="size-7 {rightVisible ? 'bg-blue-500/10 text-blue-500' : 'text-muted-foreground'}"
									onclick={toggleRightPanel}
									aria-label="Toggle Code Inspector (Right)"
									data-testid="toggle-right-panel"
								>
									<PanelRight class="size-3.5" />
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content side="bottom" class="text-xs">
							{rightVisible ? 'Hide Code Inspector' : 'Show Code Inspector'}
						</Tooltip.Content>
					</Tooltip.Root>
				</div>
			</div>

			<!-- Right: Layout Reset & Mode Switcher -->
			<div class="flex items-center gap-2">
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								size="icon"
								variant="ghost"
								class="size-7 text-muted-foreground hover:text-foreground"
								onclick={resetLayout}
								aria-label="Reset workbench layout"
								data-testid="reset-layout"
							>
								<RotateCcw class="size-3" />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content side="bottom" class="text-xs">
						Reset Panel Sizing
					</Tooltip.Content>
				</Tooltip.Root>

				<WorkbenchModeToggle />
			</div>
		</header>

		<!-- Mobile / Compact View (< 1024px) -->
		<div class="flex flex-col flex-1 min-h-0 lg:hidden overflow-hidden" data-testid="workbench-mobile-view">
			<!-- Mobile Tab Switcher -->
			<div class="flex items-center border-b border-border/40 bg-muted/10 shrink-0 px-2 pt-1 gap-1">
				<button
					type="button"
					class="flex-1 py-1.5 px-2 text-xs font-medium rounded-t-md transition-colors border-b-2 flex items-center justify-center gap-1.5 {activeMobileTab ===
					'files'
						? 'border-primary text-foreground bg-background'
						: 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeMobileTab = 'files')}
					data-testid="mobile-tab-files"
				>
					<FolderTree class="size-3.5" />
					<span>Files</span>
				</button>

				<button
					type="button"
					class="flex-1 py-1.5 px-2 text-xs font-medium rounded-t-md transition-colors border-b-2 flex items-center justify-center gap-1.5 {activeMobileTab ===
					'chat'
						? 'border-primary text-foreground bg-background'
						: 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeMobileTab = 'chat')}
					data-testid="mobile-tab-chat"
				>
					<MessageSquare class="size-3.5" />
					<span>Chat</span>
				</button>

				<button
					type="button"
					class="flex-1 py-1.5 px-2 text-xs font-medium rounded-t-md transition-colors border-b-2 flex items-center justify-center gap-1.5 {activeMobileTab ===
					'inspector'
						? 'border-primary text-foreground bg-background'
						: 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeMobileTab = 'inspector')}
					data-testid="mobile-tab-inspector"
				>
					{#if hasActiveDiff}
						<GitCompare class="size-3.5 text-amber-500" />
						<span>Diff</span>
					{:else}
						<FileCode class="size-3.5" />
						<span>Inspector</span>
					{/if}
				</button>

				<button
					type="button"
					class="flex-1 py-1.5 px-2 text-xs font-medium rounded-t-md transition-colors border-b-2 flex items-center justify-center gap-1.5 {activeMobileTab ===
					'activity'
						? 'border-primary text-foreground bg-background'
						: 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => (activeMobileTab = 'activity')}
					data-testid="mobile-tab-activity"
				>
					<Activity class="size-3.5 text-primary" />
					<span>Activity</span>
				</button>

				<button
					type="button"
					class="flex-1 py-1.5 px-2 text-xs font-medium rounded-t-md transition-colors border-b-2 flex items-center justify-center gap-1.5 {activeMobileTab ===
					'terminal'
						? 'border-primary text-foreground bg-background'
						: 'border-transparent text-muted-foreground hover:text-foreground'}"
					onclick={() => {
						activeMobileTab = 'terminal';
						terminalStore.openTerminal();
					}}
					data-testid="mobile-tab-terminal"
				>
					<Terminal class="size-3.5" />
					<span>Terminal</span>
					{#if isTerminalRunning}
						<span class="size-1.5 rounded-full bg-amber-500 animate-pulse"></span>
					{/if}
				</button>
			</div>

			<!-- Mobile Pane Contents -->
			<div class="flex-1 min-h-0 overflow-hidden">
				{#if activeMobileTab === 'files'}
					<WorkspaceExplorer class="w-full h-full" />
				{:else if activeMobileTab === 'chat'}
					<div class="w-full h-full overflow-y-auto">
						{@render chat?.()}
					</div>
				{:else if activeMobileTab === 'inspector'}
					<div class="w-full h-full overflow-hidden">
						{#if workspaceStore.diffPayload}
							<WorkspaceDiffViewer
								filePath={workspaceStore.diffPayload.filePath}
								originalContent={workspaceStore.diffPayload.originalContent}
								modifiedContent={workspaceStore.diffPayload.modifiedContent}
								initialMode={workspaceStore.diffPayload.viewMode ?? 'unified'}
								onClose={() => workspaceStore.clearDiff()}
								class="w-full h-full"
							/>
						{:else if workspaceStore.selectedPath}
							<WorkspaceFileViewer class="w-full h-full" />
						{:else}
							<div class="flex flex-col items-center justify-center h-full p-6 text-center text-muted-foreground">
								<FileCode class="size-10 opacity-30 mb-2" />
								<p class="text-sm font-medium text-foreground/80">No file selected</p>
								<p class="text-xs text-muted-foreground/60 mt-1 max-w-sm">
									Select a file from the Files tab or review changes generated by the agent.
								</p>
								<Button
									variant="outline"
									size="sm"
									class="mt-4 text-xs"
									onclick={() => (activeMobileTab = 'files')}
								>
									Go to Files
								</Button>
							</div>
						{/if}
					</div>
				{:else if activeMobileTab === 'activity'}
					<div class="w-full h-full overflow-hidden">
						<AgentObservabilityDeck class="w-full h-full" />
					</div>
				{:else if activeMobileTab === 'terminal'}
					<div class="w-full h-full overflow-hidden">
						<WorkspaceTerminal class="w-full h-full" onClose={() => (activeMobileTab = 'chat')} />
					</div>
				{/if}
			</div>
		</div>

		<!-- Desktop Multi-Pane View (>= 1024px) -->
		<div
			bind:this={layoutContainerEl}
			class="hidden lg:flex flex-col flex-1 min-h-0 w-full overflow-hidden"
			data-testid="workbench-desktop-view"
		>
			<!-- Main Row: Left (Explorer), Center (Chat), Right (Inspector) -->
			<div class="flex flex-1 min-h-0 w-full overflow-hidden" data-testid="workbench-main-row">
				<!-- Left Pane: File Tree Explorer -->
				{#if leftVisible}
					<div
						style="width: {leftWidthPercent}%;"
						class="min-w-[200px] max-w-[450px] h-full overflow-hidden shrink-0 flex flex-col"
						data-testid="workbench-left-pane"
					>
						<WorkspaceExplorer
							treeOnly={true}
							onClose={() => workbenchShellStore.setPanelVisibility('left', false)}
							class="w-full h-full"
						/>
					</div>

					<WorkbenchSplitter
						direction="horizontal"
						ariaLabel="Resize File Explorer"
						onResize={handleLeftResize}
					/>
				{/if}

				<!-- Center Pane: Chat Stage -->
				<div
					class="flex-1 min-w-[320px] h-full overflow-y-auto flex flex-col relative bg-background"
					data-testid="workbench-center-pane"
				>
					{@render chat?.()}
				</div>

				<!-- Right Pane: Code, Diff & Activity Inspector -->
				{#if rightVisible}
					<WorkbenchSplitter
						direction="horizontal"
						ariaLabel="Resize Code Inspector"
						onResize={handleRightResize}
					/>

					<div
						style="width: {rightWidthPercent}%;"
						class="min-w-[280px] max-w-[800px] h-full overflow-hidden shrink-0 flex flex-col border-l border-border/40 bg-background"
						data-testid="workbench-right-pane"
					>
						<!-- Right Pane Header: Tab Switcher: [File View] | [Changes / Diff] | [Agent Activity] -->
						<div class="flex items-center justify-between px-3 py-1.5 border-b border-border/40 bg-muted/20 shrink-0 gap-2 flex-wrap">
							<div class="flex items-center gap-2 min-w-0">
								{#if activeInspectorTab === 'activity'}
									<Activity class="size-3.5 text-primary shrink-0" />
									<span class="text-xs font-semibold text-foreground truncate">Agent Activity</span>
								{:else if activeInspectorTab === 'diff' || hasActiveDiff}
									<GitCompare class="size-3.5 text-amber-500 shrink-0" />
									<span class="text-xs font-semibold text-foreground truncate">Diff Inspector</span>
									{#if workspaceStore.diffPayload}
										<Badge variant="outline" class="text-[10px] px-1 py-0 font-mono truncate max-w-28">
											{workspaceStore.diffPayload.filePath.split('/').pop()}
										</Badge>
									{/if}
								{:else if hasSelectedFile}
									<FileCode class="size-3.5 text-blue-500 shrink-0" />
									<span class="text-xs font-semibold text-foreground truncate">File Viewer</span>
									<Badge variant="outline" class="text-[10px] px-1 py-0 font-mono truncate max-w-28">
										{workspaceStore.selectedPath?.split('/').pop()}
									</Badge>
								{:else}
									<FileCode class="size-3.5 text-muted-foreground shrink-0" />
									<span class="text-xs font-semibold text-foreground truncate">Code Inspector</span>
								{/if}
							</div>

							<!-- Tab Switcher -->
							<div class="flex items-center gap-1">
								<button
									type="button"
									class="px-2 py-0.5 text-xs font-medium rounded transition-colors {activeInspectorTab ===
									'file'
										? 'bg-background text-foreground shadow-xs font-semibold'
										: 'text-muted-foreground hover:text-foreground'}"
									onclick={() => (userSelectedInspectorTab = 'file')}
									data-testid="inspector-tab-file"
								>
									File View
								</button>

								<button
									type="button"
									class="px-2 py-0.5 text-xs font-medium rounded transition-colors flex items-center gap-1 {activeInspectorTab ===
									'diff'
										? 'bg-background text-foreground shadow-xs font-semibold'
										: 'text-muted-foreground hover:text-foreground'}"
									onclick={() => (userSelectedInspectorTab = 'diff')}
									data-testid="inspector-tab-diff"
								>
									<span>Changes / Diff</span>
									{#if hasActiveDiff}
										<span class="size-1.5 rounded-full bg-amber-500"></span>
									{/if}
								</button>

								<button
									type="button"
									class="px-2 py-0.5 text-xs font-medium rounded transition-colors flex items-center gap-1 {activeInspectorTab ===
									'activity'
										? 'bg-background text-foreground shadow-xs font-semibold'
										: 'text-muted-foreground hover:text-foreground'}"
									onclick={() => (userSelectedInspectorTab = 'activity')}
									data-testid="inspector-tab-activity"
								>
									<span>Agent Activity</span>
								</button>
							</div>

							<div class="flex items-center gap-1 shrink-0">
								{#if hasActiveDiff && activeInspectorTab === 'diff'}
									<Button
										size="icon"
										variant="ghost"
										class="size-6 text-muted-foreground hover:text-foreground"
										onclick={() => {
											workspaceStore.clearDiff();
											userSelectedInspectorTab = 'file';
										}}
										title="Close diff view"
									>
										<X class="size-3" />
									</Button>
								{/if}
								<Button
									size="icon"
									variant="ghost"
									class="size-6 text-muted-foreground hover:text-foreground"
									onclick={() => workbenchShellStore.setPanelVisibility('right', false)}
									title="Collapse inspector"
									aria-label="Close inspector"
								>
									<X class="size-3" />
								</Button>
							</div>
						</div>

						<!-- Right Pane Content -->
						<div class="flex-1 min-h-0 overflow-hidden">
							{#if activeInspectorTab === 'activity'}
								<AgentObservabilityDeck class="w-full h-full" />
							{:else if activeInspectorTab === 'diff'}
								{#if workspaceStore.diffPayload}
									<WorkspaceDiffViewer
										filePath={workspaceStore.diffPayload.filePath}
										originalContent={workspaceStore.diffPayload.originalContent}
										modifiedContent={workspaceStore.diffPayload.modifiedContent}
										initialMode={workspaceStore.diffPayload.viewMode ?? 'unified'}
										onClose={() => {
											workspaceStore.clearDiff();
											userSelectedInspectorTab = 'file';
										}}
										class="w-full h-full"
									/>
								{:else}
									<div class="flex flex-col items-center justify-center h-full p-6 text-center text-muted-foreground">
										<GitCompare class="size-12 opacity-25 mb-3" />
										<h4 class="text-xs font-semibold text-foreground/80">Diff Inspector</h4>
										<p class="text-[11px] text-muted-foreground/70 mt-1 max-w-xs leading-relaxed">
											When code modifications are generated by the agent or diff comparisons are requested, the line-by-line diff inspector will render here.
										</p>
									</div>
								{/if}
							{:else if activeInspectorTab === 'file'}
								{#if workspaceStore.selectedPath}
									<WorkspaceFileViewer class="w-full h-full" />
								{:else}
									<div class="flex flex-col items-center justify-center h-full p-6 text-center text-muted-foreground">
										<FileCode class="size-12 opacity-25 mb-3" />
										<h4 class="text-xs font-semibold text-foreground/80">Code Inspector</h4>
										<p class="text-[11px] text-muted-foreground/70 mt-1 max-w-xs leading-relaxed">
											Select any file in the workspace explorer to inspect code with syntax highlighting, or review agent code changes.
										</p>
									</div>
								{/if}
							{/if}
						</div>
					</div>
				{/if}
			</div>

			<!-- Bottom Pane: Terminal Deck -->
			{#if bottomVisible}
				<WorkbenchSplitter
					direction="vertical"
					ariaLabel="Resize Terminal"
					onResize={handleBottomResize}
				/>

				<div
					style="height: {bottomHeightPercent}%;"
					class="min-h-[140px] max-h-[500px] w-full shrink-0 border-t border-border/40 overflow-hidden flex flex-col"
					data-testid="workbench-bottom-pane"
				>
					<WorkspaceTerminal
						class="w-full h-full"
						onClose={closeBottomPanel}
					/>
				</div>
			{/if}
		</div>
	</div>
</Tooltip.Provider>
