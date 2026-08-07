import { App, Modal, Notice } from 'obsidian';
import type AuditorPlugin from './main';
import type { ControlRecord } from './controlNote';
import { buildControlsDocx, buildControlsPdf, type ExportControlEntry } from './exportControls';

/** Asks for a document title (and format) before exporting the given controls — used from the Controls view, exporting whatever's currently filtered there. */
export class ExportControlsModal extends Modal {
	private plugin: AuditorPlugin;
	private entries: ExportControlEntry[];
	private title = 'Controls export';
	private format: 'pdf' | 'docx' = 'pdf';

	constructor(app: App, plugin: AuditorPlugin, entries: { record: ControlRecord }[]) {
		super(app);
		this.plugin = plugin;
		this.entries = entries;
		this.setTitle('Export controls');
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('p', {
			text: `${this.entries.length} control(s) will be exported, in the order currently shown.`,
			cls: 'auditor-field-description',
		});

		const titleWrap = contentEl.createDiv('auditor-field');
		titleWrap.createEl('label', { text: 'Document title', cls: 'auditor-field-label' });
		const titleInput = titleWrap.createEl('input', { type: 'text' });
		titleInput.value = this.title;
		titleInput.addEventListener('input', () => { this.title = titleInput.value; });

		const formatWrap = contentEl.createDiv('auditor-field auditor-field-compact');
		formatWrap.createEl('label', { text: 'Format', cls: 'auditor-field-label' });
		const formatSelect = formatWrap.createEl('select');
		formatSelect.createEl('option', { text: 'PDF', value: 'pdf' });
		formatSelect.createEl('option', { text: 'Word (.docx)', value: 'docx' });
		formatSelect.value = this.format;
		formatSelect.addEventListener('change', () => { this.format = formatSelect.value as 'pdf' | 'docx'; });

		const statusEl = contentEl.createDiv('auditor-status');
		const exportBtn = contentEl.createEl('button', { text: 'Export', cls: 'mod-cta' });
		exportBtn.addEventListener('click', () => {
			void (async () => {
				exportBtn.disabled = true;
				statusEl.setText('Generating…');
				try {
					const file = await this.export();
					statusEl.setText(`Saved to ${file.path}.`);
					new Notice(`Auditor: exported ${this.entries.length} control(s) to ${file.path}`);
					this.close();
				} catch (e) {
					statusEl.setText(`Export failed: ${String(e)}`);
					exportBtn.disabled = false;
				}
			})();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async export() {
		const title = this.title.trim() || 'Controls export';
		if (this.format === 'pdf') {
			const doc = buildControlsPdf(title, this.entries);
			return this.plugin.saveExportFile(title, 'pdf', doc.output('arraybuffer'));
		}
		const blob = await buildControlsDocx(title, this.entries);
		return this.plugin.saveExportFile(title, 'docx', await blob.arrayBuffer());
	}
}
