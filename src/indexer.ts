/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, no-console */
import * as ort from 'onnxruntime-web/webgpu';
import * as pdfjsLib from 'pdfjs-dist';
import {
	LocalDocumentIndex,
	TransformersEmbeddings,
	type LocalDocumentResult,
} from 'vectra/browser';
// `vectra/browser` only exposes VirtualFileStorage (in-memory) and
// IndexedDBStorage (browser storage, size-limited and easy to lose). Obsidian
// desktop runs in Electron's renderer with full Node access, so we use the
// real `vectra/node` LocalFileStorage to persist the index as plain files on
// disk inside the plugin's own data folder.
import { LocalFileStorage } from 'vectra/node';
import { Vault, type TFile } from 'obsidian';

const INDEXABLE_EXTENSIONS = new Set(['md', 'pdf']);

// Injected at build time by esbuild.config.mjs: the full bundled source of
// pdfjs-dist's worker, embedded as a string so it ships inside main.js itself
// (see esbuild.config.mjs for why we can't rely on a sibling file).
declare const __PDF_WORKER_SOURCE__: string;

// Turning the embedded worker source into a Blob URL gives pdf.js a real,
// isolated Worker thread to load it into — never touching
// `globalThis.pdfjsWorker`, which Obsidian's own native PDF viewer (a
// separate, differently-versioned copy of pdfjs-dist) also reads and would
// conflict with.
const pdfWorkerBlobUrl = URL.createObjectURL(
	new Blob([__PDF_WORKER_SOURCE__], { type: 'text/javascript' }),
);
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerBlobUrl;

/** Lets the UI thread repaint between heavy synchronous embedding calls. */
const yieldToUI = (): Promise<void> =>
	new Promise((resolve) => {
		window.setTimeout(resolve, 0);
	});

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
	private storage: LocalFileStorage;
	private modelName: string;
	private chunkSize: number;
	private indexPromise: Promise<LocalDocumentIndex> | null = null;
	private onModelProgress?: (progress: ModelLoadProgress) => void;
	private cancelRequested = false;
	private indexingInProgress = false;

	/**
	 * @param indexRootFolder Absolute path to a folder (inside the plugin's own
	 * data directory) where the vector index is persisted as plain files.
	 */
	constructor(
		modelName: string,
		indexRootFolder: string,
		chunkSize = 512,
		onModelProgress?: (progress: ModelLoadProgress) => void,
	) {
		this.storage = new LocalFileStorage(indexRootFolder);
		this.modelName = modelName;
		this.chunkSize = chunkSize;
		this.onModelProgress = onModelProgress;
		log('VaultIndexer constructed', { modelName, chunkSize, indexRootFolder });
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

	get isIndexing(): boolean {
		return this.indexingInProgress;
	}

	/** Requests that an in-progress indexVaultFolder stop after its current file. */
	cancelIndexing(): void {
		if (this.indexingInProgress) {
			log('cancelIndexing: cancellation requested');
			this.cancelRequested = true;
		}
	}

	async indexVaultFolder(
		vault: Vault,
		folderPath: string,
		onProgress?: (done: number, total: number, label: string) => void,
	): Promise<void> {
		log('indexVaultFolder: starting', { folderPath });
		const idx = await this.getIndex();

		const prefix = folderPath
			? folderPath.endsWith('/')
				? folderPath
				: folderPath + '/'
			: '';
		const files = vault.getFiles().filter((f) => {
			if (!INDEXABLE_EXTENSIONS.has(f.extension)) return false;
			if (!folderPath) return true;
			return f.path.startsWith(prefix) || f.path === folderPath;
		});
		log('indexVaultFolder: files matched', files.length, {
			md: files.filter((f) => f.extension === 'md').length,
			pdf: files.filter((f) => f.extension === 'pdf').length,
		});

		this.cancelRequested = false;
		this.indexingInProgress = true;
		try {
		for (let i = 0; i < files.length; i++) {
			if (this.cancelRequested) {
				log('indexVaultFolder: cancelled', { done: i, total: files.length });
				onProgress?.(i, files.length, 'Cancelled');
				break;
			}
			const file = files[i]!;
			log('indexVaultFolder: indexing file', file.path);
			onProgress?.(i, files.length, `Indexing ${file.basename}…`);
			try {
				// Files prefixed with "_" are ingested by title only — their
				// content is intentionally never embedded.
				if (file.basename.startsWith('_')) {
					await idx.upsertDocument(file.path, file.basename, 'txt');
				} else {
					const content = await this.readFileText(vault, file);
					// Every document must end up in the index, even with empty/
					// unreadable content — fall back to indexing just the title
					// rather than skipping it outright.
					const text = content.trim().length > 0 ? content : file.basename;
					await idx.upsertDocument(file.path, text, 'txt');
				}
			} catch (e) {
				console.error('[Auditor] failed to index', file.path, e);
			}
			onProgress?.(i + 1, files.length, `Done ${file.basename}`);
			// Hand the main thread back to the UI so the progress bar repaints
			// between documents instead of freezing for the whole batch.
			await yieldToUI();
		}
		} finally {
			this.indexingInProgress = false;
			this.cancelRequested = false;
		}
		log('indexVaultFolder: complete');
	}

	/** Reads a file as plain text, extracting PDF text content where needed. */
	private async readFileText(vault: Vault, file: TFile): Promise<string> {
		if (file.extension === 'pdf') {
			const data = await vault.readBinary(file);
			return this.extractPdfText(new Uint8Array(data));
		}
		return vault.cachedRead(file);
	}

	/** Extracts concatenated text from every page of a PDF. */
	private async extractPdfText(data: Uint8Array): Promise<string> {
		const pdf = await pdfjsLib.getDocument({
			data,
			isEvalSupported: false,
			// Avoid noisy console output for fonts we don't need (text only).
			verbosity: 0,
		}).promise;
		const pages: string[] = [];
		for (let p = 1; p <= pdf.numPages; p++) {
			const page = await pdf.getPage(p);
			const content = await page.getTextContent();
			const text = content.items
				.map((item) => ('str' in item ? item.str : ''))
				.join(' ');
			pages.push(text);
			page.cleanup();
		}
		await pdf.destroy();
		return pages.join('\n\n');
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
			const sections = await result.renderSections(1200, 3, true);
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
