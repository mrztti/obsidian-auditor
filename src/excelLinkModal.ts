import { App, Modal, Notice, TFile } from 'obsidian';
import type AuditorPlugin from './main';
import { readWorkbookPreview, readWorkbookSheetNames } from './controlImport';
import { CONTROL_FIELD_KEYS, CONTROL_FIELD_LABELS, type ControlFieldKey } from './controlNote';
import { EMPTY_EXCEL_LINK } from './settings';

type Stage = 'setup' | 'mapping';

/**
 * Configures the single persisted bidirectional Excel link (FR: "define a bidirectional link to a
 * given excel file"): which vault file/sheet it points at, which header row it is, which column is
 * the control-number lookup key, and which header maps to which control field. Saved straight into
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
	private headers: string[] = [];
	private sampleRows: string[][] = [];
	private keyColumn = '';
	private gateColumn = '';
	private mapping: Partial<Record<ControlFieldKey, string>> = {};

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
					this.sampleRows = preview.sampleRows;
					if (!this.headers.includes(this.keyColumn)) this.keyColumn = '';
					if (this.gateColumn && !this.headers.includes(this.gateColumn)) this.gateColumn = '';
					for (const key of CONTROL_FIELD_KEYS) {
						const header = this.mapping[key];
						if (header && !this.headers.includes(header)) delete this.mapping[key];
					}
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

	// ─── Stage 2: key column + per-field mapping ───────────────────────────

	private renderMapping(container: HTMLElement): void {
		container.createEl('p', { text: `Assign a column from "${this.selectedSheet}" to each field you want synced; leave the rest unmapped.` });

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
					this.sampleRows = preview.sampleRows;
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
			for (const header of this.headers) headRow.createEl('th', { text: header });
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
		keySelect.createEl('option', { text: '— choose a column —', value: '' });
		for (const header of this.headers) {
			const opt = keySelect.createEl('option', { text: header, value: header });
			if (this.keyColumn === header) opt.selected = true;
		}
		keySelect.addEventListener('change', () => { this.keyColumn = keySelect.value; });
		keyWrap.createEl('p', {
			text: 'Both sync directions match a sheet row to a vault control purely by this column\'s value.',
			cls: 'auditor-field-description',
		});

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
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- quoted literal button labels, "Excel" is a literal product name
			text: 'Optional. If set, "Sync from Excel" only syncs a row when this column has a non-empty value — leave unset to sync every row. Does not affect "Sync to Excel".',
			cls: 'auditor-field-description',
		});

		const grid = container.createDiv('auditor-compact-grid');
		for (const key of CONTROL_FIELD_KEYS) {
			const wrap = grid.createDiv('auditor-field auditor-field-compact');
			wrap.createEl('label', { text: CONTROL_FIELD_LABELS[key], cls: 'auditor-field-label' });
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
