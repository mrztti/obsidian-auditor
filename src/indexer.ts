/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, no-console */
import * as ort from 'onnxruntime-web/webgpu';
import {
	LocalDocumentIndex,
	VirtualFileStorage as IndexedDBStorage,
	TransformersEmbeddings,
	type LocalDocumentResult,
} from 'vectra/browser';
import { Vault } from 'obsidian';

// Obsidian runs plugins in Electron's renderer process, where `process` is
// defined. @huggingface/transformers' env detection therefore sets
// `IS_NODE_ENV = true` and tries to load the onnxruntime-node backend — but in
// the bundled `transformers.web` build that backend is an empty stub, so
// `InferenceSession` ends up undefined and `InferenceSession.create(...)` throws.
//
// transformers checks `Symbol.for("onnxruntime")` on globalThis *first* (before
// the node/web branch), so registering a real onnxruntime-web build here forces
// it to use the wasm/webgpu backend regardless of how the environment is detected.
// Must be `globalThis` (not `window`) — that is the exact object transformers reads.
// eslint-disable-next-line obsidianmd/no-global-this
(globalThis as Record<symbol, unknown>)[Symbol.for('onnxruntime')] = ort;

export interface SearchResult {
	score: number;
	filePath: string;
	sections: string[];
}

export interface ModelLoadProgress {
	status: string;
	file?: string;
	progress?: number;
	loaded?: number;
	total?: number;
}

const log = (...args: unknown[]) => console.log('[Auditor]', ...args);

export class VaultIndexer {
	private storage: IndexedDBStorage;
	private modelName: string;
	private chunkSize: number;
	private indexPromise: Promise<LocalDocumentIndex> | null = null;
	private onModelProgress?: (progress: ModelLoadProgress) => void;

	constructor(
		modelName: string,
		chunkSize = 512,
		onModelProgress?: (progress: ModelLoadProgress) => void,
	) {
		this.storage = new IndexedDBStorage();
		this.modelName = modelName;
		this.chunkSize = chunkSize;
		this.onModelProgress = onModelProgress;
		log('VaultIndexer constructed', { modelName, chunkSize });
	}

	/** Lazily initialises embeddings + index on first use. */
	private getIndex(): Promise<LocalDocumentIndex> {
		if (!this.indexPromise) {
			log('getIndex: no cached index promise, initialising…');
			this.indexPromise = (async () => {
				log('getIndex: creating TransformersEmbeddings for model', this.modelName);
				const embeddings = await TransformersEmbeddings.create({
					model: this.modelName,
					device: 'auto',
					dtype: 'q8',
					progressCallback: (p: ModelLoadProgress) => {
						log('model download progress', p);
						this.onModelProgress?.(p);
					},
				});
				log('getIndex: embeddings ready, opening LocalDocumentIndex');
				const idx = new LocalDocumentIndex({
					folderPath: 'vault-index',
					embeddings,
					storage: this.storage,
					chunkingConfig: { chunkSize: this.chunkSize },
				});
				const created = await idx.isIndexCreated();
				log('getIndex: index already created?', created);
				if (!created) {
					log('getIndex: creating new index');
					await idx.createIndex({ version: 1 });
				}
				log('getIndex: index ready');
				return idx;
			})();
		}
		return this.indexPromise;
	}

	/** No-op — index is created lazily on first indexVaultFolder or search call. */
	async initialize(): Promise<void> {}

	async indexVaultFolder(
		vault: Vault,
		folderPath: string,
		onProgress?: (done: number, total: number, label: string) => void,
	): Promise<void> {
		log('indexVaultFolder: starting', { folderPath });
		const idx = await this.getIndex();

		const files = vault.getMarkdownFiles().filter((f) => {
			if (!folderPath) return true;
			return (
				f.path.startsWith(
					folderPath.endsWith('/') ? folderPath : folderPath + '/',
				) || f.path === folderPath
			);
		});
		log('indexVaultFolder: files matched', files.length);

		for (let i = 0; i < files.length; i++) {
			const file = files[i]!;
			log('indexVaultFolder: indexing file', file.path);
			onProgress?.(i, files.length, `Indexing ${file.basename}…`);
			const content = await vault.cachedRead(file);
			await idx.upsertDocument(file.path, content, 'txt');
			onProgress?.(i + 1, files.length, `Done ${file.basename}`);
		}
		log('indexVaultFolder: complete');
	}

	async search(query: string, topK: number): Promise<SearchResult[]> {
		log('search: starting', { query, topK });
		const idx = await this.getIndex();
		const results = await idx.queryDocuments(query, {
			maxDocuments: topK,
			maxChunks: topK * 3,
		});
		log('search: raw results count', results.length);

		const output: SearchResult[] = [];
		for (const result of results as LocalDocumentResult[]) {
			const sections = await result.renderSections(500, 1, true);
			output.push({
				score: result.score,
				filePath: result.uri,
				sections: sections.map((s: { text: string }) => s.text),
			});
		}
		log('search: returning', output.length, 'results');
		return output;
	}

	async getStats(): Promise<unknown> {
		const idx = await this.getIndex();
		return idx.getIndexStats();
	}
}
