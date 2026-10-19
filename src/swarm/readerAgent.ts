import type AuditorPlugin from '../main';
import type { StoreKind } from '../main';
import type { SearchResult } from '../vectorStore';
import { AgentMemoryStore } from '../agent/memory';
import type { AgentBus, AgentMessage } from './bus';
import { TaskQueue } from './taskQueue';

export interface ReaderDocument {
	path: string;
	location: string;
	score: number;
	text: string;
}

const label = (r: SearchResult): string => (r.page !== undefined ? `(p. ${r.page})` : r.line !== undefined ? `(L${r.line})` : '');

/** Max results per store per topic — generous, since the whole point is "list ALL documents, not just one". */
const RESULTS_PER_STORE = 15;

/**
 * A specialist "reader" agent: not a model-driven loop, since its job — "which documents does this
 * topic map to" — is a deterministic retrieval task, not something that benefits from reasoning.
 * Listens on the shared `AgentBus` for requests addressed to its `agentId`, checks its own
 * `topicDocumentMap` memory first (so a repeat request for the same topic is instant and doesn't
 * re-query the vector store), else searches the configured stores and remembers what it found —
 * always returning every matching document, never just the top one.
 */
export class ReaderAgent {
	readonly memory: AgentMemoryStore;
	/** One task per incoming request, titled by topic — lets the graph view show what this reader has handled/is handling without parsing the bus feed. */
	readonly tasks = new TaskQueue<string>();
	private unsubscribe: (() => void) | null = null;

	constructor(private plugin: AuditorPlugin, readonly agentId: string, private storeKinds: StoreKind[], private bus: AgentBus) {
		this.memory = new AgentMemoryStore(plugin, agentId);
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
		return `Searches ${this.storeKinds.join('/')} for topics writers ask about, remembering topic → document mappings so repeats are instant. Handled ${done} of ${tasks.length} request(s) so far. Recent: ${recent}.`;
	}

	private normalizedTopic(topic: string): string {
		return topic.trim().toLowerCase();
	}

	/** Exact-match lookup against this agent's own `topicDocumentMap` memory — a substring match here would risk silently handing a writer the wrong topic's documents. */
	private recall(topic: string): ReaderDocument[] | null {
		const needle = this.normalizedTopic(topic);
		const hit = this.memory.all().find((m) => m.category === 'topicDocumentMap' && !m.supersededBy && m.provenance === needle);
		if (!hit) return null;
		try {
			const parsed = JSON.parse(hit.content) as { documents: ReaderDocument[] };
			return parsed.documents;
		} catch {
			return null;
		}
	}

	private async remember(topic: string, documents: ReaderDocument[]): Promise<void> {
		const needle = this.normalizedTopic(topic);
		const existing = this.memory.all().find((m) => m.category === 'topicDocumentMap' && !m.supersededBy && m.provenance === needle);
		await this.memory.remember(
			'topicDocumentMap',
			JSON.stringify({ documents }),
			needle,
			{ supersedes: existing?.id },
		);
	}

	private async search(topic: string): Promise<ReaderDocument[]> {
		const perStore = await Promise.all(
			this.storeKinds.map((kind) => this.plugin.storeFor(kind).search(topic, RESULTS_PER_STORE).catch(() => [] as SearchResult[])),
		);
		return perStore
			.flat()
			.sort((a, b) => b.score - a.score)
			.map((r) => ({ path: r.sourcePath, location: `${r.sourcePath} ${label(r)}`.trim(), score: r.score, text: r.text }));
	}

	private async handle(msg: AgentMessage): Promise<void> {
		const { topic } = (msg.payload ?? {}) as { topic?: string };
		if (!topic || !msg.correlationId) return;
		const task = this.tasks.add(topic);
		this.bus.event(this.agentId, msg.from, { status: 'searching', topic }, `Searching: ${topic}`);

		try {
			const cached = this.recall(topic);
			const documents = cached ?? (await this.search(topic));
			if (!cached) await this.remember(topic, documents);

			this.tasks.setStatus(task.id, 'done');
			this.bus.event(this.agentId, msg.from, { status: 'idle', topic, resultCount: documents.length, cached: !!cached }, `Found ${documents.length} document(s)`);
			this.bus.respond(msg.correlationId, this.agentId, { documents }, { resultCount: documents.length, cached: !!cached });
		} catch (e) {
			this.tasks.setStatus(task.id, 'failed', e instanceof Error ? e.message : String(e));
			this.bus.respond(msg.correlationId, this.agentId, { documents: [] });
		}
	}
}
