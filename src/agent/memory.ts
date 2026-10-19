import type AuditorPlugin from '../main';
import type { AgentMemoryItem, MemoryCategory } from '../settings';

let counter = 0;
const newId = (): string => `mem-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Categories the agent itself may write via `remember_fact` — never `acceptedConclusion`/`acceptedDecision` (those are stamped only by the plugin, right after the user's own approval) or `writingStyleProfileRef` (that's a pointer the plugin keeps in sync with settings, not something to re-derive). */
export const AGENT_WRITABLE_CATEGORIES: MemoryCategory[] = ['engagementConfig', 'controlFrameworkMetadata', 'stableDocumentFact', 'thematicEvidenceMap', 'topicDocumentMap'];

/**
 * Durable, structured memory the agent can carry across chat sessions (FR-6.3) — backed in memory by
 * `plugin.settings.agentMemory`, and mirrored to its own local file (`agent-memory.json` in the
 * plugin's data folder — see `AuditorPlugin.saveAgentMemoryFile`/`loadAgentMemoryFile`) on every
 * write, so it persists across sessions independently of `data.json`. Items are never deleted on
 * supersede, only marked `supersededBy`, so the store doubles as its own audit log; `query()` only
 * ever returns live (non-superseded, non-expired) items.
 *
 * `agentId`, when given, scopes every read/write to that agent's own items only — used by the
 * swarm's specialist agents so e.g. one writer's remembered facts never leak into another's. The
 * single interactive chat agent omits it (unchanged from before this field existed), reading/writing
 * only items with no `agentId` of their own.
 */
export class AgentMemoryStore {
	constructor(private plugin: AuditorPlugin, private agentId?: string) {}

	private get items(): AgentMemoryItem[] {
		return this.plugin.settings.agentMemory;
	}

	private ownedByMe(m: AgentMemoryItem): boolean {
		return (m.agentId ?? undefined) === this.agentId;
	}

	/** Live items (not superseded, not past `retentionUntil`, owned by this store's agent scope), optionally filtered by category and/or a case-insensitive substring of `content`/`provenance`. */
	query(opts: { category?: MemoryCategory; text?: string } = {}): AgentMemoryItem[] {
		const today = new Date().toISOString().slice(0, 10);
		const needle = opts.text?.toLowerCase().trim();
		return this.items.filter((m) => {
			if (!this.ownedByMe(m)) return false;
			if (m.supersededBy) return false;
			if (m.retentionUntil && m.retentionUntil < today) return false;
			if (opts.category && m.category !== opts.category) return false;
			if (needle && !m.content.toLowerCase().includes(needle) && !m.provenance.toLowerCase().includes(needle)) return false;
			return true;
		});
	}

	/** Every item in this store's scope, live or superseded — the audit view (settings tab, or a future dedicated one). */
	all(): AgentMemoryItem[] {
		return this.items.filter((m) => this.ownedByMe(m));
	}

	/**
	 * Writes one new memory item and persists it. If `supersedes` is given, that item is marked
	 * `supersededBy` this new one's id (kept, not removed) — so a fact can be corrected or updated
	 * without losing the record that it once said something else.
	 */
	async remember(
		category: MemoryCategory,
		content: string,
		provenance: string,
		opts: { supersedes?: string; retentionUntil?: string } = {},
	): Promise<AgentMemoryItem> {
		const item: AgentMemoryItem = {
			id: newId(),
			category,
			content: content.trim(),
			provenance: provenance.trim(),
			scope: 'vault',
			version: 1,
			createdAt: new Date().toISOString(),
			retentionUntil: opts.retentionUntil,
			agentId: this.agentId,
		};
		if (opts.supersedes) {
			const prior = this.items.find((m) => m.id === opts.supersedes && !m.supersededBy && this.ownedByMe(m));
			if (prior) {
				prior.supersededBy = item.id;
				item.version = prior.version + 1;
			}
		}
		this.items.push(item);
		this.evictIfNeeded();
		await this.plugin.saveSettings();
		await this.plugin.saveAgentMemoryFile();
		return item;
	}

	/** Evicts the oldest SUPERSEDED items once over the configured cap — live items are never evicted, since dropping them silently would contradict "accepted"/"stable" facts still being true. */
	private evictIfNeeded(): void {
		const max = this.plugin.settings.persistentMemoryMaxItems || 200;
		const overBy = this.items.length - max;
		if (overBy <= 0) return;
		const evictIds = new Set(
			this.items
				.filter((m) => m.supersededBy)
				.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
				.slice(0, overBy)
				.map((m) => m.id),
		);
		if (evictIds.size === 0) return;
		this.plugin.settings.agentMemory = this.items.filter((m) => !evictIds.has(m.id));
	}

	/** Clears only this store's own scope — a per-agent store never touches another agent's (or the shared chat's) items. */
	async clear(): Promise<void> {
		this.plugin.settings.agentMemory = this.items.filter((m) => !this.ownedByMe(m));
		await this.plugin.saveSettings();
		await this.plugin.saveAgentMemoryFile();
	}
}
