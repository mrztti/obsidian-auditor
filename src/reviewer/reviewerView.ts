import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from '../main';
import { ApplyTab } from './applyTab';
import { ReviewerData } from './reviewerData';
import { ReviewTab } from './reviewTab';
import { SelectTab } from './selectTab';

export const REVIEWER_VIEW_TYPE = 'auditor-reviewer-view';

type TabKey = 'review' | 'select' | 'apply';
const TAB_LABELS: Record<TabKey, string> = { review: 'Review', select: 'Select controls', apply: 'Apply with agent' };

/** The Reviewer: read and mark up controls one at a time, choose which controls to review, and have an agent apply the resulting notes. Opens in the main editor area. */
export class ReviewerView extends ItemView {
	private data: ReviewerData;
	private review!: ReviewTab;
	private apply!: ApplyTab;
	private panes = {} as Record<TabKey, HTMLElement>;
	private buttons = {} as Record<TabKey, HTMLButtonElement>;
	private refreshTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: AuditorPlugin) {
		super(leaf);
		this.data = new ReviewerData(plugin);
	}

	getViewType(): string {
		return REVIEWER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Reviewer';
	}

	getIcon(): string {
		return 'clipboard-check';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-reviewer');

		const bar = container.createDiv('auditor-tab-bar auditor-rv-tabs');
		for (const key of Object.keys(TAB_LABELS) as TabKey[]) {
			this.buttons[key] = bar.createEl('button', { text: TAB_LABELS[key], cls: 'auditor-tab-btn' });
			this.buttons[key].addEventListener('click', () => { void this.showTab(key); });
			this.panes[key] = container.createDiv(`auditor-rv-pane auditor-rv-pane-${key}`);
		}

		this.review = new ReviewTab(this.panes.review, this.data, () => { void this.showTab('select'); });
		new SelectTab(this.panes.select, this.plugin, this.data, () => { void this.showTab('review'); });
		this.apply = new ApplyTab(this.panes.apply, this.plugin, this.data);

		const onVaultChange = (file: unknown) => {
			if (file instanceof TFile && file.extension === 'md') this.scheduleReload();
		};
		this.registerEvent(this.app.vault.on('modify', onVaultChange));
		this.registerEvent(this.app.vault.on('create', onVaultChange));
		this.registerEvent(this.app.vault.on('delete', onVaultChange));
		this.registerEvent(this.app.vault.on('rename', onVaultChange));
		this.register(() => { if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer); });

		await this.data.reload();
		await this.showTab(this.data.reviewSet().length > 0 ? 'review' : 'select');
	}

	async onClose(): Promise<void> {
		await this.review.flush();
		this.apply.dispose();
	}

	/** Reloads the controls from disk; also called by the plugin after saves made elsewhere. */
	async refresh(): Promise<void> {
		await this.data.reload();
	}

	private scheduleReload(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.data.reload();
		}, 400);
	}

	private async showTab(active: TabKey): Promise<void> {
		await this.review.flush();
		for (const key of Object.keys(TAB_LABELS) as TabKey[]) {
			this.panes[key].toggleClass('auditor-tab-hidden', key !== active);
			this.buttons[key].toggleClass('is-active', key === active);
		}
	}
}
