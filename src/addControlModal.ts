import { App, Modal, Setting } from 'obsidian';
import { emptyControlRecord, type ControlRecord } from './controlNote';
import { renderGeneralFields, renderStage1Fields, renderStage2Fields } from './controlFields';

/** Modal for manually adding an existing control to the written-controls folder, in the canonical record format. */
export class AddControlModal extends Modal {
	private record: ControlRecord = emptyControlRecord();
	private onSubmit: (record: ControlRecord) => void;

	constructor(app: App, onSubmit: (record: ControlRecord) => void) {
		super(app);
		this.onSubmit = onSubmit;
		this.setTitle('Add control');
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('auditor-large-modal');

		renderGeneralFields(contentEl, this.record);

		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "ToD" is a literal acronym used in the report format
		contentEl.createEl('h4', { text: 'Test of design (Stage 1)', cls: 'auditor-field-section-heading' });
		renderStage1Fields(contentEl, this.record);

		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "ToE" is a literal acronym used in the report format
		contentEl.createEl('h4', { text: 'Test of effectiveness (Stage 2)', cls: 'auditor-field-section-heading' });
		renderStage2Fields(contentEl, this.record);

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText('Save').setCta().onClick(() => { this.submit(); }),
		);
	}

	private submit(): void {
		if (!this.record.number.trim() || !this.record.control.trim()) return;
		this.close();
		this.onSubmit(this.record);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
