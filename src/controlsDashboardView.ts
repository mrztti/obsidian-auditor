import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from './main';
import { parseControlNoteContent, type ControlRecord } from './controlNote';
import { renderControlsDashboard } from './controlsDashboard';

export const CONTROLS_DASHBOARD_VIEW_TYPE = 'auditor-controls-dashboard-view';

/** Standalone panel charting how many controls are C / C* / NC, overall and per session. Read-only; opened from its own ribbon icon. */
export class ControlsDashboardView extends ItemView {
	private plugin: AuditorPlugin;
	private body!: HTMLElement;
	private records: ControlRecord[] = [];
	private refreshTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: AuditorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CONTROLS_DASHBOARD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Controls dashboard';
	}

	getIcon(): string {
		return 'pie-chart';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-view-container', 'auditor-controls-dashboard-pane');
		this.body = container;

		const onVaultChange = (file: unknown) => {
			if (file instanceof TFile && file.extension === 'md') this.scheduleRefresh();
		};
		this.registerEvent(this.app.vault.on('modify', onVaultChange));
		this.registerEvent(this.app.vault.on('create', onVaultChange));
		this.registerEvent(this.app.vault.on('delete', onVaultChange));
		this.registerEvent(this.app.vault.on('rename', onVaultChange));
		this.register(() => {
			if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		});

		await this.refresh();
	}

	async onClose(): Promise<void> {}

	/** Re-reads the controls folder and redraws. */
	async refresh(): Promise<void> {
		const folder = this.plugin.settings.writtenControlsFolder;
		const files = this.app.vault
			.getFiles()
			.filter((f) => f.extension === 'md' && (!folder || f.path === folder || f.path.startsWith(`${folder}/`)));
		const records: ControlRecord[] = [];
		for (const file of files) {
			records.push(parseControlNoteContent(await this.app.vault.cachedRead(file), file.basename));
		}
		this.records = records;
		this.render();
	}

	private render(): void {
		renderControlsDashboard(this.body, this.records);
	}

	/** Debounced so a burst of edits (e.g. an Excel sync) redraws once. */
	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, 500);
	}
}
