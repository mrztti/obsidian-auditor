import { CONTROL_RATINGS, type ControlRecord } from '../controlNote';
import type { ReviewerData, ReviewerPatch } from './reviewerData';

const SAVE_DEBOUNCE_MS = 700;

const RATING_CLASS: Record<string, string> = { C: 'auditor-rating-c', 'C*': 'auditor-rating-cstar', NC: 'auditor-rating-nc', '-': 'auditor-rating-na' };

/** Plain textareas/inputs let keydown bubble to app-level handlers (which swallow e.g. Backspace) — see controlFields.ts. */
function isolateKeys(el: HTMLElement): void {
	el.addEventListener('keydown', (evt) => { evt.stopPropagation(); });
}

function ratingBadge(parent: HTMLElement, label: string, rating: string): void {
	const badge = parent.createSpan({ cls: `auditor-rating-badge ${RATING_CLASS[rating] ?? 'auditor-rating-none'}` });
	badge.setText(`${label} ${rating || '—'}`);
}

/**
 * The Reviewer's main tab: the review set as a scrollable list on the left, the open control
 * (text, ratings, conclusions — all editable) in the middle, and a large notes pane on the right.
 * Edits autosave straight into the control note.
 */
export class ReviewTab {
	private listEl!: HTMLElement;
	private centerEl!: HTMLElement;
	private notesEl!: HTMLElement;
	private statusEl: HTMLElement | null = null;
	private currentNumber: string | null = null;
	private pending: ReviewerPatch = {};
	private saveTimer: number | null = null;
	private notesInput: HTMLTextAreaElement | null = null;
	private shownControl = '';

	constructor(private root: HTMLElement, private data: ReviewerData, private goToSelect: () => void) {
		this.listEl = root.createDiv('auditor-rv-list');
		this.centerEl = root.createDiv('auditor-rv-center');
		this.notesEl = root.createDiv('auditor-rv-notes');
		data.onChange(() => this.onDataChanged());
		this.renderList();
		this.renderEditor();
	}

	/** Writes any pending edit now — called when switching control, switching tab and closing the view. */
	async flush(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		const number = this.currentNumber;
		const patch = this.pending;
		if (!number || Object.keys(patch).length === 0) return;
		this.pending = {};
		this.setStatus('Saving…');
		try {
			await this.data.save(number, patch);
			this.setStatus('Saved');
		} catch (e) {
			this.pending = { ...patch, ...this.pending };
			this.setStatus(`Save failed: ${String(e)}`);
		}
	}

	private queue(patch: ReviewerPatch): void {
		Object.assign(this.pending, patch);
		this.setStatus('Unsaved changes…');
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => { void this.flush(); }, SAVE_DEBOUNCE_MS);
	}

	private setStatus(text: string): void {
		this.statusEl?.setText(text);
	}

	private onDataChanged(): void {
		const before = this.currentNumber;
		this.renderList();
		const number = this.currentNumber;
		if (number !== before) {
			this.pending = {};
			this.renderEditor();
			return;
		}
		if (!number) return;
		const record = this.data.get(number)?.record;
		if (!record) {
			this.currentNumber = null;
			this.renderEditor();
			return;
		}
		if (Object.keys(this.pending).length === 0) this.syncFromRecord(record);
	}

	/**
	 * Brings the open editor in line with a note that changed on disk, WITHOUT rebuilding it: only
	 * fields whose text really differs are updated, and never the one being typed in. (Saved text is
	 * trimmed, so comparing raw values would make every autosave look like an outside edit whenever
	 * the user had a trailing space or newline — the cause of the focus loss this replaced.)
	 */
	private syncFromRecord(record: ControlRecord): void {
		const norm = (v: string) => v.replace(/\r\n/g, '\n').trim();
		const fields: [HTMLSelectElement | HTMLTextAreaElement | null | undefined, string][] = [
			[this.stageEls.todRating, record.todRating],
			[this.stageEls.toeRating, record.toeRating],
			[this.stageEls.todConclusion, record.todConclusion],
			[this.stageEls.toeConclusion, record.toeConclusion],
			[this.notesInput, record.reviewNotes],
		];
		for (const [el, value] of fields) {
			if (el && el !== activeDocument.activeElement && norm(el.value) !== norm(value)) el.value = value;
		}
		const editing = this.centerEl.contains(activeDocument.activeElement) || this.notesEl.contains(activeDocument.activeElement);
		if (record.control !== this.shownControl && !editing) this.renderEditor();
	}

	private async select(number: string): Promise<void> {
		if (number === this.currentNumber) return;
		await this.flush();
		this.currentNumber = number;
		this.renderList();
		this.renderEditor();
	}

	private renderList(): void {
		this.listEl.empty();
		const numbers = this.data.reviewSet();
		this.listEl.createDiv({ text: `To review (${numbers.length})`, cls: 'auditor-rv-list-title' });
		if (this.currentNumber === null || !numbers.includes(this.currentNumber)) this.currentNumber = numbers[0] ?? null;
		const scroll = this.listEl.createDiv('auditor-rv-list-scroll');
		for (const number of numbers) {
			const record = this.data.get(number)?.record;
			if (!record) continue;
			const item = scroll.createDiv('auditor-rv-list-item');
			item.toggleClass('is-active', number === this.currentNumber);
			const head = item.createDiv('auditor-rv-list-item-head');
			head.createSpan({ text: number, cls: 'auditor-rv-list-item-number' });
			if (record.reviewNotes.trim()) head.createSpan({ cls: 'auditor-rv-notes-dot', attr: { 'aria-label': 'Has review notes' } });
			if (record.topic) item.createDiv({ text: record.topic, cls: 'auditor-rv-list-item-topic' });
			const badges = item.createDiv('auditor-rv-list-item-badges');
			ratingBadge(badges, 'ToD', record.todRating);
			ratingBadge(badges, 'ToE', record.toeRating);
			item.addEventListener('click', () => { void this.select(number); });
		}
	}

	private renderEditor(): void {
		this.centerEl.empty();
		this.notesEl.empty();
		this.statusEl = null;
		this.notesInput = null;
		const record = this.currentNumber ? this.data.get(this.currentNumber)?.record : undefined;
		if (!record) {
			const empty = this.centerEl.createDiv('auditor-rv-empty');
			empty.createEl('h3', { text: 'Nothing to review yet' });
			empty.createEl('p', { text: 'Choose the controls to review first.', cls: 'auditor-field-description' });
			empty.createEl('button', { text: 'Select controls', cls: 'mod-cta' }).addEventListener('click', this.goToSelect);
			return;
		}

		const header = this.centerEl.createDiv('auditor-rv-header');
		header.createEl('h2', { text: `Control ${record.number}`, cls: 'auditor-rv-title' });
		const meta = [record.standard, record.topic, record.session ? `Session ${record.session}` : '', record.status].filter(Boolean).join('  ·  ');
		if (meta) header.createDiv({ text: meta, cls: 'auditor-rv-meta' });

		this.centerEl.createEl('h4', { text: 'Control', cls: 'auditor-rv-section' });
		this.shownControl = record.control;
		this.centerEl.createDiv({ text: record.control || '(no control text)', cls: 'auditor-rv-control-text' });

		this.renderStage('Stage 1 · Test of design', record.todRating, record.todConclusion, 'todRating', 'todConclusion');
		this.renderStage('Stage 2 · Test of effectiveness', record.toeRating, record.toeConclusion, 'toeRating', 'toeConclusion');

		const notesHead = this.notesEl.createDiv('auditor-rv-notes-head');
		notesHead.createEl('h4', { text: 'Review notes', cls: 'auditor-rv-section' });
		this.statusEl = notesHead.createSpan({ cls: 'auditor-rv-save-status' });
		const notes = this.notesEl.createEl('textarea', { cls: 'auditor-rv-notes-input' });
		notes.placeholder = 'Write what should change in this control — each note is stored in the control itself and can later be applied by an agent.';
		notes.value = record.reviewNotes;
		isolateKeys(notes);
		notes.addEventListener('input', () => this.queue({ reviewNotes: notes.value }));

		this.notesInput = notes;
	}

	private stageEls: Partial<Record<'todRating' | 'toeRating' | 'todConclusion' | 'toeConclusion', HTMLSelectElement | HTMLTextAreaElement>> = {};

	private renderStage(title: string, rating: string, conclusion: string, ratingKey: 'todRating' | 'toeRating', textKey: 'todConclusion' | 'toeConclusion'): void {
		const block = this.centerEl.createDiv('auditor-rv-stage');
		const head = block.createDiv('auditor-rv-stage-head');
		head.createEl('h4', { text: title, cls: 'auditor-rv-section' });
		const select = head.createEl('select', { cls: 'auditor-rv-rating-select' });
		for (const opt of CONTROL_RATINGS) {
			const o = select.createEl('option', { text: opt === '-' ? 'N/A (-)' : opt || 'Not rated', value: opt });
			if (opt === rating) o.selected = true;
		}
		select.addEventListener('change', () => {
			this.queue({ [ratingKey]: select.value as ControlRecord['todRating'] });
			void this.flush();
		});
		this.stageEls[ratingKey] = select;
		const area = block.createEl('textarea', { cls: 'auditor-rv-conclusion' });
		this.stageEls[textKey] = area;
		area.value = conclusion;
		area.placeholder = 'No conclusion yet.';
		isolateKeys(area);
		area.addEventListener('input', () => this.queue({ [textKey]: area.value }));
	}
}
