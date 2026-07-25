import { App, Modal, Setting } from 'obsidian';

/** Modal for manually adding an existing control (title + requirement + conclusion) to the written-controls folder. */
export class AddControlModal extends Modal {
	private title = '';
	private requirement = '';
	private conclusion = '';
	private onSubmit: (title: string, requirement: string, conclusion: string) => void;

	constructor(app: App, onSubmit: (title: string, requirement: string, conclusion: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
		this.setTitle('Add control');
	}

	onOpen(): void {
		const { contentEl } = this;

		new Setting(contentEl).setName('Title').setHeading();
		const titleEl = contentEl.createEl('input', { type: 'text', cls: 'auditor-modal-title-input' });
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- literal nomenclature example, not prose
		titleEl.placeholder = 'e.g. ETSI TS 119 431-1 SIG-6.3.1-03';
		titleEl.addEventListener('input', () => { this.title = titleEl.value; });
		titleEl.focus();

		new Setting(contentEl).setName('Requirement').setHeading();
		const requirementEl = contentEl.createEl('textarea', { cls: 'auditor-modal-textarea' });
		requirementEl.rows = 6;
		requirementEl.placeholder = 'The control / requirement text…';
		requirementEl.addEventListener('input', () => { this.requirement = requirementEl.value; });

		new Setting(contentEl).setName('Conclusion').setHeading();
		const conclusionEl = contentEl.createEl('textarea', { cls: 'auditor-modal-textarea' });
		conclusionEl.rows = 10;
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- Findings/Observations-Recommendations/Evidence are literal section headings
		conclusionEl.placeholder = 'The control report conclusion (Findings / Observations-Recommendations / Evidence)…';
		conclusionEl.addEventListener('input', () => { this.conclusion = conclusionEl.value; });

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText('Save').setCta().onClick(() => { this.submit(); }),
		);
	}

	private submit(): void {
		if (!this.requirement.trim()) return;
		this.close();
		this.onSubmit(this.title.trim(), this.requirement.trim(), this.conclusion.trim());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
