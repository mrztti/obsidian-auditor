import { App, Modal, Setting } from 'obsidian';

/** Multi-line text modal used to append extra search context to a phrase before building the graph. */
export class RefineScopeModal extends Modal {
	private value: string;
	private onSubmit: (text: string) => void;

	constructor(app: App, phrase: string, initialValue: string, onSubmit: (text: string) => void) {
		super(app);
		this.value = initialValue;
		this.onSubmit = onSubmit;
		this.setTitle(`Refine scope: ${phrase}`);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('p', {
			text: 'This text is appended to the phrase when retrieving documents for the graph.',
			cls: 'auditor-status',
		});

		const textarea = contentEl.createEl('textarea', { cls: 'auditor-refine-scope-textarea' });
		textarea.value = this.value;
		textarea.rows = 10;
		textarea.addEventListener('input', () => { this.value = textarea.value; });
		textarea.focus();

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText('Save').setCta().onClick(() => {
				this.close();
				this.onSubmit(this.value.trim());
			}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
