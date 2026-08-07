import { App, Modal, Notice } from 'obsidian';
import type AuditorPlugin from './main';
import type { ControlRecord } from './controlNote';
import {
	emptyEvidenceGoal,
	type EvidenceGoal,
	type EvidenceGoalType,
	type InterviewSessionPlan,
} from './evidenceGoal';

/**
 * Tool for building Evidence Goals (EGs) for a single control, against that control's interview
 * session plan. Existing EGs in the plan (created for other controls in the same session) can be
 * linked to this control too instead of creating a near-duplicate — that's how a session ends up
 * needing as few EGs as possible. Editing an EG here edits it for every control it's linked to, since
 * an EG is a single shared entry in the session plan, not a per-control copy.
 */
export class EvidenceGoalsModal extends Modal {
	private plugin: AuditorPlugin;
	private control: ControlRecord;
	private onSaved: () => void;
	private plan: InterviewSessionPlan | null = null;
	private dirty = false;
	private statusEl!: HTMLElement;
	private saveBtn!: HTMLButtonElement;

	constructor(app: App, plugin: AuditorPlugin, control: ControlRecord, onSaved: () => void = () => {}) {
		super(app);
		this.plugin = plugin;
		this.control = control;
		this.onSaved = onSaved;
		this.modalEl.addClass('auditor-large-modal');
		this.setTitle(`Evidence goals — ${control.number || '(no number)'}`);
	}

	onOpen(): void {
		this.render();
		void this.load();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		if (!this.control.session.trim()) {
			this.contentEl.empty();
			this.contentEl.createEl('p', {
				text: 'This control has no session set — assign one before building evidence goals for it.',
				cls: 'auditor-status',
			});
			return;
		}
		this.plan = await this.plugin.loadSessionPlan(this.control.session);
		this.render();
	}

	private markDirty(): void {
		this.dirty = true;
		this.saveBtn.disabled = false;
		this.statusEl.setText('Unsaved changes.');
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();

		if (!this.control.session.trim()) return;

		if (!this.plan) {
			contentEl.createEl('p', { text: 'Loading session plan…', cls: 'auditor-status' });
			return;
		}

		const introRow = contentEl.createDiv();
		introRow.createEl('p', {
			text: `Session: ${this.plan.session}. Link this control to an existing evidence goal where possible, instead of creating a new one — the fewer evidence goals a session needs, the better.`,
			cls: 'auditor-field-description',
		});
		const viewPlanBtn = introRow.createEl('button', { text: 'View full session plan' });
		viewPlanBtn.addEventListener('click', () => {
			void this.plugin.openSessionPlan(this.control.session);
		});

		const list = contentEl.createDiv('auditor-eg-list');
		if (this.plan.evidenceGoals.length === 0) {
			list.createEl('p', { text: 'No evidence goals yet in this session.', cls: 'auditor-status' });
		}
		for (const eg of this.plan.evidenceGoals) this.renderEvidenceGoal(list, eg);

		// eslint-disable-next-line obsidianmd/ui/sentence-case -- leading "+" defeats the rule's sentence-start detection; text is already sentence case
		const addBtn = contentEl.createEl('button', { text: '+ New evidence goal for this control' });
		addBtn.addEventListener('click', () => {
			if (!this.plan) return;
			const eg = emptyEvidenceGoal(this.plan.session, this.control.number);
			this.plan.evidenceGoals.push(eg);
			this.markDirty();
			this.render();
		});

		const footer = contentEl.createDiv('auditor-edit-modal-footer');
		this.saveBtn = footer.createEl('button', { text: 'Save', cls: 'mod-cta' });
		this.saveBtn.disabled = !this.dirty;
		const closeBtn = footer.createEl('button', { text: 'Close' });
		this.statusEl = footer.createDiv('auditor-autosave-status');
		this.statusEl.setText(this.dirty ? 'Unsaved changes.' : 'No changes.');

		this.saveBtn.addEventListener('click', () => {
			void this.save();
		});
		closeBtn.addEventListener('click', () => {
			this.close();
		});
	}

	private renderEvidenceGoal(list: HTMLElement, eg: EvidenceGoal): void {
		const linked = eg.controlNumbers.includes(this.control.number);
		const card = list.createDiv(`auditor-eg-card${linked ? ' auditor-eg-card-linked' : ''}`);

		const linkRow = card.createDiv('auditor-eg-link-row');
		const linkLabel = linkRow.createEl('label', { cls: 'auditor-checkbox-label' });
		const linkCheckbox = linkLabel.createEl('input', { type: 'checkbox' });
		linkCheckbox.checked = linked;
		linkLabel.createSpan({ text: `Applies to ${this.control.number || 'this control'}` });
		linkCheckbox.addEventListener('change', () => {
			if (linkCheckbox.checked) {
				if (!eg.controlNumbers.includes(this.control.number)) eg.controlNumbers.push(this.control.number);
			} else {
				eg.controlNumbers = eg.controlNumbers.filter((c) => c !== this.control.number);
			}
			this.markDirty();
			this.render();
		});

		const otherControls = eg.controlNumbers.filter((c) => c !== this.control.number);
		if (otherControls.length > 0) {
			linkRow.createSpan({
				text: `Also used by: ${otherControls.join(', ')}`,
				cls: 'auditor-eg-also-used-by',
			});
		}

		const grid = card.createDiv('auditor-compact-grid');
		const nameWrap = grid.createDiv('auditor-field auditor-field-full');
		nameWrap.createEl('label', { text: 'Name', cls: 'auditor-field-label' });
		const nameInput = nameWrap.createEl('input', { type: 'text' });
		nameInput.value = eg.name;
		nameInput.placeholder = 'E.g. Password policy configuration screen';
		nameInput.addEventListener('input', () => { eg.name = nameInput.value; this.markDirty(); });

		const typeWrap = grid.createDiv('auditor-field auditor-field-compact');
		typeWrap.createEl('label', { text: 'Type', cls: 'auditor-field-label' });
		const typeSelect = typeWrap.createEl('select');
		for (const opt of ['screenshot', 'file'] as EvidenceGoalType[]) {
			const optionEl = typeSelect.createEl('option', { text: opt === 'file' ? 'File' : 'Screenshot', value: opt });
			if (opt === eg.type) optionEl.selected = true;
		}
		typeSelect.addEventListener('change', () => { eg.type = typeSelect.value as EvidenceGoalType; this.markDirty(); });

		const descWrap = card.createDiv('auditor-field');
		descWrap.createEl('label', { text: 'Description', cls: 'auditor-field-label' });
		const descArea = descWrap.createEl('textarea', { cls: 'auditor-pipeline-textarea' });
		descArea.rows = 3;
		descArea.value = eg.description;
		descArea.placeholder = 'What exactly should be captured, and what it demonstrates.';
		descArea.addEventListener('input', () => { eg.description = descArea.value; this.markDirty(); });

		const questionsWrap = card.createDiv('auditor-field');
		questionsWrap.createEl('label', { text: 'Related questions (one per line)', cls: 'auditor-field-label' });
		const questionsArea = questionsWrap.createEl('textarea', { cls: 'auditor-pipeline-textarea' });
		questionsArea.rows = 3;
		questionsArea.value = eg.questions.join('\n');
		questionsArea.addEventListener('input', () => {
			eg.questions = questionsArea.value.split(/\r?\n/).map((q) => q.trim()).filter(Boolean);
			this.markDirty();
		});

		const removeBtn = card.createEl('button', { text: 'Delete evidence goal', cls: 'auditor-eg-delete-btn' });
		removeBtn.addEventListener('click', () => {
			if (!this.plan) return;
			this.plan.evidenceGoals = this.plan.evidenceGoals.filter((e) => e.id !== eg.id);
			this.markDirty();
			this.render();
		});
	}

	private async save(): Promise<void> {
		if (!this.plan) return;
		this.saveBtn.disabled = true;
		this.statusEl.setText('Saving…');
		try {
			// Evidence goals with no controls left (unchecked from everything) and nothing else filled
			// in are just clutter — drop them rather than persisting empty entries.
			this.plan.evidenceGoals = this.plan.evidenceGoals.filter(
				(eg) => eg.controlNumbers.length > 0 || eg.name.trim() || eg.description.trim(),
			);
			await this.plugin.saveSessionPlan(this.plan);
			void this.plugin.evidenceGoalIndex.rebuildAll(this.app.vault, this.plugin.evidenceGoalsSubfolder());
			this.dirty = false;
			this.statusEl.setText('Saved.');
			this.onSaved();
		} catch (e) {
			this.saveBtn.disabled = false;
			this.statusEl.setText(`Save failed: ${String(e)}`);
			new Notice(`Auditor: failed to save session plan — ${String(e)}`);
		}
	}
}
