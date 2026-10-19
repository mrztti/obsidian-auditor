import type AuditorPlugin from '../main';
import { ControlStore } from '../agent/controlStore';
import { AgentMemoryStore } from '../agent/memory';
import type { AgentBus, AgentMessage } from './bus';
import { TaskQueue } from './taskQueue';

export interface SimilarControl {
	number: string;
	standard: string;
	topic: string;
	control: string;
	todRating: string;
	toeRating: string;
}

export const CONTROLS_READER_ID = 'controls-reader';

/**
 * A specialist reader for "what existing controls already cover this" — unlike `ReaderAgent`
 * (chunked vector search over evidence/standards), this wraps `ControlStore.find()`/`.load()` so a
 * writer gets back structured prior-art: control numbers, their requirement text, and their current
 * ratings, not raw text snippets. Lets a writer match the wording/structure/rating pattern of
 * similar already-written controls rather than drafting a topic in isolation.
 */
export class ControlsReaderAgent {
	readonly agentId = CONTROLS_READER_ID;
	readonly memory: AgentMemoryStore;
	readonly tasks = new TaskQueue<string>();
	private unsubscribe: (() => void) | null = null;

	constructor(private plugin: AuditorPlugin, private bus: AgentBus) {
		this.memory = new AgentMemoryStore(plugin, this.agentId);
	}

	start(): void {
		this.unsubscribe = this.bus.subscribe((msg) => {
			if (msg.to === this.agentId && msg.kind === 'request') void this.handle(msg);
		});
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	/** One-paragraph status for the graph view — see `graphView.ts`'s per-node summary panel. */
	getSummary(): string {
		const tasks = this.tasks.list();
		const done = tasks.filter((t) => t.status === 'done').length;
		const recent = tasks.slice(-3).map((t) => `"${t.payload}" (${t.status})`).join(', ') || 'no requests yet';
		return `Looks up existing written controls by topic so writers can match prior-art wording/structure/ratings. Handled ${done} of ${tasks.length} request(s) so far. Recent: ${recent}.`;
	}

	private async search(topic: string): Promise<SimilarControl[]> {
		const controls = new ControlStore(this.plugin);
		const { matches } = await controls.find(topic, {}, 10);
		return matches.map((m) => {
			const r = m.entry.record;
			return { number: r.number, standard: r.standard, topic: r.topic, control: r.control, todRating: r.todRating, toeRating: r.toeRating };
		});
	}

	private async handle(msg: AgentMessage): Promise<void> {
		const { topic } = (msg.payload ?? {}) as { topic?: string };
		if (!topic || !msg.correlationId) return;
		const task = this.tasks.add(topic);
		this.bus.event(this.agentId, msg.from, { status: 'searching', topic }, `Searching: ${topic}`);

		try {
			const controls = await this.search(topic);
			this.tasks.setStatus(task.id, 'done');
			this.bus.event(this.agentId, msg.from, { status: 'idle', topic, resultCount: controls.length }, `Found ${controls.length} control(s)`);
			this.bus.respond(msg.correlationId, this.agentId, { controls }, { resultCount: controls.length });
		} catch (e) {
			this.tasks.setStatus(task.id, 'failed', e instanceof Error ? e.message : String(e));
			this.bus.respond(msg.correlationId, this.agentId, { controls: [] });
		}
	}
}
