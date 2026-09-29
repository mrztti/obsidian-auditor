/** A control's Stage 1 or Stage 2 conclusion, queued up to be written by the chat agent. */
export type DraftStage = 'stage1' | 'stage2';

export interface DraftQueueItem {
	id: string;
	controlNumber: string;
	/** Denormalized at add time so the queue panel and the launch prompt still read fine if the control is edited or renamed before the queue is launched. */
	topic: string;
	stage: DraftStage;
	/** Extra instructions the user typed for this item specifically — folded into the launch prompt alongside it. */
	note: string;
	addedAt: number;
}

type Listener = () => void;

function generateId(): string {
	return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Shared, in-memory queue of drafting targets: filled from the Controls view's "Add to queue"
 * buttons, reviewed (per-item notes, delete) and launched from the chat panel's queue drawer.
 * Lives on the plugin, not either view, so both see the same list without depending on each
 * other. Cleared whenever the chat launches it — the agent's own plan/activity log then carries
 * the work forward, so there's no need to track "in progress" queue state here too.
 */
export class DraftQueue {
	private items: DraftQueueItem[] = [];
	private listeners = new Set<Listener>();

	list(): DraftQueueItem[] {
		return [...this.items];
	}

	get size(): number {
		return this.items.length;
	}

	has(controlNumber: string, stage: DraftStage): boolean {
		return this.items.some((i) => i.controlNumber === controlNumber && i.stage === stage);
	}

	/** No-ops if this (control, stage) pair is already queued, so repeated clicks don't pile up duplicates. */
	add(controlNumber: string, topic: string, stage: DraftStage): void {
		if (this.has(controlNumber, stage)) return;
		this.items.push({ id: generateId(), controlNumber, topic, stage, note: '', addedAt: Date.now() });
		this.notify();
	}

	remove(id: string): void {
		const before = this.items.length;
		this.items = this.items.filter((i) => i.id !== id);
		if (this.items.length !== before) this.notify();
	}

	/** Removes the item for this (control, stage) pair, if queued — the counterpart to `add`, for the Controls view's toggle button. */
	removeByControl(controlNumber: string, stage: DraftStage): void {
		const before = this.items.length;
		this.items = this.items.filter((i) => !(i.controlNumber === controlNumber && i.stage === stage));
		if (this.items.length !== before) this.notify();
	}

	clear(): void {
		if (this.items.length === 0) return;
		this.items = [];
		this.notify();
	}

	setNote(id: string, note: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) item.note = note;
	}

	onChange(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => { this.listeners.delete(fn); };
	}

	private notify(): void {
		for (const fn of this.listeners) fn();
	}
}
