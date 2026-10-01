import type { DraftStage } from '../agent/types';
import type { RapidFireBatch, RapidFireItem } from './types';

type Listener = () => void;

let batchCounter = 0;
const newBatchId = (): string => `rf-${Date.now().toString(36)}-${(batchCounter++).toString(36)}`;

/**
 * In-memory store of every Rapid Fire batch this plugin session has created — mirrors
 * `DraftQueue`'s shape (lives on the plugin, pub/sub via `onChange`) so the Controls view and the
 * Rapid Fire view stay in sync without depending on each other. Not persisted across an Obsidian
 * restart: a Rapid Fire batch is a working session, not a durable record — once items are accepted
 * they're written to the control notes themselves, which ARE durable.
 */
export class RapidFireStore {
	private batches: RapidFireBatch[] = [];
	private listeners = new Set<Listener>();

	list(): RapidFireBatch[] {
		return [...this.batches];
	}

	get(id: string): RapidFireBatch | undefined {
		return this.batches.find((b) => b.id === id);
	}

	/** Every (control, stage) pair currently in an active (not completed/cancelled) batch — used to warn about/prevent duplicate exports (FR-8.1). */
	activeKeys(): Set<string> {
		const keys = new Set<string>();
		for (const b of this.batches) {
			if (b.status === 'completed' || b.status === 'cancelled') continue;
			for (const item of b.items) keys.add(`${item.controlNumber}:${item.stage}`);
		}
		return keys;
	}

	create(controls: { controlNumber: string; stages: DraftStage[] }[], filtersSummary: string): RapidFireBatch {
		const items: RapidFireItem[] = controls.flatMap((c) => c.stages.map((stage): RapidFireItem => ({
			controlNumber: c.controlNumber,
			stage,
			state: 'queued',
			batchId: '',
			escalated: false,
		})));
		const batch: RapidFireBatch = {
			id: newBatchId(),
			createdAt: new Date().toISOString(),
			filtersSummary,
			status: 'queued',
			pauseReason: null,
			items,
			similarityBatches: [],
			evidenceMaps: [],
			estimate: null,
			usage: [],
			boostedUsageUsd: 0,
		};
		this.batches.push(batch);
		this.notify();
		return batch;
	}

	remove(id: string): void {
		const before = this.batches.length;
		this.batches = this.batches.filter((b) => b.id !== id);
		if (this.batches.length !== before) this.notify();
	}

	/** Called by the engine/view after any mutation to a batch already in the store — re-notifies listeners since batches are mutated in place rather than replaced. */
	touch(): void {
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
