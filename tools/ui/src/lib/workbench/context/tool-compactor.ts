/**
 * Tool output compaction logic for OMENA Autonomous Workbench.
 *
 * Implements symmetric head/tail preservation for oversized tool execution outputs,
 * preventing context overflow while preserving essential logs, headers, and exit statuses.
 */

import { DEFAULT_CONTEXT_BUDGET_CONFIG, type CompactionResult, type ContextBudgetConfig } from './types';

export function compactToolOutput(
	content: string,
	options?: Partial<ContextBudgetConfig>
): CompactionResult {
	if (!content) {
		return {
			compacted: false,
			finalChars: 0,
			originalChars: 0,
			text: ''
		};
	}

	const maxChars = options?.maxToolOutputChars ?? DEFAULT_CONTEXT_BUDGET_CONFIG.maxToolOutputChars;
	const headLinesPreserved =
		options?.headLinesPreserved ?? DEFAULT_CONTEXT_BUDGET_CONFIG.headLinesPreserved;
	const tailLinesPreserved =
		options?.tailLinesPreserved ?? DEFAULT_CONTEXT_BUDGET_CONFIG.tailLinesPreserved;

	const originalChars = content.length;

	// Content fits comfortably within the budget ceiling
	if (originalChars <= maxChars) {
		return {
			compacted: false,
			finalChars: originalChars,
			originalChars,
			text: content
		};
	}

	const lines = content.split(/\r?\n/);

	// Multi-line output with enough lines to perform line-based head/tail compaction
	if (lines.length > headLinesPreserved + tailLinesPreserved) {
		const headLines = lines.slice(0, headLinesPreserved);
		const tailLines = lines.slice(lines.length - tailLinesPreserved);

		const headText = headLines.join('\n');
		const tailText = tailLines.join('\n');

		const omittedLines = lines.length - headLinesPreserved - tailLinesPreserved;
		const omittedChars = originalChars - (headText.length + tailText.length);

		const text = `${headText}\n\n... [Workbench: ${omittedLines} lines (${omittedChars} chars) omitted for context budget] ...\n\n${tailText}`;

		return {
			compacted: true,
			finalChars: text.length,
			originalChars,
			text
		};
	}

	// Single-line or sparse line output exceeding character limit (e.g. minified code or huge JSON)
	const half = Math.max(100, Math.floor((maxChars - 100) / 2));
	const headChunk = content.slice(0, half);
	const tailChunk = content.slice(content.length - half);
	const omittedChars = originalChars - (headChunk.length + tailChunk.length);

	const text = `${headChunk}\n\n... [Workbench: 0 lines (${omittedChars} chars) omitted for context budget] ...\n\n${tailChunk}`;

	return {
		compacted: true,
		finalChars: text.length,
		originalChars,
		text
	};
}
