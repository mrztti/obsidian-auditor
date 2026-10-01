import type AuditorPlugin from '../main';

interface CacheEntry<T> {
	value: T;
	createdAt: number;
	/** Vault paths this result depends on — any `modify`/`delete` event on one of these invalidates the entry (FR-5.2's "a source document changes"). */
	sourceFiles: string[];
}

/**
 * Caches research-tool results (search_documents, read_document, search_reference_style) so an
 * equivalent call made again — by the same run, a later run, or a different control's research in
 * the same batch — reuses the prior result instead of re-querying the vector store or re-reading a
 * file (FR-5.2). Lives on the plugin (not one `ChatAgent`/chat session), since the vault's documents
 * don't change just because the user started a new chat.
 *
 * Scope note: FR-5.2 asks the cache key to include tenant/engagement scope, user authorization
 * scope and permission context. This plugin is single-user and single-vault with no such
 * boundaries — there is nothing to scope by — so the key is built from the call itself
 * (tool + normalized args) and entries are invalidated purely by source-file changes and a size
 * cap. "Never reuse cached content across unauthorized engagement or tenant boundaries" is
 * trivially true here: there is exactly one engagement (this vault) and one user.
 */
export class ResearchCache {
	private entries = new Map<string, CacheEntry<unknown>>();
	private inflight = new Map<string, Promise<unknown>>();
	/** Diagnostics only — how many `getOrFetch` calls this session were hits vs misses, surfaced in settings/debugging rather than a dedicated UI. */
	private hits = 0;
	private misses = 0;

	constructor(private plugin: AuditorPlugin) {
		plugin.registerEvent(plugin.app.vault.on('modify', (file) => this.invalidateSource(file.path)));
		plugin.registerEvent(plugin.app.vault.on('delete', (file) => this.invalidateSource(file.path)));
		plugin.registerEvent(plugin.app.vault.on('rename', (file, oldPath) => this.invalidateSource(oldPath)));
	}

	/** Builds a normalized, deterministic cache key from a tool name and its arguments (sorted keys, so argument order never causes a spurious miss). */
	static key(toolName: string, args: Record<string, unknown>): string {
		const sorted: Record<string, unknown> = {};
		for (const k of Object.keys(args).sort()) sorted[k] = args[k];
		return `${toolName}::${JSON.stringify(sorted)}`;
	}

	/**
	 * Returns the cached value for `key` if still valid, else calls `fetch()`, caches the result
	 * (tagged with whatever `sourceFiles` it reports — e.g. the paths its results actually came
	 * from — so a later change to any of them invalidates this entry), and returns it. Simultaneous
	 * identical requests (the same key fetched again before the first finishes) share the one
	 * in-flight call rather than issuing it twice. `sourceFiles` is returned alongside the value
	 * (rather than passed in upfront) because for a search it is only known once results are in.
	 */
	async getOrFetch<T>(key: string, fetch: () => Promise<{ value: T; sourceFiles: string[] }>): Promise<{ value: T; hit: boolean }> {
		const cached = this.entries.get(key);
		if (cached) {
			this.hits++;
			return { value: cached.value as T, hit: true };
		}
		const existing = this.inflight.get(key);
		if (existing) {
			this.hits++;
			return { value: (await existing as { value: T }).value, hit: true };
		}
		this.misses++;
		const promise = fetch();
		this.inflight.set(key, promise);
		try {
			const { value, sourceFiles } = await promise;
			this.entries.set(key, { value, createdAt: Date.now(), sourceFiles });
			this.evictIfNeeded();
			return { value, hit: false };
		} finally {
			this.inflight.delete(key);
		}
	}

	private invalidateSource(path: string): void {
		for (const [key, entry] of this.entries) {
			if (entry.sourceFiles.includes(path)) this.entries.delete(key);
		}
	}

	private evictIfNeeded(): void {
		const max = this.plugin.settings.evidenceCacheMaxEntries || 300;
		while (this.entries.size > max) {
			const oldestKey = this.entries.keys().next().value; // Map iterates in insertion order
			if (oldestKey === undefined) break;
			this.entries.delete(oldestKey);
		}
	}

	clear(): void {
		this.entries.clear();
		this.inflight.clear();
	}

	get diagnostics(): { size: number; hits: number; misses: number } {
		return { size: this.entries.size, hits: this.hits, misses: this.misses };
	}
}
