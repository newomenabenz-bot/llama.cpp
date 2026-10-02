<script lang="ts">
	import { ArrowRight, Server, Settings } from '@lucide/svelte';
	import { ServerStatus } from '$lib/components/app';
	import { Button } from '$lib/components/ui/button';
	import { serverStore } from '$lib/stores';
	import { fade } from 'svelte/transition';
	import { onMount } from 'svelte';

	interface Props {
		class?: string;
		message?: string;
	}

	let { class: className = '', message = 'Initializing connection to server...' }: Props = $props();

	let showFallback = $state(false);

	onMount(() => {
		const timer = setTimeout(() => {
			showFallback = true;
		}, 2500);

		// Hard safety release: ensure loading screen never locks the user out permanently
		const hardReleaseTimer = setTimeout(() => {
			if (serverStore.loading) {
				console.warn('[ServerLoadingSplash] Safety timeout reached (6s); releasing splash screen');
				serverStore.loading = false;
			}
		}, 6000);

		return () => {
			clearTimeout(timer);
			clearTimeout(hardReleaseTimer);
		};
	});

	function handleContinue() {
		serverStore.loading = false;
	}

	function handleOpenSettings() {
		serverStore.loading = false;
		if (typeof window !== 'undefined') {
			window.dispatchEvent(new CustomEvent('open-settings'));
		}
	}
</script>

<div class="flex h-full items-center justify-center {className}">
	<div class="text-center max-w-sm px-4">
		<div in:fade={{ duration: 300 }} class="mb-4">
			<div class="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
				<Server class="h-8 w-8 animate-pulse text-muted-foreground" />
			</div>

			<h2 class="mb-2 text-xl font-semibold">Connecting to Server</h2>

			<p class="text-sm text-muted-foreground">
				{message}
			</p>
		</div>

		<div class="mt-4">
			<ServerStatus class="justify-center" />
		</div>

		{#if showFallback}
			<div in:fade={{ duration: 200 }} class="mt-6 flex flex-col items-center gap-2.5">
				<Button
					variant="default"
					class="w-full font-medium"
					onclick={handleContinue}
				>
					<ArrowRight class="mr-2 h-4 w-4" />
					Continue to Workbench
				</Button>

				<Button
					variant="outline"
					class="w-full text-xs"
					onclick={() => (serverStore.loading = false)}
				>
					Continue Offline / Configure Providers
				</Button>

				<Button
					variant="ghost"
					size="sm"
					class="text-xs text-muted-foreground hover:text-foreground"
					onclick={handleOpenSettings}
				>
					<Settings class="mr-1.5 h-3.5 w-3.5" />
					Open Settings
				</Button>
			</div>
		{/if}
	</div>
</div>
