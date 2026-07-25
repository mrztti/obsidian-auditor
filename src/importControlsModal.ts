import { App, Modal, TFile } from 'obsidian';
import type AuditorPlugin from './main';
import { readWorkbookPreview, readWorkbookRows } from './controlImport';
import { CONTROL_FIELD_KEYS, emptyControlRecord, type ControlFieldKey, type ControlRating, type ControlRecord } from './controlNote';

/** Turns free-text rating cells (e.g. "Non-conformant", "Conform w/ observation") into the canonical rating code, without needing an LLM call. */
function normalizeRating(raw: string): ControlRating {
	const v = raw.trim();
	if (v === 'C' || v === 'C*' || v === 'NC') return v;
	const lower = v.toLowerCase();
	if (!lower) return '';
	if (lower.includes('non') && lower.includes('conform')) return 'NC';
	if (lower.includes('conform') && (lower.includes('*') || lower.includes('observ') || lower.includes('minor'))) return 'C*';
	if (lower.includes('conform')) return 'C';
	return '';
}

const FIELD_LABELS: Record<ControlFieldKey, string> = {
	number: 'Control number',
	standard: 'Standard',
	topic: 'Topic',
	control: 'Control',
	session: 'Session',
	assignedMember: 'Assigned member',
	status: 'Status',
	todFinding: 'ToD finding',
	todRecommendation: 'ToD recommendation',
	todRating: 'ToD rating',
	toeFinding: 'ToE finding',
	toeRecommendation: 'ToE recommendation',
	toeRating: 'ToE rating',
	comments: 'Comments',
};

type Stage = 'setup' | 'mapping' | 'importing' | 'done';

/** Modal driving the Excel import flow: pick a workbook → LLM proposes a column mapping (reviewable) → once the mapping is confirmed, rows are copied directly into control notes (no further LLM calls needed). */
export class ImportControlsModal extends Modal {
	private plugin: AuditorPlugin;
	private onComplete: () => void;
	private stage: Stage = 'setup';
	private selectedFile: TFile | null = null;
	private instructions = '';
	private mapping: Partial<Record<ControlFieldKey, string>> = {};
	private mappingNotes = '';
	private headers: string[] = [];
	private cancelled = false;

	constructor(app: App, plugin: AuditorPlugin, onComplete: () => void) {
		super(app);
		this.plugin = plugin;
		this.onComplete = onComplete;
		this.modalEl.addClass('auditor-edit-modal');
		this.setTitle('Import controls from spreadsheet');
	}

	onOpen(): void {
		this.render();
	}

	onClose(): void {
		this.cancelled = true;
		this.contentEl.empty();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (this.stage === 'setup') this.renderSetup(contentEl);
		else if (this.stage === 'mapping') this.renderMapping(contentEl);
		else this.renderProgress(contentEl);
	}

	// ─── Stage 1: pick file + instructions ─────────────────────────────────

	private renderSetup(container: HTMLElement): void {
		const files = this.app.vault.getFiles().filter((f) => f.extension === 'xlsx' || f.extension === 'xls');

		container.createDiv('auditor-field').createEl('label', { text: 'Spreadsheet', cls: 'auditor-field-label' });
		const select = container.createEl('select');
		select.createEl('option', { text: '— choose a file —', value: '' });
		for (const file of files) select.createEl('option', { text: file.path, value: file.path });
		select.addEventListener('change', () => {
			this.selectedFile = files.find((f) => f.path === select.value) ?? null;
		});
		if (files.length === 0) {
			container.createEl('p', { text: 'No .xlsx/.xls files found in the vault.', cls: 'auditor-status' });
		}

		const instrField = container.createDiv('auditor-field');
		instrField.createEl('label', { text: 'Additional instructions for column mapping', cls: 'auditor-field-label' });
		const textarea = instrField.createEl('textarea', { cls: 'auditor-pipeline-textarea' });
		textarea.rows = 5;
		textarea.placeholder = 'Anything the model should know about this sheet\'s columns or conventions…';
		textarea.addEventListener('input', () => { this.instructions = textarea.value; });

		const statusEl = container.createDiv('auditor-status');
		const initBtn = container.createEl('button', { text: 'Initialize', cls: 'mod-cta' });
		initBtn.addEventListener('click', () => {
			void (async () => {
				if (!this.selectedFile) { statusEl.setText('Choose a spreadsheet first.'); return; }
				initBtn.disabled = true;
				statusEl.setText('Reading workbook…');
				try {
					const preview = await readWorkbookPreview(this.app.vault, this.selectedFile);
					this.headers = preview.headers;
					statusEl.setText(`${preview.rowCount} row(s), ${preview.headers.length} column(s). Asking the model to map columns…`);
					const result = await this.plugin.geminiGenerate.mapExcelColumns(preview.headers, preview.sampleRows, this.instructions);
					this.mapping = result.mapping;
					this.mappingNotes = result.notes;
					this.stage = 'mapping';
					this.render();
				} catch (e) {
					statusEl.setText(`Failed: ${String(e)}`);
					initBtn.disabled = false;
				}
			})();
		});
	}

	// ─── Stage 2: review/edit mapping ──────────────────────────────────────

	private renderMapping(container: HTMLElement): void {
		container.createEl('p', { text: 'Review the column mapping the model proposed, and correct anything that looks wrong.' });
		if (this.mappingNotes) {
			container.createEl('p', { text: this.mappingNotes, cls: 'auditor-status' });
		}

		const grid = container.createDiv('auditor-compact-grid');
		for (const key of CONTROL_FIELD_KEYS) {
			const wrap = grid.createDiv('auditor-field auditor-field-compact');
			wrap.createEl('label', { text: FIELD_LABELS[key], cls: 'auditor-field-label' });
			const select = wrap.createEl('select');
			select.createEl('option', { text: '(None)', value: '' });
			for (const header of this.headers) {
				const opt = select.createEl('option', { text: header, value: header });
				if (this.mapping[key] === header) opt.selected = true;
			}
			select.addEventListener('change', () => {
				if (select.value) this.mapping[key] = select.value;
				else delete this.mapping[key];
			});
		}

		const actions = container.createDiv('auditor-research-actions');
		const backBtn = actions.createEl('button', { text: 'Back' });
		backBtn.addEventListener('click', () => { this.stage = 'setup'; this.render(); });
		const startBtn = actions.createEl('button', { text: 'Start import', cls: 'mod-cta' });
		startBtn.addEventListener('click', () => {
			this.stage = 'importing';
			this.render();
			void this.runImport();
		});
	}

	// ─── Stage 3: direct copy + write ──────────────────────────────────────

	private progressEl!: HTMLElement;
	private summaryEl!: HTMLElement;

	private renderProgress(container: HTMLElement): void {
		container.createEl('h4', { text: 'Importing…' });
		this.progressEl = container.createDiv('auditor-status');
		this.summaryEl = container.createDiv();
		if (this.stage === 'done') {
			const closeBtn = container.createEl('button', { text: 'Close', cls: 'mod-cta' });
			closeBtn.addEventListener('click', () => { this.close(); });
		} else {
			const cancelBtn = container.createEl('button', { text: 'Cancel' });
			cancelBtn.addEventListener('click', () => { this.cancelled = true; });
		}
	}

	private async runImport(): Promise<void> {
		if (!this.selectedFile) return;
		this.progressEl.setText('Reading rows…');
		const rows = await readWorkbookRows(this.app.vault, this.selectedFile);

		const columnIndex = new Map(this.headers.map((h, i) => [h, i]));
		const records: ControlRecord[] = [];
		for (const row of rows) {
			if (this.cancelled) break;
			const record = emptyControlRecord();
			for (const key of CONTROL_FIELD_KEYS) {
				const header = this.mapping[key];
				if (!header) continue;
				const index = columnIndex.get(header);
				const raw = index === undefined ? '' : (row[index] ?? '');
				if (key === 'todRating' || key === 'toeRating') record[key] = normalizeRating(raw);
				else record[key] = raw;
			}
			records.push(record);
		}

		this.progressEl.setText(this.cancelled ? 'Cancelled. Writing what was mapped so far…' : 'Writing control notes…');
		const { written, failed } = await this.plugin.importControlRecords(records);

		this.stage = 'done';
		this.render();
		this.progressEl.setText(this.cancelled ? 'Import cancelled.' : 'Import complete.');
		const lines = [
			`${written} control note(s) written out of ${rows.length} row(s).`,
			...(failed.length > 0 ? [`${failed.length} record(s) failed to save.`] : []),
		];
		for (const line of lines) this.summaryEl.createEl('p', { text: line });
		this.onComplete();
	}
}
