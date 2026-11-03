import { Notice } from 'obsidian';
import type AuditorPlugin from '../main';
import { CONTROL_RATINGS, CONTROL_STATUSES, type ControlRecord } from '../controlNote';
import type { ControlSelectionCandidate } from '../geminiGenerate';
import type { ReviewerData } from './reviewerData';

const RENDER_CHUNK = 400;
/** Characters of control descriptions sent to the model per call — bounds each request, not how many controls can be selected. */
const AI_BATCH_CHARS = 90_000;

type Facet = 'session' | 'standard' | 'topic' | 'status';
type ConclusionFilter = '' | 'has' | 'missing';

interface Filters {
	text: string;
	facets: Record<Facet, Set<string>>;
	todRating: string;
	toeRating: string;
	todConclusion: ConclusionFilter;
	toeConclusion: ConclusionFilter;
	notes: ConclusionFilter;
}

const emptyFilters = (): Filters => ({
	text: '',
	facets: { session: new Set(), standard: new Set(), topic: new Set(), status: new Set() },
	todRating: '',
	toeRating: '',
	todConclusion: '',
	toeConclusion: '',
	notes: '',
});

const NOT_RATED = '__none__';

function matchesRating(value: string, wanted: string): boolean {
	if (!wanted) return true;
	return wanted === NOT_RATED ? value === '' : value === wanted;
}

function matchesPresence(text: string, wanted: ConclusionFilter): boolean {
	if (!wanted) return true;
	return wanted === 'has' ? text.trim() !== '' : text.trim() === '';
}

function matches(r: ControlRecord, f: Filters): boolean {
	for (const facet of Object.keys(f.facets) as Facet[]) {
		const set = f.facets[facet];
		if (set.size > 0 && !set.has(r[facet])) return false;
	}
	if (!matchesRating(r.todRating, f.todRating) || !matchesRating(r.toeRating, f.toeRating)) return false;
	if (!matchesPresence(r.todConclusion, f.todConclusion) || !matchesPresence(r.toeConclusion, f.toeConclusion) || !matchesPresence(r.reviewNotes, f.notes)) return false;
	const q = f.text.trim().toLowerCase();
	if (q && ![r.number, r.control, r.todConclusion, r.toeConclusion].some((t) => t.toLowerCase().includes(q))) return false;
	return true;
}

const excerpt = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function describe(r: ControlRecord): string {
	return [
		[r.standard, r.topic, r.session && `session ${r.session}`, `status ${r.status}`, `ToD ${r.todRating || 'not rated'}`, `ToE ${r.toeRating || 'not rated'}`].filter(Boolean).join(' | '),
		`Control: ${excerpt(r.control, 700)}`,
		`Stage 1 conclusion: ${excerpt(r.todConclusion, 300) || '(none)'}`,
		`Stage 2 conclusion: ${excerpt(r.toeConclusion, 300) || '(none)'}`,
	].join('\n');
}

/**
 * The Reviewer's selection tab: narrow the controls down with filters and/or an AI request, tick
 * the ones wanted and add them to the review set. There is no cap on how many can be selected.
 */
export class SelectTab {
	private filters = emptyFilters();
	private checked = new Set<string>();
	/** When set, the list shows only the AI's picks (with reasons) instead of the filtered list. */
	private ai: { reasons: Map<string, string>; note: string } | null = null;
	private shown = RENDER_CHUNK;
	private filterPanel: HTMLElement;
	private resultsEl: HTMLElement;
	private listEl!: HTMLElement;
	private countEl!: HTMLElement;
	private actionEl!: HTMLElement;
	private aiStatusEl!: HTMLElement;
	private aiBtn!: HTMLButtonElement;
	private aiRunning = false;
	private aiCancelled = false;
	/** Signature of the facet options last rendered — the filter panel is only rebuilt when it changes, so open sections and the AI request text survive routine reloads. */
	private filterSig = '';

	constructor(root: HTMLElement, private plugin: AuditorPlugin, private data: ReviewerData, private goToReview: () => void) {
		this.filterPanel = root.createDiv('auditor-rv-filters');
		this.resultsEl = root.createDiv('auditor-rv-results');
		this.renderResultsShell();
		data.onChange(() => {
			const sig = (['session', 'topic', 'standard', 'status'] as Facet[]).map((f) => this.distinct(f).join('\u0001')).join('\u0002');
			if (sig !== this.filterSig) { this.filterSig = sig; this.renderFilters(); }
			this.renderList();
		});
		this.renderFilters();
		this.renderList();
	}

	private pool(): ControlRecord[] {
		return this.data.entries.map((e) => e.record).filter((r) => matches(r, this.filters));
	}

	private distinct(facet: Facet): string[] {
		return [...new Set(this.data.entries.map((e) => e.record[facet]).filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
	}

	// ─── filters ───────────────────────────────────────────────────────────

	private renderFilters(): void {
		const panel = this.filterPanel;
		const scrollTop = panel.scrollTop;
		panel.empty();
		panel.createEl('h3', { text: 'Filters', cls: 'auditor-rv-panel-title' });

		const search = panel.createEl('input', { type: 'text', cls: 'auditor-rv-filter-search' });
		search.placeholder = 'Search number, control or conclusion text…';
		search.value = this.filters.text;
		search.addEventListener('keydown', (e) => e.stopPropagation());
		search.addEventListener('input', () => { this.filters.text = search.value; this.ai = null; this.shown = RENDER_CHUNK; this.renderList(); });

		for (const [facet, label] of [['session', 'Session'], ['topic', 'Topic'], ['standard', 'Standard'], ['status', 'Status']] as [Facet, string][]) {
			this.renderFacet(panel, facet, label, facet === 'status' ? [...new Set([...CONTROL_STATUSES, ...this.distinct('status')])] : this.distinct(facet));
		}

		this.renderSelect(panel, 'Stage 1 rating', this.filters.todRating, [['', 'Any'], [NOT_RATED, 'Not rated'], ...CONTROL_RATINGS.filter(Boolean).map((r): [string, string] => [r, r])], (v) => { this.filters.todRating = v; });
		this.renderSelect(panel, 'Stage 2 rating', this.filters.toeRating, [['', 'Any'], [NOT_RATED, 'Not rated'], ...CONTROL_RATINGS.filter(Boolean).map((r): [string, string] => [r, r])], (v) => { this.filters.toeRating = v; });
		const presence: [string, string][] = [['', 'Any'], ['has', 'Has one'], ['missing', 'Missing']];
		this.renderSelect(panel, 'Stage 1 conclusion', this.filters.todConclusion, presence, (v) => { this.filters.todConclusion = v as ConclusionFilter; });
		this.renderSelect(panel, 'Stage 2 conclusion', this.filters.toeConclusion, presence, (v) => { this.filters.toeConclusion = v as ConclusionFilter; });
		this.renderSelect(panel, 'Review notes', this.filters.notes, [['', 'Any'], ['has', 'Has notes'], ['missing', 'No notes']], (v) => { this.filters.notes = v as ConclusionFilter; });

		panel.createEl('button', { text: 'Clear filters', cls: 'auditor-rv-clear' }).addEventListener('click', () => {
			this.filters = emptyFilters();
			this.ai = null;
			this.shown = RENDER_CHUNK;
			this.renderFilters();
			this.renderList();
		});

		this.renderAiBox(panel);
		panel.scrollTop = scrollTop;
	}

	private renderFacet(panel: HTMLElement, facet: Facet, label: string, options: string[]): void {
		const selected = this.filters.facets[facet];
		const details = panel.createEl('details', { cls: 'auditor-rv-facet' });
		if (selected.size > 0) details.open = true;
		details.createEl('summary', { text: selected.size > 0 ? `${label} (${selected.size})` : label });
		const list = details.createDiv('auditor-rv-facet-list');
		if (options.length === 0) list.createDiv({ text: 'No values yet.', cls: 'auditor-field-description' });
		for (const opt of options) {
			const row = list.createEl('label', { cls: 'auditor-checkbox-label' });
			const box = row.createEl('input', { type: 'checkbox' });
			box.checked = selected.has(opt);
			row.createSpan({ text: opt });
			box.addEventListener('change', () => {
				if (box.checked) selected.add(opt);
				else selected.delete(opt);
				details.querySelector('summary')?.setText(selected.size > 0 ? `${label} (${selected.size})` : label);
				this.ai = null;
				this.shown = RENDER_CHUNK;
				this.renderList();
			});
		}
	}

	private renderSelect(panel: HTMLElement, label: string, value: string, options: [string, string][], set: (v: string) => void): void {
		const wrap = panel.createDiv('auditor-rv-filter-field');
		wrap.createEl('label', { text: label, cls: 'auditor-field-label' });
		const select = wrap.createEl('select');
		for (const [v, text] of options) {
			const o = select.createEl('option', { text, value: v });
			if (v === value) o.selected = true;
		}
		select.addEventListener('change', () => { set(select.value); this.ai = null; this.shown = RENDER_CHUNK; this.renderList(); });
	}

	// ─── AI selection ──────────────────────────────────────────────────────

	private renderAiBox(panel: HTMLElement): void {
		const box = panel.createDiv('auditor-rv-ai');
		box.createEl('h3', { text: 'Select with AI', cls: 'auditor-rv-panel-title' });
		const input = box.createEl('textarea', { cls: 'auditor-rv-ai-input' });
		input.rows = 4;
		input.placeholder = 'Describe what to review, e.g. "controls about access management whose conclusion has no recommendation". Applies to the filtered list above.';
		input.addEventListener('keydown', (e) => e.stopPropagation());
		this.aiBtn = box.createEl('button', { text: 'Find controls', cls: 'mod-cta' });
		this.aiStatusEl = box.createDiv({ cls: 'auditor-field-description' });
		this.aiBtn.addEventListener('click', () => {
			if (this.aiRunning) { this.aiCancelled = true; this.aiStatusEl.setText('Stopping after the current batch…'); return; }
			void this.runAi(input.value.trim());
		});
	}

	private async runAi(request: string): Promise<void> {
		if (!request) return;
		if (!this.plugin.settings.geminiApiKey) {
			new Notice('Auditor: add your Gemini API key in the plugin settings first.');
			return;
		}
		const pool = this.pool();
		if (pool.length === 0) { this.aiStatusEl.setText('No controls match the filters.'); return; }

		const batches: ControlSelectionCandidate[][] = [];
		let current: ControlSelectionCandidate[] = [];
		let size = 0;
		for (const r of pool) {
			const description = describe(r);
			if (current.length > 0 && size + description.length > AI_BATCH_CHARS) { batches.push(current); current = []; size = 0; }
			current.push({ number: r.number, description });
			size += description.length;
		}
		if (current.length > 0) batches.push(current);

		this.aiRunning = true;
		this.aiCancelled = false;
		this.aiBtn.setText('Stop');
		const valid = new Set(pool.map((r) => r.number));
		const picks = new Map<string, { reason: string; relevance: number }>();
		let limit = 0;
		try {
			for (let i = 0; i < batches.length; i++) {
				if (this.aiCancelled) break;
				this.aiStatusEl.setText(`Reading controls… batch ${i + 1} of ${batches.length}`);
				const result = await this.plugin.geminiGenerate.selectControlsForReview(request, batches[i] ?? []);
				if (result.limit > 0) limit = limit > 0 ? Math.min(limit, result.limit) : result.limit;
				for (const s of result.selected) {
					if (valid.has(s.controlNumber)) picks.set(s.controlNumber, { reason: s.reason, relevance: s.relevance });
				}
			}
			let chosen = [...picks.entries()];
			let note = `${chosen.length} control${chosen.length === 1 ? '' : 's'} selected by the AI.`;
			if (limit > 0 && chosen.length > limit) {
				chosen = chosen.sort((a, b) => b[1].relevance - a[1].relevance).slice(0, limit);
				note = `Your request asked for ${limit}; showing the ${limit} best fits.`;
			}
			if (this.aiCancelled) note += ' (stopped early)';
			this.ai = { reasons: new Map(chosen.map(([n, v]) => [n, v.reason])), note };
			this.checked = new Set(chosen.map(([n]) => n));
			this.shown = RENDER_CHUNK;
			this.aiStatusEl.setText(note);
			this.renderList();
		} catch (e) {
			this.aiStatusEl.setText(`AI selection failed: ${String(e)}`);
		} finally {
			this.aiRunning = false;
			this.aiBtn.setText('Find controls');
		}
	}

	// ─── results ───────────────────────────────────────────────────────────

	private renderResultsShell(): void {
		const head = this.resultsEl.createDiv('auditor-rv-results-head');
		this.countEl = head.createDiv({ cls: 'auditor-rv-results-count' });
		const bulk = head.createDiv('auditor-rv-results-bulk');
		bulk.createEl('button', { text: 'Select all' }).addEventListener('click', () => { for (const r of this.visible()) this.checked.add(r.number); this.renderList(); });
		bulk.createEl('button', { text: 'Deselect all' }).addEventListener('click', () => { this.checked.clear(); this.renderList(); });
		this.actionEl = this.resultsEl.createDiv('auditor-rv-results-actions');
		this.listEl = this.resultsEl.createDiv('auditor-rv-results-list');
	}

	private visible(): ControlRecord[] {
		if (this.ai) return this.ai.reasons.size === 0 ? [] : this.data.entries.map((e) => e.record).filter((r) => this.ai?.reasons.has(r.number));
		return this.pool();
	}

	private renderList(): void {
		const rows = this.visible();
		const total = this.data.entries.length;
		this.countEl.setText(this.ai ? `${this.ai.note}` : rows.length === total ? `${total} controls` : `${rows.length} of ${total} controls`);

		this.listEl.empty();
		if (rows.length === 0) this.listEl.createDiv({ text: 'No controls match.', cls: 'auditor-field-description' });
		for (const r of rows.slice(0, this.shown)) {
			const row = this.listEl.createEl('label', { cls: 'auditor-rv-result-row' });
			const box = row.createEl('input', { type: 'checkbox' });
			box.checked = this.checked.has(r.number);
			box.addEventListener('change', () => {
				if (box.checked) this.checked.add(r.number);
				else this.checked.delete(r.number);
				this.renderActions();
			});
			const text = row.createDiv('auditor-rv-result-text');
			const title = text.createDiv('auditor-rv-result-title');
			title.createSpan({ text: r.number, cls: 'auditor-rv-list-item-number' });
			title.createSpan({ text: [r.topic, r.session && `Session ${r.session}`, r.status, `ToD ${r.todRating || '—'}`, `ToE ${r.toeRating || '—'}`].filter(Boolean).join('  ·  '), cls: 'auditor-rv-result-meta' });
			text.createDiv({ text: excerpt(r.control, 220), cls: 'auditor-rv-result-control' });
			const reason = this.ai?.reasons.get(r.number);
			if (reason) text.createDiv({ text: reason, cls: 'auditor-rv-result-reason' });
		}
		if (rows.length > this.shown) {
			this.listEl.createEl('button', { text: `Show ${Math.min(RENDER_CHUNK, rows.length - this.shown)} more` }).addEventListener('click', () => { this.shown += RENDER_CHUNK; this.renderList(); });
		}
		this.renderActions();
	}

	private renderActions(): void {
		this.actionEl.empty();
		const inSet = this.data.reviewSet();
		const picked = [...this.checked].filter((n) => this.data.get(n));
		this.actionEl.createSpan({ text: `${picked.length} selected · ${inSet.length} in the review set`, cls: 'auditor-rv-results-summary' });
		const add = this.actionEl.createEl('button', { text: `Add ${picked.length} to review set`, cls: 'mod-cta' });
		add.disabled = picked.length === 0;
		add.addEventListener('click', () => { void this.data.setReviewSet([...inSet, ...picked]).then(this.goToReview); });
		const replace = this.actionEl.createEl('button', { text: 'Replace review set' });
		replace.disabled = picked.length === 0;
		replace.addEventListener('click', () => { void this.data.setReviewSet(picked).then(this.goToReview); });
		const clear = this.actionEl.createEl('button', { text: 'Empty review set' });
		clear.disabled = inSet.length === 0;
		clear.addEventListener('click', () => { void this.data.setReviewSet([]); });
	}
}
