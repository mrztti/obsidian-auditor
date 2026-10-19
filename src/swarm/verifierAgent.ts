import type AuditorPlugin from '../main';
import { EMPTY_WRITING_STYLE_PROFILE } from '../settings';
import type { DraftStage } from '../agent/types';
import type { AgentBus, AgentMessage } from './bus';
import { TaskQueue } from './taskQueue';

export interface VerificationItemInput {
	controlId: string;
	stage: DraftStage;
	controlText: string;
	conclusionText: string;
	rating: string;
	evidenceReferences: string[];
}

export interface VerificationItemResult {
	controlId: string;
	stage: DraftStage;
	pass: boolean;
	correctedConclusionText: string;
	correctedRating: string;
	findings: string[];
}

export const VERIFIER_AGENT_ID = 'verifier';

/**
 * The swarm's verifier: genuinely independent of whichever writer drafted a conclusion — a writer
 * reaches it only through a bus request (`request_verification`, see `tools.ts`), never by calling
 * QA on itself in its own tool loop. Wraps the same `qaReviewConclusionsBatch` Gemini call the
 * original single-agent chat used (`qa_review_conclusions_batch`), so the actual QA logic/prompt is
 * not duplicated — just reached as a message to a separate agent instead of an in-loop tool.
 *
 * Unlike the original chat's QA gate, a "fail" here is never treated as a block-and-redraft signal
 * — `findings`/`pass` are reported for transparency, but the caller is expected to apply
 * `correctedConclusionText`/`correctedRating` either way. QA's job is to *fix* a batch of drafts in
 * one pass, not to bounce them back and forth.
 */
export class VerifierAgent {
	readonly agentId = VERIFIER_AGENT_ID;
	readonly tasks = new TaskQueue<string>();
	private unsubscribe: (() => void) | null = null;

	/** @param burnEnabled Read live on every request — defaults to true (the verifier uses the boosted model by default, unlike the other agents) unless the user unchecks it in the graph view. */
	constructor(private plugin: AuditorPlugin, private bus: AgentBus, private burnEnabled: () => boolean = () => true) {}

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
		const done = tasks.filter((t) => t.status === 'done').length;
		const recent = tasks.slice(-3).map((t) => `"${t.payload}" (${t.status})`).join(', ') || 'no requests yet';
		return `Independently QA-reviews drafted conclusions against the configured writing-style profile, using the ${this.burnEnabled() ? 'boosted' : 'base'} model. Reviewed ${done} of ${tasks.length} batch(es) so far. Recent: ${recent}.`;
	}

	private model(): string | undefined {
		if (!this.burnEnabled()) return undefined;
		const boosted = this.plugin.settings.boostedModel.trim();
		return boosted || undefined;
	}

	private async handle(msg: AgentMessage): Promise<void> {
		const { items } = (msg.payload ?? {}) as { items?: VerificationItemInput[] };
		if (!items || !msg.correlationId) return;
		const task = this.tasks.add(`${items.length} item(s): ${items.map((i) => i.controlId).join(', ')}`);
		this.bus.event(this.agentId, msg.from, { status: 'reviewing', count: items.length }, `Reviewing ${items.length} item(s)`);

		const profile = this.plugin.settings.writingStyleProfile ?? EMPTY_WRITING_STYLE_PROFILE;
		if (profile.name.trim() === '') {
			this.tasks.setStatus(task.id, 'failed', 'No writing-style profile configured');
			this.bus.respond(msg.correlationId, this.agentId, { error: 'No writing-style profile is configured in Auditor settings.' });
			return;
		}
		const writingRules = { stage1: this.plugin.settings.defaultWritingRules, stage2: this.plugin.settings.defaultStage2WritingRules };
		try {
			const { results } = await this.plugin.geminiGenerate.qaReviewConclusionsBatch(items, writingRules, profile, this.model());
			this.tasks.setStatus(task.id, 'done');
			this.bus.event(this.agentId, msg.from, { status: 'idle', count: items.length, passed: results.filter((r) => r.pass).length }, `${results.filter((r) => r.pass).length}/${results.length} passed`);
			this.bus.respond(msg.correlationId, this.agentId, { results }, { passed: results.filter((r) => r.pass).length, total: results.length });
		} catch (e) {
			this.tasks.setStatus(task.id, 'failed', e instanceof Error ? e.message : String(e));
			this.bus.respond(msg.correlationId, this.agentId, { error: e instanceof Error ? e.message : String(e) });
		}
	}
}
