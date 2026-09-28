<script lang="ts">
	import { AlertTriangle, Play, Shield, Trash2, Wrench } from '@lucide/svelte';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { conversationsStore } from '$lib/stores/conversations/index.svelte';
	import { WorkbenchRecoveryCoordinator } from '../persistence/recovery.coordinator';
	import type { AgentCheckpoint } from '../persistence/types';

	interface Props {
		class?: string;
	}

	let { class: className = '' }: Props = $props();

	let isResuming = $state(false);
	let revision = $state(0);

	let activeConvId = $derived(conversationsStore.activeConversation?.id ?? '');

	// Reactively read recovery status using activeConvId and revision trigger
	let recoveryStatus = $derived.by(() => {
		// touch revision to allow manual re-evaluation on events
		void revision;
		if (!activeConvId) {
			return { checkpoint: null as AgentCheckpoint | null, recoverable: false };
		}
		return WorkbenchRecoveryCoordinator.checkRecoveryStatus(activeConvId);
	});

	let isRecoverable = $derived(recoveryStatus.recoverable);
	let checkpoint = $derived(recoveryStatus.checkpoint);

	// Subscribe to coordinator events (resume/discard) to force reactive refresh
	$effect(() => {
		const unsubscribe = WorkbenchRecoveryCoordinator.subscribe((convId) => {
			if (convId === activeConvId || !convId) {
				revision++;
			}
		});

		return () => {
			unsubscribe();
		};
	});

	async function handleResume() {
		if (!activeConvId || isResuming) return;
		isResuming = true;
		try {
			await WorkbenchRecoveryCoordinator.resumeSession(activeConvId);
		} catch (err) {
			console.error('[SessionRecoveryBanner] Resumption failed:', err);
		} finally {
			isResuming = false;
			revision++;
		}
	}

	function handleDiscard() {
		if (!activeConvId) return;
		WorkbenchRecoveryCoordinator.discardSession(activeConvId);
		revision++;
	}
</script>

{#if isRecoverable && checkpoint}
	<aside
		class="relative overflow-hidden rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 shadow-sm backdrop-blur-sm transition-all {className}"
		data-testid="session-recovery-banner"
		aria-label="Interrupted session recovery"
	>
		<div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<!-- Info section -->
			<div class="flex items-start gap-3">
				<div class="mt-0.5 rounded-lg bg-amber-500/20 p-2 text-amber-500">
					<AlertTriangle class="size-5" />
				</div>
				<div class="space-y-1">
					<div class="flex flex-wrap items-center gap-2">
						<h4 class="text-sm font-semibold text-foreground">
							Interrupted Agent Session Detected (Turn {checkpoint.turn} of {checkpoint.maxTurns})
						</h4>
						<Badge
							variant="outline"
							class="text-xs font-medium uppercase {checkpoint.executionMode === 'AUTONOMOUS'
								? 'border-purple-500/40 text-purple-400 bg-purple-500/10'
								: checkpoint.executionMode === 'ASSISTED'
									? 'border-amber-500/40 text-amber-400 bg-amber-500/10'
									: 'border-emerald-500/40 text-emerald-400 bg-emerald-500/10'}"
						>
							<Shield class="mr-1 size-3" />
							{checkpoint.executionMode}
						</Badge>
					</div>

					<p class="text-xs text-muted-foreground">
						{#if checkpoint.pendingToolCalls.length > 0}
							<span class="inline-flex items-center gap-1 font-medium text-amber-400/90">
								<Wrench class="size-3" />
								{checkpoint.pendingToolCalls.length} pending tool call(s)
							</span>
							awaiting execution.
						{:else if checkpoint.state === 'AWAITING_PERMISSION'}
							Suspended awaiting user permission.
						{:else}
							Interrupted during execution.
						{/if}
						You can safely resume execution or discard the uncompleted run.
					</p>
				</div>
			</div>

			<!-- Action buttons -->
			<div class="flex items-center gap-2 sm:self-center">
				<Button
					size="sm"
					variant="outline"
					class="h-8 gap-1.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
					onclick={handleDiscard}
					disabled={isResuming}
				>
					<Trash2 class="size-3.5" />
					Discard Run
				</Button>

				<Button
					size="sm"
					class="h-8 gap-1.5 bg-amber-500 text-xs font-medium text-zinc-950 hover:bg-amber-400"
					onclick={handleResume}
					disabled={isResuming}
				>
					<Play class="size-3.5 fill-current" />
					{isResuming ? 'Resuming...' : 'Resume Execution'}
				</Button>
			</div>
		</div>
	</aside>
{/if}
