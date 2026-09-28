/**
 * Audit Store - In-memory / Reactive Audit Receipt Ring Buffer.
 *
 * Tracks every tool evaluation, security policy decision, execution time,
 * and completion status for security auditing and transparency.
 */

import type { AuditReceipt } from './types';

const DEFAULT_MAX_RECEIPTS = 500;

export class AuditStore {
	private maxCapacity: number;
	private receipts: AuditReceipt[] = [];
	private listeners = new Set<() => void>();

	constructor(maxCapacity: number = DEFAULT_MAX_RECEIPTS) {
		this.maxCapacity = maxCapacity;
	}

	/**
	 * Subscribes to changes in the audit store (new receipt, status change, or clear).
	 */
	subscribe(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private notify(): void {
		for (const fn of this.listeners) {
			try {
				fn();
			} catch (err) {
				console.warn('[AuditStore] Listener error:', err);
			}
		}
	}

	/**
	 * Records a new audit receipt into the ring buffer.
	 */
	recordReceipt(entry: Omit<AuditReceipt, 'id' | 'timestamp'>): AuditReceipt {
		const receipt: AuditReceipt = {
			id: `audit_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
			timestamp: Date.now(),
			...entry,
			status: entry.status ?? (entry.decision === 'DENY' ? 'DENIED' : 'PENDING')
		};

		this.receipts.unshift(receipt);

		if (this.receipts.length > this.maxCapacity) {
			this.receipts.pop();
		}

		this.notify();
		return receipt;
	}

	/**
	 * Updates the status or execution duration of a previously recorded receipt.
	 */
	updateReceiptStatus(
		id: string,
		status: NonNullable<AuditReceipt['status']>,
		executionTimeMs?: number
	): boolean {
		const receipt = this.receipts.find((r) => r.id === id);
		if (!receipt) {
			return false;
		}

		receipt.status = status;
		if (executionTimeMs !== undefined) {
			receipt.executionTimeMs = executionTimeMs;
		}

		this.notify();
		return true;
	}

	/**
	 * Retrieves all receipts currently in the ring buffer (ordered newest to oldest).
	 */
	getReceipts(): AuditReceipt[] {
		return [...this.receipts];
	}

	/**
	 * Retrieves a receipt by its unique ID.
	 */
	getReceiptById(id: string): AuditReceipt | undefined {
		return this.receipts.find((r) => r.id === id);
	}

	/**
	 * Clears the audit buffer.
	 */
	clear(): void {
		this.receipts = [];
		this.notify();
	}

	/**
	 * Alias for clear().
	 */
	clearReceipts(): void {
		this.clear();
	}

	/**
	 * Alias for getReceiptById().
	 */
	getReceipt(id: string): AuditReceipt | undefined {
		return this.getReceiptById(id);
	}

	/**
	 * Returns the total count of receipts in buffer.
	 */
	size(): number {
		return this.receipts.length;
	}
}

export const auditStore = new AuditStore();
