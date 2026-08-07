import * as pdfjsLib from 'pdfjs-dist';
import * as mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { LocalDocumentIndex, type EmbeddingsModel } from 'vectra/browser';
import { LocalFileStorage } from 'vectra/node';
import { Vault, type TFile } from 'obsidian';
import { chunkMarkdown, chunkPdfPages } from './chunker';
import { CachingEmbeddings } from './embeddingsCache';
import { cellToString } from './controlImport';

const INDEXABLE_EXTENSIONS = new Set(['md', 'pdf', 'docx', 'xlsx', 'xls']);
const BINARY_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'xls']);

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

const log = (...args: unknown[]) => console.debug('[Auditor]', ...args);

export interface SearchResult {
	text: string;
	sourcePath: string;
	page?: number;
	line?: number;
	score: number;
}

/** Recap of a completed (or cancelled) indexFolder run. */
export interface IndexSummary {
	totalFiles: number;
	/** Newly indexed or re-indexed because their content changed. */
	indexed: number;
	/** Content hash matched the manifest — chunking/embedding was skipped entirely. */
	skippedUnchanged: number;
	/** Reading or chunking the file threw (e.g. corrupt/unreadable PDF). */
	skippedUnreadable: number;
	/** Previously-indexed files no longer present under the folder; their chunks were removed. */
	removed: number;
	cancelled: boolean;
}

type FileIndexStatus = 'indexed' | 'unchanged' | 'unreadable';

interface ManifestEntry {
	hash: string;
	chunkUris: string[];
}

type Manifest = Record<string, ManifestEntry>;

/** filePath -> last error message from a failed read/chunk attempt. */
type ErrorMap = Record<string, string>;

/** Cheap, deterministic non-cryptographic hash used to detect unchanged file content between re-indexes. */
function hashText(text: string): string {
	let hash = 0;
	for (let i = 0; i < text.length; i++) {
		hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0;
	}
	return `${text.length}:${hash}`;
}

/**
 * One paragraph-chunked, Gemini-embedded vectra index over a single vault folder.
 * Supports markdown, PDF, and .docx (via mammoth) source files.
 *
 * Each paragraph chunk is stored as its own synthetic vectra "document" (e.g.
 * `note.md#L44` or `standard.pdf#p12#c0`) so the page/line location of every
 * chunk survives instead of being lost to vectra's own internal, page-unaware
 * text splitter. A manifest tracks each source file's content hash and the
 * chunk URIs it currently owns, so re-indexing only re-embeds changed files
 * and cleans up chunks whose paragraphs shifted or were removed.
 */
export class AuditVectorStore {
	private storage: LocalFileStorage;
	/** Wraps the real embeddings model so chunk embeddings can be prewarmed concurrently across files, ahead of the serialized index-commit section — see `CachingEmbeddings`. */
	private embeddings: CachingEmbeddings;
	private chunkWords: number;
	private maxConcurrentFiles: number;
	private indexPromise: Promise<LocalDocumentIndex> | null = null;
	private manifest: Manifest | null = null;
	private errors: ErrorMap | null = null;
	private cancelRequested = false;
	private indexingInProgress = false;
	/** Serializes manifest/error persistence so concurrent file workers don't race overlapping disk writes. */
	private persistQueue: Promise<void> = Promise.resolve();
	/**
	 * vectra's `LocalDocumentIndex` maintains a single internal begin/end-update transaction — it is
	 * not safe for two concurrent callers to have one open at once (`upsertDocument`/`deleteDocument`
	 * throw "Update already in progress" if they overlap). File reading/chunking still runs
	 * concurrently across the worker pool, but every actual index mutation is funneled through this
	 * one queue, so exactly one file at a time ever holds the index's update transaction.
	 */
	private indexMutationQueue: Promise<void> = Promise.resolve();

	constructor(embeddings: EmbeddingsModel, indexRootFolder: string, chunkWords = 300, maxConcurrentFiles = 10) {
		this.storage = new LocalFileStorage(indexRootFolder);
		this.embeddings = new CachingEmbeddings(embeddings);
		this.chunkWords = chunkWords;
		this.maxConcurrentFiles = maxConcurrentFiles;
	}

	setMaxConcurrentFiles(n: number): void {
		this.maxConcurrentFiles = n;
	}

	get isIndexing(): boolean {
		return this.indexingInProgress;
	}

	cancelIndexing(): void {
		if (this.indexingInProgress) this.cancelRequested = true;
	}

	private getIndex(): Promise<LocalDocumentIndex> {
		if (!this.indexPromise) {
			this.indexPromise = (async () => {
				const idx = new LocalDocumentIndex({
					folderPath: 'index',
					embeddings: this.embeddings,
					storage: this.storage,
					// Chunks are already paragraph-sized; a large chunkSize keeps
					// vectra's own splitter from re-splitting what we already split.
					chunkingConfig: { chunkSize: 2000 },
				});
				if (!(await idx.isIndexCreated())) await idx.createIndex({ version: 1 });
				return idx;
			})();
		}
		return this.indexPromise;
	}

	private async loadManifest(): Promise<Manifest> {
		if (this.manifest) return this.manifest;
		if (await this.storage.pathExists('manifest.json')) {
			const raw = await this.storage.readFile('manifest.json');
			this.manifest = JSON.parse(raw.toString('utf8')) as Manifest;
		} else {
			this.manifest = {};
		}
		return this.manifest;
	}

	private async saveManifest(): Promise<void> {
		await this.storage.upsertFile('manifest.json', JSON.stringify(this.manifest ?? {}));
	}

	private async loadErrors(): Promise<ErrorMap> {
		if (this.errors) return this.errors;
		if (await this.storage.pathExists('errors.json')) {
			const raw = await this.storage.readFile('errors.json');
			this.errors = JSON.parse(raw.toString('utf8')) as ErrorMap;
		} else {
			this.errors = {};
		}
		return this.errors;
	}

	private async saveErrors(): Promise<void> {
		await this.storage.upsertFile('errors.json', JSON.stringify(this.errors ?? {}));
	}

	/** Queues a manifest+errors save after the in-flight one, so concurrent file workers never overlap disk writes. */
	private persist(): Promise<void> {
		this.persistQueue = this.persistQueue.then(() => Promise.all([this.saveManifest(), this.saveErrors()])).then(() => {});
		return this.persistQueue;
	}

	/** Runs `fn` only once every prior queued mutation has fully settled — the single controller serializing all index begin/end-update transactions across concurrent file workers. */
	private withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.indexMutationQueue.then(fn, fn);
		this.indexMutationQueue = run.then(() => undefined, () => undefined);
		return run;
	}

	async indexFolder(
		vault: Vault,
		folderPath: string,
		onProgress?: (done: number, total: number, label: string) => void,
		onActiveFilesChange?: (activePaths: string[]) => void,
	): Promise<IndexSummary> {
		log('indexFolder: starting', { folderPath });
		this.embeddings.clear();
		const idx = await this.getIndex();
		const manifest = await this.loadManifest();
		const errors = await this.loadErrors();

		const prefix = folderPath ? (folderPath.endsWith('/') ? folderPath : `${folderPath}/`) : '';
		const files = vault.getFiles().filter((f) => {
			if (!INDEXABLE_EXTENSIONS.has(f.extension)) return false;
			if (!folderPath) return true;
			return f.path.startsWith(prefix) || f.path === folderPath;
		});
		log('indexFolder: files matched', files.length);

		const summary: IndexSummary = {
			totalFiles: files.length,
			indexed: 0,
			skippedUnchanged: 0,
			skippedUnreadable: 0,
			removed: 0,
			cancelled: false,
		};

		const seenPaths = new Set(files.map((f) => f.path));
		// Files that were removed or moved out of the folder: drop their stale chunks.
		for (const path of Object.keys(manifest)) {
			if (!seenPaths.has(path)) {
				for (const uri of manifest[path]!.chunkUris) await idx.deleteDocument(uri);
				delete manifest[path];
				summary.removed++;
			}
		}
		for (const path of Object.keys(errors)) {
			if (!seenPaths.has(path)) delete errors[path];
		}

		this.cancelRequested = false;
		this.indexingInProgress = true;
		const activeFiles = new Set<string>();
		const notifyActive = () => onActiveFilesChange?.(Array.from(activeFiles));
		let cursor = 0;
		let doneCount = 0;

		const worker = async (): Promise<void> => {
			while (!this.cancelRequested) {
				const i = cursor++;
				if (i >= files.length) return;
				const file = files[i]!;
				activeFiles.add(file.path);
				notifyActive();
				try {
					const status = await this.indexFile(idx, vault, file, manifest, errors);
					if (status === 'indexed') summary.indexed++;
					else if (status === 'unchanged') summary.skippedUnchanged++;
					else summary.skippedUnreadable++;
				} catch (e) {
					console.error('[Auditor] failed to index', file.path, e);
					errors[file.path] = String(e);
					summary.skippedUnreadable++;
				}
				activeFiles.delete(file.path);
				doneCount++;
				notifyActive();
				onProgress?.(doneCount, files.length, `Done ${file.basename}`);
				await this.persist();
				await yieldToUI();
			}
		};

		try {
			const workerCount = Math.max(1, Math.min(this.maxConcurrentFiles, files.length));
			await Promise.all(Array.from({ length: workerCount }, worker));
			if (this.cancelRequested) {
				summary.cancelled = true;
				onProgress?.(doneCount, files.length, 'Cancelled');
			}
		} finally {
			this.indexingInProgress = false;
			this.cancelRequested = false;
			activeFiles.clear();
			notifyActive();
		}
		log('indexFolder: complete', summary);
		return summary;
	}

	/**
	 * Indexes a single file, first checking a hash of its *raw* content against the manifest so
	 * unchanged files are skipped before any chunking/PDF-extraction/embedding work is done.
	 */
	private async indexFile(
		idx: LocalDocumentIndex,
		vault: Vault,
		file: TFile,
		manifest: Manifest,
		errors: ErrorMap,
	): Promise<FileIndexStatus> {
		const isBinary = BINARY_EXTENSIONS.has(file.extension);
		let rawContent: string;
		try {
			rawContent = isBinary
				? Buffer.from(await vault.readBinary(file)).toString('base64')
				: await vault.cachedRead(file);
		} catch (e) {
			console.error('[Auditor] failed to read', file.path, e);
			errors[file.path] = String(e);
			return 'unreadable';
		}

		const hash = hashText(rawContent);
		const previous = manifest[file.path];
		if (previous && previous.hash === hash) {
			log('indexFile: unchanged, skipping', file.path);
			// A successful read implies the file is still readable, so a prior error no longer applies.
			delete errors[file.path];
			return 'unchanged';
		}

		let chunks: { text: string; page?: number; line?: number }[];
		try {
			if (file.extension === 'pdf') {
				chunks = chunkPdfPages(await this.extractPdfPages(Buffer.from(rawContent, 'base64')), this.chunkWords);
			} else if (file.extension === 'docx') {
				chunks = chunkMarkdown(await this.extractDocxText(Buffer.from(rawContent, 'base64')), this.chunkWords);
			} else if (file.extension === 'xlsx' || file.extension === 'xls') {
				// Reuses chunkPdfPages: each worksheet stands in for a "page", so results still carry a
				// sheet number (surfaced to the user as `page`) instead of a meaningless line number.
				chunks = chunkPdfPages(await this.extractExcelSheets(Buffer.from(rawContent, 'base64')), this.chunkWords);
			} else {
				chunks = chunkMarkdown(rawContent, this.chunkWords);
			}
		} catch (e) {
			console.error('[Auditor] failed to chunk', file.path, e);
			errors[file.path] = String(e);
			return 'unreadable';
		}

		// The actual network cost — the embedding calls — happens here, still fully concurrent with
		// other files' prewarms (bounded only by GeminiEmbeddings' own worker pool + the shared rate
		// limiter). This populates the cache so the locked section below, which vectra requires to be
		// single-file-at-a-time, hits it instantly instead of making its own (serialized) network call.
		await Promise.all(chunks.map((chunk) => this.embeddings.prewarm(chunk.text)));

		// vectra's index only tolerates one begin/end-update transaction in flight at a time, so the
		// actual delete+upsert calls (each of which opens one internally) are serialized here — see
		// `withIndexLock`. Everything above this point (reading, hashing, chunking, embedding) already
		// ran concurrently with other files; only this fast bookkeeping/commit section is
		// single-file-at-a-time.
		const chunkUris = await this.withIndexLock(async () => {
			if (previous) {
				for (const uri of previous.chunkUris) await idx.deleteDocument(uri);
			}
			const uris: string[] = [];
			for (let i = 0; i < chunks.length; i++) {
				const chunk = chunks[i]!;
				const uri = chunk.page !== undefined
					? `${file.path}#p${chunk.page}#c${i}`
					: `${file.path}#L${chunk.line}`;
				await idx.upsertDocument(uri, chunk.text, 'txt', {
					sourcePath: file.path,
					...(chunk.page !== undefined ? { page: chunk.page } : {}),
					...(chunk.line !== undefined ? { line: chunk.line } : {}),
				});
				uris.push(uri);
			}
			return uris;
		});

		manifest[file.path] = { hash, chunkUris };
		delete errors[file.path];
		return 'indexed';
	}

	/** Extracts each PDF page's text, preserving line breaks (via `hasEOL`) so paragraph detection works. */
	private async extractPdfPages(data: Uint8Array): Promise<string[]> {
		const pdf = await pdfjsLib.getDocument({
			data,
			isEvalSupported: false,
			verbosity: 0,
		}).promise;
		const pages: string[] = [];
		for (let p = 1; p <= pdf.numPages; p++) {
			const page = await pdf.getPage(p);
			const content = await page.getTextContent();
			let text = '';
			for (const item of content.items) {
				if (!('str' in item)) continue;
				text += item.str;
				text += item.hasEOL ? '\n' : ' ';
			}
			pages.push(text);
			page.cleanup();
		}
		await pdf.destroy();
		return pages;
	}

	/** Extracts raw text from a .docx file via mammoth (no page concept — paragraphs are chunked like markdown). */
	private async extractDocxText(data: Buffer): Promise<string> {
		const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
		const result = await mammoth.extractRawText({ arrayBuffer });
		return result.value;
	}

	/**
	 * One text block per worksheet, one row per line, cells pipe-separated, with a blank line between
	 * rows — so `chunkPdfPages`' paragraph splitter treats each row as its own paragraph (merging
	 * short consecutive rows up to `chunkWords`, same as it would markdown paragraphs), and evidence
	 * kept as spreadsheets is just as searchable as a written note.
	 */
	private async extractExcelSheets(data: Buffer): Promise<string[]> {
		const workbook = new ExcelJS.Workbook();
		const arrayBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
		await workbook.xlsx.load(arrayBuffer);
		return workbook.worksheets.map((sheet) => {
			const lines: string[] = [];
			sheet.eachRow({ includeEmpty: false }, (row) => {
				const cells: string[] = [];
				row.eachCell({ includeEmpty: false }, (cell) => {
					const text = cellToString(cell.value).trim();
					if (text) cells.push(text);
				});
				if (cells.length > 0) lines.push(cells.join(' | '));
			});
			return lines.join('\n\n');
		});
	}

	/** Paths of all files currently represented in this store's manifest (used to decorate the file explorer). */
	async getIndexedPaths(): Promise<string[]> {
		const manifest = await this.loadManifest();
		return Object.keys(manifest);
	}

	/** filePath -> last error message, for files whose most recent indexing attempt failed. */
	async getErroredPaths(): Promise<ErrorMap> {
		return this.loadErrors();
	}

	async search(query: string, topK: number): Promise<SearchResult[]> {
		const idx = await this.getIndex();
		const results = await idx.queryDocuments(query, { maxDocuments: topK, maxChunks: topK });
		const output: SearchResult[] = [];
		for (const result of results) {
			const metadata = await result.loadMetadata();
			const text = await result.loadText();
			output.push({
				text,
				sourcePath: String(metadata.sourcePath ?? result.uri),
				page: typeof metadata.page === 'number' ? metadata.page : undefined,
				line: typeof metadata.line === 'number' ? metadata.line : undefined,
				score: result.score,
			});
		}
		return output;
	}
}
