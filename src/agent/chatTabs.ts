import { setIcon } from 'obsidian';
import type AuditorPlugin from '../main';
import { ChatPanel } from './chatPanel';

interface ChatTab {
	id: number;
	name: string;
	panel: ChatPanel;
	pane: HTMLElement;
	tabEl: HTMLElement;
	labelEl: HTMLElement;
}

/**
 * The agent chat's tab strip: each tab is an independent agent session (own conversation, plan and
 * run) so several tasks can run at the same time. Tabs share the plugin's long-term memory, research
 * cache and drafting queue, but nothing else. Double-click a tab's name to rename it.
 */
export class ChatTabs {
	private tabs: ChatTab[] = [];
	private activeId = -1;
	private nextId = 1;
	private tabBar: HTMLElement;
	private body: HTMLElement;

	constructor(container: HTMLElement, private plugin: AuditorPlugin) {
		this.tabBar = container.createDiv('auditor-chat-tabs');
		this.body = container.createDiv('auditor-chat-tab-body');
		this.addTab();
	}

	private addTab(): void {
		const id = this.nextId++;
		const tabEl = this.tabBar.createDiv('auditor-chat-tab');
		const labelEl = tabEl.createSpan({ cls: 'auditor-chat-tab-label' });
		const busyDot = tabEl.createSpan({ cls: 'auditor-chat-tab-busy auditor-agent-hidden', attr: { 'aria-label': 'Working' } });
		const closeBtn = tabEl.createEl('button', { cls: 'auditor-chat-tab-close', attr: { 'aria-label': 'Close tab' } });
		setIcon(closeBtn, 'x');

		const pane = this.body.createDiv('auditor-chat-pane auditor-agent-hidden');
		const tab: ChatTab = {
			id,
			name: `Agent ${id}`,
			pane,
			tabEl,
			labelEl,
			panel: new ChatPanel(pane, this.plugin, `chat-${id}`, (busy) => busyDot.toggleClass('auditor-agent-hidden', !busy)),
		};
		labelEl.setText(tab.name);
		this.tabs.push(tab);

		tabEl.addEventListener('click', () => this.activate(id));
		labelEl.addEventListener('dblclick', (e) => {
			e.stopPropagation();
			this.startRename(tab);
		});
		closeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.close(id);
		});

		// The "+" button always stays last in the strip.
		this.tabBar.querySelector('.auditor-chat-tab-add')?.remove();
		const addBtn = this.tabBar.createEl('button', { cls: 'auditor-chat-tab-add', attr: { 'aria-label': 'New agent' } });
		setIcon(addBtn, 'plus');
		addBtn.addEventListener('click', () => this.addTab());

		this.activate(id);
	}

	private activate(id: number): void {
		this.activeId = id;
		for (const tab of this.tabs) {
			const active = tab.id === id;
			tab.tabEl.toggleClass('is-active', active);
			tab.pane.toggleClass('auditor-agent-hidden', !active);
		}
		this.tabs.find((t) => t.id === id)?.panel.focusInput();
	}

	private close(id: number): void {
		const index = this.tabs.findIndex((t) => t.id === id);
		if (index === -1) return;
		const [tab] = this.tabs.splice(index, 1);
		if (!tab) return;
		tab.panel.dispose();
		tab.pane.remove();
		tab.tabEl.remove();
		if (this.tabs.length === 0) {
			this.addTab();
		} else if (this.activeId === id) {
			this.activate((this.tabs[Math.min(index, this.tabs.length - 1)] as ChatTab).id);
		}
	}

	private startRename(tab: ChatTab): void {
		const input = createEl('input', { type: 'text', cls: 'auditor-chat-tab-rename' });
		input.value = tab.name;
		tab.labelEl.empty();
		tab.labelEl.appendChild(input);
		input.focus();
		input.select();

		let finished = false;
		const finish = (commit: boolean) => {
			if (finished) return;
			finished = true;
			const next = input.value.trim();
			if (commit && next) tab.name = next;
			tab.labelEl.empty();
			tab.labelEl.setText(tab.name);
		};
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') finish(true);
			else if (e.key === 'Escape') finish(false);
		});
		input.addEventListener('blur', () => finish(true));
		input.addEventListener('click', (e) => e.stopPropagation());
	}

	dispose(): void {
		for (const tab of this.tabs) tab.panel.dispose();
		this.tabs = [];
	}
}
