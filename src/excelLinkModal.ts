import { App, Modal, Notice, TFile } from 'obsidian';
import type AuditorPlugin from './main';
import { readWorkbookPreview, readWorkbookSheetNames } from './controlImport';
import { CONTROL_FIELD_KEYS, CONTROL_FIELD_LABELS, type ControlFieldKey } from './controlNote';
import { EMPTY_EXCEL_LINK } from './settings';

type Stage = 'setup' | 'mapping';

/** Converts a 1-based column number to its spreadsheet letter(s) (1→A, 26→Z, 27→AA, …) — purely for display in the mapping dropdowns/preview table. */
function columnNumberToLetter(n: number): string {
	let result = '';
	let num = n;
	while (num > 0) {
		const rem = (num - 1) % 26;
		result = String.fromCharCode(65 + rem) + result;
		num = Math.floor((num - 1) / 26);
	}
	return result || '?';
}

/** Collapses a header's internal whitespace (including embedded line breaks from a wrapped header cell) into single spaces, purely for a clean one-line dropdown label — the stored mapping never depends on this text matching anything. */
function cleanHeaderLabel(header: string): string {
	const collapsed = header.replace(/\s+/g, ' ').trim();
	return collapsed || '(blank)';
}

/**
 * Configures the single persisted bidirectional Excel link (FR: "define a bidirectional link to a
 * given excel file"): which vault file/sheet it points at, which header row it is, which COLUMN
 * NUMBER is the control-number lookup key, and which column number maps to which control field.
 * Columns are matched/saved by position, not by header text — header text is read here only to
 * label the dropdowns for picking, since matching by header text turned out to be unreliable (a
 * header cell wrapped across two lines persists with an embedded line break that never matches
 * live again; duplicate header text is also not uncommon). Saved straight into
 * `plugin.settings.excelLink` — the two sync directions (`syncFromExcel`/`syncToExcel` in
 * `excelLink.ts`) read this config fresh on every run rather than caching anything here.
 */
export class ExcelLinkModal extends Modal {
	private plugin: AuditorPlugin;
	private onSaved: () => void;
	private stage: Stage = 'setup';
	private selectedFile: TFile | null = null;
	private sheetNames: string[] = [];
	private selectedSheet = '';
	private headerRowNumber = 0;
	/** 1-based column number `headers[0]`/row arrays' index 0 corresponds to — a defined Excel Table can anchor anywhere on the sheet. */
	private startColumn = 1;
	private headers: string[] = [];
	private sampleRows: string[][] = [];
	private keyColumn = 0;
	private gateColumn = 0;
	private mapping: Partial<Record<ControlFieldKey, number>> = {};

	constructor(app: App, plugin: AuditorPlugin, onSaved: () => void) {
		super(app);
		this.plugin = plugin;
		this.onSaved = onSaved;
		this.modalEl.addClass('auditor-large-modal');
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Excel" is a literal product name
		this.setTitle('Configure Excel link');

		const existing = plugin.settings.excelLink;
		if (existing.filePath) {
			const file = app.vault.getAbstractFileByPath(existing.filePath);
			if (file instanceof TFile) this.selectedFile = file;
			this.selectedSheet = existing.sheetName;
			this.headerRowNumber = existing.headerRowNumber;
			this.keyColumn = existing.keyColumn;
			this.gateColumn = existing.gateColumn;
			this.mapping = { ...existing.mapping };
		}
	}

	onOpen(): void {
		if (this.selectedFile && this.selectedSheet) {
			this.contentEl.createEl('p', { text: 'Loading current link…', cls: 'auditor-status' });
			void this.loadExistingAndShowMapping();
		} else {
			this.render();
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}

	/** Re-reads the linked sheet's headers for whatever's already saved in settings, then opens straight on the mapping screen pre-filled with the saved key/gate/field columns — so reopening this modal to tweak the mapping doesn't require re-picking the file/sheet and clicking "Load columns" again. Falls back to the setup screen if the linked file/sheet can no longer be read (e.g. moved or deleted). */
	private async loadExistingAndShowMapping(): Promise<void> {
		if (!this.selectedFile) return;
		try {
			const preview = await readWorkbookPreview(this.app.vault, this.selectedFile, this.selectedSheet, this.headerRowNumber || undefined);
			this.headers = preview.headers;
			this.headerRowNumber = preview.headerRowNumber;
			this.startColumn = preview.startColumn;
			this.sampleRows = preview.sampleRows;
			this.stage = 'mapping';
			this.render();
		} catch (e) {
			new Notice(`Auditor: could not reload the linked sheet (${String(e)}) — reconfigure below.`);
			this.stage = 'setup';
			this.render();
		}
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (this.stage === 'setup') this.renderSetup(contentEl);
		else this.renderMapping(contentEl);
	}

	// ─── Stage 1: pick file + sheet, load headers ──────────────────────────

	private renderSetup(container: HTMLElement): void {
		container.createEl('p', {
			text: 'Pick the spreadsheet and sheet to link. Both syncs match rows to controls purely by the control-number column you choose next — no rows are ever inserted, reordered, or restyled.',
			cls: 'auditor-field-description',
		});

		const files = this.app.vault.getFiles().filter((f) => f.extension === 'xlsx' || f.extension === 'xls');

		container.createDiv('auditor-field').createEl('label', { text: 'Spreadsheet', cls: 'auditor-field-label' });
		const fileSelect = container.createEl('select');
		fileSelect.createEl('option', { text: '— choose a file —', value: '' });
		for (const file of files) {
			const opt = fileSelect.createEl('option', { text: file.path, value: file.path });
			if (this.selectedFile?.path === file.path) opt.selected = true;
		}
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

		const loadSheetNames = async (file: TFile) => {
			statusEl.setText('Reading sheet names…');
			try {
				this.sheetNames = await readWorkbookSheetNames(this.app.vault, file);
				sheetSelect.empty();
				for (const name of this.sheetNames) sheetSelect.createEl('option', { text: name, value: name });
				this.selectedSheet = this.sheetNames.includes(this.selectedSheet) ? this.selectedSheet : (this.sheetNames[0] ?? '');
				sheetSelect.value = this.selectedSheet;
				sheetSelect.disabled = false;
				statusEl.setText('');
			} catch (e) {
				statusEl.setText(`Failed to read workbook: ${String(e)}`);
			}
		};

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
				await loadSheetNames(this.selectedFile);
			})();
		});
		if (this.selectedFile) void loadSheetNames(this.selectedFile);

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
					this.headerRowNumber = preview.headerRowNumber;
					this.startColumn = preview.startColumn;
					this.sampleRows = preview.sampleRows;
					this.pruneOutOfRangeSelections();
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

	/** Clears any saved key/gate/field column that no longer falls within the freshly-read header range — e.g. after reloading against a sheet with fewer columns than when this link was last configured. */
	private pruneOutOfRangeSelections(): void {
		const inRange = (col: number) => col >= this.startColumn && col < this.startColumn + this.headers.length;
		if (this.keyColumn && !inRange(this.keyColumn)) this.keyColumn = 0;
		if (this.gateColumn && !inRange(this.gateColumn)) this.gateColumn = 0;
		for (const key of CONTROL_FIELD_KEYS) {
			const col = this.mapping[key];
			if (col && !inRange(col)) delete this.mapping[key];
		}
	}

	// ─── Stage 2: key column + per-field mapping ───────────────────────────

	/** Populates a `<select>` with one option per read column — value is the absolute column number (as a string), label is "A — Header text". */
	private populateColumnSelect(select: HTMLSelectElement, selected: number, includeNone: boolean, noneLabel = '(None)'): void {
		select.empty();
		if (includeNone) select.createEl('option', { text: noneLabel, value: '' });
		for (let i = 0; i < this.headers.length; i++) {
			const col = this.startColumn + i;
			const opt = select.createEl('option', { text: `${columnNumberToLetter(col)} — ${cleanHeaderLabel(this.headers[i] ?? '')}`, value: String(col) });
			if (selected === col) opt.selected = true;
		}
	}

	private renderMapping(container: HTMLElement): void {
		container.createEl('p', { text: `Assign a column from "${this.selectedSheet}" to each field you want synced; leave the rest unmapped. Columns are saved by position, not by header text.` });

		const headerRowWrap = container.createDiv('auditor-field auditor-field-compact');
		headerRowWrap.createEl('label', { text: 'Header row', cls: 'auditor-field-label' });
		const headerRowInput = headerRowWrap.createEl('input', { type: 'number' });
		headerRowInput.min = '1';
		headerRowInput.value = String(this.headerRowNumber);
		const reloadStatusEl = container.createDiv('auditor-status');
		const reloadBtn = headerRowWrap.createEl('button', { text: 'Reload for this row' });
		reloadBtn.addEventListener('click', () => {
			void (async () => {
				if (!this.selectedFile) return;
				const override = parseInt(headerRowInput.value, 10);
				if (!Number.isFinite(override) || override < 1) { reloadStatusEl.setText('Enter a valid row number.'); return; }
				reloadStatusEl.setText('Reloading…');
				try {
					const preview = await readWorkbookPreview(this.app.vault, this.selectedFile, this.selectedSheet, override);
					this.headers = preview.headers;
					this.headerRowNumber = preview.headerRowNumber;
					this.startColumn = preview.startColumn;
					this.sampleRows = preview.sampleRows;
					this.pruneOutOfRangeSelections();
					reloadStatusEl.setText('');
					this.render();
				} catch (e) {
					reloadStatusEl.setText(`Failed: ${String(e)}`);
				}
			})();
		});
		headerRowWrap.createEl('p', {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- false positive on "e.g."
			text: 'Auto-detected — correct it and reload if the columns/preview below don\'t look right (e.g. a title or banner row got picked instead of the real header).',
			cls: 'auditor-field-description',
		});

		if (this.sampleRows.length > 0) {
			const tableWrap = container.createDiv('auditor-import-preview-wrap');
			const table = tableWrap.createEl('table', { cls: 'auditor-import-preview-table' });
			const headRow = table.createEl('thead').createEl('tr');
			for (let i = 0; i < this.headers.length; i++) {
				headRow.createEl('th', { text: `${columnNumberToLetter(this.startColumn + i)}: ${cleanHeaderLabel(this.headers[i] ?? '')}` });
			}
			const tbody = table.createEl('tbody');
			for (const row of this.sampleRows) {
				const tr = tbody.createEl('tr');
				for (let i = 0; i < this.headers.length; i++) tr.createEl('td', { text: row[i] ?? '' });
			}
			container.createEl('p', {
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- false positive on "i.e."
				text: 'Preview of the first rows read as DATA (i.e. right after the header row above) — check the first row here is really the first control, not another header/title row.',
				cls: 'auditor-field-description',
			});
		}

		const keyWrap = container.createDiv('auditor-field');
		keyWrap.createEl('label', { text: 'Control-number column (lookup key)', cls: 'auditor-field-label' });
		const keySelect = keyWrap.createEl('select');
		this.populateColumnSelect(keySelect, this.keyColumn, true, '— choose a column —');
		keySelect.addEventListener('change', () => { this.keyColumn = keySelect.value ? Number(keySelect.value) : 0; });
		keyWrap.createEl('p', {
			text: 'Both sync directions match a sheet row to a vault control purely by this column\'s value.',
			cls: 'auditor-field-description',
		});

		const gateWrap = container.createDiv('auditor-field');
		gateWrap.createEl('label', { text: 'Import gate column', cls: 'auditor-field-label' });
		const gateSelect = gateWrap.createEl('select');
		this.populateColumnSelect(gateSelect, this.gateColumn, true);
		gateSelect.addEventListener('change', () => { this.gateColumn = gateSelect.value ? Number(gateSelect.value) : 0; });
		gateWrap.createEl('p', {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- quoted literal button labels, "Excel" is a literal product name
			text: 'Optional. If set, "Sync from Excel" only syncs a row when this column has a non-empty value — leave unset to sync every row. Does not affect "Sync to Excel".',
			cls: 'auditor-field-description',
		});

		const grid = container.createDiv('auditor-compact-grid');
		for (const key of CONTROL_FIELD_KEYS) {
			const wrap = grid.createDiv('auditor-field auditor-field-compact');
			wrap.createEl('label', { text: CONTROL_FIELD_LABELS[key], cls: 'auditor-field-label' });
			const select = wrap.createEl('select');
			this.populateColumnSelect(select, this.mapping[key] ?? 0, true);
			select.addEventListener('change', () => {
				if (select.value) this.mapping[key] = Number(select.value);
				else delete this.mapping[key];
			});
		}

		const statusEl = container.createDiv('auditor-status');
		const actions = container.createDiv('auditor-research-actions');
		const backBtn = actions.createEl('button', { text: 'Back' });
		backBtn.addEventListener('click', () => { this.stage = 'setup'; this.render(); });

		const clearBtn = actions.createEl('button', { text: 'Clear link' });
		clearBtn.addEventListener('click', () => {
			void (async () => {
				this.plugin.settings.excelLink = { ...EMPTY_EXCEL_LINK };
				await this.plugin.saveSettings();
				new Notice('Auditor: Excel link cleared.');
				this.onSaved();
				this.close();
			})();
		});

		const saveBtn = actions.createEl('button', { text: 'Save link', cls: 'mod-cta' });
		saveBtn.addEventListener('click', () => {
			void (async () => {
				if (!this.selectedFile) { statusEl.setText('No spreadsheet selected.'); return; }
				if (!this.keyColumn) { statusEl.setText('Choose a control-number column first.'); return; }
				saveBtn.disabled = true;
				this.plugin.settings.excelLink = {
					filePath: this.selectedFile.path,
					sheetName: this.selectedSheet,
					headerRowNumber: this.headerRowNumber,
					keyColumn: this.keyColumn,
					gateColumn: this.gateColumn,
					mapping: { ...this.mapping },
				};
				await this.plugin.saveSettings();
				new Notice('Auditor: Excel link saved.');
				this.onSaved();
				this.close();
			})();
		});
	}
}

/** Confirms a bulk overwrite before "Sync from Excel" runs — listing exactly which existing control notes would be overwritten, never just a bare count, so the decision is informed. Used by the Controls view's "Sync from Excel" button. */
class ConfirmExcelOverwriteModal extends Modal {
	private onDecide: (proceed: boolean) => void;
	private decided = false;
	private toOverwrite: string[];
	private toCreate: number;

	constructor(app: App, toOverwrite: string[], toCreate: number, onDecide: (proceed: boolean) => void) {
		super(app);
		this.toOverwrite = toOverwrite;
		this.toCreate = toCreate;
		this.onDecide = onDecide;
		this.setTitle('Overwrite existing controls?');
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('p', {
			text: `Syncing from Excel will OVERWRITE ${this.toOverwrite.length} existing control note(s) with whatever is currently in the sheet` +
				(this.toCreate > 0 ? `, and create ${this.toCreate} new one(s).` : '.'),
		});
		const listWrap = contentEl.createDiv('auditor-import-preview-wrap');
		const list = listWrap.createEl('ul', { cls: 'auditor-import-overwrite-list' });
		for (const number of this.toOverwrite) list.createEl('li', { text: number });

		const actions = contentEl.createDiv('auditor-research-actions');
		const cancelBtn = actions.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => { this.decided = true; this.onDecide(false); this.close(); });
		const confirmBtn = actions.createEl('button', { text: 'Overwrite and sync', cls: 'mod-warning' });
		confirmBtn.addEventListener('click', () => { this.decided = true; this.onDecide(true); this.close(); });
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.decided) this.onDecide(false);
	}
}

/** Resolves to true if there's nothing to overwrite (no confirmation needed) or the user confirmed the overwrite; false if they cancelled. */
export function confirmExcelOverwrite(app: App, toOverwrite: string[], toCreate: number): Promise<boolean> {
	if (toOverwrite.length === 0) return Promise.resolve(true);
	return new Promise((resolve) => {
		new ConfirmExcelOverwriteModal(app, toOverwrite, toCreate, resolve).open();
	});
}
