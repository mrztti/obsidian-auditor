import { App, Modal, Notice } from 'obsidian';
import type AuditorPlugin from '../main';
import type { ControlRecord } from '../controlNote';

type StageSelection = 'stage1' | 'stage2' | 'both';

const STAGE_INSTRUCTIONS: Record<StageSelection, string> = {
	both: 'Draft both Stage 1 and Stage 2 for every control listed, where evidence supports it.',
	stage1: 'Only draft Stage 1 (Test of Design) for every control listed — do not touch Stage 2.',
	stage2: 'Only draft Stage 2 (Test of Effectiveness) for every control listed — do not touch Stage 1.',
};

/**
 * "Export to Swarm" — the controls page's equivalent of "Export to Rapid Fire…", but dispatching
 * the live agent swarm (coordinator → writer pool → verifier, see `src/swarm/`) instead of creating
 * a Rapid Fire batch. Confirms the frozen list of controls and requested stage(s) before launching.
 */
export class SwarmExportModal extends Modal {
	private stages: StageSelection = 'both';
	private poolSize = 2;

	constructor(
		app: App,
		private plugin: AuditorPlugin,
		private entries: { record: ControlRecord }[],
		private filtersSummary: string,
	) {
		super(app);
		this.setTitle('Export to swarm');
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('p', {
			cls: 'auditor-field-description',
			text: `${this.entries.length} control(s) matching the current filters will be dispatched to the writer pool. Finished drafts land in the swarm outbox for your review — nothing is written until you approve it there.`,
		});
		contentEl.createEl('p', { cls: 'auditor-field-description', text: `Active filters: ${this.filtersSummary || '(none)'}` });

		const stageWrap = contentEl.createDiv('auditor-field');
		stageWrap.createEl('label', { text: 'Requested stage(s)', cls: 'auditor-field-label' });
		const stageSelect = stageWrap.createEl('select');
		for (const [value, label] of [['both', 'Stage 1 and Stage 2'], ['stage1', 'Stage 1'], ['stage2', 'Stage 2']] as const) {
			stageSelect.createEl('option', { text: label, value });
		}
		stageSelect.value = this.stages;
		stageSelect.addEventListener('change', () => { this.stages = stageSelect.value as StageSelection; });

		const poolWrap = contentEl.createDiv('auditor-field');
		poolWrap.createEl('label', { text: 'Writer pool size', cls: 'auditor-field-label' });
		const poolSelect = poolWrap.createEl('select');
		for (const n of [2, 3]) {
			const opt = poolSelect.createEl('option', { text: `${n} writers`, value: String(n) });
			opt.selected = n === this.poolSize;
		}
		poolSelect.addEventListener('change', () => { this.poolSize = Number(poolSelect.value); });

		const listWrap = contentEl.createDiv('auditor-rf-export-list');
		for (const e of this.entries.slice(0, 50)) listWrap.createDiv({ text: e.record.number || '(no number)' });
		if (this.entries.length > 50) listWrap.createDiv({ text: `… and ${this.entries.length - 50} more`, cls: 'auditor-field-description' });

		const launchBtn = contentEl.createEl('button', { text: 'Launch swarm', cls: 'mod-cta' });
		launchBtn.addEventListener('click', () => this.launch(launchBtn));
	}

	private launch(button: HTMLButtonElement): void {
		if (!this.plugin.settings.geminiApiKey) {
			new Notice('Auditor: add your Gemini API key in the plugin settings first.');
			return;
		}
		const controlNumbers = [...new Set(this.entries.map((e) => e.record.number).filter(Boolean))];
		if (controlNumbers.length === 0) {
			new Notice('Auditor: no controls to export.');
			return;
		}
		button.disabled = true;
		try {
			this.plugin.swarm.start(controlNumbers, STAGE_INSTRUCTIONS[this.stages], this.poolSize);
			new Notice(`Auditor: dispatched ${controlNumbers.length} control(s) across ${Math.min(this.poolSize, controlNumbers.length)} writer(s).`);
			void this.plugin.activateCoordinatorView();
			void this.plugin.activateSwarmGraphView();
			this.close();
		} catch (e) {
			new Notice(`Auditor: could not launch the swarm — ${String(e)}`);
			button.disabled = false;
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
