import { ItemView, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from '../main';
import { CoordinatorPanel } from './coordinatorPanel';

export const COORDINATOR_VIEW_TYPE = 'auditor-swarm-coordinator-view';

/** The swarm coordinator's own chat, living in its own view — talk to it the way you'd talk to the main chat agent, instead of a one-shot launch form. */
export class CoordinatorView extends ItemView {
	private panel: CoordinatorPanel | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: AuditorPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return COORDINATOR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Swarm coordinator';
	}

	getIcon(): string {
		return 'git-branch';
	}

	onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-chat-view');
		this.panel = new CoordinatorPanel(container, this.plugin);
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.panel?.dispose();
		this.panel = null;
		return Promise.resolve();
	}
}
