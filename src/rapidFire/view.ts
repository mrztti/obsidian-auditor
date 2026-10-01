import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from '../main';
import { formatCost, formatTokens, sumUsage } from '../agent/usage';
import { RapidFireEngine, type RapidFireEngineHost } from './engine';
import { RAPID_FIRE_STATE_LABELS, type RapidFireBatch, type RapidFireItem, type RapidFireState } from './types';

export const RAPID_FIRE_VIEW_TYPE = 'auditor-rapid-fire-view';

type Tab = 'overview' | 'batches' | 'evidence' | 'review';
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', batches: 'Topic batches', evidence: 'Evidence map', review: 'Review queue' };

/** States shown together under "Drafting progress" in the overview — everything from being classified through a completed draft. */
const DRAFTING_STATES: RapidFireState[] = ['queued', 'classifying', 'researching', 'ready_to_draft', 'drafting'];

const PAUSE_REASON_LABELS: Record<NonNullable<RapidFireBatch['pauseReason']>, string> = {
	user: 'Paused by you.',
	max_batch_cost: 'Paused: max batch cost reached. Raise the limit in Auditor settings, or just keep reviewing/accepting what\'s ready, then Resume.',
	max_boosted_escalation: 'Paused: boosted-model escalation budget reached. Raise the limit in Auditor settings, then Resume.',
	no_writing_style_profile: 'Paused: no writing-style profile is configured, so QA has nothing to check against. Set one in Auditor settings → Writing style profile, then Resume.',
	error: 'Paused: an unexpected error occurred. Check the console for details, then Resume to retry.',
};
/** States shown under "QA progress". */
const QA_STATES: RapidFireState[] = ['ready_for_qa', 'qa_failed'];

function estimateCostUsd(batch: RapidFireBatch, plugin: AuditorPlugin): { retrievalTokens: number; draftingTokens: number; qaTokens: number; totalProjectedUsd: number } {
	const n = batch.items.length;
	const uniqueControls = new Set(batch.items.map((i) => i.controlNumber)).size;
	// Rough heuristics — see FR-8.8: one retrieval pass per ~4 controls' worth of topic batches, a drafting+QA call per item.
	const retrievalTokens = Math.ceil(uniqueControls / 4) * 3000;
	const draftingTokens = n * 1400;
	const qaTokens = n * 900;
	const s = plugin.settings;
	const blendedInRate = (s.baseModelInputPricePerMtok + s.baseModelOutputPricePerMtok) / 2;
	const totalProjectedUsd = ((retrievalTokens + draftingTokens + qaTokens) / 1_000_000) * blendedInRate;
	return { retrievalTokens, draftingTokens, qaTokens, totalProjectedUsd };
}

/**
 * The Rapid Fire workspace (Epic 8): one view with tabbed sections standing in for FR-8.2's seven
 * "primary views" — Batch overview + Drafting/QA progress live together in Overview (they're all
 * just different slices of the same per-item state), Topic batches and Evidence map are Phase
 * 1/2's own outputs, and Review queue is Phase 5. A literal seventh "token and cost dashboard" view
 * didn't earn its own tab — the running total is already visible in the header on every tab.
 */
export class RapidFireView extends ItemView {
	private batch: RapidFireBatch | null = null;
	private engine: RapidFireEngine;
	private tab: Tab = 'overview';
	private body!: HTMLElement;
	private headerUsageEl!: HTMLElement;
	private running = false;
	private stopRequest: 'none' | 'pause' | 'cancel' = 'none';
	private reviewFilters = { batchId: '', stage: '', qa: '' as '' | 'pass' | 'fail', decision: '' as '' | 'accepted' | 'rejected' | 'undecided' };
	private focusedReviewIndex = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: AuditorPlugin) {
		super(leaf);
		this.engine = new RapidFireEngine(plugin);
	}

	getViewType(): string { return RAPID_FIRE_VIEW_TYPE; }
	getDisplayText(): string { return this.batch ? `Rapid Fire (${this.batch.id.slice(-6)})` : 'Rapid Fire'; }
	getIcon(): string { return 'zap'; }

	async setBatch(batchId: string): Promise<void> {
		this.batch = this.plugin.rapidFireStore.get(batchId) ?? null;
		await this.render();
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	onClose(): Promise<void> {
		return Promise.resolve();
	}

	private async render(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-rapid-fire-view');

		if (!this.batch) {
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Rapid Fire" and "Controls" are literal feature/view names
			container.createEl('p', { text: 'No Rapid Fire batch selected — export one from the Controls view.', cls: 'auditor-status' });
			return;
		}

		const header = container.createDiv('auditor-rf-header');
		header.createEl('h3', { text: `Rapid Fire — ${this.batch.filtersSummary}` });
		this.headerUsageEl = header.createDiv('auditor-rf-usage');
		this.renderHeaderUsage();

		const tabBar = container.createDiv('auditor-rf-tabbar');
		for (const t of Object.keys(TAB_LABELS) as Tab[]) {
			const btn = tabBar.createEl('button', { text: TAB_LABELS[t], cls: `auditor-rf-tab-btn${this.tab === t ? ' is-active' : ''}` });
			btn.addEventListener('click', () => { this.tab = t; void this.render(); });
		}

		this.body = container.createDiv('auditor-rf-body');
		if (this.tab === 'overview') this.renderOverview(this.body);
		else if (this.tab === 'batches') this.renderBatchesTab(this.body);
		else if (this.tab === 'evidence') this.renderEvidenceTab(this.body);
		else this.renderReviewTab(this.body);
	}

	private renderHeaderUsage(): void {
		if (!this.batch) return;
		const totals = sumUsage(this.batch.usage);
		this.headerUsageEl.setText(`${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out · ${formatCost(totals.totalCost)} spent${this.batch.boostedUsageUsd > 0 ? ` (${formatCost(this.batch.boostedUsageUsd)} boosted)` : ''}`);
	}

	// ─── Overview tab ───────────────────────────────────────────────────────
	private renderOverview(container: HTMLElement): void {
		const batch = this.batch;
		if (!batch) return;

		const controls = container.createDiv('auditor-rf-controls-row');
		controls.createSpan({ text: `Status: ${batch.status}`, cls: 'auditor-rf-status' });
		if (batch.pauseReason) {
			container.createDiv({ text: PAUSE_REASON_LABELS[batch.pauseReason], cls: 'auditor-rf-pause-notice' });
		}

		if (!batch.estimate && batch.status === 'queued') {
			batch.estimate = estimateCostUsd(batch, this.plugin);
		}
		if (batch.estimate && batch.usage.length === 0) {
			container.createDiv({
				cls: 'auditor-field-description',
				text: `Estimated before starting: ~${formatTokens(batch.estimate.retrievalTokens)} retrieval + ~${formatTokens(batch.estimate.draftingTokens)} drafting + ~${formatTokens(batch.estimate.qaTokens)} QA tokens ≈ ${formatCost(batch.estimate.totalProjectedUsd)}.`,
			});
		} else if (batch.estimate) {
			const actual = sumUsage(batch.usage).totalCost;
			container.createDiv({ cls: 'auditor-field-description', text: `Actual so far: ${formatCost(actual)} vs. estimated ${formatCost(batch.estimate.totalProjectedUsd)}.` });
		}

		const startBtn = controls.createEl('button', { text: batch.status === 'queued' ? 'Start' : batch.status === 'paused' ? 'Resume' : 'Running…', cls: 'mod-cta' });
		startBtn.disabled = this.running || batch.status === 'completed' || batch.status === 'cancelled';
		startBtn.addEventListener('click', () => void this.start());

		const pauseBtn = controls.createEl('button', { text: 'Pause' });
		pauseBtn.disabled = !this.running;
		pauseBtn.addEventListener('click', () => { this.stopRequest = 'pause'; });

		const cancelBtn = controls.createEl('button', { text: 'Cancel batch', cls: 'mod-warning' });
		cancelBtn.disabled = batch.status === 'completed' || batch.status === 'cancelled';
		cancelBtn.addEventListener('click', () => {
			if (this.running) this.stopRequest = 'cancel';
			else { batch.status = 'cancelled'; this.plugin.rapidFireStore.touch(); void this.render(); }
		});

		container.createEl('h4', { text: 'Drafting progress' });
		this.renderStateTable(container, batch, DRAFTING_STATES);
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "QA" is a literal acronym
		container.createEl('h4', { text: 'QA progress' });
		this.renderStateTable(container, batch, QA_STATES);
		container.createEl('h4', { text: 'Ready for review / done' });
		this.renderStateTable(container, batch, ['ready_for_review', 'changes_requested', 'accepted']);
		container.createEl('h4', { text: 'Blocked' });
		this.renderStateTable(container, batch, ['blocked'], true);
	}

	private renderStateTable(container: HTMLElement, batch: RapidFireBatch, states: RapidFireState[], showRetry = false): void {
		const items = batch.items.filter((i) => states.includes(i.state));
		if (items.length === 0) { container.createEl('p', { text: 'None.', cls: 'auditor-field-description' }); return; }
		const list = container.createDiv('auditor-rf-item-list');
		for (const item of items) {
			const row = list.createDiv('auditor-rf-item-row');
			row.createSpan({ text: item.controlNumber, cls: 'auditor-rf-item-number' });
			row.createSpan({ text: item.stage === 'stage1' ? 'Stage 1' : 'Stage 2', cls: 'auditor-rf-item-stage' });
			row.createSpan({ text: RAPID_FIRE_STATE_LABELS[item.state], cls: `auditor-rf-item-state is-${item.state}` });
			if (item.blockedReason) row.createSpan({ text: item.blockedReason, cls: 'auditor-field-description' });
			if (showRetry) {
				const retryBtn = row.createEl('button', { text: 'Retry' });
				retryBtn.addEventListener('click', () => {
					item.state = item.qaResult ? 'ready_for_qa' : 'ready_to_draft';
					item.blockedReason = undefined;
					this.plugin.rapidFireStore.touch();
					void this.render();
				});
			}
		}
	}

	private async start(): Promise<void> {
		if (!this.batch || this.running) return;
		this.running = true;
		this.stopRequest = 'none';
		const host: RapidFireEngineHost = {
			emit: (event) => {
				if (event.type === 'usage') this.renderHeaderUsage();
				// Item-state/compaction-style granular events re-render the current tab's table on
				// every change — batches are small enough (bounded by the Controls view export) that
				// this stays responsive without needing an in-place DOM diff like the chat view's.
				if (this.tab === 'overview') void this.render();
			},
			shouldStop: () => {
				if (this.stopRequest === 'cancel') return 'cancel';
				if (this.stopRequest === 'pause') return 'pause';
				return 'continue';
			},
		};
		try {
			await this.engine.run(this.batch, host);
		} catch (e) {
			new Notice(`Rapid Fire batch failed: ${String(e)}`);
			if (this.batch) { this.batch.status = 'paused'; this.batch.pauseReason = 'error'; }
		} finally {
			this.running = false;
			this.plugin.rapidFireStore.touch();
			await this.render();
		}
	}

	// ─── Topic batches tab (FR-8.3) ─────────────────────────────────────────
	private renderBatchesTab(container: HTMLElement): void {
		const batch = this.batch;
		if (!batch) return;
		if (batch.similarityBatches.length === 0) { container.createEl('p', { text: 'Not yet classified — start the batch.', cls: 'auditor-status' }); return; }
		for (const sb of batch.similarityBatches) {
			const card = container.createDiv('auditor-rf-batch-card');
			card.createEl('h4', { text: `${sb.topicLabel} (${sb.controlNumbers.length} control${sb.controlNumbers.length === 1 ? '' : 's'}, ~${formatTokens(sb.estimatedContextTokens)} tokens)` });
			if (sb.sharedTerms.length > 0) card.createDiv({ text: `Shared terms: ${sb.sharedTerms.join(', ')}`, cls: 'auditor-field-description' });
			const list = card.createDiv('auditor-rf-item-list');
			for (const n of sb.controlNumbers) {
				const row = list.createDiv('auditor-rf-item-row');
				row.createSpan({ text: n, cls: 'auditor-rf-item-number' });
				row.createSpan({ text: sb.reasons[n] ?? '', cls: 'auditor-field-description' });
			}
		}
	}

	// ─── Evidence map tab (FR-8.4) ──────────────────────────────────────────
	private renderEvidenceTab(container: HTMLElement): void {
		const batch = this.batch;
		if (!batch) return;
		if (batch.evidenceMaps.length === 0) { container.createEl('p', { text: 'No evidence gathered yet.', cls: 'auditor-status' }); return; }
		for (const map of batch.evidenceMaps) {
			const card = container.createDiv('auditor-rf-batch-card');
			card.createEl('h4', { text: `${map.themeLabel} (${map.facts.length} fact${map.facts.length === 1 ? '' : 's'}, ~${formatTokens(map.contextTokenCount)} tokens)` });
			for (const fact of map.facts) {
				const row = card.createDiv('auditor-rf-fact-row');
				row.createDiv({ text: fact.text });
				row.createDiv({ text: `${fact.sourcePath}${fact.location ? ` (${fact.location})` : ''} — ${fact.controlNumbers.join(', ')}`, cls: 'auditor-field-description' });
			}
			if (map.unresolvedQuestions.length > 0) {
				card.createEl('p', { text: 'Unresolved:', cls: 'auditor-field-label' });
				for (const q of map.unresolvedQuestions) card.createEl('p', { text: q, cls: 'auditor-field-description' });
			}
		}
	}

	// ─── Review queue tab (FR-8.7) ──────────────────────────────────────────
	private renderReviewTab(container: HTMLElement): void {
		const batch = this.batch;
		if (!batch) return;

		const filterRow = container.createDiv('auditor-rf-filter-row');
		const batchSelect = filterRow.createEl('select');
		batchSelect.createEl('option', { text: 'All topic batches', value: '' });
		for (const sb of batch.similarityBatches) batchSelect.createEl('option', { text: sb.topicLabel, value: sb.batchId });
		batchSelect.value = this.reviewFilters.batchId;
		batchSelect.addEventListener('change', () => { this.reviewFilters.batchId = batchSelect.value; void this.render(); });

		const stageSelect = filterRow.createEl('select');
		for (const [v, label] of [['', 'All stages'], ['stage1', 'Stage 1'], ['stage2', 'Stage 2']]) stageSelect.createEl('option', { text: label, value: v });
		stageSelect.value = this.reviewFilters.stage;
		stageSelect.addEventListener('change', () => { this.reviewFilters.stage = stageSelect.value; void this.render(); });

		const qaSelect = filterRow.createEl('select');
		for (const [v, label] of [['', 'Any QA result'], ['pass', 'QA passed'], ['fail', 'QA failed']]) qaSelect.createEl('option', { text: label, value: v });
		qaSelect.value = this.reviewFilters.qa;
		qaSelect.addEventListener('change', () => { this.reviewFilters.qa = qaSelect.value as typeof this.reviewFilters.qa; void this.render(); });

		const decisionSelect = filterRow.createEl('select');
		for (const [v, label] of [['', 'Any decision'], ['undecided', 'Undecided'], ['accepted', 'Accepted'], ['rejected', 'Rejected']]) decisionSelect.createEl('option', { text: label, value: v });
		decisionSelect.value = this.reviewFilters.decision;
		decisionSelect.addEventListener('change', () => { this.reviewFilters.decision = decisionSelect.value as typeof this.reviewFilters.decision; void this.render(); });

		const items = batch.items.filter((i) => {
			if (i.state !== 'ready_for_review' && i.decision === undefined) return false;
			if (this.reviewFilters.batchId && i.batchId !== this.reviewFilters.batchId) return false;
			if (this.reviewFilters.stage && i.stage !== this.reviewFilters.stage) return false;
			if (this.reviewFilters.qa === 'pass' && !i.qaResult?.pass) return false;
			if (this.reviewFilters.qa === 'fail' && i.qaResult?.pass !== false) return false;
			if (this.reviewFilters.decision === 'undecided' && i.decision !== undefined) return false;
			if (this.reviewFilters.decision === 'accepted' && i.decision !== 'accepted') return false;
			if (this.reviewFilters.decision === 'rejected' && i.decision !== 'rejected') return false;
			return true;
		});

		if (items.length === 0) { container.createEl('p', { text: 'Nothing to review (yet).', cls: 'auditor-status' }); return; }

		// eslint-disable-next-line obsidianmd/ui/sentence-case -- single-letter key labels, not sentence text
		const hint = container.createEl('p', { cls: 'auditor-field-description', text: 'Keyboard: ↑/↓ to move, A to accept, R to reject the focused item.' });
		void hint;

		const list = container.createDiv('auditor-rf-review-list');
		list.tabIndex = 0;
		const rows: HTMLElement[] = [];
		items.forEach((item, i) => {
			const row = this.renderReviewItem(list, item, batch);
			if (i === this.focusedReviewIndex) row.addClass('is-focused');
			rows.push(row);
		});

		list.addEventListener('keydown', (e) => {
			if (e.target instanceof HTMLTextAreaElement) return;
			if (e.key === 'ArrowDown') { e.preventDefault(); this.focusedReviewIndex = Math.min(items.length - 1, this.focusedReviewIndex + 1); void this.render(); }
			else if (e.key === 'ArrowUp') { e.preventDefault(); this.focusedReviewIndex = Math.max(0, this.focusedReviewIndex - 1); void this.render(); }
			else if (e.key.toLowerCase() === 'a') { const item = items[this.focusedReviewIndex]; if (item) { item.decision = 'accepted'; void this.render(); } }
			else if (e.key.toLowerCase() === 'r') { const item = items[this.focusedReviewIndex]; if (item) { item.decision = 'rejected'; void this.render(); } }
		});

		const footer = container.createDiv('auditor-rf-review-footer');
		const undecided = items.filter((i) => i.decision === undefined).length;
		const rejectedWithoutComment = items.filter((i) => i.decision === 'rejected' && !i.comment?.trim()).length;
		const hintEl = footer.createSpan({ cls: 'auditor-field-description' });
		hintEl.setText(undecided > 0 ? `${undecided} item(s) not yet decided` : rejectedWithoutComment > 0 ? `${rejectedWithoutComment} rejection(s) need a comment` : '');
		const submitBtn = footer.createEl('button', { text: 'Submit review', cls: 'mod-cta' });
		submitBtn.disabled = undecided > 0 || rejectedWithoutComment > 0;
		submitBtn.addEventListener('click', () => void this.submitReview());
	}

	private renderReviewItem(list: HTMLElement, item: RapidFireItem, batch: RapidFireBatch): HTMLElement {
		const row = list.createDiv('auditor-rf-review-item');
		const head = row.createDiv('auditor-rf-review-item-head');
		head.createSpan({ text: `${item.controlNumber} · ${item.stage === 'stage1' ? 'Stage 1' : 'Stage 2'}`, cls: 'auditor-proposal-number' });
		head.createSpan({ text: item.qaResult?.pass ? 'QA passed' : 'QA failed', cls: `auditor-rf-qa-badge ${item.qaResult?.pass ? 'is-pass' : 'is-fail'}` });

		row.createEl('p', { text: item.qaResult?.correctedConclusionText ?? item.draftConclusion ?? '', cls: 'auditor-rf-review-text' });
		row.createEl('p', { text: `Rating: ${item.qaResult?.correctedRating ?? item.draftRating ?? ''}`, cls: 'auditor-field-description' });
		if (item.qaResult && item.qaResult.findings.length > 0) {
			row.createEl('p', { text: `QA findings: ${item.qaResult.findings.join('; ')}`, cls: 'auditor-field-description' });
		}

		const decisionRow = row.createDiv('auditor-proposal-decision-row');
		const acceptBtn = decisionRow.createEl('button', { text: 'Accept', cls: `auditor-proposal-accept${item.decision === 'accepted' ? ' is-selected' : ''}` });
		const rejectBtn = decisionRow.createEl('button', { text: 'Reject', cls: `auditor-proposal-reject${item.decision === 'rejected' ? ' is-selected' : ''}` });
		acceptBtn.addEventListener('click', () => { item.decision = item.decision === 'accepted' ? undefined : 'accepted'; void this.render(); });
		rejectBtn.addEventListener('click', () => { item.decision = item.decision === 'rejected' ? undefined : 'rejected'; void this.render(); });

		if (item.decision) {
			const comment = row.createEl('textarea', { cls: 'auditor-pipeline-textarea' });
			comment.rows = 2;
			comment.placeholder = item.decision === 'rejected' ? 'Required: what should change?' : 'Optional note…';
			comment.value = item.comment ?? '';
			comment.addEventListener('input', () => { item.comment = comment.value; void this.refreshSubmitState(); });
		}

		void batch;
		return row;
	}

	/** Cheap refresh for the footer's enabled/disabled state after a comment edit, without re-rendering the whole (possibly long) review list and losing textarea focus. */
	private async refreshSubmitState(): Promise<void> {
		if (!this.batch) return;
		const footer = this.body.querySelector('.auditor-rf-review-footer');
		if (!footer) return;
		await Promise.resolve();
		const items = this.batch.items.filter((i) => i.state === 'ready_for_review' || i.decision !== undefined);
		const undecided = items.filter((i) => i.decision === undefined).length;
		const rejectedWithoutComment = items.filter((i) => i.decision === 'rejected' && !i.comment?.trim()).length;
		const hintEl = footer.querySelector('.auditor-field-description');
		if (hintEl) hintEl.textContent = undecided > 0 ? `${undecided} item(s) not yet decided` : rejectedWithoutComment > 0 ? `${rejectedWithoutComment} rejection(s) need a comment` : '';
		const submitBtn = footer.querySelector('button.mod-cta');
		if (submitBtn instanceof HTMLButtonElement) submitBtn.disabled = undecided > 0 || rejectedWithoutComment > 0;
	}

	private async submitReview(): Promise<void> {
		if (!this.batch) return;
		const { saved, failed } = await this.engine.submitReview(this.batch);
		this.plugin.rapidFireStore.touch();
		new Notice(`Rapid Fire: saved ${saved.length}${failed.length > 0 ? `, failed ${failed.length}` : ''}.`);
		const rejected = this.batch.items.filter((i) => i.state === 'changes_requested').length;
		if (rejected > 0) {
			this.engine.prepareRefinement(this.batch);
			new Notice(`${rejected} item(s) queued for refinement — press Start/Resume on the Overview tab to redraft them.`);
			this.tab = 'overview';
		}
		await this.render();
	}
}
