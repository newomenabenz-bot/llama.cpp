/**
 * Context Budget and History Pruning Contracts for OMENA Workbench.
 */

export interface ContextBudgetConfig {
	/** Context window ceiling in tokens (e.g. 4096, 8192, 32768, 1000000) */
	maxTokens: number;
	/** Ratio of maxTokens triggering compaction of historical tool results (default: 0.75) */
	warningThreshold: number;
	/** Ratio of maxTokens triggering aggressive context budgeting (default: 0.90) */
	criticalThreshold: number;
	/** Maximum character ceiling for a single historical tool output before compaction (default: 4000) */
	maxToolOutputChars: number;
	/** Leading lines preserved during head/tail tool compaction (default: 30) */
	headLinesPreserved: number;
	/** Trailing lines preserved during head/tail tool compaction (default: 30) */
	tailLinesPreserved: number;
}

export const DEFAULT_CONTEXT_BUDGET_CONFIG: ContextBudgetConfig = {
	maxTokens: 32768,
	warningThreshold: 0.75,
	criticalThreshold: 0.9,
	maxToolOutputChars: 4000,
	headLinesPreserved: 30,
	tailLinesPreserved: 30
};

export interface CompactionResult {
	compacted: boolean;
	originalChars: number;
	finalChars: number;
	text: string;
}

export interface TokenEstimation {
	totalTokens: number;
	messageCount: number;
	isWarning: boolean;
	isCritical: boolean;
}
