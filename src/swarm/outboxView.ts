import { ItemView, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from '../main';
import { renderProposalCard, type ProposalCardHandle } from '../agent/proposalCard';
import { renderAgentBadge } from './agentColors';
import type { OutboxEntry } from './outboxStore';

export const SWARM_OUTBOX_VIEW_TYPE = 'auditor-swarm-outbox-view';

/**
 * Every finished proposal the writer pool produced, in one place, reusing the exact same
 * diff/approve-reject card (`proposalCard.ts`) the interactive chat shows inline — the only
 * difference is where it lands: here, instead of a transient chat message, so the user can review
 * the whole pool's output together rather than per-conversation.
 */
export class SwarmOutboxView extends ItemView {
	private unsubscribe: (() => void) | null = null;
	private handles = new Map<string, ProposalCardHandle>();
	private outcomesShown = new Set<string>();

	constructor(leaf: WorkspaceLeaf, private plugin: AuditorPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return SWARM_OUTBOX_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Swarm outbox';
	}

	getIcon(): string {
		return 'inbox';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-outbox-view');
		this.unsubscribe = this.plugin.swarm.outbox.onChange(() => this.render());
		this.render();
		await Promise.resolve();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		await Promise.resolve();
	}

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		const entries = this.plugin.swarm.outbox.list();
		if (entries.length === 0) {
			container.empty();
			this.handles.clear();
			this.outcomesShown.clear();
			container.createDiv('auditor-chat-empty').createEl('p', {
				text: 'Nothing waiting for review yet. Launch the control-writing swarm to see finished drafts appear here.',
				cls: 'auditor-field-description',
			});
			return;
		}
		// Only (re)render entries we haven't rendered yet — card state (decisions typed in) must never be wiped by a sibling entry arriving.
		if (this.handles.size === 0) container.empty();
		for (const entry of entries) {
			if (!this.handles.has(entry.id)) this.renderEntry(container, entry);
			const outcomes = this.plugin.swarm.outbox.outcomesFor(entry.id);
			if (outcomes && !this.outcomesShown.has(entry.id)) {
				this.outcomesShown.add(entry.id);
				this.handles.get(entry.id)?.showOutcomes(outcomes);
			}
		}
	}

	private renderEntry(container: HTMLElement, entry: OutboxEntry): void {
		const wrap = container.createDiv('auditor-chat-message auditor-chat-message-assistant auditor-outbox-entry');
		const source = wrap.createDiv('auditor-outbox-entry-source');
		source.createSpan({ text: 'From ' });
		renderAgentBadge(source, entry.agentId);
		const handle = renderProposalCard(wrap, entry.proposal, (decision) => {
			this.plugin.swarm.outbox.decide(entry.id, decision);
		});
		this.handles.set(entry.id, handle);
	}
}
