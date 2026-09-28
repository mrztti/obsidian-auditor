import { Type } from '@google/genai';
import type { TFile } from 'obsidian';
import type AuditorPlugin from '../../main';
import type { StoreKind } from '../../main';
import type { SearchResult } from '../../vectorStore';
import { clampInt, str, truncate, type AgentTool } from './types';

const SOURCES: StoreKind[] = ['standards', 'evidence', 'interviewEvidence', 'writtenControls'];

const SOURCE_DESCRIPTION =
	'"standards" = the standards/requirements being audited against; "evidence" = evidence documents supplied by the audited party; "interviewEvidence" = meeting/interview notes and evidence gathered in sessions; "writtenControls" = the control notes themselves.';

function folderFor(plugin: AuditorPlugin, kind: StoreKind): string {
	const s = plugin.settings;
	if (kind === 'standards') return s.standardsFolder;
	if (kind === 'evidence') return s.evidenceFolder;
	if (kind === 'interviewEvidence') return s.interviewEvidenceFolder;
	return s.writtenControlsFolder;
}

function inFolder(file: TFile, folder: string): boolean {
	return !folder || file.path.startsWith(`${folder}/`);
}

function label(r: SearchResult): string {
	if (r.page !== undefined) return `${r.sourcePath} (p. ${r.page})`;
	if (r.line !== undefined) return `${r.sourcePath} (L${r.line})`;
	return r.sourcePath;
}

const parseSources = (raw: unknown): StoreKind[] => {
	const picked = (Array.isArray(raw) ? raw : []).filter((s): s is StoreKind => SOURCES.includes(s as StoreKind));
	return picked.length > 0 ? picked : SOURCES;
};

export const searchDocumentsTool: AgentTool = {
	declaration: {
		name: 'search_documents',
		description:
			'Semantic search over the vault\'s indexed documents. Use it to find standards clauses, evidence, meeting/interview notes, or other written controls relevant to a topic. Write keyword-dense queries (concepts, synonyms, terms likely to appear in the text) rather than restating the user\'s message. Run several searches with different angles when the first is thin. Results are chunks with their file path; use read_document for the whole file.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				query: { type: Type.STRING, description: 'Keyword-dense search query.' },
				sources: { type: Type.ARRAY, items: { type: Type.STRING, enum: SOURCES }, description: `Which indexes to search (default: all). ${SOURCE_DESCRIPTION}` },
				limit: { type: Type.INTEGER, description: 'Max results per source (default 8, max 20).' },
			},
			required: ['query'],
		},
	},
	label: (a) => `Searching documents: ${str(a.query)}`,
	run: async (args, ctx) => {
		const query = str(args.query).trim();
		if (!query) return { ok: false, output: { error: 'query is required.' }, summary: 'Empty search query' };
		const limit = clampInt(args.limit, 8, 1, 20);
		const kinds = parseSources(args.sources);
		const perStore = await Promise.all(kinds.map((k) => ctx.plugin.storeFor(k).search(query, limit).catch(() => [] as SearchResult[])));
		const results = perStore
			.flatMap((rs, i) => rs.map((r) => ({ source: kinds[i]!, r })))
			.sort((a, b) => b.r.score - a.r.score);
		return {
			output: {
				resultCount: results.length,
				results: results.map(({ source, r }) => ({ source, location: label(r), path: r.sourcePath, score: Number(r.score.toFixed(3)), text: truncate(r.text, 1500) })),
				...(results.length === 0 ? { hint: 'Nothing found. The index may be empty or not built yet, or try different terms.' } : {}),
			},
			summary: `${results.length} results across ${kinds.join(', ')}`,
		};
	},
};

export const listDocumentsTool: AgentTool = {
	declaration: {
		name: 'list_documents',
		description:
			'List files in one of the vault\'s document folders, optionally filtered by a substring of the file name/path (e.g. a date or meeting name). Use this to find a specific meeting note or evidence file by name, newest first.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				source: { type: Type.STRING, enum: SOURCES, description: SOURCE_DESCRIPTION },
				nameContains: { type: Type.STRING, description: 'Case-insensitive substring of the path.' },
				limit: { type: Type.INTEGER, description: 'Default 30, max 100.' },
			},
			required: ['source'],
		},
	},
	label: (a) => `Listing ${str(a.source)} files${str(a.nameContains) ? ` matching "${str(a.nameContains)}"` : ''}`,
	run: (args, ctx) => {
		const source = str(args.source) as StoreKind;
		if (!SOURCES.includes(source)) return Promise.resolve({ ok: false, output: { error: `source must be one of ${SOURCES.join(', ')}` }, summary: 'Unknown source' });
		const needle = str(args.nameContains).toLowerCase();
		const folder = folderFor(ctx.plugin, source);
		const files = ctx.plugin.app.vault
			.getFiles()
			.filter((f) => inFolder(f, folder) && (!needle || f.path.toLowerCase().includes(needle)))
			.sort((a, b) => b.stat.mtime - a.stat.mtime);
		const limit = clampInt(args.limit, 30, 1, 100);
		return Promise.resolve({
			output: {
				total: files.length,
				files: files.slice(0, limit).map((f) => ({ path: f.path, modified: new Date(f.stat.mtime).toISOString().slice(0, 10), sizeKb: Math.round(f.stat.size / 1024) })),
			},
			summary: `${files.length} files in ${source}`,
		});
	},
};

/** Max characters of one document returned per read — the model can page through longer ones. */
const READ_CHUNK_CHARS = 12000;

export const readDocumentTool: AgentTool = {
	declaration: {
		name: 'read_document',
		description:
			'Read a whole document from the vault (markdown, text, PDF, Word or Excel) by its exact path, as returned by search_documents or list_documents. Long documents are returned in pieces: pass `offset` from the previous result\'s `nextOffset` to continue.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				path: { type: Type.STRING, description: 'Exact vault path.' },
				offset: { type: Type.INTEGER, description: 'Character offset to start from (default 0).' },
			},
			required: ['path'],
		},
	},
	label: (a) => `Reading ${str(a.path)}`,
	run: async (args, ctx) => {
		const path = str(args.path);
		const { vault } = ctx.plugin.app;
		const file = vault.getFileByPath(path);
		if (!file) return { ok: false, output: { error: `No file at "${path}". Use list_documents or search_documents to get exact paths.` }, summary: `File not found: ${path}` };
		const allowed = (['standards', 'evidence', 'interviewEvidence', 'writtenControls'] as StoreKind[]).some((k) => inFolder(file, folderFor(ctx.plugin, k)))
			|| inFolder(file, ctx.plugin.settings.interviewSessionPlansFolder);
		if (!allowed) return { ok: false, output: { error: 'That file is outside the configured audit folders.' }, summary: 'File outside audit folders' };

		let pages: string[] | null;
		try {
			pages = await ctx.plugin.storeFor('evidence').readPages(vault, file);
		} catch (e) {
			return { ok: false, output: { error: `Could not read the file: ${String(e)}` }, summary: `Could not read ${path}` };
		}
		if (!pages) return { ok: false, output: { error: `Unsupported file type ".${file.extension}".` }, summary: `Unsupported type: ${file.extension}` };

		const paged = pages.length > 1;
		const text = paged ? pages.map((p, i) => `--- page/sheet ${i + 1} ---\n${p}`).join('\n\n') : (pages[0] ?? '');
		const offset = clampInt(args.offset, 0, 0, Math.max(text.length - 1, 0));
		const slice = text.slice(offset, offset + READ_CHUNK_CHARS);
		const end = offset + slice.length;
		return {
			output: {
				path,
				totalChars: text.length,
				offset,
				text: slice,
				...(end < text.length ? { nextOffset: end, note: 'Document continues — call read_document again with nextOffset if you need the rest.' } : {}),
			},
			summary: `Read ${path} (${offset}–${end} of ${text.length} chars)`,
		};
	},
};
