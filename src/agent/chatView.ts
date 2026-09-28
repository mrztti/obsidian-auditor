import { ItemView, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from '../main';
import { ChatPanel } from './chatPanel';

export const AGENT_CHAT_VIEW_TYPE = 'auditor-agent-chat-view';

/** The Auditor agent chat, living in its own view in the right sidebar so it stays open next to whatever note, control or session plan is being worked on. */
export class AgentChatView extends ItemView {
	private panel: ChatPanel | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: AuditorPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return AGENT_CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Auditor chat';
	}

	getIcon(): string {
		return 'bot';
	}

	onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-chat-view');
		this.panel = new ChatPanel(container, this.plugin);
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.panel?.dispose();
		this.panel = null;
		return Promise.resolve();
	}
}
