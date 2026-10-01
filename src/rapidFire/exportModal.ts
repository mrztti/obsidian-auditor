import { App, Modal } from 'obsidian';
import type AuditorPlugin from '../main';
import type { ControlRecord } from '../controlNote';
import type { DraftStage } from '../agent/types';

type StageSelection = 'stage1' | 'stage2' | 'both';

/**
 * "Export to Rapid Fire" (FR-8.1): confirms the frozen snapshot — control count, active filters,
 * selected controls, requested stage(s) — before creating the batch, and flags any (control, stage)
 * already in an active batch so the auditor doesn't silently duplicate work.
 */
export class RapidFireExportModal extends Modal {
	private stages: StageSelection = 'both';

	constructor(
		app: App,
		private plugin: AuditorPlugin,
		private entries: { record: ControlRecord }[],
		private filtersSummary: string,
	) {
		super(app);
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Rapid Fire" is the feature's own name
		this.setTitle('Export to Rapid Fire');
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('p', {
			cls: 'auditor-field-description',
			text: `${this.entries.length} control(s) matching the current filters will move into a Rapid Fire batch — a frozen snapshot; changing filters afterward will not alter this batch.`,
		});
		contentEl.createEl('p', { cls: 'auditor-field-description', text: `Active filters: ${this.filtersSummary || '(none)'}` });

		const stageWrap = contentEl.createDiv('auditor-field');
		stageWrap.createEl('label', { text: 'Requested stage(s)', cls: 'auditor-field-label' });
		const stageSelect = stageWrap.createEl('select');
		for (const [value, label] of [['both', 'Stage 1 and Stage 2'], ['stage1', 'Stage 1'], ['stage2', 'Stage 2']] as const) {
			stageSelect.createEl('option', { text: label, value });
		}
		stageSelect.value = this.stages;
		stageSelect.addEventListener('change', () => { this.stages = stageSelect.value as StageSelection; renderDuplicates(); });

		const listWrap = contentEl.createDiv('auditor-rf-export-list');
		for (const e of this.entries.slice(0, 50)) listWrap.createDiv({ text: e.record.number || '(no number)' });
		if (this.entries.length > 50) listWrap.createDiv({ text: `… and ${this.entries.length - 50} more`, cls: 'auditor-field-description' });

		const duplicatesEl = contentEl.createDiv('auditor-field-description');
		const renderDuplicates = () => {
			const active = this.plugin.rapidFireStore.activeKeys();
			const stages = this.selectedStages();
			const duplicates = this.entries.filter((e) => stages.some((s) => active.has(`${e.record.number}:${s}`)));
			duplicatesEl.setText(duplicates.length > 0
				? `${duplicates.length} control(s) already in an active Rapid Fire batch will be skipped: ${duplicates.map((d) => d.record.number).slice(0, 10).join(', ')}${duplicates.length > 10 ? '…' : ''}`
				: '');
		};
		renderDuplicates();

		const exportBtn = contentEl.createEl('button', { text: 'Export', cls: 'mod-cta' });
		exportBtn.addEventListener('click', () => {
			const active = this.plugin.rapidFireStore.activeKeys();
			const stages = this.selectedStages();
			const controls = this.entries
				.map((e) => ({ controlNumber: e.record.number, stages: stages.filter((s) => !active.has(`${e.record.number}:${s}`)) }))
				.filter((c) => c.controlNumber && c.stages.length > 0);
			if (controls.length === 0) {
				duplicatesEl.setText('Nothing to export — every selected control/stage is already in an active batch.');
				return;
			}
			const batch = this.plugin.rapidFireStore.create(controls, this.filtersSummary || `${this.entries.length} control(s)`);
			this.close();
			void this.plugin.openRapidFire(batch.id);
		});
	}

	private selectedStages(): DraftStage[] {
		if (this.stages === 'both') return ['stage1', 'stage2'];
		return [this.stages];
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
