import { App, Modal } from 'obsidian';
import { renderGeneralFields, renderStage1Fields, renderStage2Fields } from './controlFields';
import type { ControlRecord } from './controlNote';

type EditTab = 'general' | 'stage1' | 'stage2';

const EDIT_TAB_LABELS: Record<EditTab, string> = {
	general: 'General',
	stage1: 'Stage 1',
	stage2: 'Stage 2',
};

/** Full-screen, tabbed modal for editing an existing control record (opened from the Controls grid). Saved explicitly, once, via the Save button — not on every keystroke, so the folder isn't re-indexed repeatedly. */
export class EditControlModal extends Modal {
	private record: ControlRecord;
	private onSave: (record: ControlRecord) => Promise<void>;
	private dirty = false;
	private statusEl!: HTMLElement;
	private saveBtn!: HTMLButtonElement;

	constructor(app: App, record: ControlRecord, onSave: (record: ControlRecord) => Promise<void>) {
		super(app);
		this.record = { ...record };
		this.onSave = onSave;
		this.modalEl.addClass('auditor-edit-modal');
		this.setTitle(`Control ${record.number || ''}`.trim());
	}

	onOpen(): void {
		const { contentEl } = this;

		const tabBar = contentEl.createDiv('auditor-tab-bar');
		const tabContents: Record<EditTab, HTMLElement> = {
			general: contentEl.createDiv('auditor-tab-content'),
			stage1: contentEl.createDiv('auditor-tab-content'),
			stage2: contentEl.createDiv('auditor-tab-content'),
		};
		const tabButtons: Record<EditTab, HTMLButtonElement> = {} as Record<EditTab, HTMLButtonElement>;
		const setActiveTab = (name: EditTab) => {
			(Object.keys(tabContents) as EditTab[]).forEach((key) => {
				tabContents[key].toggleClass('auditor-tab-hidden', key !== name);
				tabButtons[key].toggleClass('is-active', key === name);
			});
		};
		(Object.keys(EDIT_TAB_LABELS) as EditTab[]).forEach((name) => {
			const btn = tabBar.createEl('button', { text: EDIT_TAB_LABELS[name], cls: 'auditor-tab-btn' });
			btn.addEventListener('click', () => { setActiveTab(name); });
			tabButtons[name] = btn;
		});

		const markDirty = () => {
			this.dirty = true;
			this.saveBtn.disabled = false;
			this.statusEl.setText('Unsaved changes.');
		};
		renderGeneralFields(tabContents.general, this.record, markDirty);
		renderStage1Fields(tabContents.stage1, this.record, markDirty);
		renderStage2Fields(tabContents.stage2, this.record, markDirty);
		setActiveTab('general');

		const footer = contentEl.createDiv('auditor-edit-modal-footer');
		this.saveBtn = footer.createEl('button', { text: 'Save', cls: 'mod-cta' });
		this.saveBtn.disabled = true;
		this.statusEl = footer.createDiv('auditor-autosave-status');
		this.statusEl.setText('No changes.');

		this.saveBtn.addEventListener('click', () => {
			void (async () => {
				this.saveBtn.disabled = true;
				this.statusEl.setText('Saving…');
				try {
					await this.onSave({ ...this.record });
					this.dirty = false;
					this.statusEl.setText('Saved.');
				} catch (e) {
					this.saveBtn.disabled = false;
					this.statusEl.setText(`Save failed: ${String(e)}`);
				}
			})();
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
