import { App, Modal, Setting } from 'obsidian';
import { CONTROL_RATINGS, CONTROL_STATUSES, emptyControlRecord, type ControlRecord } from './controlNote';

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

		new Setting(contentEl)
			.setName('Control number')
			.setDesc('The audit template number; also used as the filename.')
			.addText((text) => {
				text.onChange((v) => { this.record.number = v; });
				text.inputEl.focus();
			});

		new Setting(contentEl).setName('Standard').addText((text) => {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- literal standard name example
			text.setPlaceholder('e.g. ETSI EN 319 401');
			text.onChange((v) => { this.record.standard = v; });
		});

		new Setting(contentEl).setName('Topic').addText((text) => {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- literal example text, not prose
			text.setPlaceholder('e.g. Device Management');
			text.onChange((v) => { this.record.topic = v; });
		});

		new Setting(contentEl).setName('Control').setHeading();
		const controlEl = contentEl.createEl('textarea', { cls: 'auditor-modal-textarea' });
		controlEl.rows = 4;
		controlEl.placeholder = 'The control / requirement text…';
		controlEl.addEventListener('input', () => { this.record.control = controlEl.value; });

		new Setting(contentEl).setName('Session').addText((text) => {
			text.onChange((v) => { this.record.session = v; });
		});

		new Setting(contentEl).setName('Assigned member').addText((text) => {
			text.onChange((v) => { this.record.assignedMember = v; });
		});

		new Setting(contentEl).setName('Status').addDropdown((dd) => {
			for (const s of CONTROL_STATUSES) dd.addOption(s, s);
			dd.setValue(this.record.status);
			dd.onChange((v) => { this.record.status = v; });
		});

		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "ToD" is a literal acronym used in the report format
		new Setting(contentEl).setName('Test of design (Stage 1)').setHeading();
		const todFindingEl = contentEl.createEl('textarea', { cls: 'auditor-modal-textarea' });
		todFindingEl.rows = 3;
		todFindingEl.placeholder = 'Finding…';
		todFindingEl.addEventListener('input', () => { this.record.todFinding = todFindingEl.value; });
		const todRecEl = contentEl.createEl('textarea', { cls: 'auditor-modal-textarea' });
		todRecEl.rows = 3;
		todRecEl.placeholder = 'Recommendation…';
		todRecEl.addEventListener('input', () => { this.record.todRecommendation = todRecEl.value; });
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "ToD" is a literal acronym used in the report format
		new Setting(contentEl).setName('ToD rating').addDropdown((dd) => {
			for (const r of CONTROL_RATINGS) dd.addOption(r, r || '(none)');
			dd.setValue(this.record.todRating);
			dd.onChange((v) => { this.record.todRating = v as ControlRecord['todRating']; });
		});

		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "ToE" is a literal acronym used in the report format
		new Setting(contentEl).setName('Test of effectiveness (Stage 2)').setHeading();
		const toeFindingEl = contentEl.createEl('textarea', { cls: 'auditor-modal-textarea' });
		toeFindingEl.rows = 3;
		toeFindingEl.placeholder = 'Finding…';
		toeFindingEl.addEventListener('input', () => { this.record.toeFinding = toeFindingEl.value; });
		const toeRecEl = contentEl.createEl('textarea', { cls: 'auditor-modal-textarea' });
		toeRecEl.rows = 3;
		toeRecEl.placeholder = 'Recommendation…';
		toeRecEl.addEventListener('input', () => { this.record.toeRecommendation = toeRecEl.value; });
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "ToE" is a literal acronym used in the report format
		new Setting(contentEl).setName('ToE rating').addDropdown((dd) => {
			for (const r of CONTROL_RATINGS) dd.addOption(r, r || '(none)');
			dd.setValue(this.record.toeRating);
			dd.onChange((v) => { this.record.toeRating = v as ControlRecord['toeRating']; });
		});

		new Setting(contentEl).setName('Comments').setHeading();
		const commentsEl = contentEl.createEl('textarea', { cls: 'auditor-modal-textarea' });
		commentsEl.rows = 3;
		commentsEl.addEventListener('input', () => { this.record.comments = commentsEl.value; });

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
