/**
 * Security types, schemas, and policy definitions for OMENA Autonomous Workbench.
 */

export type ExecutionMode = 'SAFE' | 'ASSISTED' | 'AUTONOMOUS';

export type CommandRisk = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type PolicyAction = 'ALLOW' | 'PROMPT' | 'DENY';

export interface PathValidationResult {
	allowed: boolean;
	normalizedPath: string;
	reason?: string;
}

export interface CommandClassificationResult {
	risk: CommandRisk;
	reason?: string;
}

export interface PolicyDecision {
	action: PolicyAction;
	reason: string;
	risk: CommandRisk;
	targetPath?: string;
	sanitizedCommand?: string;
}

export interface PolicyContext {
	mode: ExecutionMode;
	workspaceRoot?: string;
	conversationId?: string;
	turn?: number;
	maxAutonomousTurns?: number;
	sessionApprovedTools?: Set<string>;
}

export interface AuditReceipt {
	id: string;
	timestamp: number;
	toolName: string;
	args: Record<string, unknown>;
	mode: ExecutionMode;
	decision: PolicyAction;
	reason: string;
	risk: CommandRisk;
	executionTimeMs?: number;
	status?: 'SUCCESS' | 'ERROR' | 'DENIED' | 'PENDING';
}
