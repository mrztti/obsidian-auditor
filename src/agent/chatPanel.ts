import { Notice, setIcon } from 'obsidian';
import type AuditorPlugin from '../main';
import { renderChatMarkdownInto } from '../markdown';
import { ChatAgent } from './agent';
import type { DraftQueueItem, DraftStage } from './draftQueue';
import { renderProposalCard, type ProposalCardHandle } from './proposalCard';
import type { AgentEvent, AgentHost, AgentPlan, ApplyOutcome, ApprovalDecision, PlanStepStatus, ReviewProposal } from './types';

const STAGE_LABEL: Record<DraftStage, string> = { stage1: 'Stage 1', stage2: 'Stage 2' };

/** Composes the message that launches a batch of queued drafting targets — instructs the agent to work through them one at a time, in full, rather than skimming across all of them. */
function buildQueueLaunchPrompt(items: DraftQueueItem[]): string {
	const lines = items.map((item, i) => {
		const parts = [`${i + 1}. Control ${item.controlNumber} — ${STAGE_LABEL[item.stage]}${item.topic ? ` (${item.topic})` : ''}`];
		if (item.note.trim()) parts.push(`   Extra instructions for this item: ${item.note.trim()}`);
		return parts.join('\n');
	});
	return [
		`Write up the following ${items.length} queued conclusion${items.length === 1 ? '' : 's'}, one at a time, in the order listed. Quality over quantity: it is far better to finish fewer of these — done thoroughly, with real evidence and a genuine QA pass — than to rush through all of them.`,
		'',
		'Items:',
		lines.join('\n'),
	].join('\n');
}

const STEP_ICONS: Record<PlanStepStatus, string> = {
	pending: 'circle',
	in_progress: 'loader-2',
	done: 'check-circle-2',
	skipped: 'minus-circle',
	failed: 'x-circle',
};

const SUGGESTIONS = [
	'Draft the Stage 1 conclusion for a control from the evidence we have',
	'Which non-conform controls still have no recommendation in their conclusion?',
	'Summarize what was captured in the meeting for one of my sessions',
	'Find the evidence and standard clauses behind the access review control',
];

/** One agent run as shown in the chat: live plan, activity log, proposal reviews and the final answer. */
class RunView {
	readonly root: HTMLElement;
	private statusEl: HTMLElement;
	private stopBtn: HTMLButtonElement;
	private planEl: HTMLElement;
	private activityDetails: HTMLDetailsElement;
	private activityList: HTMLElement;
	private toolRows = new Map<number, HTMLElement>();
	private lastPlan: AgentPlan | null = null;
	private proposalHandle: ProposalCardHandle | null = null;
	private pendingResolve: ((d: ApprovalDecision) => void) | null = null;
	private toolCount = 0;

	constructor(parent: HTMLElement, private plugin: AuditorPlugin, onStop: () => void, private scroll: () => void) {
		this.root = parent.createDiv('auditor-chat-message auditor-chat-message-assistant auditor-run');
		const header = this.root.createDiv('auditor-run-header');
		setIcon(header.createSpan('auditor-run-spinner'), 'loader-2');
		this.statusEl = header.createSpan({ text: 'Thinking…', cls: 'auditor-run-status' });
		this.stopBtn = header.createEl('button', { text: 'Stop', cls: 'auditor-run-stop' });
		this.stopBtn.addEventListener('click', onStop);
		this.planEl = this.root.createDiv('auditor-plan auditor-agent-hidden');
		this.activityDetails = this.root.createEl('details', { cls: 'auditor-thinking auditor-activity auditor-agent-hidden' });
		this.activityDetails.open = true;
		this.activityDetails.createEl('summary', { text: 'Activity' });
		this.activityList = this.activityDetails.createDiv('auditor-activity-list');
	}

	setStatus(text: string): void {
		this.statusEl.setText(text);
	}

	renderPlan(plan: AgentPlan): void {
		const previous = this.lastPlan;
		const prevTitles = new Map(previous?.steps.map((s) => [s.id, s.title]) ?? []);
		const revised = previous !== null && (previous.steps.length !== plan.steps.length || plan.steps.some((s) => prevTitles.get(s.id) !== s.title));
		this.lastPlan = plan;

		this.planEl.removeClass('auditor-agent-hidden');
		this.planEl.empty();
		const head = this.planEl.createDiv('auditor-plan-head');
		setIcon(head.createSpan('auditor-plan-icon'), 'list-checks');
		head.createSpan({ text: 'Plan', cls: 'auditor-plan-title' });
		const finished = plan.steps.filter((s) => s.status !== 'pending' && s.status !== 'in_progress').length;
		head.createSpan({ text: `${finished}/${plan.steps.length}`, cls: 'auditor-plan-count' });
		if (revised) head.createSpan({ text: 'revised', cls: 'auditor-plan-revised' });
		if (plan.objective) this.planEl.createDiv({ text: plan.objective, cls: 'auditor-plan-objective' });

		const bar = this.planEl.createDiv('auditor-plan-bar');
		bar.createDiv('auditor-plan-bar-fill').setCssProps({ width: `${plan.steps.length ? Math.round((finished / plan.steps.length) * 100) : 0}%` });

		const list = this.planEl.createEl('ol', { cls: 'auditor-plan-steps' });
		for (const step of plan.steps) {
			const isNew = previous !== null && !prevTitles.has(step.id);
			const li = list.createEl('li', { cls: `auditor-plan-step is-${step.status}${isNew ? ' is-new' : ''}` });
			setIcon(li.createSpan('auditor-plan-step-icon'), STEP_ICONS[step.status]);
			li.createSpan({ text: step.title, cls: 'auditor-plan-step-title' });
		}
		this.scroll();
	}

	addNote(text: string): void {
		this.activityDetails.removeClass('auditor-agent-hidden');
		this.activityList.createDiv({ text, cls: 'auditor-activity-note' });
		this.scroll();
	}

	toolStart(id: number, label: string): void {
		this.activityDetails.removeClass('auditor-agent-hidden');
		this.toolCount++;
		const row = this.activityList.createDiv('auditor-activity-row is-running');
		setIcon(row.createSpan('auditor-activity-icon'), 'loader-2');
		row.createSpan({ text: label, cls: 'auditor-activity-label' });
		this.toolRows.set(id, row);
		this.setStatus(label);
		this.scroll();
	}

	toolEnd(id: number, ok: boolean, summary: string): void {
		const row = this.toolRows.get(id);
		if (!row) return;
		row.removeClass('is-running');
		row.addClass(ok ? 'is-ok' : 'is-failed');
		const icon = row.querySelector<HTMLElement>('.auditor-activity-icon');
		if (icon) { icon.empty(); setIcon(icon, ok ? 'check' : 'x'); }
		row.createSpan({ text: summary, cls: 'auditor-activity-summary' });
		this.scroll();
	}

	showProposal(proposal: ReviewProposal): Promise<ApprovalDecision> {
		this.setStatus('Waiting for your review…');
		return new Promise((resolve) => {
			this.pendingResolve = resolve;
			this.proposalHandle = renderProposalCard(this.root, proposal, (decision) => {
				this.pendingResolve = null;
				this.setStatus('Applying…');
				resolve(decision);
			});
			this.scroll();
		});
	}

	showApplied(outcomes: ApplyOutcome[]): void {
		this.proposalHandle?.showOutcomes(outcomes);
		this.proposalHandle = null;
	}

	/** Resolves any proposal still awaiting review as rejected — used when the run is stopped or the chat is reset. */
	cancelPending(reason: string): void {
		if (!this.pendingResolve) return;
		const resolve = this.pendingResolve;
		this.pendingResolve = null;
		this.proposalHandle?.lock('Not applied');
		this.proposalHandle = null;
		resolve({ approved: [], rejected: [], feedback: reason });
	}

	/** Makes the plan card tell the truth once the run is over: nothing keeps spinning, and steps the agent never got to are shown as such. */
	private reconcilePlan(event: Extract<AgentEvent, { type: 'final' | 'error' }>): void {
		const plan = this.lastPlan;
		if (!plan) return;
		const completed = event.type === 'final' && !event.askedUser && event.text !== 'Stopped.';
		if (event.type === 'final' && event.askedUser) return;
		const steps = plan.steps.map((s): typeof s => {
			if (s.status === 'in_progress') return { ...s, status: completed ? 'done' : 'failed' };
			if (s.status === 'pending' && completed) return { ...s, status: 'skipped' };
			return s;
		});
		this.renderPlan({ ...plan, steps });
	}

	finish(event: Extract<AgentEvent, { type: 'final' | 'error' }>): void {
		this.stopBtn.remove();
		this.root.addClass('is-finished');
		this.root.querySelector('.auditor-run-header')?.addClass(event.type === 'error' ? 'is-error' : 'is-done');
		if (event.type === 'error') {
			this.setStatus('Stopped with an error');
			this.root.createDiv({ text: event.message, cls: 'auditor-run-error' });
		} else {
			this.setStatus(event.askedUser ? 'Needs your input' : event.text === 'Stopped.' ? 'Stopped' : 'Done');
			if (event.text !== 'Stopped.') renderChatMarkdownInto(this.root.createDiv('auditor-chat-message-text'), event.text);
		}
		this.reconcilePlan(event);
		if (this.toolCount > 0) {
			this.activityDetails.open = false;
			this.activityDetails.querySelector('summary')?.setText(`Activity (${this.toolCount} step${this.toolCount === 1 ? '' : 's'})`);
		}
		this.scroll();
	}
}

/** The chat tab: transcript, agent runs with live plan + approvals, and the input box. */
export class ChatPanel {
	private agent: ChatAgent;
	private messagesEl!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private emptyEl: HTMLElement | null = null;
	private currentRun: RunView | null = null;
	private queueEl!: HTMLElement;
	private queueLaunchBtn!: HTMLButtonElement;
	private unsubscribeQueue: () => void;

	constructor(private container: HTMLElement, private plugin: AuditorPlugin) {
		this.agent = new ChatAgent(plugin);
		this.render();
		this.unsubscribeQueue = plugin.draftQueue.onChange(() => this.renderQueue());
		this.renderQueue();
	}

	private render(): void {
		const bar = this.container.createDiv('auditor-chat-toolbar');
		bar.createSpan({ text: 'Agent', cls: 'auditor-chat-toolbar-title' });
		const newChat = bar.createEl('button', { text: 'New chat', cls: 'auditor-chat-new' });
		newChat.addEventListener('click', () => this.resetChat());

		this.queueEl = this.container.createDiv('auditor-queue auditor-agent-hidden');

		this.messagesEl = this.container.createDiv('auditor-chat-messages');
		this.renderEmptyState();

		const row = this.container.createDiv('auditor-chat-input-row');
		this.input = row.createEl('textarea', { cls: 'auditor-chat-input' });
		this.input.rows = 1;
		this.input.placeholder = 'Ask about controls, evidence, standards or meetings…';
		this.input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});
	}

	private renderEmptyState(): void {
		this.emptyEl = this.messagesEl.createDiv('auditor-chat-empty');
		this.emptyEl.createEl('h4', { text: 'Start an audit task' });
		this.emptyEl.createEl('p', {
			text: 'Find controls, read standards, evidence, meeting notes and session plans, and draft edits. The plan updates as work proceeds, and nothing is saved until you approve it.',
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
		this.currentRun?.cancelPending('The chat was closed.');
		this.agent.stop();
		this.unsubscribeQueue();
	}

	/**
	 * The drafting-queue drawer: filled from the Controls view's "Add to queue" buttons, edited here
	 * (per-item extra instructions, delete), and launched into a single agent run that works through
	 * every item in order. Hidden entirely while empty so it doesn't clutter the chat for people not
	 * using it.
	 */
	private renderQueue(): void {
		const items = this.plugin.draftQueue.list();
		this.queueEl.toggleClass('auditor-agent-hidden', items.length === 0);
		if (items.length === 0) return;
		this.queueEl.empty();

		const header = this.queueEl.createDiv('auditor-queue-header');
		setIcon(header.createSpan('auditor-queue-icon'), 'list-todo');
		header.createSpan({ text: `Drafting queue (${items.length})`, cls: 'auditor-queue-title' });
		const clearBtn = header.createEl('a', { text: 'Clear', cls: 'auditor-queue-clear' });
		clearBtn.addEventListener('click', (e) => {
			e.preventDefault();
			this.plugin.draftQueue.clear();
		});

		const list = this.queueEl.createDiv('auditor-queue-list');
		for (const item of items) {
			const row = list.createDiv('auditor-queue-item');
			const head = row.createDiv('auditor-queue-item-head');
			head.createSpan({ text: item.controlNumber || '(no number)', cls: 'auditor-queue-item-number' });
			head.createSpan({ text: STAGE_LABEL[item.stage], cls: `auditor-queue-item-stage auditor-queue-item-stage-${item.stage}` });
			if (item.topic) head.createSpan({ text: item.topic, cls: 'auditor-queue-item-topic' });
			const removeBtn = head.createEl('a', { text: 'Remove', cls: 'auditor-queue-item-remove' });
			removeBtn.addEventListener('click', (e) => {
				e.preventDefault();
				this.plugin.draftQueue.remove(item.id);
			});
			const note = row.createEl('input', { type: 'text', cls: 'auditor-queue-item-note' });
			note.placeholder = 'Add instructions for this item (optional)…';
			note.value = item.note;
			note.addEventListener('input', () => { this.plugin.draftQueue.setNote(item.id, note.value); });
		}

		const footer = this.queueEl.createDiv('auditor-queue-footer');
		this.queueLaunchBtn = footer.createEl('button', { text: 'Launch queue', cls: 'mod-cta' });
		this.queueLaunchBtn.addEventListener('click', () => this.launchQueue());
		this.updateQueueLaunchState();
	}

	private updateQueueLaunchState(): void {
		if (!this.queueLaunchBtn) return;
		this.queueLaunchBtn.disabled = this.agent.isRunning || this.plugin.draftQueue.size === 0;
		this.queueLaunchBtn.setText(this.agent.isRunning ? 'Agent is busy…' : 'Launch queue');
	}

	private launchQueue(): void {
		const items = this.plugin.draftQueue.list();
		if (items.length === 0 || this.agent.isRunning) return;
		if (!this.plugin.settings.geminiApiKey) {
			new Notice('Auditor: add your Gemini API key in the plugin settings first.');
			return;
		}
		const prompt = buildQueueLaunchPrompt(items);
		this.plugin.draftQueue.clear();
		this.addUserMessage(`Launched the drafting queue: ${items.map((i) => `${i.controlNumber} (${STAGE_LABEL[i.stage]})`).join(', ')}.`);
		void this.startRun(prompt);
	}

	private resetChat(): void {
		this.currentRun?.cancelPending('The chat was reset.');
		this.agent.stop();
		this.agent.reset();
		this.currentRun = null;
		this.messagesEl.empty();
		this.renderEmptyState();
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
			this.addUserMessage(text, 'Sent while working — the agent will see this before its next step');
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
		this.updateQueueLaunchState();
		this.scrollToBottom();

		const host: AgentHost = {
			emit: (event) => {
				if (event.type === 'plan') run.renderPlan(event.plan);
				else if (event.type === 'note') run.addNote(event.text);
				else if (event.type === 'tool_start') run.toolStart(event.id, event.label);
				else if (event.type === 'tool_end') run.toolEnd(event.id, event.ok, event.summary);
				else run.finish(event);
			},
			requestApproval: (proposal) => run.showProposal(proposal),
			reportApplied: (outcomes) => run.showApplied(outcomes),
		};
		await this.agent.run(text, host);
		if (this.currentRun === run) this.currentRun = null;
		this.updateQueueLaunchState();
		this.input.focus();
	}
}
