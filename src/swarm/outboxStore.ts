import type { ApplyOutcome, ApprovalDecision, ReviewProposal } from '../agent/types';

export interface OutboxEntry {
	id: string;
	agentId: string;
	proposal: ReviewProposal;
	addedAt: number;
	decided: boolean;
}

type Listener = () => void;

let counter = 0;
const newId = (): string => `outbox-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/**
 * The swarm's outbox: every writer's finished `ReviewProposal` lands here instead of an inline chat
 * card, so the user reviews everything the whole pool produced in one place. `add()` returns the
 * same kind of pending promise the interactive chat's proposal card does — resolved only once the
 * outbox view's own Approve/Reject UI decides, which is exactly what `createBackgroundHost`'s
 * `requestApproval` needs to stay a genuine gate (nothing is written to a control note until this
 * resolves). In-memory only, same lifetime as `DraftQueue`/`RapidFireStore` — a reload just means
 * nothing was written yet, since nothing here has been approved.
 */
export class OutboxStore {
	private entries: OutboxEntry[] = [];
	private resolvers = new Map<string, (decision: ApprovalDecision) => void>();
	private outcomes = new Map<string, ApplyOutcome[]>();
	private listeners = new Set<Listener>();

	list(): OutboxEntry[] {
		return [...this.entries];
	}

	get size(): number {
		return this.entries.filter((e) => !e.decided).length;
	}

	add(agentId: string, proposal: ReviewProposal): { id: string; decision: Promise<ApprovalDecision> } {
		const entry: OutboxEntry = { id: newId(), agentId, proposal, addedAt: Date.now(), decided: false };
		this.entries.push(entry);
		this.notify();
		const decision = new Promise<ApprovalDecision>((resolve) => {
			this.resolvers.set(entry.id, (d) => {
				entry.decided = true;
				resolve(d);
				this.notify();
			});
		});
		return { id: entry.id, decision };
	}

	/** Called by the outbox view once the user has decided every item in an entry. */
	decide(id: string, decision: ApprovalDecision): void {
		this.resolvers.get(id)?.(decision);
		this.resolvers.delete(id);
	}

	/** Called by `createBackgroundHost`'s `reportApplied` once the approved items have actually been written — lets the outbox view show Saved/Failed per item. */
	reportOutcomes(id: string, outcomes: ApplyOutcome[]): void {
		this.outcomes.set(id, outcomes);
		this.notify();
	}

	outcomesFor(id: string): ApplyOutcome[] | undefined {
		return this.outcomes.get(id);
	}

	remove(id: string): void {
		const before = this.entries.length;
		this.entries = this.entries.filter((e) => e.id !== id);
		if (this.entries.length !== before) this.notify();
	}

	clear(): void {
		if (this.entries.length === 0) return;
		this.entries = [];
		this.notify();
	}

	onChange(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => { this.listeners.delete(fn); };
	}

	private notify(): void {
		for (const fn of this.listeners) fn();
	}
}
