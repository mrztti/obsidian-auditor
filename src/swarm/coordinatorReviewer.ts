import { Notice } from 'obsidian';
import type AuditorPlugin from '../main';
import { ControlStore } from '../agent/controlStore';
import { AgentMemoryStore } from '../agent/memory';
import { FIELD_LABELS, type DiffEntry, type DraftStage, type ReviewItem, type ReviewProposal } from '../agent/types';
import { EMPTY_WRITING_STYLE_PROFILE } from '../settings';
import type { AgentBus, AgentMessage } from './bus';
import { createBackgroundHost } from './backgroundHost';
import { COORDINATOR_AGENT_ID } from './coordinatorAgent';
import type { OutboxStore } from './outboxStore';
import { SUBMITTER_AGENT_ID, type SubmissionCheckResult } from './submitterAgent';
import { TaskQueue } from './taskQueue';

export const COORDINATOR_ID = COORDINATOR_AGENT_ID;

/** Called when the USER rejects a staged proposal in the outbox, so the orchestrator can route it back to the originating writer for a full redraft — see `SwarmOrchestrator.requestRevision`. Never used for a submitter block; that loop stays entirely between the coordinator and the submitter (see `fixUntilApproved`). */
export type RevisionRequester = (writerId: string, controlId: string, stage: DraftStage, comment: string) => void;

export interface DraftSubmission {
	writerId: string;
	controlId: string;
	stage: DraftStage;
	controlText: string;
	conclusionText: string;
	rating: string;
	evidenceReferences: string[];
}

/** How many times the coordinator will attempt to fix a draft the submitter blocks, giving the submitter this many checks total, before letting the control through as-is rather than holding it forever — see `fixUntilApproved`. */
const MAX_FIX_ATTEMPTS = 3;

/** Where one (control, stage) currently stands in the coordinator's pipeline — the "appropriate system" for tracking status, since a plain task-queue entry (pending/done/failed) can't express "blocked, on fix attempt 2 of 3" or "let through unresolved after 4 checks". Nothing here is ever silently dropped: every entry stays in `CoordinatorReviewer`'s map until it reaches `staged`/`applied` (normally, or `forced` if the submitter's check never cleared it) or `rejected` (the user's own decision). `needs_attention` is reserved for when the pipeline itself couldn't even run (an exception, not a quality verdict) — a genuine quality disagreement after `MAX_FIX_ATTEMPTS` attempts is let through, flagged, rather than held stuck. */
export type ControlTaskStatus = 'reviewing' | 'fixing' | 'needs_attention' | 'staged' | 'forced' | 'applied' | 'rejected';

export interface ControlTaskStatusEntry {
	key: string;
	controlId: string;
	stage: DraftStage;
	writerId: string;
	status: ControlTaskStatus;
	/** How many fix attempts have been made so far (0 before the first submitter check). */
	attempts: number;
	/** The submitter's most recent findings (if blocked), or other context — empty once staged. */
	note: string;
	updatedAt: number;
	/** The latest known-good text/rating for this item — a `needs_attention` entry resumes from here on retry, not from the writer's original draft. */
	controlText: string;
	conclusionText: string;
	rating: string;
	evidenceReferences: string[];
}

/**
 * The coordinator's "final say": every writer's finished, already-verified draft is submitted here
 * (`submit_to_coordinator`, see `tools.ts`) instead of the writer proposing changes itself. This
 * runs one more, authoritative QA pass (reusing the same `qaReviewConclusionsBatch` call the
 * verifier uses, by default with the boosted model — see `burnEnabled`), then sends the result to
 * the `SubmitterAgent` — a strict, no-corrections gate (base model by default) that enforces the
 * exact writing rules configured in settings. If the submitter blocks it, the loop stays entirely
 * between the COORDINATOR and the submitter: it is the coordinator's job (`fixUntilApproved`) to
 * apply the submitter's exact cited modifications and resubmit, up to `MAX_FIX_ATTEMPTS` times —
 * never the writer's. If the submitter still hasn't cleared it after that many attempts, the
 * control is let through AS IS (with the submitter's outstanding findings attached as a comment,
 * for transparency) rather than held stuck — a quality gate exists to catch and fix real issues,
 * not to block a control indefinitely once the coordinator has genuinely tried. Every
 * (control, stage) this coordinator has ever touched is tracked in `statuses` (see
 * `ControlTaskStatusEntry`) until it's finished — the coordinator's job is to ensure every task it
 * owns actually reaches a resolved state, not to let one quietly vanish.
 */
export class CoordinatorReviewer {
	readonly tasks = new TaskQueue<string>();
	/** One entry per (control, stage) this coordinator has ever handled — see `ControlTaskStatusEntry`. */
	private statuses = new Map<string, ControlTaskStatusEntry>();
	private controls: ControlStore;
	/** The coordinator's own scoped memory — tracks every rejection/block and its reason (FR: "keeps track of all rejections and reasons"), surfaced to future QA passes via `recall_memory`-style queries if ever needed, and inspectable in the settings tab like any other agent's memory. */
	private memory: AgentMemoryStore;
	private unsubscribe: (() => void) | null = null;

	constructor(
		private plugin: AuditorPlugin,
		private bus: AgentBus,
		private outbox: OutboxStore,
		private burnEnabled: () => boolean = () => true,
		private requestRevision: RevisionRequester = () => {},
	) {
		this.controls = new ControlStore(plugin);
		this.memory = new AgentMemoryStore(plugin, COORDINATOR_ID);
	}

	start(): void {
		this.unsubscribe = this.bus.subscribe((msg) => {
			if (msg.to === COORDINATOR_ID && msg.kind === 'request') void this.handleSubmission(msg);
		});
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	/** Every (control, stage) this coordinator has tracked, for the graph view's status panel and `get_swarm_status`. */
	getControlStatuses(): ControlTaskStatusEntry[] {
		return [...this.statuses.values()];
	}

	/** One-paragraph status for the graph view's per-node summary panel. */
	getSummary(): string {
		const entries = [...this.statuses.values()];
		const staged = entries.filter((e) => e.status === 'staged' || e.status === 'forced' || e.status === 'applied').length;
		const forced = entries.filter((e) => e.status === 'forced').length;
		const stuck = entries.filter((e) => e.status === 'needs_attention');
		const rejections = this.memory.query({ category: 'acceptedDecision' }).filter((m) => m.content.includes('REJECTED')).length;
		const stuckText = stuck.length > 0 ? ` ${stuck.length} item(s) need attention: ${stuck.map((e) => e.controlId).slice(0, 5).join(', ')}.` : '';
		return `Receives every writer's finished draft, runs a final QA pass (${this.burnEnabled() ? 'boosted' : 'base'} model), then the submitter's strict check (base model) — on a block, the coordinator itself applies the exact cited fixes and resubmits, up to ${MAX_FIX_ATTEMPTS} times; if it still doesn't clear after that, the control is let through flagged rather than held. ${staged} of ${entries.length} tracked item(s) reached the outbox (${forced} let through unresolved), ${rejections} user rejection(s) on record.${stuckText}`;
	}

	private model(): string | undefined {
		if (!this.burnEnabled()) return undefined;
		const boosted = this.plugin.settings.boostedModel.trim();
		return boosted || undefined;
	}

	private statusKey(controlId: string, stage: DraftStage): string {
		return `${controlId}::${stage}`;
	}

	private upsertStatus(draft: Pick<DraftSubmission, 'writerId' | 'controlId' | 'stage' | 'controlText' | 'evidenceReferences'>, status: ControlTaskStatus, note: string, attempts: number, conclusionText: string, rating: string): ControlTaskStatusEntry {
		const key = this.statusKey(draft.controlId, draft.stage);
		const entry: ControlTaskStatusEntry = {
			key, controlId: draft.controlId, stage: draft.stage, writerId: draft.writerId,
			status, attempts, note, updatedAt: Date.now(),
			controlText: draft.controlText, conclusionText, rating, evidenceReferences: draft.evidenceReferences,
		};
		this.statuses.set(key, entry);
		return entry;
	}

	private async handleSubmission(msg: AgentMessage): Promise<void> {
		const draft = msg.payload as DraftSubmission | undefined;
		if (!draft?.controlId || !msg.correlationId) return;
		// Ack immediately so the submitting writer's tool call returns fast — the actual QA/staging happens in the background.
		this.bus.respond(msg.correlationId, COORDINATOR_ID, { accepted: true });

		const task = this.tasks.add(`${draft.controlId} (${draft.stage})`);
		this.upsertStatus(draft, 'reviewing', '', 0, draft.conclusionText, draft.rating);
		this.bus.event(COORDINATOR_ID, draft.writerId, { status: 'reviewing', controlId: draft.controlId }, `Final QA: ${draft.controlId}`);
		try {
			const { conclusionText, rating, note } = await this.runFinalQa(draft);
			const result = await this.fixUntilApproved(draft, conclusionText, rating);

			let finalNote = note;
			if (result.forced) {
				finalNote = [note, `Coordinator: let through after ${result.attempts} check(s) — the submitter's own strict pass could not be fully satisfied. Outstanding: ${result.lastComment}`].filter(Boolean).join('\n');
				await this.memory.remember(
					'acceptedDecision',
					`${draft.controlId} (${draft.stage}): let through unresolved after ${result.attempts} coordinator fix attempt(s). ${result.lastComment}`,
					draft.controlId,
				);
				new Notice(`Auditor: ${draft.controlId} (${draft.stage}) didn't fully clear the submitter's check after ${result.attempts} attempt(s) — staged anyway, flagged in its comments.`);
			}

			await this.stageForApproval(draft, result.conclusionText, result.rating, finalNote, { approved: true, findings: [], violations: [] });
			this.upsertStatus(draft, result.forced ? 'forced' : 'staged', result.forced ? result.lastComment : '', result.attempts, result.conclusionText, result.rating);
			this.tasks.setStatus(task.id, 'done');
			this.bus.event(COORDINATOR_ID, '*', { status: 'idle' }, `Staged ${draft.controlId}`);
			if (!result.forced) new Notice(`Auditor: coordinator staged ${draft.controlId} (${draft.stage}) for your review.`);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.upsertStatus(draft, 'needs_attention', message, 0, draft.conclusionText, draft.rating);
			this.tasks.setStatus(task.id, 'failed', message);
			this.bus.event(COORDINATOR_ID, '*', { status: 'failed', error: message }, `Failed: ${draft.controlId}`);
			new Notice(`Auditor: coordinator could not finalize ${draft.controlId} — ${message}`);
		}
	}

	/**
	 * Re-runs a `needs_attention` item from its last known text/rating — exposed for the graph
	 * view's "Retry" button and the coordinator chat's `retry_control` tool. A no-op if the item
	 * isn't actually stuck (e.g. it was already retried from another place).
	 */
	async retry(controlId: string, stage: DraftStage): Promise<void> {
		const entry = this.statuses.get(this.statusKey(controlId, stage));
		if (!entry || entry.status !== 'needs_attention') return;
		const draft: DraftSubmission = {
			writerId: entry.writerId, controlId: entry.controlId, stage: entry.stage,
			controlText: entry.controlText, conclusionText: entry.conclusionText, rating: entry.rating,
			evidenceReferences: entry.evidenceReferences,
		};
		const task = this.tasks.add(`${controlId} (${stage}) — retry`);
		this.upsertStatus(draft, 'reviewing', '', entry.attempts, entry.conclusionText, entry.rating);
		try {
			const result = await this.fixUntilApproved(draft, entry.conclusionText, entry.rating);
			const note = result.forced ? `Coordinator: let through after ${result.attempts} check(s) on retry — the submitter's own strict pass could not be fully satisfied. Outstanding: ${result.lastComment}` : '';
			await this.stageForApproval(draft, result.conclusionText, result.rating, note, { approved: true, findings: [], violations: [] });
			this.upsertStatus(draft, result.forced ? 'forced' : 'staged', result.forced ? result.lastComment : '', result.attempts, result.conclusionText, result.rating);
			this.tasks.setStatus(task.id, 'done');
			new Notice(result.forced
				? `Auditor: ${controlId} (${stage}) still didn't clear the submitter on retry — staged anyway, flagged in its comments.`
				: `Auditor: ${controlId} (${stage}) was fixed on retry and staged for your review.`);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.upsertStatus(draft, 'needs_attention', message, entry.attempts, entry.conclusionText, entry.rating);
			this.tasks.setStatus(task.id, 'failed', message);
			new Notice(`Auditor: retry for ${controlId} failed — ${message}`);
		}
	}

	/**
	 * The coordinator↔submitter fix loop: checks with the submitter, and on a block, applies EXACTLY
	 * the violations it cited (`GeminiGenerate.applySubmitterFixes`) and checks again — up to
	 * `MAX_FIX_ATTEMPTS` times. Every attempt is reflected in `statuses` (`fixing`, with the attempt
	 * count) so the pipeline's progress is visible rather than a silent retry loop. If the submitter
	 * still hasn't cleared it after the last attempt, returns `forced: true` — the caller lets it
	 * through as-is rather than holding it, with `lastComment` carrying what the submitter still
	 * objects to (attached to the control as a transparency note, not acted on further).
	 */
	private async fixUntilApproved(draft: DraftSubmission, conclusionText: string, rating: string): Promise<{ conclusionText: string; rating: string; attempts: number; forced: boolean; lastComment: string }> {
		let text = conclusionText;
		let rate = rating;
		for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
			this.bus.event(COORDINATOR_ID, SUBMITTER_AGENT_ID, { status: 'checking', controlId: draft.controlId, attempt }, `Final check: ${draft.controlId} (attempt ${attempt + 1})`);
			const check = await this.checkWithSubmitter(draft, text, rate);
			if (check.approved) return { conclusionText: text, rating: rate, attempts: attempt, forced: false, lastComment: '' };

			const comment = check.findings.join('\n') || 'The submitter blocked this without specific findings.';
			if (attempt === MAX_FIX_ATTEMPTS) {
				this.bus.event(COORDINATOR_ID, '*', { status: 'forced', controlId: draft.controlId }, `Letting ${draft.controlId} through unresolved after ${attempt + 1} check(s)`);
				return { conclusionText: text, rating: rate, attempts: attempt + 1, forced: true, lastComment: comment };
			}
			this.upsertStatus(draft, 'fixing', comment, attempt + 1, text, rate);

			this.bus.event(COORDINATOR_ID, COORDINATOR_ID, { status: 'fixing', controlId: draft.controlId, attempt: attempt + 1 }, `Fixing ${draft.controlId} (attempt ${attempt + 1})`);
			const fix = await this.plugin.geminiGenerate.applySubmitterFixes(
				{ controlId: draft.controlId, stage: draft.stage, controlText: draft.controlText, conclusionText: text, rating: rate },
				check.violations,
				this.model(),
			);
			text = fix.conclusionText;
			rate = fix.rating;
		}
		// Unreachable (the loop always returns inside), but keeps the function's return type total.
		return { conclusionText: text, rating: rate, attempts: MAX_FIX_ATTEMPTS, forced: true, lastComment: '' };
	}

	/** Sends the coordinator's current text/rating to the submitter for its strict, no-corrections gate check — see `SubmitterAgent`. */
	private async checkWithSubmitter(draft: DraftSubmission, conclusionText: string, rating: string): Promise<SubmissionCheckResult> {
		const reply = await this.bus.request(
			COORDINATOR_ID,
			SUBMITTER_AGENT_ID,
			{ controlId: draft.controlId, stage: draft.stage, controlText: draft.controlText, conclusionText, rating, evidenceReferences: draft.evidenceReferences },
			{ title: `Final check: ${draft.controlId} (${draft.stage})` },
		);
		return reply as SubmissionCheckResult;
	}

	/** Runs the authoritative QA pass. Falls back to the writer's own text/rating unchanged (with a note) if no writing-style profile is configured, rather than blocking the whole pipeline on a settings gap. */
	private async runFinalQa(draft: DraftSubmission): Promise<{ conclusionText: string; rating: string; note: string }> {
		const profile = this.plugin.settings.writingStyleProfile ?? EMPTY_WRITING_STYLE_PROFILE;
		if (profile.name.trim() === '') {
			return { conclusionText: draft.conclusionText, rating: draft.rating, note: 'Coordinator: no writing-style profile configured — staged without a final QA pass.' };
		}
		const writingRules = { stage1: this.plugin.settings.defaultWritingRules, stage2: this.plugin.settings.defaultStage2WritingRules };
		const { results } = await this.plugin.geminiGenerate.qaReviewConclusionsBatch(
			[{ controlId: draft.controlId, stage: draft.stage, controlText: draft.controlText, conclusionText: draft.conclusionText, rating: draft.rating, evidenceReferences: draft.evidenceReferences }],
			writingRules,
			profile,
			this.model(),
		);
		const result = results[0];
		if (!result) return { conclusionText: draft.conclusionText, rating: draft.rating, note: '' };
		const note = result.findings.length > 0 ? `Coordinator QA: ${result.findings.join('; ')}` : '';
		return { conclusionText: result.correctedConclusionText, rating: result.correctedRating, note };
	}

	/**
	 * Builds a single-item `ReviewProposal` for this (control, stage) and stages it into the outbox
	 * via the same background-host/apply path every other proposal uses. Requires a `check` with
	 * `approved: true` — the submitter (via `fixUntilApproved`) is the only path that can produce
	 * one, enforced here too so a future change can't accidentally call this without a real approval.
	 */
	private async stageForApproval(draft: DraftSubmission, conclusionText: string, rating: string, note: string, check: SubmissionCheckResult): Promise<void> {
		if (!check.approved) throw new Error(`Refusing to stage ${draft.controlId} (${draft.stage}): the submitter did not approve it.`);
		this.controls.resetSnapshots();
		const { found } = await this.controls.load([draft.controlId]);
		const entry = found[0];
		if (!entry) throw new Error(`Control "${draft.controlId}" no longer exists.`);

		const conclusionField = draft.stage === 'stage1' ? 'todConclusion' : 'toeConclusion';
		const ratingField = draft.stage === 'stage1' ? 'todRating' : 'toeRating';
		const parsed = this.controls.parseChanges([{
			number: draft.controlId,
			fields: { [conclusionField]: conclusionText, [ratingField]: rating },
			addComments: note ? [note] : [],
		}]);
		if ('error' in parsed) throw new Error(parsed.error);
		const resolved = this.controls.resolve(parsed.changes);
		if (resolved.length === 0) return; // identical to what's already on the note — nothing to review

		const change = resolved[0]!;
		const stageLabel = draft.stage === 'stage1' ? 'Stage 1' : 'Stage 2';
		const entries: DiffEntry[] = [
			{ label: FIELD_LABELS[conclusionField], before: entry.record[conclusionField], after: conclusionText },
			{ label: FIELD_LABELS[ratingField], before: entry.record[ratingField], after: rating },
		];
		if (note) entries.push({ label: FIELD_LABELS.comments, before: '', after: note });
		const reviewItem: ReviewItem = {
			key: `${draft.controlId}::${draft.stage}`,
			title: `${draft.controlId} · ${stageLabel}`,
			subtitle: `Drafted by ${draft.writerId}`,
			entries,
		};
		const proposal: ReviewProposal = {
			heading: `Coordinator review: ${draft.controlId} (${stageLabel})`,
			summary: `Drafted by ${draft.writerId}, finalized by the coordinator's own QA pass, and approved by the submitter's strict final check.`,
			items: [reviewItem],
			burn: this.burnEnabled(),
		};

		const host = createBackgroundHost(COORDINATOR_ID, this.bus, this.outbox);
		const decision = await host.requestApproval(proposal);

		if (decision.rejected.includes(reviewItem.key)) {
			const comment = decision.comments[reviewItem.key] ?? '(no comment given)';
			await this.memory.remember(
				'acceptedDecision',
				`${draft.controlId} (${stageLabel}): user REJECTED the coordinator's proposal. Reason: ${comment}`,
				draft.controlId,
			);
			this.upsertStatus(draft, 'rejected', comment, 0, conclusionText, rating);
			host.reportApplied([]);
			this.bus.event(COORDINATOR_ID, draft.writerId, { status: 'revision', controlId: draft.controlId, comment }, `Sending ${draft.controlId} back to ${draft.writerId} for revision`);
			new Notice(`Auditor: ${draft.controlId} was rejected — sending it back to ${draft.writerId} for revision.`);
			this.requestRevision(draft.writerId, draft.controlId, draft.stage, comment);
			return;
		}

		const toApply = decision.approved.includes(reviewItem.key) ? [change] : [];
		const outcomes = toApply.length > 0 ? await this.controls.apply(toApply) : [];
		if (outcomes.some((o) => o.ok)) this.upsertStatus(draft, 'applied', '', 0, conclusionText, rating);
		host.reportApplied(outcomes);
	}
}
