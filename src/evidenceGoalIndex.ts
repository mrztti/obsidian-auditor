import { LocalDocumentIndex, type EmbeddingsModel } from 'vectra/browser';
import { LocalFileStorage } from 'vectra/node';
import type { Vault } from 'obsidian';
import { parseSessionPlanContent, type EvidenceGoal } from './evidenceGoal';

/**
 * Deliberately lightweight — just enough to identify the match. Callers (the "prepare session" flow)
 * already have the full, authoritative `EvidenceGoal` objects in memory (loaded from the session plan
 * note itself) and look them up by `id`, rather than trusting a reconstruction from vector-index
 * metadata, which only carries a denormalized copy of the text for embedding/ranking purposes.
 */
export interface EvidenceGoalSearchResult {
	id: string;
	session: string;
	name: string;
	score: number;
}

/** Combined text an EG is embedded from — name, description, and questions all matter for judging relevance to a control. */
function evidenceGoalText(eg: EvidenceGoal): string {
	return [eg.name, eg.description, ...eg.questions].filter(Boolean).join('\n');
}

/**
 * A vectra index over Evidence Goals, one vectra "document" per EG (unlike `AuditVectorStore`, which
 * chunks files into many documents) — an EG is already a small, atomic unit, so it's embedded and
 * retrieved as a whole. Indexed from every session plan note under the configured folder; since the
 * total number of EGs in a vault is small, re-syncing is a full rebuild rather than the
 * hash-diffing/manifest machinery `AuditVectorStore` needs for large document folders.
 */
export class EvidenceGoalIndex {
	private storage: LocalFileStorage;
	private embeddings: EmbeddingsModel;
	private indexPromise: Promise<LocalDocumentIndex> | null = null;
	private mutationQueue: Promise<void> = Promise.resolve();

	constructor(embeddings: EmbeddingsModel, indexRootFolder: string) {
		this.storage = new LocalFileStorage(indexRootFolder);
		this.embeddings = embeddings;
	}

	private getIndex(): Promise<LocalDocumentIndex> {
		if (!this.indexPromise) {
			this.indexPromise = (async () => {
				const idx = new LocalDocumentIndex({
					folderPath: 'index',
					embeddings: this.embeddings,
					storage: this.storage,
					chunkingConfig: { chunkSize: 2000 },
				});
				if (!(await idx.isIndexCreated())) await idx.createIndex({ version: 1 });
				return idx;
			})();
		}
		return this.indexPromise;
	}

	/** Serializes index mutations — vectra tolerates only one begin/end-update transaction at a time. */
	private withLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.mutationQueue.then(fn, fn);
		this.mutationQueue = run.then(() => undefined, () => undefined);
		return run;
	}

	/** Re-syncs the index against every EG currently in every session plan note under `folderPath`. */
	async rebuildAll(vault: Vault, folderPath: string): Promise<void> {
		const idx = await this.getIndex();
		const prefix = folderPath ? (folderPath.endsWith('/') ? folderPath : `${folderPath}/`) : '';
		const files = vault.getFiles().filter((f) => {
			if (f.extension !== 'md') return false;
			if (!folderPath) return true;
			return f.path.startsWith(prefix) || f.path === folderPath;
		});

		const current = new Map<string, { eg: EvidenceGoal; session: string }>();
		for (const file of files) {
			const content = await vault.cachedRead(file);
			const plan = parseSessionPlanContent(content, file.basename);
			for (const eg of plan.evidenceGoals) current.set(eg.id, { eg, session: plan.session });
		}

		await this.withLock(async () => {
			// upsertDocument replaces any existing document with the same uri on its own, so this only
			// needs to explicitly delete documents whose EG no longer exists at all.
			const existingUris = new Set((await idx.listDocuments()).map((d) => d.uri));
			for (const uri of existingUris) {
				if (!current.has(uri)) await idx.deleteDocument(uri);
			}
			for (const [id, { eg, session }] of current) {
				await idx.upsertDocument(id, evidenceGoalText(eg), 'txt', {
					session,
					name: eg.name,
					controlNumbers: eg.controlNumbers.join(','),
				});
			}
		});
	}

	/** Upserts a single EG — used right after it's created/modified, instead of a full rebuild. */
	async upsert(eg: EvidenceGoal, session: string): Promise<void> {
		const idx = await this.getIndex();
		await this.withLock(async () => {
			await idx.upsertDocument(eg.id, evidenceGoalText(eg), 'txt', {
				session,
				name: eg.name,
				controlNumbers: eg.controlNumbers.join(','),
			});
		});
	}

	async remove(id: string): Promise<void> {
		const idx = await this.getIndex();
		await this.withLock(async () => {
			if (await idx.getDocumentId(id)) await idx.deleteDocument(id);
		});
	}

	/**
	 * Searches all indexed EGs by semantic similarity to `query`, optionally restricted to one
	 * session. `session`, if given, over-fetches (`topK * 4`) before filtering client-side, since
	 * vectra's own metadata filters aren't reliably available across versions.
	 */
	async search(query: string, topK: number, session?: string): Promise<EvidenceGoalSearchResult[]> {
		const idx = await this.getIndex();
		const results = await idx.queryDocuments(query, { maxDocuments: session ? topK * 4 : topK, maxChunks: session ? topK * 4 : topK });
		const output: EvidenceGoalSearchResult[] = [];
		for (const result of results) {
			const metadata = await result.loadMetadata();
			const resultSession = String(metadata.session ?? '');
			if (session && resultSession !== session) continue;
			output.push({
				id: result.uri,
				session: resultSession,
				name: String(metadata.name ?? ''),
				score: result.score,
			});
			if (output.length >= topK) break;
		}
		return output;
	}
}
