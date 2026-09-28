<script lang="ts">
	interface Props {
		direction?: 'horizontal' | 'vertical';
		onResize?: (delta: number) => void;
		onResizeEnd?: () => void;
		class?: string;
		disabled?: boolean;
		ariaLabel?: string;
	}

	let {
		ariaLabel,
		class: className = '',
		direction = 'horizontal',
		disabled = false,
		onResize,
		onResizeEnd
	}: Props = $props();

	let isDragging = $state(false);
	let lastCoord = $state(0);
	let splitterEl = $state<HTMLDivElement | null>(null);

	function handlePointerDown(e: PointerEvent) {
		if (disabled || e.button !== 0) return;

		e.preventDefault();
		isDragging = true;
		lastCoord = direction === 'horizontal' ? e.clientX : e.clientY;

		const target = e.currentTarget as HTMLElement;
		if (target && target.setPointerCapture) {
			try {
				target.setPointerCapture(e.pointerId);
			} catch {
				// Fallback if pointer capture is unsupported in test/mock environment
			}
		}

		window.addEventListener('pointermove', handlePointerMove);
		window.addEventListener('pointerup', handlePointerUp);
		window.addEventListener('pointercancel', handlePointerUp);
	}

	function handlePointerMove(e: PointerEvent) {
		if (!isDragging) return;

		const currentCoord = direction === 'horizontal' ? e.clientX : e.clientY;
		const delta = currentCoord - lastCoord;

		if (delta !== 0) {
			lastCoord = currentCoord;
			onResize?.(delta);
		}
	}

	function handlePointerUp(e: PointerEvent) {
		if (!isDragging) return;

		isDragging = false;

		const target = splitterEl;
		if (target && target.releasePointerCapture) {
			try {
				target.releasePointerCapture(e.pointerId);
			} catch {
				// No-op
			}
		}

		window.removeEventListener('pointermove', handlePointerMove);
		window.removeEventListener('pointerup', handlePointerUp);
		window.removeEventListener('pointercancel', handlePointerUp);

		onResizeEnd?.();
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (disabled) return;

		const step = e.shiftKey ? 30 : 10;
		if (direction === 'horizontal') {
			if (e.key === 'ArrowLeft') {
				e.preventDefault();
				onResize?.(-step);
				onResizeEnd?.();
			} else if (e.key === 'ArrowRight') {
				e.preventDefault();
				onResize?.(step);
				onResizeEnd?.();
			}
		} else {
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				onResize?.(-step);
				onResizeEnd?.();
			} else if (e.key === 'ArrowDown') {
				e.preventDefault();
				onResize?.(step);
				onResizeEnd?.();
			}
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	bind:this={splitterEl}
	role="separator"
	tabindex={disabled ? -1 : 0}
	aria-orientation={direction}
	aria-label={ariaLabel || (direction === 'horizontal' ? 'Resize columns' : 'Resize rows')}
	aria-disabled={disabled}
	onpointerdown={handlePointerDown}
	onkeydown={handleKeyDown}
	class="workbench-splitter select-none relative group transition-colors shrink-0 {direction ===
	'horizontal'
		? 'w-1.5 h-full cursor-col-resize'
		: 'h-1.5 w-full cursor-row-resize'} {disabled ? 'pointer-events-none opacity-40' : ''} {className}"
	data-testid="workbench-splitter"
	data-direction={direction}
	data-dragging={isDragging}
>
	<!-- Central hairline indicator -->
	<div
		class="absolute inset-0 m-auto transition-colors duration-150 {direction === 'horizontal'
			? 'w-[2px] h-full'
			: 'h-[2px] w-full'} {isDragging
			? 'bg-primary'
			: 'bg-border/60 group-hover:bg-primary/70'}"
	></div>
</div>
