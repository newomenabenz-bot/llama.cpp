/**
 * WorkbenchDiffService - Diff Calculation & Format Translation Service
 *
 * Wraps upstream computeLineDiff to provide:
 * - Line-level diff calculation
 * - Change metrics (additions, deletions, modifications, isClean)
 * - Canonical git-compatible unified patch generation
 * - Aligned side-by-side split row mapping
 */

import { DiffLineKind } from '$lib/enums';
import {
	computeLineDiff,
	prefixFor,
	renderUnifiedDiff,
	type DiffLine
} from '$lib/utils/compute-line-diff';
import type { DiffStats, SplitDiffRow, SplitDiffSide } from './types';

export class WorkbenchDiffService {
	/**
	 * Computes line-level unified diff between original and modified text.
	 */
	static computeDiff(originalText: string, modifiedText: string): DiffLine[] {
		return computeLineDiff(originalText ?? '', modifiedText ?? '');
	}

	/**
	 * Computes aggregated statistics from diff lines.
	 */
	static getDiffStats(diffLines: DiffLine[]): DiffStats {
		let additions = 0;
		let deletions = 0;

		for (const line of diffLines) {
			if (line.kind === DiffLineKind.ADD) {
				additions++;
			} else if (line.kind === DiffLineKind.REMOVE) {
				deletions++;
			}
		}

		return {
			additions,
			deletions,
			isClean: additions === 0 && deletions === 0,
			modifications: Math.min(additions, deletions)
		};
	}

	/**
	 * Formats a canonical git-compatible unified diff patch string.
	 */
	static generateUnifiedDiffText(
		filePath: string,
		original: string,
		modified: string
	): string {
		const diffLines = this.computeDiff(original, modified);
		const stats = this.getDiffStats(diffLines);

		if (stats.isClean) {
			return '';
		}

		const origLines = (original ? original.split('\n').length : 0);
		const modLines = (modified ? modified.split('\n').length : 0);
		const normPath = filePath.replace(/\\/g, '/');

		const header = [
			`--- a/${normPath}`,
			`+++ b/${normPath}`,
			`@@ -1,${origLines} +1,${modLines} @@`
		].join('\n');

		const unifiedBody = renderUnifiedDiff(diffLines);
		return `${header}\n${unifiedBody}`;
	}

	/**
	 * Converts linear DiffLine array into aligned side-by-side rows for split mode rendering.
	 */
	static computeSplitRows(diffLines: DiffLine[]): SplitDiffRow[] {
		const rows: SplitDiffRow[] = [];
		let i = 0;

		while (i < diffLines.length) {
			const line = diffLines[i];

			if (line.kind === DiffLineKind.CONTEXT) {
				rows.push({
					left: {
						kind: 'context',
						lineNum: line.oldLine,
						text: line.text
					},
					right: {
						kind: 'context',
						lineNum: line.newLine,
						text: line.text
					}
				});
				i++;
				continue;
			}

			// Gather all consecutive non-context lines (both REMOVE and ADD)
			const removes: DiffLine[] = [];
			const adds: DiffLine[] = [];
			while (i < diffLines.length && diffLines[i].kind !== DiffLineKind.CONTEXT) {
				if (diffLines[i].kind === DiffLineKind.REMOVE) {
					removes.push(diffLines[i]);
				} else if (diffLines[i].kind === DiffLineKind.ADD) {
					adds.push(diffLines[i]);
				}
				i++;
			}

			// Pair them side by side
			const maxCount = Math.max(removes.length, adds.length);
			for (let k = 0; k < maxCount; k++) {
				const rem = removes[k];
				const add = adds[k];

				const leftSide: SplitDiffSide = rem
					? { kind: 'remove', lineNum: rem.oldLine, text: rem.text }
					: { kind: 'empty', text: '' };

				const rightSide: SplitDiffSide = add
					? { kind: 'add', lineNum: add.newLine, text: add.text }
					: { kind: 'empty', text: '' };

				rows.push({
					left: leftSide,
					right: rightSide
				});
			}
		}

		return rows;
	}
}

export { prefixFor };
