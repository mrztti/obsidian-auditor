import { App, Modal, Notice } from 'obsidian';
import type AuditorPlugin from './main';
import type { InterviewSessionPlan } from './evidenceGoal';
import type { EvidenceResult } from './evidenceResult';
import { buildEvidenceDocx, buildEvidencePdf, organizeEvidenceForExport } from './exportEvidence';

/** Asks for a document title (and format) before exporting a session's Evidence Goals + captured Evidence Results (notes + screenshots) — used from the session-plan view. */
export class ExportEvidenceModal extends Modal {
	private plugin: AuditorPlugin;
	private plan: InterviewSessionPlan;
	private title: string;
	private format: 'pdf' | 'docx' = 'pdf';

	constructor(app: App, plugin: AuditorPlugin, plan: InterviewSessionPlan) {
		super(app);
		this.plugin = plugin;
		this.plan = plan;
		this.title = `Evidence — ${plan.session}`;
		this.setTitle('Export evidence');
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('p', {
			text: `${this.plan.evidenceGoals.length} evidence goal(s) for session "${this.plan.session}" will be exported, including notes and pasted screenshots.`,
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
				try {
					statusEl.setText('Loading evidence results…');
					const results = new Map<string, EvidenceResult>();
					for (const eg of this.plan.evidenceGoals) {
						results.set(eg.id, await this.plugin.loadEvidenceResult(eg.id));
					}
					statusEl.setText('Generating…');
					const sections = organizeEvidenceForExport(this.plan, results, this.app.vault);
					const title = this.title.trim() || `Evidence — ${this.plan.session}`;
					const file = this.format === 'pdf'
						? await this.exportPdf(title, sections)
						: await this.exportDocx(title, sections);
					statusEl.setText(`Saved to ${file.path}.`);
					new Notice(`Auditor: exported evidence for "${this.plan.session}" to ${file.path}`);
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

	private async exportPdf(title: string, sections: ReturnType<typeof organizeEvidenceForExport>) {
		const doc = await buildEvidencePdf(title, this.plan.session, sections, this.app.vault);
		return this.plugin.saveExportFile(title, 'pdf', doc.output('arraybuffer'));
	}

	private async exportDocx(title: string, sections: ReturnType<typeof organizeEvidenceForExport>) {
		const blob = await buildEvidenceDocx(title, this.plan.session, sections, this.app.vault);
		return this.plugin.saveExportFile(title, 'docx', await blob.arrayBuffer());
	}
}
