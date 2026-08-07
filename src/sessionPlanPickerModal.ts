import { App, Modal } from 'obsidian';
import type AuditorPlugin from './main';
import { parseControlNoteContent } from './controlNote';

/** Simple session picker so the session-plan view is reachable on its own, without going through the Prepare Session tab or a specific control's Evidence Goals tool first. */
export class SessionPlanPickerModal extends Modal {
	private plugin: AuditorPlugin;

	constructor(app: App, plugin: AuditorPlugin) {
		super(app);
		this.plugin = plugin;
		this.setTitle('Open session plan');
	}

	onOpen(): void {
		void this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('p', { text: 'Loading sessions…', cls: 'auditor-status' });

		const folder = this.plugin.settings.writtenControlsFolder;
		const files = this.app.vault
			.getFiles()
			.filter((f) => f.extension === 'md' && (!folder || f.path === folder || f.path.startsWith(`${folder}/`)));
		const sessions = new Set<string>();
		for (const file of files) {
			const content = await this.app.vault.cachedRead(file);
			const session = parseControlNoteContent(content, file.basename).session.trim();
			if (session) sessions.add(session);
		}
		const sorted = [...sessions].sort((a, b) => a.localeCompare(b));

		contentEl.empty();
		if (sorted.length === 0) {
			contentEl.createEl('p', { text: 'No sessions found — assign a session to at least one control first.', cls: 'auditor-status' });
			return;
		}
		const list = contentEl.createDiv('auditor-session-picker-list');
		for (const session of sorted) {
			const item = list.createEl('button', { text: session, cls: 'auditor-session-picker-item' });
			item.addEventListener('click', () => {
				void this.plugin.openSessionPlan(session);
				this.close();
			});
		}
	}
}
