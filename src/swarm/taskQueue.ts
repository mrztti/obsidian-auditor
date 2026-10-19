export type TaskStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface QueuedTask<T> {
	id: string;
	payload: T;
	status: TaskStatus;
	addedAt: number;
	error?: string;
}

type Listener = () => void;

let counter = 0;
const newId = (): string => `task-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/**
 * One agent's own work queue — same listenable, addressable shape as `agent/draftQueue.ts`'s
 * drafting queue, generalized to an arbitrary payload so every swarm role (not just "draft this
 * control") can use it. An agent drains its own queue one task at a time; the bus/orchestrator only
 * ever appends to it.
 */
export class TaskQueue<T> {
	private items: QueuedTask<T>[] = [];
	private listeners = new Set<Listener>();

	list(): QueuedTask<T>[] {
		return [...this.items];
	}

	get size(): number {
		return this.items.length;
	}

	get pendingCount(): number {
		return this.items.filter((i) => i.status === 'pending').length;
	}

	add(payload: T): QueuedTask<T> {
		const task: QueuedTask<T> = { id: newId(), payload, status: 'pending', addedAt: Date.now() };
		this.items.push(task);
		this.notify();
		return task;
	}

	/** The next not-yet-started task, or null if the queue is empty/everything is already in progress. */
	nextPending(): QueuedTask<T> | null {
		return this.items.find((i) => i.status === 'pending') ?? null;
	}

	setStatus(id: string, status: TaskStatus, error?: string): void {
		const item = this.items.find((i) => i.id === id);
		if (!item) return;
		item.status = status;
		item.error = error;
		this.notify();
	}

	remove(id: string): void {
		const before = this.items.length;
		this.items = this.items.filter((i) => i.id !== id);
		if (this.items.length !== before) this.notify();
	}

	clear(): void {
		if (this.items.length === 0) return;
		this.items = [];
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
