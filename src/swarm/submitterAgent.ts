import type AuditorPlugin from '../main';
import { EMPTY_WRITING_STYLE_PROFILE } from '../settings';
import type { DraftStage } from '../agent/types';
import type { SubmitterViolation } from '../geminiGenerate';
import type { AgentBus, AgentMessage } from './bus';
import { TaskQueue } from './taskQueue';

export interface SubmissionCheckInput {
	controlId: string;
	stage: DraftStage;
	controlText: string;
	conclusionText: string;
	rating: string;
	evidenceReferences: string[];
}

export interface SubmissionCheckResult {
	approved: boolean;
	/** One line per violation, each already formatted as `Rule: "<exact rule text>" → Required change: <exact modification>` — see `formatViolation`. Empty when approved. */
	findings: string[];
	/** The raw, structured violations behind `findings` — the coordinator feeds these verbatim into `GeminiGenerate.applySubmitterFixes` rather than re-interpreting the formatted strings. */
	violations: SubmitterViolation[];
}

export const SUBMITTER_AGENT_ID = 'submitter';

function formatViolation(v: SubmitterViolation): string {
	return `Rule: "${v.ruleQuote}" → Required change: ${v.requiredModification}`;
}

/**
 * The swarm's last line of defense: a strict, no-corrections gate the coordinator must pass a
 * finalized (control, stage) draft through before it reaches the outbox at all. Everything else in
 * this pipeline (the verifier, the coordinator's own QA pass) corrects and moves on — this agent
 * does the opposite. It enforces the exact writing rules configured in Auditor settings for that
 * stage (`defaultWritingRules`/`defaultStage2WritingRules`) and the configured writing-style
 * profile's prohibited wording, STRICTLY, via `GeminiGenerate.submitterFinalCheck`: if any
 * requirement is not met, it does not fix anything itself — it blocks and returns the exact rule
 * text violated (word-for-word) and the exact modification required per violation. It is the
 * COORDINATOR's job (`CoordinatorReviewer`, not the writer) to apply those fixes and resubmit, as
 * many times as it takes — see that class's fix loop.
 *
 * Runs on the regular (non-boosted) model by default, unlike the verifier/coordinator's own QA
 * passes — this is a strict, mechanical rule check, not a step that benefits from the more
 * expensive model, and the user has asked for it to stay on the base model unless explicitly
 * switched on in the graph view.
 */
export class SubmitterAgent {
	readonly agentId = SUBMITTER_AGENT_ID;
	readonly tasks = new TaskQueue<string>();
	private unsubscribe: (() => void) | null = null;

	/** @param burnEnabled Read live on every request — defaults to false (base model) unless the user checks it in the graph view. */
	constructor(private plugin: AuditorPlugin, private bus: AgentBus, private burnEnabled: () => boolean = () => false) {}

	start(): void {
		this.unsubscribe = this.bus.subscribe((msg) => {
			if (msg.to === this.agentId && msg.kind === 'request') void this.handle(msg);
		});
	}

	stop(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	/** One-paragraph status for the graph view — see `graphView.ts`'s per-node summary panel. */
	getSummary(): string {
		const tasks = this.tasks.list();
		const approved = tasks.filter((t) => t.status === 'done').length;
		const blocked = tasks.filter((t) => t.status === 'failed').length;
		const recent = tasks.slice(-3).map((t) => `"${t.payload}" (${t.status})`).join(', ') || 'no checks yet';
		return `Strictly enforces the configured stage 1/stage 2 writing rules on every finalized draft before it can reach the outbox — no corrections of its own, only approve or block, citing the exact rule text and exact required modification for every violation (${this.burnEnabled() ? 'boosted' : 'base'} model). ${approved} approved, ${blocked} blocked so far. Recent: ${recent}.`;
	}

	private model(): string | undefined {
		if (!this.burnEnabled()) return undefined;
		const boosted = this.plugin.settings.boostedModel.trim();
		return boosted || undefined;
	}

	private async handle(msg: AgentMessage): Promise<void> {
		const draft = msg.payload as SubmissionCheckInput | undefined;
		if (!draft?.controlId || !msg.correlationId) return;
		const task = this.tasks.add(`${draft.controlId} (${draft.stage})`);
		this.bus.event(this.agentId, msg.from, { status: 'checking', controlId: draft.controlId }, `Final check: ${draft.controlId}`);

		const profile = this.plugin.settings.writingStyleProfile ?? EMPTY_WRITING_STYLE_PROFILE;
		if (profile.name.trim() === '') {
			this.tasks.setStatus(task.id, 'failed', 'No writing-style profile configured');
			this.bus.respond(msg.correlationId, this.agentId, {
				approved: false,
				findings: ['No writing-style profile is configured in Auditor settings — nothing can be strictly enforced until one is.'],
				violations: [],
			} satisfies SubmissionCheckResult);
			return;
		}
		const writingRules = { stage1: this.plugin.settings.defaultWritingRules, stage2: this.plugin.settings.defaultStage2WritingRules };
		try {
			const { results } = await this.plugin.geminiGenerate.submitterFinalCheck(
				[{ controlId: draft.controlId, stage: draft.stage, controlText: draft.controlText, conclusionText: draft.conclusionText, rating: draft.rating, evidenceReferences: draft.evidenceReferences }],
				writingRules,
				profile,
				this.model(),
			);
			const result = results[0];
			const approved = result?.approved === true;
			const violations = result?.violations ?? [];
			const findings = violations.map(formatViolation);
			this.tasks.setStatus(task.id, approved ? 'done' : 'failed', approved ? undefined : findings.join('; '));
			this.bus.event(this.agentId, msg.from, { status: 'idle', controlId: draft.controlId, approved }, approved ? `Approved: ${draft.controlId}` : `Blocked: ${draft.controlId}`);
			this.bus.respond(msg.correlationId, this.agentId, { approved, findings, violations } satisfies SubmissionCheckResult, { approved });
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			this.tasks.setStatus(task.id, 'failed', message);
			this.bus.respond(msg.correlationId, this.agentId, {
				approved: false,
				findings: [`Could not run the final check: ${message}`],
				violations: [],
			} satisfies SubmissionCheckResult);
		}
	}
}
