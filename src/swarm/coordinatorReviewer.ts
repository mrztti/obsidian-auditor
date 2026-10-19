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
import { TaskQueue } from './taskQueue';

export const COORDINATOR_ID = COORDINATOR_AGENT_ID;

/** Called when the user rejects a staged proposal, so the orchestrator can route it back to the originating writer for revision — see `SwarmOrchestrator.requestRevision`. */
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

/**
 * The coordinator's "final say": every writer's finished, already-verified draft is submitted here
 * (`submit_to_coordinator`, see `tools.ts`) instead of the writer proposing changes itself. This
 * runs one more, authoritative QA pass (reusing the same `qaReviewConclusionsBatch` call the
 * verifier uses, by default with the boosted model — see `burnEnabled`), ALWAYS applies the
 * corrected text/rating it returns (never a block-and-redraft loop — see `verifierAgent.ts`'s own
 * doc comment for why), stages the result into the shared outbox under the coordinator's own name,
 * and proactively notifies the user (FR: "automatically update the user on advancement").
 */
export class CoordinatorReviewer {
	readonly tasks = new TaskQueue<string>();
	private controls: ControlStore;
	/** The coordinator's own scoped memory — tracks every rejection and its reason (FR: "keeps track of all rejections and reasons"), surfaced to future QA passes via `recall_memory`-style queries if ever needed, and inspectable in the settings tab like any other agent's memory. */
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

	/** One-paragraph status for the graph view's per-node summary panel. */
	getSummary(): string {
		const tasks = this.tasks.list();
		const done = tasks.filter((t) => t.status === 'done').length;
		const recent = tasks.slice(-3).map((t) => `"${t.payload}" (${t.status})`).join(', ') || 'no submissions yet';
		const rejections = this.memory.query({ category: 'acceptedDecision' }).filter((m) => m.content.includes('REJECTED')).length;
		return `Receives every writer's finished draft, runs a final independent QA pass (${this.burnEnabled() ? 'boosted' : 'base'} model), and has the final say on what reaches the outbox. Reviewed ${done} of ${tasks.length} submission(s), ${rejections} rejection(s) on record (with reasons, routed back to the writer). Recent: ${recent}.`;
	}

	private model(): string | undefined {
		if (!this.burnEnabled()) return undefined;
		const boosted = this.plugin.settings.boostedModel.trim();
		return boosted || undefined;
	}

	private async handleSubmission(msg: AgentMessage): Promise<void> {
		const draft = msg.payload as DraftSubmission | undefined;
		if (!draft?.controlId || !msg.correlationId) return;
		// Ack immediately so the submitting writer's tool call returns fast — the actual QA/staging happens in the background.
		this.bus.respond(msg.correlationId, COORDINATOR_ID, { accepted: true });

		const task = this.tasks.add(`${draft.controlId} (${draft.stage})`);
		this.bus.event(COORDINATOR_ID, draft.writerId, { status: 'reviewing', controlId: draft.controlId }, `Final QA: ${draft.controlId}`);
		try {
			const { conclusionText, rating, note } = await this.runFinalQa(draft);
			await this.stageForApproval(draft, conclusionText, rating, note);
			this.tasks.setStatus(task.id, 'done');
			this.bus.event(COORDINATOR_ID, '*', { status: 'idle' }, `Staged ${draft.controlId}`);
			new Notice(`Auditor: coordinator staged ${draft.controlId} (${draft.stage}) for your review.`);
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.tasks.setStatus(task.id, 'failed', message);
			this.bus.event(COORDINATOR_ID, '*', { status: 'failed', error: message }, `Failed: ${draft.controlId}`);
			new Notice(`Auditor: coordinator could not finalize ${draft.controlId} — ${message}`);
		}
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

	/** Builds a single-item `ReviewProposal` for this (control, stage) and stages it into the outbox via the same background-host/apply path every other proposal uses. */
	private async stageForApproval(draft: DraftSubmission, conclusionText: string, rating: string, note: string): Promise<void> {
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
			summary: `Drafted by ${draft.writerId}, finalized by the coordinator's own QA pass.`,
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
			host.reportApplied([]);
			this.bus.event(COORDINATOR_ID, draft.writerId, { status: 'revision', controlId: draft.controlId, comment }, `Sending ${draft.controlId} back to ${draft.writerId} for revision`);
			new Notice(`Auditor: ${draft.controlId} was rejected — sending it back to ${draft.writerId} for revision.`);
			this.requestRevision(draft.writerId, draft.controlId, draft.stage, comment);
			return;
		}

		const toApply = decision.approved.includes(reviewItem.key) ? [change] : [];
		const outcomes = toApply.length > 0 ? await this.controls.apply(toApply) : [];
		host.reportApplied(outcomes);
	}
}
