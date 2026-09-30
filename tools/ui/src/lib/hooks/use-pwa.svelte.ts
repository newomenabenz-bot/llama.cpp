import { browser } from '$app/environment';
import { BUILD_VERSION_LOCALSTORAGE_KEY, SW_CONFIG } from '$lib/constants';
import { versionStore } from '$lib/stores';
import { useRegisterSW } from 'virtual:pwa-register/svelte';
import { writable, type Writable } from 'svelte/store';

function canRegisterServiceWorker(): boolean {
	if (!browser) return false;
	if (typeof window === 'undefined') return false;
	if (!('serviceWorker' in navigator)) return false;
	try {
		return Boolean(
			window.isSecureContext ||
			window.location.hostname === 'localhost' ||
			window.location.hostname === '127.0.0.1'
		);
	} catch {
		return false;
	}
}

/**
 * Hook for PWA service worker registration, update polling, and build version mismatch detection.
 *
 * Combines two concerns that always belong together:
 * 1. SW registration with periodic polling for updates
 * 2. localStorage-based version tracking for non-PWA users
 */
export function usePwa() {
	let swCheckInterval: ReturnType<typeof setInterval> | null = null;
	let needRefreshByStorage = $state(false);

	let pwaNeedRefresh: Writable<boolean> = writable(false);
	let updateServiceWorker: (reloadPage?: boolean) => Promise<void> = async () => {};

	if (canRegisterServiceWorker()) {
		try {
			const reg = useRegisterSW({
				onRegisteredSW(swUrl: string, r: ServiceWorkerRegistration | undefined) {
					if (swCheckInterval) {
						clearInterval(swCheckInterval);
					}

					swCheckInterval = setInterval(async () => {
						if (!r || r.installing || !navigator?.onLine) return;

						try {
							const resp = await fetch(swUrl, {
								cache: SW_CONFIG.UPDATE_FETCH_OPTIONS.CACHE,
								headers: {
									cache: SW_CONFIG.UPDATE_FETCH_OPTIONS.HEADERS.CACHE,
									'cache-control': SW_CONFIG.UPDATE_FETCH_OPTIONS.HEADERS.CACHE_CONTROL
								}
							});

							if (resp?.status === 200) {
								await r.update();
							}
						} catch (e) {
							console.error(e);
						}
					}, SW_CONFIG.CHECK_INTERVAL_MS);
				},
				onRegisterError(error: unknown) {
					console.warn('[PWA] SW registration safely skipped or rejected:', error);
				}
			});

			pwaNeedRefresh = reg.needRefresh;
			updateServiceWorker = reg.updateServiceWorker;
		} catch (error) {
			console.warn('[PWA] Service Worker registration failed (insecure or unsupported context):', error);
		}
	} else {
		console.info('[PWA] Service Worker registration skipped: insecure non-localhost context');
	}

	// Detect version mismatch via localStorage.
	// _app/version.json is SvelteKit's native version file for PWA cache invalidation.
	// This comparison detects server upgrades for non-PWA users.
	$effect(() => {
		if (!browser) return;

		// PWA pages update via the service worker path; the storage check is the non-PWA fallback only
		if (navigator.serviceWorker?.controller) return;

		const currentVersion = versionStore.frontend;

		if (!currentVersion) return;

		try {
			const storedVersion = localStorage.getItem(BUILD_VERSION_LOCALSTORAGE_KEY);

			needRefreshByStorage = !!storedVersion && storedVersion !== currentVersion;
			localStorage.setItem(BUILD_VERSION_LOCALSTORAGE_KEY, currentVersion);
		} catch {
			needRefreshByStorage = false;
		}
	});

	return {
		/** Writable that is true when a PWA service worker update is available */
		get needRefresh() {
			return pwaNeedRefresh;
		},
		/** Version mismatch detected via localStorage (non-PWA users) */
		get needRefreshByStorage() {
			return needRefreshByStorage;
		},
		updateServiceWorker
	};
}
