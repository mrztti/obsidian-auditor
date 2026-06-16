import { App, Modal, Setting } from 'obsidian';

/** Simple text-input modal used to name a newly-created finding note. */
export class NewFindingModal extends Modal {
	private value = '';
	private onSubmit: (name: string) => void;

	constructor(app: App, onSubmit: (name: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'New finding note' });

		new Setting(contentEl).setName('Title').addText((text) => {
			text.setPlaceholder('Finding title').onChange((v) => { this.value = v; });
			text.inputEl.focus();
			text.inputEl.addEventListener('keydown', (e) => {
				if (e.key === 'Enter') this.submit();
			});
		});

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText('Create').setCta().onClick(() => { this.submit(); }),
		);
	}

	private submit(): void {
		const name = this.value.trim();
		if (!name) return;
		this.close();
		this.onSubmit(name);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
