import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra/browser';

/** Collapses all whitespace (real newlines, vectra's own separator-rejoin spaces, etc.) so a chunk of text maps to the same cache key regardless of minor formatting differences introduced by vectra's internal text splitter. */
function normalizeKey(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * Wraps an `EmbeddingsModel` with a content-keyed cache so a chunk's embedding is computed at most
 * once. This exists to let indexing genuinely parallelize the expensive part — the network round
 * trip to Gemini — across concurrently-processed files: callers `prewarm()` every chunk's text
 * *outside* vectra's single-at-a-time index-update lock (so many prewarm calls are in flight
 * together), and vectra's own `upsertDocument()` (called *inside* that lock, one file at a time)
 * then hits this cache instantly instead of making its own network call, keeping the locked section
 * itself fast.
 */
export class CachingEmbeddings implements EmbeddingsModel {
	readonly maxTokens: number;
	private inner: EmbeddingsModel;
	private cache = new Map<string, number[]>();

	constructor(inner: EmbeddingsModel) {
		this.inner = inner;
		this.maxTokens = inner.maxTokens;
	}

	/** Populates the cache for one chunk of text; safe to call concurrently for many chunks/files at once. */
	async prewarm(text: string): Promise<void> {
		await this.createEmbeddings([text]);
	}

	async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
		const texts = Array.isArray(inputs) ? inputs : [inputs];
		const keys = texts.map(normalizeKey);

		const missing: { text: string; key: string }[] = [];
		const seenMissingKeys = new Set<string>();
		keys.forEach((key, i) => {
			if (!this.cache.has(key) && !seenMissingKeys.has(key)) {
				seenMissingKeys.add(key);
				missing.push({ text: texts[i]!, key });
			}
		});

		if (missing.length > 0) {
			const response = await this.inner.createEmbeddings(missing.map((m) => m.text));
			if (response.status !== 'success' || !response.output) return response;
			missing.forEach((m, j) => { this.cache.set(m.key, response.output![j]!); });
		}

		const output = keys.map((key) => this.cache.get(key)!);
		return { status: 'success', output };
	}

	/** Bounds memory growth across multiple indexing runs — call once a run completes. */
	clear(): void {
		this.cache.clear();
	}
}
