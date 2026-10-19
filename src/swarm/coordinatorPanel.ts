import { Notice } from 'obsidian';
import type AuditorPlugin from '../main';
import { RunView } from '../agent/chatPanel';
import { renderChatMarkdownInto } from '../markdown';
import type { AgentHost } from '../agent/types';
import { formatUsageLine } from '../agent/usage';
import { COORDINATOR_AGENT_ID, CoordinatorAgent } from './coordinatorAgent';

const SUGGESTIONS = [
	'Draft stage 1 for controls 4.1, 4.2 and 4.3 with 2 writers',
	'Dispatch everything in session 3 across 3 writers',
	'How is the swarm doing?',
	'Stop the swarm',
];

/**
 * The coordinator's chat panel — same shape as `agent/chatPanel.ts`'s `ChatPanel`, trimmed to what
 * the coordinator actually needs (no draft-queue drawer, no Burn Mode toggle, both chat-specific).
 * Reuses `RunView` for the plan/activity/proposal rendering, so a coordinator run looks and behaves
 * exactly like a chat run — just bound to `CoordinatorAgent` instead of `ChatAgent`.
 */
export class CoordinatorPanel {
	private agent: CoordinatorAgent;
	private messagesEl!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private emptyEl: HTMLElement | null = null;
	private currentRun: RunView | null = null;
	private sessionTotalEl!: HTMLElement;

	constructor(private container: HTMLElement, private plugin: AuditorPlugin) {
		this.agent = new CoordinatorAgent(plugin);
		this.render();
	}

	private render(): void {
		const bar = this.container.createDiv('auditor-chat-toolbar');
		bar.createSpan({ text: 'Coordinator', cls: 'auditor-chat-toolbar-title' });
		this.sessionTotalEl = bar.createSpan({ cls: 'auditor-chat-session-usage auditor-agent-hidden' });
		const newChat = bar.createEl('button', { text: 'New chat', cls: 'auditor-chat-new' });
		newChat.addEventListener('click', () => this.resetChat());

		this.messagesEl = this.container.createDiv('auditor-chat-messages');
		this.renderEmptyState();

		const row = this.container.createDiv('auditor-chat-input-row');
		this.input = row.createEl('textarea', { cls: 'auditor-chat-input' });
		this.input.rows = 1;
		this.input.placeholder = 'Tell the coordinator what to draft…';
		this.input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});
	}

	private renderEmptyState(): void {
		this.emptyEl = this.messagesEl.createDiv('auditor-chat-empty');
		this.emptyEl.createEl('h4', { text: 'Dispatch the writer pool' });
		this.emptyEl.createEl('p', {
			text: 'Describe which controls to draft and how many writers to split them across. Progress shows live in the swarm graph view; finished drafts land in the swarm outbox for your review.',
			cls: 'auditor-field-description',
		});
		const chips = this.emptyEl.createDiv('auditor-chat-suggestions');
		for (const text of SUGGESTIONS) {
			const chip = chips.createEl('button', { text, cls: 'auditor-chat-suggestion' });
			chip.addEventListener('click', () => { this.input.value = text; this.input.focus(); });
		}
	}

	/** Called when the view closes: ends any run and unblocks a pending approval so nothing is left hanging. */
	dispose(): void {
		this.currentRun?.cancelPending('The coordinator chat was closed.');
		this.agent.stop();
	}

	private resetChat(): void {
		this.currentRun?.cancelPending('The chat was reset.');
		this.agent.stop();
		this.agent.reset();
		this.currentRun = null;
		this.messagesEl.empty();
		this.renderEmptyState();
		this.sessionTotalEl.addClass('auditor-agent-hidden');
	}

	private scrollToBottom = (): void => {
		this.messagesEl.scrollTo({ top: this.messagesEl.scrollHeight, behavior: 'smooth' });
	};

	private addUserMessage(text: string, note?: string): void {
		this.emptyEl?.remove();
		this.emptyEl = null;
		const row = this.messagesEl.createDiv('auditor-chat-message auditor-chat-message-user');
		renderChatMarkdownInto(row.createDiv('auditor-chat-message-text'), text);
		if (note) row.createDiv({ text: note, cls: 'auditor-chat-message-note' });
		this.scrollToBottom();
	}

	private submit(): void {
		const text = this.input.value.trim();
		if (!text) return;
		if (!this.plugin.settings.geminiApiKey) {
			new Notice('Auditor: add your Gemini API key in the plugin settings first.');
			return;
		}
		this.input.value = '';

		if (this.agent.isRunning) {
			this.agent.steer(text);
			this.addUserMessage(text, 'Sent while working — the coordinator will see this before its next step');
			return;
		}
		this.addUserMessage(text);
		void this.startRun(text);
	}

	private async startRun(text: string): Promise<void> {
		const run = new RunView(this.messagesEl, this.plugin, () => {
			run.cancelPending('The user stopped the run.');
			run.setStatus('Stopping…');
			this.agent.stop();
		}, this.scrollToBottom);
		this.currentRun = run;
		this.scrollToBottom();

		const host: AgentHost = {
			emit: (event) => {
				if (event.type === 'plan') run.renderPlan(event.plan);
				else if (event.type === 'note') run.addNote(event.text);
				else if (event.type === 'tool_start') run.toolStart(event.id, event.label, event.burn);
				else if (event.type === 'tool_end') run.toolEnd(event.id, event.ok, event.summary);
				else if (event.type === 'usage') {
					run.updateUsage(event.stepId, event.usage, event.runTotals);
					this.sessionTotalEl.removeClass('auditor-agent-hidden');
					this.sessionTotalEl.setText(`Session: ${formatUsageLine(event.sessionTotals)}`);
				}
				else if (event.type === 'context') run.updateContext(event.usage);
				else if (event.type === 'compaction') run.noteCompaction(event.beforeTokens, event.afterTokens, event.duplicatesRemoved, event.elided);
				else run.finish(event);
			},
			requestApproval: (proposal) => run.showProposal(proposal),
			reportApplied: (outcomes) => run.showApplied(outcomes),
			requestCheckpoint: (info) => run.showCheckpoint(info),
			requestErrorRecovery: (info) => run.showErrorRecovery(info),
		};
		await this.agent.run(text, host, () => this.plugin.swarm.burnModeFor(COORDINATOR_AGENT_ID));
		if (this.currentRun === run) this.currentRun = null;
		this.input.focus();
	}
}
