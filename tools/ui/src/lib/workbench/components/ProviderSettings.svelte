<script lang="ts">
	import { onMount } from 'svelte';
	import {
		AlertTriangle,
		Check,
		Cpu,
		ExternalLink,
		Eye,
		EyeOff,
		Folder,
		Key,
		Loader2,
		RotateCcw,
		Shield,
		ShieldAlert,
		ShieldCheck,
		Sparkles
	} from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { WorkbenchSettingsService } from '../settings/workbench-settings.service';
	import {
		verifyAndFetchGeminiModels,
		type DiscoveredGeminiModel
	} from '../providers/gemini.provider';
	import type { ExecutionMode } from '../security/types';

	let activeProvider = $state<'llama-server' | 'gemini'>(
		WorkbenchSettingsService.getActiveProviderId()
	);
	let apiKey = $state<string>(WorkbenchSettingsService.getGeminiApiKey());
	let selectedModel = $state<string>(
		WorkbenchSettingsService.getSelectedGeminiModel() || WorkbenchSettingsService.getGeminiModel()
	);
	let executionMode = $state<ExecutionMode>(WorkbenchSettingsService.getExecutionMode());
	let workspaceRoot = $state<string>(
		WorkbenchSettingsService.getWorkspaceRoot() || '/home/ubuntu'
	);
	let showApiKey = $state<boolean>(false);
	let saveNotice = $state<boolean>(false);

	const initialCachedModels = WorkbenchSettingsService.getCachedGeminiModels();
	let availableModels = $state<Array<{ id: string; displayName: string; description?: string }>>(
		initialCachedModels.length > 0 ? initialCachedModels : []
	);
	let isChecking = $state<boolean>(false);
	let connectionStatus = $state<'idle' | 'success' | 'error'>(
		initialCachedModels.length > 0 ? 'success' : 'idle'
	);
	let apiErrorMessage = $state<string | null>(null);
	let apiErrorCode = $state<string | null>(null);
	let customModelInput = $state<string>('');
	let isCustomModelMode = $state<boolean>(false);

	// Check if selectedModel is a custom model not in discovered models
	$effect(() => {
		if (selectedModel && availableModels.length > 0 && !availableModels.some((m) => m.id === selectedModel)) {
			customModelInput = selectedModel;
			isCustomModelMode = true;
		}
	});

	let isConfigured = $derived(Boolean(apiKey.trim()));

	onMount(() => {
		// 1. Read getCachedGeminiModels() and populate availableModels immediately
		const cached = WorkbenchSettingsService.getCachedGeminiModels();
		if (cached && cached.length > 0) {
			availableModels = cached;
			connectionStatus = 'success';
		}

		// 2. Read getSelectedGeminiModel() and set dropdown selection
		const savedModel = WorkbenchSettingsService.getSelectedGeminiModel();
		if (savedModel) {
			selectedModel = savedModel;
		}

		// 3. Ensure workspaceRoot binds to /home/ubuntu if empty
		const currentRoot = WorkbenchSettingsService.getWorkspaceRoot();
		if (currentRoot) {
			workspaceRoot = currentRoot;
		} else {
			workspaceRoot = '/home/ubuntu';
		}

		// 4. If an API key is present but no cache exists, run verification automatically in the background
		if (apiKey.trim() && (!cached || cached.length === 0)) {
			void handleCheckConnection();
		}
	});

	async function handleCheckConnection() {
		const key = apiKey.trim();
		if (!key) {
			connectionStatus = 'error';
			apiErrorCode = 'API_KEY_REQUIRED';
			apiErrorMessage = 'API key cannot be empty';
			return;
		}

		isChecking = true;
		connectionStatus = 'idle';
		apiErrorMessage = null;
		apiErrorCode = null;

		try {
			const result = await verifyAndFetchGeminiModels(key);
			if (result.success) {
				connectionStatus = 'success';
				availableModels = result.models;
				apiErrorMessage = null;
				apiErrorCode = null;

				// 1. Save discovered models array to cache
				WorkbenchSettingsService.saveCachedGeminiModels(result.models);
				WorkbenchSettingsService.setGeminiApiKey(key);

				// 2. If no model previously selected, default to first viable model
				if (result.models.length > 0 && !isCustomModelMode) {
					const hasCurrent = selectedModel && result.models.some((m) => m.id === selectedModel);
					if (!hasCurrent) {
						const flashModel = result.models.find((m) => m.id.includes('flash')) || result.models[0];
						selectedModel = flashModel.id;
					}
					WorkbenchSettingsService.saveSelectedGeminiModel(selectedModel);
					WorkbenchSettingsService.setGeminiModel(selectedModel);
				}
				showSaveFeedback();
			} else {
				connectionStatus = 'error';
				availableModels = [];
				apiErrorCode = result.error?.code || (result.error?.status ? `HTTP_${result.error.status}` : 'API_ERROR');
				apiErrorMessage = result.error?.message || 'Failed to authenticate with Google API';
			}
		} catch (err: unknown) {
			connectionStatus = 'error';
			availableModels = [];
			apiErrorCode = 'NETWORK_ERROR';
			apiErrorMessage = err instanceof Error ? err.message : 'Network error: Unable to reach Google API endpoint';
		} finally {
			isChecking = false;
		}
	}

	function selectProvider(provider: 'llama-server' | 'gemini') {
		activeProvider = provider;
		WorkbenchSettingsService.setActiveProviderId(provider);
		showSaveFeedback();
	}

	function handleApiKeyInput(e: Event) {
		const target = e.target as HTMLInputElement;
		const oldKey = apiKey;
		apiKey = target.value;
		WorkbenchSettingsService.setGeminiApiKey(apiKey);
		if (apiKey !== oldKey) {
			connectionStatus = 'idle';
			apiErrorMessage = null;
			apiErrorCode = null;
		}
		showSaveFeedback();
	}

	function handleModelSelect(e: Event) {
		const target = e.target as HTMLSelectElement;
		const val = target.value;
		if (val === '__custom__') {
			isCustomModelMode = true;
			if (!customModelInput) {
				customModelInput = selectedModel;
			}
		} else {
			isCustomModelMode = false;
			selectedModel = val;
			WorkbenchSettingsService.saveSelectedGeminiModel(selectedModel);
			WorkbenchSettingsService.setGeminiModel(selectedModel);
			showSaveFeedback();
		}
	}

	function handleCustomModelInput(e: Event) {
		const target = e.target as HTMLInputElement;
		customModelInput = target.value.trim();
		if (customModelInput) {
			selectedModel = customModelInput;
			WorkbenchSettingsService.saveSelectedGeminiModel(selectedModel);
			WorkbenchSettingsService.setGeminiModel(selectedModel);
			showSaveFeedback();
		}
	}

	function handleSaveSettings() {
		const key = apiKey.trim();
		WorkbenchSettingsService.setGeminiApiKey(key);
		if (selectedModel) {
			WorkbenchSettingsService.saveSelectedGeminiModel(selectedModel);
			WorkbenchSettingsService.setGeminiModel(selectedModel);
		}
		showSaveFeedback();
	}

	function selectExecutionMode(mode: ExecutionMode) {
		executionMode = mode;
		WorkbenchSettingsService.setExecutionMode(mode);
		showSaveFeedback();
	}

	function handleWorkspaceRootInput(e: Event) {
		const target = e.target as HTMLInputElement;
		workspaceRoot = target.value;
		WorkbenchSettingsService.setWorkspaceRoot(workspaceRoot);
		showSaveFeedback();
	}

	function resetWorkspaceRoot() {
		WorkbenchSettingsService.setWorkspaceRoot('/home/ubuntu');
		workspaceRoot = '/home/ubuntu';
		showSaveFeedback();
	}

	function showSaveFeedback() {
		saveNotice = true;
		setTimeout(() => {
			saveNotice = false;
		}, 2000);
	}
</script>

<div class="space-y-6">
	<!-- Model Provider Configuration Card -->
	<div class="rounded-xl border border-border/60 bg-card p-5 text-card-foreground shadow-xs">
		<!-- Header -->
		<div class="flex items-center justify-between pb-4 border-b border-border/40">
			<div class="flex items-center gap-2.5">
				<div class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
					{#if activeProvider === 'gemini'}
						<Sparkles class="h-4 w-4 text-amber-500" />
					{:else}
						<Cpu class="h-4 w-4 text-primary" />
					{/if}
				</div>
				<div>
					<h3 class="text-sm font-semibold tracking-tight">Model Provider</h3>
					<p class="text-xs text-muted-foreground">Select inference engine for chat and agentic reasoning</p>
				</div>
			</div>

			{#if activeProvider === 'gemini'}
				<Badge
					variant={isConfigured ? 'default' : 'secondary'}
					class={isConfigured
						? 'bg-emerald-600 text-white hover:bg-emerald-600'
						: 'bg-amber-500/20 text-amber-600 dark:text-amber-400'}
				>
					{isConfigured ? 'Key Configured' : 'API Key Required'}
				</Badge>
			{:else}
				<Badge variant="outline" class="bg-muted/40 font-normal">
					Local llama-server
				</Badge>
			{/if}
		</div>

		<!-- Provider Selection Buttons -->
		<div class="mt-4 grid grid-cols-2 gap-2.5">
			<button
				type="button"
				class="flex flex-col items-start gap-1 rounded-lg border p-3.5 text-left transition-all {activeProvider ===
				'llama-server'
					? 'border-primary bg-primary/5 ring-1 ring-primary/40'
					: 'border-border/60 hover:bg-muted/40'}"
				onclick={() => selectProvider('llama-server')}
			>
				<div class="flex w-full items-center justify-between">
					<span class="flex items-center gap-1.5 text-xs font-semibold">
						<Cpu class="h-3.5 w-3.5 text-muted-foreground" />
						llama-server (Local)
					</span>
					{#if activeProvider === 'llama-server'}
						<Check class="h-3.5 w-3.5 text-primary" />
					{/if}
				</div>
				<span class="text-[11px] text-muted-foreground line-clamp-2">
					Upstream local C++ server (/v1/chat/completions)
				</span>
			</button>

			<button
				type="button"
				class="flex flex-col items-start gap-1 rounded-lg border p-3.5 text-left transition-all {activeProvider ===
				'gemini'
					? 'border-primary bg-primary/5 ring-1 ring-primary/40'
					: 'border-border/60 hover:bg-muted/40'}"
				onclick={() => selectProvider('gemini')}
			>
				<div class="flex w-full items-center justify-between">
					<span class="flex items-center gap-1.5 text-xs font-semibold">
						<Sparkles class="h-3.5 w-3.5 text-amber-500" />
						Google Gemini
					</span>
					{#if activeProvider === 'gemini'}
						<Check class="h-3.5 w-3.5 text-primary" />
					{/if}
				</div>
				<span class="text-[11px] text-muted-foreground line-clamp-2">
					Google DeepMind models with native thinking & tools
				</span>
			</button>
		</div>

		<!-- Gemini Specific Configuration Fields -->
		{#if activeProvider === 'gemini'}
			<div class="mt-5 space-y-4 rounded-lg bg-muted/20 border border-border/40 p-4">
				<!-- API Key Input & Check Connection Button -->
				<div>
					<div class="flex items-center justify-between mb-1.5">
						<label for="gemini-api-key" class="text-xs font-medium flex items-center gap-1.5">
							<Key class="h-3.5 w-3.5 text-muted-foreground" />
							Gemini API Key
						</label>
						<a
							href="https://aistudio.google.com/app/apikey"
							target="_blank"
							rel="noopener noreferrer"
							class="text-[11px] text-primary hover:underline flex items-center gap-1"
						>
							Get API key <ExternalLink class="h-2.5 w-2.5" />
						</a>
					</div>
					<div class="flex gap-2 items-center">
						<div class="relative flex-1">
							<Input
								id="gemini-api-key"
								type={showApiKey ? 'text' : 'password'}
								placeholder="AIzaSy..."
								value={apiKey}
								oninput={handleApiKeyInput}
								class="pr-10 font-mono text-xs"
							/>
							<Button
								type="button"
								variant="ghost"
								size="sm"
								class="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
								onclick={() => (showApiKey = !showApiKey)}
							>
								{#if showApiKey}
									<EyeOff class="h-3.5 w-3.5" />
								{:else}
									<Eye class="h-3.5 w-3.5" />
								{/if}
							</Button>
						</div>
						<Button
							type="button"
							variant="default"
							class="shrink-0 h-9 text-xs px-3 font-medium flex items-center gap-1.5"
							disabled={isChecking || !apiKey.trim()}
							onclick={handleCheckConnection}
						>
							{#if isChecking}
								<Loader2 class="h-3.5 w-3.5 animate-spin" />
								<span>Checking...</span>
							{:else}
								<Sparkles class="h-3.5 w-3.5 text-amber-300" />
								<span>Check Connection</span>
							{/if}
						</Button>
					</div>

					<!-- Real-Time Status / Error Banners -->
					{#if connectionStatus === 'success' && availableModels.length > 0}
						<div
							class="mt-2.5 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 text-xs flex items-center justify-between gap-2"
							data-testid="gemini-connection-success"
						>
							<div class="flex items-center gap-2">
								<Check class="h-4 w-4 shrink-0 text-emerald-500" />
								<span class="font-medium">
									✓ Discovered {availableModels.length} active models.
								</span>
							</div>
							<Badge
								variant="outline"
								class="border-emerald-500/40 text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-500/10"
							>
								{availableModels.length} Live Models Verified
							</Badge>
						</div>
					{:else if connectionStatus === 'error'}
						<div
							class="mt-2.5 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-destructive text-xs flex items-start gap-2.5"
							data-testid="gemini-connection-error"
						>
							<AlertTriangle class="h-4 w-4 shrink-0 mt-0.5 text-destructive" />
							<div class="flex-1 min-w-0">
								<p class="font-semibold text-xs leading-tight">
									✕ Connection Failed ({apiErrorCode || 'API_ERROR'}):
								</p>
								<p class="text-[11px] text-destructive/90 mt-1 break-words font-mono">
									{apiErrorMessage}
								</p>
							</div>
						</div>
					{/if}

					<p class="text-[11px] text-muted-foreground mt-1.5">
						Stored securely in your local browser storage. Never transmitted to third-party servers.
					</p>
				</div>

				<!-- Dynamic Gemini Model Selector -->
				<div>
					<div class="flex items-center justify-between mb-1.5">
						<label for="gemini-model-select" class="text-xs font-medium flex items-center gap-1.5">
							<Sparkles class="h-3.5 w-3.5 text-amber-500" />
							Default Gemini Model
						</label>
						{#if connectionStatus === 'success' && availableModels.length > 0}
							<Badge variant="outline" class="text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
								{availableModels.length} Live Models
							</Badge>
						{/if}
					</div>

					<select
						id="gemini-model-select"
						value={isCustomModelMode ? '__custom__' : selectedModel}
						onchange={handleModelSelect}
						disabled={availableModels.length === 0 && !isCustomModelMode}
						class="w-full rounded-md border border-input bg-background px-3 py-2 text-xs shadow-xs focus:outline-hidden focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{#if availableModels.length === 0}
							<option value="" disabled selected>No models available — verify API key first</option>
						{:else}
							{#each availableModels as model}
								<option value={model.id}>
									{model.displayName} ({model.id})
								</option>
							{/each}
						{/if}
						<option value="__custom__">⚙ Auto / Custom Model Identifier...</option>
					</select>

					{#if availableModels.length > 0}
						<p class="text-[10px] text-muted-foreground mt-1">
							{availableModels.length} active models returned by Google Generative Language API
						</p>
					{:else if connectionStatus !== 'error'}
						<p class="text-[10px] text-muted-foreground mt-1">
							Click "Check Connection" above to verify your key and discover available models.
						</p>
					{/if}

					<!-- Auto / Custom Model Input -->
					{#if isCustomModelMode}
						<div class="mt-2.5 space-y-1">
							<label for="gemini-custom-model" class="text-[11px] font-medium text-foreground/80 block">
								Auto / Custom Model Identifier
							</label>
							<Input
								id="gemini-custom-model"
								type="text"
								placeholder="e.g., gemini-2.0-flash-exp, gemini-exp-1206"
								value={customModelInput || selectedModel}
								oninput={handleCustomModelInput}
								class="font-mono text-xs h-8"
							/>
							<p class="text-[10px] text-muted-foreground">
								Directly specify any cutting-edge or experimental Google model identifier.
							</p>
						</div>
					{/if}
				</div>

				<!-- Explicit Save Settings Action -->
				<div class="pt-3 flex items-center justify-between border-t border-border/30">
					<Button
						type="button"
						variant="default"
						size="sm"
						class="h-8 px-3 text-xs font-medium flex items-center gap-1.5"
						onclick={handleSaveSettings}
					>
						<Check class="h-3.5 w-3.5" />
						<span>Save Settings</span>
					</Button>
					{#if saveNotice}
						<span class="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-medium">
							<Check class="h-3.5 w-3.5" />
							Settings saved
						</span>
					{/if}
				</div>
			</div>
		{/if}
	</div>

	<!-- Security Policy & Execution Mode Card -->
	<div class="rounded-xl border border-border/60 bg-card p-5 text-card-foreground shadow-xs">
		<!-- Header -->
		<div class="flex items-center justify-between pb-4 border-b border-border/40">
			<div class="flex items-center gap-2.5">
				<div class="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
					{#if executionMode === 'AUTONOMOUS'}
						<ShieldAlert class="h-4 w-4 text-amber-500" />
					{:else if executionMode === 'ASSISTED'}
						<ShieldCheck class="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
					{:else}
						<Shield class="h-4 w-4 text-blue-500" />
					{/if}
				</div>
				<div>
					<h3 class="text-sm font-semibold tracking-tight">Security & Autonomy Policy</h3>
					<p class="text-xs text-muted-foreground">Configure agentic execution permissions and sandbox guardrails</p>
				</div>
			</div>

			<Badge
				variant="outline"
				class={executionMode === 'AUTONOMOUS'
					? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
					: executionMode === 'ASSISTED'
						? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
						: 'border-blue-500/40 bg-blue-500/10 text-blue-600 dark:text-blue-400'}
			>
				{executionMode} MODE
			</Badge>
		</div>

		<!-- Mode Selection Grid -->
		<div class="mt-4 grid grid-cols-1 md:grid-cols-3 gap-2.5">
			<!-- SAFE Mode -->
			<button
				type="button"
				class="flex flex-col items-start gap-1 rounded-lg border p-3.5 text-left transition-all {executionMode ===
				'SAFE'
					? 'border-blue-500 bg-blue-500/5 ring-1 ring-blue-500/40'
					: 'border-border/60 hover:bg-muted/40'}"
				onclick={() => selectExecutionMode('SAFE')}
			>
				<div class="flex w-full items-center justify-between">
					<span class="flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400">
						<Shield class="h-3.5 w-3.5" />
						SAFE
					</span>
					{#if executionMode === 'SAFE'}
						<Check class="h-3.5 w-3.5 text-blue-500" />
					{/if}
				</div>
				<span class="text-[11px] text-muted-foreground line-clamp-3">
					Prompt on every tool call. Shell commands strictly blocked. Maximum verification.
				</span>
			</button>

			<!-- ASSISTED Mode -->
			<button
				type="button"
				class="flex flex-col items-start gap-1 rounded-lg border p-3.5 text-left transition-all {executionMode ===
				'ASSISTED'
					? 'border-emerald-500 bg-emerald-500/5 ring-1 ring-emerald-500/40'
					: 'border-border/60 hover:bg-muted/40'}"
				onclick={() => selectExecutionMode('ASSISTED')}
			>
				<div class="flex w-full items-center justify-between">
					<span class="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
						<ShieldCheck class="h-3.5 w-3.5" />
						ASSISTED
					</span>
					{#if executionMode === 'ASSISTED'}
						<Check class="h-3.5 w-3.5 text-emerald-500" />
					{/if}
				</div>
				<span class="text-[11px] text-muted-foreground line-clamp-3">
					Auto-approve read tools. Prompt once for file writes per session. Medium shell prompts.
				</span>
			</button>

			<!-- AUTONOMOUS Mode -->
			<button
				type="button"
				class="flex flex-col items-start gap-1 rounded-lg border p-3.5 text-left transition-all {executionMode ===
				'AUTONOMOUS'
					? 'border-amber-500 bg-amber-500/5 ring-1 ring-amber-500/40'
					: 'border-border/60 hover:bg-muted/40'}"
				onclick={() => selectExecutionMode('AUTONOMOUS')}
			>
				<div class="flex w-full items-center justify-between">
					<span class="flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
						<ShieldAlert class="h-3.5 w-3.5" />
						AUTONOMOUS
					</span>
					{#if executionMode === 'AUTONOMOUS'}
						<Check class="h-3.5 w-3.5 text-amber-500" />
					{/if}
				</div>
				<span class="text-[11px] text-muted-foreground line-clamp-3">
					Full auto-execution in workspace. Critical system commands & traversal hard-blocked.
				</span>
			</button>
		</div>

		<!-- Workspace Sandbox Boundary Configuration -->
		<div class="mt-5 space-y-2 rounded-lg bg-muted/20 border border-border/40 p-4">
			<div class="flex items-center justify-between mb-1">
				<label for="workbench-workspace-root" class="text-xs font-medium flex items-center gap-1.5">
					<Folder class="h-3.5 w-3.5 text-muted-foreground" />
					Workspace Sandbox Boundary
				</label>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					class="h-6 px-2 text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
					onclick={resetWorkspaceRoot}
				>
					<RotateCcw class="h-3 w-3" />
					Reset to Default
				</Button>
			</div>

			<Input
				id="workbench-workspace-root"
				type="text"
				placeholder="/home/ubuntu"
				value={workspaceRoot || '/home/ubuntu'}
				oninput={handleWorkspaceRootInput}
				class="font-mono text-xs"
			/>

			<p class="text-[11px] text-muted-foreground">
				All filesystem operations and path validations are strictly sandboxed within this root directory across all execution modes (defaults to /home/ubuntu).
			</p>
		</div>

		{#if saveNotice}
			<div class="mt-4 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
				<Check class="h-3.5 w-3.5" />
				<span>Workbench settings saved</span>
			</div>
		{/if}
	</div>
</div>
