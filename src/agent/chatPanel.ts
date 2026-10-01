import { Notice, setIcon } from 'obsidian';
import type AuditorPlugin from '../main';
import { renderChatMarkdownInto } from '../markdown';
import { ChatAgent } from './agent';
import type { DraftQueueItem, DraftStage } from './draftQueue';
import { renderProposalCard, type ProposalCardHandle } from './proposalCard';
import type { AgentEvent, AgentHost, AgentPlan, ApplyOutcome, ApprovalDecision, ContextUsageSnapshot, ErrorRecoverySnapshot, ExecutionDecision, ExecutionSnapshot, PlanStepStatus, ReviewProposal } from './types';
import { formatTokens as formatTokensCompact, formatUsageLine, sumUsage, type StepUsage, type UsageTotals } from './usage';

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

/** A small "Burn Mode" fire-outline badge — pink→orange gradient, via a CSS mask rather than `setIcon` so the gradient shows through the icon's own outline shape instead of a flat currentColor fill. */
function createBurnIcon(container: HTMLElement, label = 'Burn Mode'): HTMLElement {
	const icon = container.createSpan({ cls: 'auditor-burn-icon' });
	icon.setAttr('aria-label', label);
	return icon;
}

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
	/** Resolves a currently-shown checkpoint/error-recovery pause card — see `showPause`. */
	private pendingPauseResolve: ((d: ExecutionDecision) => void) | null = null;
	private toolCount = 0;
	/** One cost/token badge per plan step id, refreshed in place by `updateUsage` so a usage tick never needs a full plan re-render. */
	private stepUsageEls = new Map<string, HTMLElement>();
	private runTotalEl: HTMLElement | null = null;
	/** Context-window usage badge (FR-6.2) — lives in the run header since context events can arrive before any plan exists. */
	private contextEl: HTMLElement;

	constructor(parent: HTMLElement, private plugin: AuditorPlugin, onStop: () => void, private scroll: () => void) {
		this.root = parent.createDiv('auditor-chat-message auditor-chat-message-assistant auditor-run');
		const header = this.root.createDiv('auditor-run-header');
		setIcon(header.createSpan('auditor-run-spinner'), 'loader-2');
		this.statusEl = header.createSpan({ text: 'Thinking…', cls: 'auditor-run-status' });
		this.contextEl = header.createSpan({ cls: 'auditor-context-badge auditor-agent-hidden' });
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
		this.runTotalEl = head.createSpan({ cls: 'auditor-plan-usage-total auditor-agent-hidden' });
		if (plan.objective) this.planEl.createDiv({ text: plan.objective, cls: 'auditor-plan-objective' });

		const bar = this.planEl.createDiv('auditor-plan-bar');
		bar.createDiv('auditor-plan-bar-fill').setCssProps({ width: `${plan.steps.length ? Math.round((finished / plan.steps.length) * 100) : 0}%` });

		this.stepUsageEls.clear();
		const list = this.planEl.createEl('ol', { cls: 'auditor-plan-steps' });
		for (const step of plan.steps) {
			const isNew = previous !== null && !prevTitles.has(step.id);
			const li = list.createEl('li', { cls: `auditor-plan-step is-${step.status}${isNew ? ' is-new' : ''}` });
			setIcon(li.createSpan('auditor-plan-step-icon'), STEP_ICONS[step.status]);
			li.createSpan({ text: step.title, cls: 'auditor-plan-step-title' });
			if (step.burn) createBurnIcon(li, 'Burn Mode step — uses the boosted model');
			const usageEl = li.createSpan({ cls: 'auditor-plan-step-usage auditor-agent-hidden' });
			this.stepUsageEls.set(step.id, usageEl);
			if (step.usage?.length) this.setStepUsageText(usageEl, sumUsage(step.usage));
		}
		this.scroll();
	}

	private setStepUsageText(el: HTMLElement, totals: UsageTotals, prefix = ''): void {
		el.removeClass('auditor-agent-hidden');
		el.setText(prefix + formatUsageLine(totals));
	}

	/** Called by the host on every `usage` event — refreshes just that step's badge plus the run total, without touching the rest of the plan DOM. */
	updateUsage(stepId: string, _usage: StepUsage, runTotals: UsageTotals): void {
		const stepEl = this.stepUsageEls.get(stepId);
		if (stepEl) {
			const step = this.lastPlan?.steps.find((s) => s.id === stepId);
			this.setStepUsageText(stepEl, step?.usage?.length ? sumUsage(step.usage) : runTotals);
		}
		if (this.runTotalEl) this.setStepUsageText(this.runTotalEl, runTotals, 'Run: ');
	}

	/** Called on every `context` event (FR-6.2) — current/max tokens, % used, and a status-coloured badge. */
	updateContext(usage: ContextUsageSnapshot): void {
		this.contextEl.removeClass('auditor-agent-hidden');
		this.contextEl.empty();
		this.contextEl.removeClass('is-normal', 'is-approaching', 'is-compaction_required');
		this.contextEl.addClass(`is-${usage.status}`);
		const pct = Math.min(100, Math.max(0, usage.percentUsed));
		const tokensText = `${formatTokensCompact(usage.currentTokens)}${usage.estimated ? '~' : ''} / ${formatTokensCompact(usage.maxTokens)}`;
		this.contextEl.setText(`Context: ${tokensText} (${pct.toFixed(0)}%)`);
		const label = usage.status === 'compaction_required' ? 'Compaction required' : usage.status === 'approaching' ? 'Approaching context limit' : 'Context usage normal';
		this.contextEl.setAttr('aria-label', `${label}. Reserved: ${formatTokensCompact(usage.reservedTokens)}. Last compaction: ${usage.lastCompactionAt ? `step ${usage.lastCompactionStep}, ${usage.lastCompactionAt}` : 'never'}.`);
	}

	/** A passive note in the activity log (FR-6.4: "users can see compaction occurred without being interrupted") — never a modal or anything blocking. */
	noteCompaction(beforeTokens: number, afterTokens: number, duplicatesRemoved: number, elided: number): void {
		const parts = [`Compacted context: ~${formatTokensCompact(beforeTokens)} → ~${formatTokensCompact(afterTokens)} tokens`];
		if (duplicatesRemoved > 0) parts.push(`${duplicatesRemoved} duplicate result${duplicatesRemoved === 1 ? '' : 's'} removed`);
		if (elided > 0) parts.push(`${elided} large result${elided === 1 ? '' : 's'} condensed`);
		this.addNote(parts.join(' — '));
	}

	addNote(text: string): void {
		this.activityDetails.removeClass('auditor-agent-hidden');
		this.activityList.createDiv({ text, cls: 'auditor-activity-note' });
		this.scroll();
	}

	toolStart(id: number, label: string, burn: boolean): void {
		this.activityDetails.removeClass('auditor-agent-hidden');
		this.toolCount++;
		const row = this.activityList.createDiv('auditor-activity-row is-running');
		setIcon(row.createSpan('auditor-activity-icon'), 'loader-2');
		row.createSpan({ text: label, cls: 'auditor-activity-label' });
		if (burn) createBurnIcon(row, 'Ran with Burn Mode (boosted model)');
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

	/** Resolves any proposal still awaiting review as rejected, and any open checkpoint/error-recovery pause as "stop" — used when the run is stopped or the chat is reset. */
	cancelPending(reason: string): void {
		if (this.pendingResolve) {
			const resolve = this.pendingResolve;
			this.pendingResolve = null;
			this.proposalHandle?.lock('Not applied');
			this.proposalHandle = null;
			resolve({ approved: [], rejected: [], comments: {} });
		}
		if (this.pendingPauseResolve) {
			const resolve = this.pendingPauseResolve;
			this.pendingPauseResolve = null;
			resolve('stop');
		}
	}

	/**
	 * Renders a single pause card — used for both the routine checkpoint (FR-4.1) and
	 * error-recovery (FR-4.2) prompts, which only differ in heading/body copy and whether an
	 * attempt count is shown. The card stays in place once decided (no separate "applied" step):
	 * it just locks and shows which choice was made.
	 */
	private showPause(heading: string, body: string, snapshot: ExecutionSnapshot, attempt?: number): Promise<ExecutionDecision> {
		this.setStatus('Waiting for your decision…');
		return new Promise((resolve) => {
			this.pendingPauseResolve = resolve;
			const card = this.root.createDiv('auditor-pause-card');
			const head = card.createDiv('auditor-pause-head');
			setIcon(head.createSpan('auditor-pause-icon'), 'pause-circle');
			head.createSpan({ text: heading, cls: 'auditor-pause-heading' });
			card.createEl('p', { text: body, cls: 'auditor-pause-body' });

			const stats = card.createDiv('auditor-pause-stats');
			stats.createSpan({ text: `${snapshot.completed} completed`, cls: 'auditor-pause-stat' });
			stats.createSpan({ text: `${snapshot.pending} pending`, cls: 'auditor-pause-stat' });
			if (snapshot.failed > 0) stats.createSpan({ text: `${snapshot.failed} failed`, cls: 'auditor-pause-stat' });
			if (snapshot.skipped > 0) stats.createSpan({ text: `${snapshot.skipped} skipped`, cls: 'auditor-pause-stat' });
			if (attempt !== undefined) stats.createSpan({ text: `attempt ${attempt}`, cls: 'auditor-pause-stat' });

			card.createDiv({ text: `Run so far: ${formatUsageLine(snapshot.runTotals)}`, cls: 'auditor-pause-usage' });
			card.createDiv({ text: `Session: ${formatUsageLine(snapshot.sessionTotals)}`, cls: 'auditor-pause-usage' });

			const buttons = card.createDiv('auditor-pause-buttons');
			const continueBtn = buttons.createEl('button', { text: 'Continue', cls: 'mod-cta' });
			const stopBtn = buttons.createEl('button', { text: 'Stop' });
			const settle = (decision: ExecutionDecision) => {
				this.pendingPauseResolve = null;
				continueBtn.disabled = true;
				stopBtn.disabled = true;
				card.addClass('is-settled');
				card.createDiv({ text: decision === 'continue' ? 'Continuing…' : 'Stopped.', cls: 'auditor-pause-outcome' });
				this.setStatus(decision === 'continue' ? 'Continuing…' : 'Stopped');
				resolve(decision);
			};
			continueBtn.addEventListener('click', () => settle('continue'));
			stopBtn.addEventListener('click', () => settle('stop'));
			this.scroll();
		});
	}

	showCheckpoint(info: ExecutionSnapshot): Promise<ExecutionDecision> {
		return this.showPause(
			'Checkpoint reached',
			'The agent has been working for a while. Nothing is lost either way — continuing picks up from the next pending step, stopping ends the run cleanly with everything reached so far kept.',
			info,
		);
	}

	showErrorRecovery(info: ErrorRecoverySnapshot): Promise<ExecutionDecision> {
		return this.showPause(
			'Model temporarily unavailable',
			'The model is temporarily unavailable — this can happen during high demand and usually clears up shortly. Your progress so far is saved. Continuing retries only the step that failed.',
			info,
			info.attempt,
		);
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
			if (event.text !== 'Stopped.') {
				const wrap = this.root.createDiv(event.burn ? 'auditor-burn-frame' : undefined);
				renderChatMarkdownInto(wrap.createDiv('auditor-chat-message-text'), event.text);
			}
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
	/** Cumulative token/cost total for the whole chat session (every run since the last "New chat"), shown in the toolbar — see `usage.ts`. */
	private sessionTotalEl!: HTMLElement;
	/** "Burn Mode": while on, plan steps the agent itself marks quality-sensitive (QA, planning, drafting) use the boosted model from settings instead of the regular one. Per-chat UI state, not persisted. */
	private burnModeEnabled = false;

	constructor(private container: HTMLElement, private plugin: AuditorPlugin) {
		this.agent = new ChatAgent(plugin);
		this.render();
		this.unsubscribeQueue = plugin.draftQueue.onChange(() => this.renderQueue());
		this.renderQueue();
	}

	private render(): void {
		const bar = this.container.createDiv('auditor-chat-toolbar');
		bar.createSpan({ text: 'Agent', cls: 'auditor-chat-toolbar-title' });
		this.sessionTotalEl = bar.createSpan({ cls: 'auditor-chat-session-usage auditor-agent-hidden' });
		this.sessionTotalEl.setAttr('aria-label', 'Estimated token usage and cost for this chat session, from the configured per-token prices in settings');
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

		this.renderBurnModeToggle(this.container);
	}

	/**
	 * "Burn Mode" toggle — a plain switch below the input, not a settings-page control, since it's
	 * meant to be flicked per-task the way you'd reach for a more expensive tool only when it's worth
	 * it. It only ever does anything when a boosted model is actually configured; otherwise it's shown
	 * disabled with a pointer to where to set one, rather than silently doing nothing.
	 */
	private renderBurnModeToggle(container: HTMLElement): void {
		const hasBoostedModel = this.plugin.settings.boostedModel.trim() !== '';
		const row = container.createDiv('auditor-burn-toggle-row');
		const label = row.createEl('label', { cls: `auditor-burn-toggle${hasBoostedModel ? '' : ' is-disabled'}` });
		const checkbox = label.createEl('input', { type: 'checkbox' });
		checkbox.checked = this.burnModeEnabled;
		checkbox.disabled = !hasBoostedModel;
		createBurnIcon(label);
		label.createSpan({ text: 'Burn Mode', cls: 'auditor-burn-toggle-text' });
		checkbox.addEventListener('change', () => { this.burnModeEnabled = checkbox.checked; });
		row.createSpan({
			text: hasBoostedModel
				? 'Lets the agent use the boosted model for steps it marks quality-sensitive (QA, planning, drafting).'
				: 'Set a boosted model in Auditor settings to enable this.',
			cls: 'auditor-field-description',
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
		await this.agent.run(text, host, () => this.burnModeEnabled);
		if (this.currentRun === run) this.currentRun = null;
		this.updateQueueLaunchState();
		this.input.focus();
	}
}
