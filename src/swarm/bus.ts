export type MessageKind = 'task' | 'request' | 'response' | 'event';

export interface AgentMessage {
	id: string;
	from: string;
	to: string;
	kind: MessageKind;
	/** Ties a `response` back to the `request` it answers. Set by `request()`/`respond()`; irrelevant for plain `send()`/`event` traffic. */
	correlationId?: string;
	/** Short human label for the notification feed, e.g. "Evidence: access review" — every `request`/`response` call site is expected to supply one; falls back to a generic `<kind> <to|from>` when omitted. */
	title: string;
	/** Small structured facts about this message worth surfacing in the feed without parsing `payload` (e.g. `{ resultCount: 4 }`) — purely descriptive, never read by the recipient's own handling logic. */
	meta?: Record<string, unknown>;
	payload: unknown;
	at: number;
}

type Listener = (msg: AgentMessage) => void;

let counter = 0;
const newId = (): string => `msg-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** How long `request()` waits for a `respond()` before giving up — a reader/verifier agent that never answers must not hang its caller forever. */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

interface PendingRequest {
	resolve: (payload: unknown) => void;
	reject: (e: Error) => void;
	timer: number;
	/** The original request's title, echoed back as "Re: <title>" on the matching response so the feed reads as a conversation, not two unrelated rows. */
	title: string;
}

export interface RequestOptions {
	title?: string;
	meta?: Record<string, unknown>;
	timeoutMs?: number;
}

/**
 * The swarm's message bus: every agent-to-agent interaction (task dispatch, request/await-response,
 * and plain status events for the graph UI) goes through one shared instance on the plugin, so the
 * graph view can subscribe once and see the whole swarm's traffic rather than wiring into each
 * agent individually.
 */
export class AgentBus {
	private listeners = new Set<Listener>();
	private pending = new Map<string, PendingRequest>();

	private publish(msg: AgentMessage): void {
		for (const fn of this.listeners) fn(msg);
	}

	/** Fire-and-forget — used for task dispatch (orchestrator → writer) and plain status events. */
	send(msg: Omit<AgentMessage, 'id' | 'at' | 'title'> & { title?: string }): void {
		this.publish({ ...msg, id: newId(), at: Date.now(), title: msg.title ?? `${msg.kind} → ${msg.to}` });
	}

	/**
	 * Sends a request to `to` and waits for the matching `respond()` call — this is how one agent
	 * "waits on the response of another agent" (e.g. a writer asking the evidence reader for
	 * documents on a topic). Rejects if nothing responds within `timeoutMs`.
	 */
	request(from: string, to: string, payload: unknown, options: RequestOptions = {}): Promise<unknown> {
		const correlationId = newId();
		const title = options.title ?? `Request → ${to}`;
		const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		return new Promise((resolve, reject) => {
			const timer = window.setTimeout(() => {
				this.pending.delete(correlationId);
				reject(new Error(`${to} did not respond within ${Math.round(timeoutMs / 1000)}s.`));
			}, timeoutMs);
			this.pending.set(correlationId, { resolve, reject, timer, title });
			this.publish({ id: newId(), from, to, kind: 'request', correlationId, title, meta: options.meta, payload, at: Date.now() });
		});
	}

	/** Answers a pending `request()` by its `correlationId` — the responder reads that id off the incoming `request` message it handled. */
	respond(correlationId: string, from: string, payload: unknown, meta?: Record<string, unknown>): void {
		const waiting = this.pending.get(correlationId);
		const title = waiting ? `Re: ${waiting.title}` : 'Response';
		if (waiting) {
			window.clearTimeout(waiting.timer);
			this.pending.delete(correlationId);
			waiting.resolve(payload);
		}
		// Published either way, so the graph UI can show the response traveling even if the
		// original requester already timed out and moved on.
		this.publish({ id: newId(), from, to: '*', kind: 'response', correlationId, title, meta, payload, at: Date.now() });
	}

	/** A plain status/progress note for the graph UI — not a task or a request awaiting a reply. */
	event(from: string, to: string, payload: unknown, title?: string): void {
		this.publish({ id: newId(), from, to, kind: 'event', title: title ?? 'Status', payload, at: Date.now() });
	}

	/** Every message published on the bus, for the graph view's live log. */
	subscribe(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => { this.listeners.delete(fn); };
	}

	/** Cancels every request still waiting on a reply — used when the swarm is torn down, so nothing is left hanging. */
	clear(): void {
		for (const { reject, timer } of this.pending.values()) {
			window.clearTimeout(timer);
			reject(new Error('The swarm was stopped.'));
		}
		this.pending.clear();
	}
}
