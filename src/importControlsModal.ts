import { App, Modal, TFile } from 'obsidian';
import type AuditorPlugin from './main';
import { readWorkbookPreview, readWorkbookRows, readWorkbookSheetNames } from './controlImport';
import { CONTROL_FIELD_KEYS, emptyControlRecord, todayIsoDate, type ControlFieldKey, type ControlRating, type ControlRecord } from './controlNote';

/** Turns free-text rating cells (e.g. "Non-conformant", "Conform w/ observation") into the canonical rating code. */
function normalizeRating(raw: string): ControlRating {
	const v = raw.trim();
	if (v === 'C' || v === 'C*' || v === 'NC' || v === '-') return v;
	const lower = v.toLowerCase();
	if (!lower) return '';
	if (lower === 'n/a' || lower === 'na' || lower === 'not applicable') return '-';
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
	todConclusion: 'ToD conclusion',
	todRating: 'ToD rating',
	toeConclusion: 'ToE conclusion',
	toeRating: 'ToE rating',
};

type Stage = 'setup' | 'mapping' | 'confirm' | 'importing' | 'done';

/** Modal driving the fully manual Excel import flow: pick a workbook and sheet, review a sample of its rows, assign a column to each control field, then rows are copied directly into control notes. No LLM involved. */
export class ImportControlsModal extends Modal {
	private plugin: AuditorPlugin;
	private onComplete: () => void;
	private stage: Stage = 'setup';
	private selectedFile: TFile | null = null;
	private sheetNames: string[] = [];
	private selectedSheet = '';
	private mapping: Partial<Record<ControlFieldKey, string>> = {};
	/** Column whose value gates whether a row is imported at all — rows where this column is empty are skipped. Left unset, every row is imported. */
	private gateColumn = '';
	/** Optional column whose value becomes the control's first comment, dated with today's date. */
	private commentColumn = '';
	private headers: string[] = [];
	private sampleRows: string[][] = [];
	private cancelled = false;
	private pendingRecords: ControlRecord[] = [];
	private overwritePaths: string[] = [];

	constructor(app: App, plugin: AuditorPlugin, onComplete: () => void) {
		super(app);
		this.plugin = plugin;
		this.onComplete = onComplete;
		this.modalEl.addClass('auditor-large-modal');
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
		else if (this.stage === 'confirm') this.renderConfirm(contentEl);
		else this.renderProgress(contentEl);
	}

	// ─── Stage 1: pick file + sheet ────────────────────────────────────────

	private renderSetup(container: HTMLElement): void {
		const files = this.app.vault.getFiles().filter((f) => f.extension === 'xlsx' || f.extension === 'xls');

		container.createDiv('auditor-field').createEl('label', { text: 'Spreadsheet', cls: 'auditor-field-label' });
		const fileSelect = container.createEl('select');
		fileSelect.createEl('option', { text: '— choose a file —', value: '' });
		for (const file of files) fileSelect.createEl('option', { text: file.path, value: file.path });
		if (files.length === 0) {
			container.createEl('p', { text: 'No .xlsx/.xls files found in the vault.', cls: 'auditor-status' });
		}

		const sheetField = container.createDiv('auditor-field');
		sheetField.createEl('label', { text: 'Sheet', cls: 'auditor-field-label' });
		const sheetSelect = sheetField.createEl('select');
		sheetSelect.disabled = true;
		sheetSelect.createEl('option', { text: '— choose a file first —', value: '' });
		sheetSelect.addEventListener('change', () => { this.selectedSheet = sheetSelect.value; });

		const statusEl = container.createDiv('auditor-status');

		fileSelect.addEventListener('change', () => {
			void (async () => {
				this.selectedFile = files.find((f) => f.path === fileSelect.value) ?? null;
				this.selectedSheet = '';
				sheetSelect.disabled = true;
				sheetSelect.empty();
				if (!this.selectedFile) {
					sheetSelect.createEl('option', { text: '— choose a file first —', value: '' });
					return;
				}
				statusEl.setText('Reading sheet names…');
				try {
					this.sheetNames = await readWorkbookSheetNames(this.app.vault, this.selectedFile);
					sheetSelect.empty();
					for (const name of this.sheetNames) sheetSelect.createEl('option', { text: name, value: name });
					this.selectedSheet = this.sheetNames[0] ?? '';
					sheetSelect.value = this.selectedSheet;
					sheetSelect.disabled = false;
					statusEl.setText('');
				} catch (e) {
					statusEl.setText(`Failed to read workbook: ${String(e)}`);
				}
			})();
		});

		const loadBtn = container.createEl('button', { text: 'Load columns', cls: 'mod-cta' });
		loadBtn.addEventListener('click', () => {
			void (async () => {
				if (!this.selectedFile) { statusEl.setText('Choose a spreadsheet first.'); return; }
				if (!this.selectedSheet) { statusEl.setText('Choose a sheet first.'); return; }
				loadBtn.disabled = true;
				statusEl.setText('Reading sheet…');
				try {
					const preview = await readWorkbookPreview(this.app.vault, this.selectedFile, this.selectedSheet);
					this.headers = preview.headers;
					this.sampleRows = preview.sampleRows;
					this.mapping = {};
					statusEl.setText('');
					this.stage = 'mapping';
					this.render();
				} catch (e) {
					statusEl.setText(`Failed: ${String(e)}`);
					loadBtn.disabled = false;
				}
			})();
		});
	}

	// ─── Stage 2: manually assign a column to each field ───────────────────

	private renderMapping(container: HTMLElement): void {
		container.createEl('p', { text: `Assign a column from "${this.selectedSheet}" to each control field. Leave a field unmapped to skip it.` });

		if (this.sampleRows.length > 0) {
			const tableWrap = container.createDiv('auditor-import-preview-wrap');
			const table = tableWrap.createEl('table', { cls: 'auditor-import-preview-table' });
			const headRow = table.createEl('thead').createEl('tr');
			for (const header of this.headers) headRow.createEl('th', { text: header });
			const tbody = table.createEl('tbody');
			for (const row of this.sampleRows) {
				const tr = tbody.createEl('tr');
				for (let i = 0; i < this.headers.length; i++) tr.createEl('td', { text: row[i] ?? '' });
			}
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

		const gateWrap = container.createDiv('auditor-field');
		gateWrap.createEl('label', { text: 'Import gate column', cls: 'auditor-field-label' });
		const gateSelect = gateWrap.createEl('select');
		gateSelect.createEl('option', { text: '(None)', value: '' });
		for (const header of this.headers) {
			const opt = gateSelect.createEl('option', { text: header, value: header });
			if (this.gateColumn === header) opt.selected = true;
		}
		gateSelect.addEventListener('change', () => { this.gateColumn = gateSelect.value; });
		gateWrap.createEl('p', {
			text: 'Optional. If set, a row is only imported when this column has a non-empty value — leave unset to import every row.',
			cls: 'auditor-field-description',
		});

		const commentWrap = container.createDiv('auditor-field');
		commentWrap.createEl('label', { text: 'Comment column', cls: 'auditor-field-label' });
		const commentSelect = commentWrap.createEl('select');
		commentSelect.createEl('option', { text: '(None)', value: '' });
		for (const header of this.headers) {
			const opt = commentSelect.createEl('option', { text: header, value: header });
			if (this.commentColumn === header) opt.selected = true;
		}
		commentSelect.addEventListener('change', () => { this.commentColumn = commentSelect.value; });
		commentWrap.createEl('p', {
			text: "Optional. If set, a non-empty value in this column is added as this control's first comment, dated today.",
			cls: 'auditor-field-description',
		});

		const statusEl = container.createDiv('auditor-status');
		const actions = container.createDiv('auditor-research-actions');
		const backBtn = actions.createEl('button', { text: 'Back' });
		backBtn.addEventListener('click', () => { this.stage = 'setup'; this.render(); });
		const startBtn = actions.createEl('button', { text: 'Continue', cls: 'mod-cta' });
		startBtn.addEventListener('click', () => {
			void (async () => {
				if (!this.selectedFile) return;
				startBtn.disabled = true;
				statusEl.setText('Reading rows…');
				try {
					this.pendingRecords = await this.buildRecords();
					this.overwritePaths = this.pendingRecords
						.map((r) => this.plugin.controlNotePath(r))
						.filter((path) => this.app.vault.getAbstractFileByPath(path) !== null);
					this.stage = 'confirm';
					this.render();
				} catch (e) {
					statusEl.setText(`Failed: ${String(e)}`);
					startBtn.disabled = false;
				}
			})();
		});
	}

	private async buildRecords(): Promise<ControlRecord[]> {
		if (!this.selectedFile) return [];
		const rows = await readWorkbookRows(this.app.vault, this.selectedFile, this.selectedSheet);
		const columnIndex = new Map(this.headers.map((h, i) => [h, i]));
		const gateIndex = this.gateColumn ? columnIndex.get(this.gateColumn) : undefined;
		const commentIndex = this.commentColumn ? columnIndex.get(this.commentColumn) : undefined;
		const records: ControlRecord[] = [];
		for (const row of rows) {
			if (gateIndex !== undefined && !(row[gateIndex] ?? '').trim()) continue;
			const record = emptyControlRecord();
			for (const key of CONTROL_FIELD_KEYS) {
				const header = this.mapping[key];
				if (!header) continue;
				const index = columnIndex.get(header);
				const raw = index === undefined ? '' : (row[index] ?? '');
				if (key === 'todRating' || key === 'toeRating') record[key] = normalizeRating(raw);
				else record[key] = raw;
			}
			if (commentIndex !== undefined) {
				const commentText = (row[commentIndex] ?? '').trim();
				if (commentText) record.comments.push({ date: todayIsoDate(), text: commentText });
			}
			records.push(record);
		}
		return records;
	}

	// ─── Stage 3: confirm overwrites ────────────────────────────────────────

	private renderConfirm(container: HTMLElement): void {
		container.createEl('p', { text: `${this.pendingRecords.length} control note(s) will be written.` });

		if (this.overwritePaths.length > 0) {
			container.createEl('p', {
				text: `${this.overwritePaths.length} of these already exist and will be OVERWRITTEN if you continue:`,
				cls: 'auditor-status',
			});
			const listWrap = container.createDiv('auditor-import-preview-wrap');
			const list = listWrap.createEl('ul', { cls: 'auditor-import-overwrite-list' });
			for (const path of this.overwritePaths) list.createEl('li', { text: path });
		} else {
			container.createEl('p', { text: 'No existing notes will be overwritten — all will be created as new.' });
		}

		const actions = container.createDiv('auditor-research-actions');
		const backBtn = actions.createEl('button', { text: 'Back' });
		backBtn.addEventListener('click', () => { this.stage = 'mapping'; this.render(); });
		const confirmBtn = actions.createEl('button', {
			text: this.overwritePaths.length > 0 ? 'Overwrite and import' : 'Start import',
			cls: 'mod-cta',
		});
		confirmBtn.addEventListener('click', () => {
			this.stage = 'importing';
			this.render();
			void this.runImport();
		});
	}

	// ─── Stage 4: direct copy + write ──────────────────────────────────────

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
		const records = this.cancelled ? [] : this.pendingRecords;
		this.progressEl.setText('Writing control notes…');
		const { written, failed } = await this.plugin.importControlRecords(records, this.overwritePaths.length > 0);

		this.stage = 'done';
		this.render();
		this.progressEl.setText(this.cancelled ? 'Import cancelled.' : 'Import complete.');
		const lines = [
			`${written} control note(s) written out of ${this.pendingRecords.length} row(s).`,
			...(failed.length > 0 ? [`${failed.length} record(s) failed to save.`] : []),
		];
		for (const line of lines) this.summaryEl.createEl('p', { text: line });
		this.onComplete();
	}
}
