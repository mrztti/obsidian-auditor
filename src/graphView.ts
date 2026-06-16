import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from './main';
import { getSection, setSection } from './sections';
import type { GraphNodeDef, GraphEdgeDef } from './graphCanvasView';
import { RefineScopeModal } from './refineScopeModal';

export const GRAPH_VIEW_TYPE = 'auditor-graph-view';

const PHRASES_HEADING = 'Phrases';
const PHRASES_LEVEL = 2 as const;
const SCOPE_LEVEL = 3 as const;
const SCOPE_HEADING_PREFIX = 'Scope: ';
const AUTO_TOP_K = 50;
const DEFAULT_AUTO_THRESHOLD_PCT = 50;

interface PhraseEntry {
	phrase: string;
	mode: 'topk' | 'auto';
	k: number;
	thresholdPct: number;
	/** Extra free-text appended to `phrase` when retrieving documents; persisted separately. */
	scope: string;
}

/** Heading used to persist a given phrase's refine-scope text, stored as its own level-3 section. */
function scopeHeading(phrase: string): string {
	return `${SCOPE_HEADING_PREFIX}${phrase}`;
}

/** Serializes phrase entries as `- phrase :: k` or `- phrase :: auto:thresholdPct` bullet lines. */
function serializePhrases(entries: PhraseEntry[]): string {
	return entries
		.map((e) => (e.mode === 'auto' ? `- ${e.phrase} :: auto:${e.thresholdPct}` : `- ${e.phrase} :: ${e.k}`))
		.join('\n');
}

/** Parses bullet lines back into phrase entries, supporting both the top-k and auto forms. */
function parsePhrases(text: string): PhraseEntry[] {
	const entries: PhraseEntry[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		const autoMatch = /^-\s*(.+?)\s*::\s*auto:(\d+)\s*$/.exec(trimmed);
		if (autoMatch) {
			const phrase = autoMatch[1]!.trim();
			const thresholdPct = Number(autoMatch[2]);
			if (phrase.length > 0) {
				entries.push({ phrase, mode: 'auto', thresholdPct, k: DEFAULT_AUTO_THRESHOLD_PCT, scope: '' });
			}
			continue;
		}
		const topkMatch = /^-\s*(.+?)\s*::\s*(\d+)\s*$/.exec(trimmed);
		if (topkMatch) {
			const phrase = topkMatch[1]!.trim();
			const k = Number(topkMatch[2]);
			if (phrase.length > 0 && k > 0) {
				entries.push({ phrase, mode: 'topk', k, thresholdPct: DEFAULT_AUTO_THRESHOLD_PCT, scope: '' });
			}
		}
	}
	return entries;
}

/**
 * Sidebar tool: lets the user maintain a list of phrases, persisted as
 * markdown bullets in a dedicated note. Each phrase is retrieved either by a
 * fixed top-k, or in "auto" mode — fetching the top 50 results and keeping
 * only documents at or above a confidence threshold. Each phrase can also
 * have a "refine scope" — free text appended to the phrase when searching,
 * persisted as its own level-3 section keyed by phrase text. "Build graph"
 * runs the searches and hands the resulting phrase/document graph off to
 * GraphCanvasView, which renders it as an interactive force-directed graph
 * in the main workspace area.
 */
export class GraphView extends ItemView {
	private plugin: AuditorPlugin;
	private phraseInput!: HTMLInputElement;
	private kInput!: HTMLInputElement;
	private autoCheckbox!: HTMLInputElement;
	private thresholdInput!: HTMLInputElement;
	private listEl!: HTMLElement;
	private statusEl!: HTMLElement;
	private buildBtn!: HTMLButtonElement;
	private entries: PhraseEntry[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: AuditorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return GRAPH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Phrase graph';
	}

	getIcon(): string {
		return 'share-2';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-graph-container');

		container.createEl('h4', { text: 'Phrase graph' });

		const form = container.createDiv('auditor-graph-form');
		this.phraseInput = form.createEl('input', {
			type: 'text',
			placeholder: 'Phrase or word…',
			cls: 'auditor-graph-phrase-input',
		});
		this.kInput = form.createEl('input', {
			type: 'number',
			placeholder: 'k',
			cls: 'auditor-graph-k-input',
		});
		this.kInput.value = String(this.plugin.settings.maxResults);
		this.kInput.min = '1';

		this.thresholdInput = form.createEl('input', {
			type: 'number',
			placeholder: 'min %',
			cls: 'auditor-graph-threshold-input',
		});
		this.thresholdInput.value = String(DEFAULT_AUTO_THRESHOLD_PCT);
		this.thresholdInput.min = '1';
		this.thresholdInput.max = '100';
		this.thresholdInput.addClass('auditor-graph-hidden');

		const autoLabel = form.createEl('label', { cls: 'auditor-graph-auto-label' });
		this.autoCheckbox = autoLabel.createEl('input', { type: 'checkbox' });
		autoLabel.createSpan({ text: 'Auto' });
		this.autoCheckbox.addEventListener('change', () => {
			const isAuto = this.autoCheckbox.checked;
			this.kInput.toggleClass('auditor-graph-hidden', isAuto);
			this.thresholdInput.toggleClass('auditor-graph-hidden', !isAuto);
		});

		const addBtn = form.createEl('button', { text: 'Add', cls: 'mod-cta' });
		const addEntry = () => { void this.addPhrase(); };
		addBtn.addEventListener('click', addEntry);
		this.phraseInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') addEntry();
		});

		this.listEl = container.createDiv('auditor-graph-list');

		this.buildBtn = container.createEl('button', { text: 'Build graph', cls: 'auditor-graph-build-btn mod-cta' });
		this.buildBtn.addEventListener('click', () => { void this.buildGraph(); });

		this.statusEl = container.createDiv('auditor-graph-status');

		await this.loadPhrases();
		this.renderList();
	}

	async onClose(): Promise<void> {}

	private async ensureGraphNote(): Promise<import('obsidian').TFile> {
		const path = this.plugin.settings.graphNotePath;
		const existing = this.app.vault.getFileByPath(path);
		if (existing) return existing;
		return this.app.vault.create(path, `## ${PHRASES_HEADING}\n\n`);
	}

	private async loadPhrases(): Promise<void> {
		const file = await this.ensureGraphNote();
		const content = await this.app.vault.read(file);
		const entries = parsePhrases(getSection(content, PHRASES_HEADING, PHRASES_LEVEL));
		for (const entry of entries) {
			entry.scope = getSection(content, scopeHeading(entry.phrase), SCOPE_LEVEL).trim();
		}
		this.entries = entries;
	}

	private async savePhrases(): Promise<void> {
		const file = await this.ensureGraphNote();
		await this.app.vault.process(file, (current) =>
			setSection(current, PHRASES_HEADING, PHRASES_LEVEL, serializePhrases(this.entries)),
		);
	}

	private async saveScope(phrase: string, scope: string): Promise<void> {
		const file = await this.ensureGraphNote();
		await this.app.vault.process(file, (current) =>
			setSection(current, scopeHeading(phrase), SCOPE_LEVEL, scope),
		);
	}

	private async addPhrase(): Promise<void> {
		const phrase = this.phraseInput.value.trim();
		if (!phrase) {
			new Notice('Auditor: enter a phrase.');
			return;
		}

		if (this.autoCheckbox.checked) {
			const thresholdPct = Number(this.thresholdInput.value);
			if (!Number.isFinite(thresholdPct) || thresholdPct < 1 || thresholdPct > 100) {
				new Notice('Auditor: enter a valid confidence threshold (1-100).');
				return;
			}
			this.entries.push({ phrase, mode: 'auto', thresholdPct: Math.round(thresholdPct), k: DEFAULT_AUTO_THRESHOLD_PCT, scope: '' });
		} else {
			const k = Number(this.kInput.value);
			if (!Number.isFinite(k) || k < 1) {
				new Notice('Auditor: enter a valid top-k.');
				return;
			}
			this.entries.push({ phrase, mode: 'topk', k: Math.round(k), thresholdPct: DEFAULT_AUTO_THRESHOLD_PCT, scope: '' });
		}

		this.phraseInput.value = '';
		await this.savePhrases();
		this.renderList();
	}

	private async removePhrase(index: number): Promise<void> {
		this.entries.splice(index, 1);
		await this.savePhrases();
		this.renderList();
	}

	private openRefineScope(entry: PhraseEntry): void {
		new RefineScopeModal(this.app, entry.phrase, entry.scope, (text) => {
			entry.scope = text;
			void this.saveScope(entry.phrase, text);
			this.renderList();
		}).open();
	}

	private renderList(): void {
		this.listEl.empty();
		if (this.entries.length === 0) {
			this.listEl.createEl('p', { text: 'No phrases yet — add one above.', cls: 'auditor-status' });
			return;
		}
		this.entries.forEach((entry, i) => {
			const row = this.listEl.createDiv('auditor-graph-phrase-row');
			row.createSpan({ text: entry.phrase, cls: 'auditor-graph-phrase-label' });
			row.createSpan({
				text: entry.mode === 'auto' ? `auto ≥${entry.thresholdPct}%` : `top-${entry.k}`,
				cls: 'auditor-graph-phrase-k',
			});
			const scopeBtn = row.createEl('button', {
				text: 'Refine scope',
				cls: 'auditor-graph-phrase-scope-btn',
			});
			scopeBtn.toggleClass('is-active', entry.scope.length > 0);
			scopeBtn.addEventListener('click', () => { this.openRefineScope(entry); });
			const removeBtn = row.createEl('button', { text: '✕', cls: 'auditor-graph-phrase-remove' });
			removeBtn.addEventListener('click', () => { void this.removePhrase(i); });
		});
	}

	private async buildGraph(): Promise<void> {
		if (this.entries.length === 0) {
			new Notice('Auditor: add at least one phrase first.');
			return;
		}
		this.statusEl.empty();
		this.statusEl.createEl('p', { text: 'Searching…', cls: 'auditor-status' });
		this.buildBtn.disabled = true;
		try {
			// Map of filePath -> set of phrase indices whose results retrieved it.
			const docToPhrases = new Map<string, Set<number>>();
			for (let i = 0; i < this.entries.length; i++) {
				const entry = this.entries[i]!;
				const query = entry.scope ? `${entry.phrase}\n\n${entry.scope}` : entry.phrase;
				const results = entry.mode === 'auto'
					? (await this.plugin.indexer.search(query, AUTO_TOP_K))
						.filter((r) => r.score >= entry.thresholdPct / 100)
					: await this.plugin.indexer.search(query, entry.k);

				for (const result of results) {
					let set = docToPhrases.get(result.filePath);
					if (!set) {
						set = new Set();
						docToPhrases.set(result.filePath, set);
					}
					set.add(i);
				}
			}

			if (docToPhrases.size === 0) {
				this.statusEl.empty();
				this.statusEl.createEl('p', { text: 'No documents retrieved for any phrase.', cls: 'auditor-status' });
				return;
			}

			const nodes: GraphNodeDef[] = this.entries.map((entry, i) => ({
				id: `phrase:${i}`,
				label: entry.phrase,
				kind: 'phrase',
			}));
			const edges: GraphEdgeDef[] = [];
			for (const [filePath, phraseSet] of docToPhrases) {
				const fileName = filePath.split('/').pop()?.replace(/\.\w+$/, '') ?? filePath;
				nodes.push({ id: `doc:${filePath}`, label: fileName, kind: 'document', filePath });
				for (const i of phraseSet) {
					edges.push({ source: `phrase:${i}`, target: `doc:${filePath}` });
				}
			}

			await this.plugin.openGraphCanvas(nodes, edges);
			this.statusEl.empty();
			this.statusEl.createEl('p', { text: 'Graph opened in the main view.', cls: 'auditor-status' });
		} catch (e) {
			this.statusEl.empty();
			this.statusEl.createEl('p', { text: `Search failed: ${String(e)}`, cls: 'auditor-status' });
		} finally {
			this.buildBtn.disabled = false;
		}
	}
}
