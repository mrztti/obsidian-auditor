import { App, ItemView, Modal, TFile, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from './main';
import { renderGeneralFields, renderStage1Fields, renderStage2Fields } from './controlFields';
import { buildControlNoteContent, sanitizeFileTitle, type ControlRecord } from './controlNote';

export const CONTROL_DETAIL_VIEW_TYPE = 'auditor-control-detail-view';

/** Confirms discarding unsaved changes — used whenever navigation would otherwise silently throw away edits. */
class ConfirmDiscardModal extends Modal {
	private onDecide: (discard: boolean) => void;
	private decided = false;

	constructor(app: App, onDecide: (discard: boolean) => void) {
		super(app);
		this.onDecide = onDecide;
		this.setTitle('Discard unsaved changes?');
	}

	onOpen(): void {
		this.contentEl.createEl('p', { text: 'This control has unsaved changes. Discard them?' });
		const actions = this.contentEl.createDiv('auditor-research-actions');
		const cancelBtn = actions.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => { this.decided = true; this.onDecide(false); this.close(); });
		const discardBtn = actions.createEl('button', { text: 'Discard changes', cls: 'mod-warning' });
		discardBtn.addEventListener('click', () => { this.decided = true; this.onDecide(true); this.close(); });
	}

	onClose(): void {
		this.contentEl.empty();
		// If the modal was dismissed (Esc / click-outside) without an explicit choice, treat it as "cancel".
		if (!this.decided) this.onDecide(false);
	}
}

function confirmDiscard(app: App): Promise<boolean> {
	return new Promise((resolve) => {
		new ConfirmDiscardModal(app, resolve).open();
	});
}

type EditTab = 'stages' | 'general';

const EDIT_TAB_LABELS: Record<EditTab, string> = {
	stages: 'Findings',
	general: 'General',
};

/**
 * Right-panel view for editing a single control record — replaces the old `EditControlModal`.
 * Opened from the Controls view's "Edit control" button via `plugin.openControlDetail`, which sets
 * the file/record via `setControl` after activating the leaf (a view registered via `registerView`
 * has no constructor arguments of its own, so state is pushed in afterwards).
 */
export class ControlDetailView extends ItemView {
	private plugin: AuditorPlugin;
	private file: TFile | null = null;
	private record: ControlRecord | null = null;
	private dirty = false;
	private statusEl!: HTMLElement;
	private saveBtn!: HTMLButtonElement;

	constructor(leaf: WorkspaceLeaf, plugin: AuditorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CONTROL_DETAIL_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.record ? `Control ${this.record.number || ''}`.trim() : 'Control';
	}

	getIcon(): string {
		return 'file-text';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {}

	/** Switches the view to a different control. If the current one has unsaved changes, confirms discarding them first — resolves to whether the switch happened. */
	async setControl(file: TFile, record: ControlRecord): Promise<boolean> {
		if (this.dirty && !(await confirmDiscard(this.app))) return false;
		this.file = file;
		this.record = { ...record };
		this.dirty = false;
		this.render();
		return true;
	}

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-view-container', 'auditor-control-detail-container');

		if (!this.record || !this.file) {
			container.createEl('p', { text: 'No control selected. Click "edit control" on a control in the controls view to start.', cls: 'auditor-status' });
			return;
		}

		container.createEl('h3', { text: `Control ${this.record.number || ''}`.trim() });

		const tabBar = container.createDiv('auditor-tab-bar');
		const tabContents: Record<EditTab, HTMLElement> = {
			stages: container.createDiv('auditor-tab-content auditor-findings-tab'),
			general: container.createDiv('auditor-tab-content'),
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
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "ToD" is a literal acronym used in the report format
		tabContents.stages.createEl('h4', { text: 'Test of design (Stage 1)', cls: 'auditor-field-section-heading' });
		renderStage1Fields(tabContents.stages, this.record, markDirty, true);
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "ToE" is a literal acronym used in the report format
		tabContents.stages.createEl('h4', { text: 'Test of effectiveness (Stage 2)', cls: 'auditor-field-section-heading' });
		renderStage2Fields(tabContents.stages, this.record, markDirty, true);
		renderGeneralFields(tabContents.general, this.record, markDirty, () => { void this.save(); });
		setActiveTab('stages');

		const footer = container.createDiv('auditor-edit-modal-footer');
		this.saveBtn = footer.createEl('button', { text: 'Save', cls: 'mod-cta' });
		this.saveBtn.disabled = true;
		const closeBtn = footer.createEl('button', { text: 'Close' });
		this.statusEl = footer.createDiv('auditor-autosave-status');
		this.statusEl.setText('No changes.');

		this.saveBtn.addEventListener('click', () => {
			void this.save();
		});
		closeBtn.addEventListener('click', () => {
			void (async () => {
				if (this.dirty && !(await confirmDiscard(this.app))) return;
				this.file = null;
				this.record = null;
				this.dirty = false;
				this.render();
			})();
		});
	}

	/** Persists the current record — used both by the explicit Save button and by comment auto-save. */
	private async save(): Promise<void> {
		if (!this.record || !this.file) return;
		this.saveBtn.disabled = true;
		this.statusEl.setText('Saving…');
		try {
			const folder = this.plugin.settings.writtenControlsFolder;
			const safeNumber = sanitizeFileTitle(this.record.number || this.file.basename);
			const newPath = folder ? `${folder}/${safeNumber}.md` : `${safeNumber}.md`;
			if (newPath !== this.file.path) {
				await this.app.fileManager.renameFile(this.file, newPath);
			}
			await this.app.vault.modify(this.file, buildControlNoteContent(this.record));
			this.dirty = false;
			this.statusEl.setText('Saved.');
			void this.plugin.runIndexing('writtenControls');
			void this.plugin.refreshControlsViews();
		} catch (e) {
			this.saveBtn.disabled = false;
			this.statusEl.setText(`Save failed: ${String(e)}`);
		}
	}
}
