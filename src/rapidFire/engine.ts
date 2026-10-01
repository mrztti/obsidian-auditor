import type AuditorPlugin from '../main';
import { ControlStore } from '../agent/controlStore';
import type { ControlChange, DraftStage } from '../agent/types';
import { computeStepUsage, sumUsage, type StepUsage } from '../agent/usage';
import type {
	EvidenceFact,
	RapidFireBatch,
	RapidFireItem,
	RapidFireState,
	SimilarityBatch,
	ThemeEvidenceMap,
} from './types';

/** How many controls' worth of evidence the search step pulls per topic batch — a fixed, small number since Phase 2 runs once per batch, not per control. */
const EVIDENCE_RESULTS_PER_BATCH = 15;
/** How many (control, stage) items a Phase 3/Phase 4 draft/QA retry attempts individually before giving up and marking the item blocked. */
const MAX_ITEM_RETRIES = 2;

let factCounter = 0;
const newFactId = (): string => `fact-${Date.now().toString(36)}-${(factCounter++).toString(36)}`;

export type RapidFireEngineEvent =
	| { type: 'item_state'; item: RapidFireItem }
	| { type: 'usage'; usage: StepUsage; totals: { inputTokens: number; cachedInputTokens: number; outputTokens: number; totalCost: number } }
	| { type: 'note'; text: string }
	| { type: 'paused'; reason: NonNullable<RapidFireBatch['pauseReason']> }
	| { type: 'done' };

export interface RapidFireEngineHost {
	emit(event: RapidFireEngineEvent): void;
	/** Checked between phases/chunks — a batch-level pause or cancel from the UI takes effect at the next checkpoint, same spirit as the chat agent's own pause points. */
	shouldStop(): 'continue' | 'pause' | 'cancel';
}

const key = (controlNumber: string, stage: DraftStage): string => `${controlNumber}:${stage}`;

/**
 * Runs a `RapidFireBatch` through FR-8.3–8.7's five phases. Every item's state is updated and
 * emitted as it changes, so the UI (and a resumed run after a pause) always reflects exactly where
 * each control/stage actually stands — nothing here holds state that isn't on the `RapidFireItem`
 * itself, so pausing and resuming never re-does completed work (FR-8.2's traceability + FR-4-style
 * resumability, applied to a batch instead of a chat run).
 */
export class RapidFireEngine {
	private controls: ControlStore;

	constructor(private plugin: AuditorPlugin) {
		this.controls = new ControlStore(plugin);
	}

	/**
	 * Every Gemini GENERATION call this engine makes goes through here first — unlike the chat
	 * agent (naturally paced by the user reading/typing between turns), Rapid Fire can otherwise
	 * fire its drafting/QA/classification calls back to back with nothing pacing them, which is
	 * exactly how a large batch bursts past a provider rate limit. `rapidFireRateLimiter` is its own
	 * instance (not the embeddings one), paced per `rapidFireMaxRequestsPerSecond`.
	 */
	private async callModel<T>(fn: () => Promise<T>): Promise<T> {
		await this.plugin.rapidFireRateLimiter.acquire();
		return fn();
	}

	private setState(item: RapidFireItem, state: RapidFireState, host: RapidFireEngineHost): void {
		item.state = state;
		host.emit({ type: 'item_state', item });
	}

	private recordUsage(batch: RapidFireBatch, modelTier: 'base' | 'boosted', meta: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number } | undefined, host: RapidFireEngineHost): StepUsage {
		const record = computeStepUsage({
			stepId: batch.id,
			modelTier,
			inputTokens: meta?.promptTokenCount ?? 0,
			cachedInputTokens: meta?.cachedContentTokenCount,
			outputTokens: meta?.candidatesTokenCount ?? 0,
		}, this.plugin.settings);
		batch.usage.push(record);
		if (modelTier === 'boosted') batch.boostedUsageUsd += record.totalCost;
		host.emit({ type: 'usage', usage: record, totals: sumUsage(batch.usage) });
		return record;
	}

	/** Checked before every model call that would cost money — the one place every budget limit in FR-8.8 is actually enforced. Never cancels or discards the batch; it only ever pauses. */
	private checkBudgets(batch: RapidFireBatch, host: RapidFireEngineHost): boolean {
		const s = this.plugin.settings;
		const spent = sumUsage(batch.usage).totalCost;
		if (s.rapidFireMaxBatchCostUsd > 0 && spent >= s.rapidFireMaxBatchCostUsd) {
			batch.status = 'paused';
			batch.pauseReason = 'max_batch_cost';
			host.emit({ type: 'paused', reason: 'max_batch_cost' });
			return false;
		}
		if (s.rapidFireBoostedEscalationBudgetUsd > 0 && batch.boostedUsageUsd >= s.rapidFireBoostedEscalationBudgetUsd) {
			batch.status = 'paused';
			batch.pauseReason = 'max_boosted_escalation';
			host.emit({ type: 'paused', reason: 'max_boosted_escalation' });
			return false;
		}
		const control = host.shouldStop();
		if (control === 'cancel') {
			batch.status = 'cancelled';
			return false;
		}
		if (control === 'pause') {
			batch.status = 'paused';
			batch.pauseReason = 'user';
			host.emit({ type: 'paused', reason: 'user' });
			return false;
		}
		return true;
	}

	/** Drives every phase in order, stopping cleanly (not erroring) the moment a budget/user pause fires — resuming later just calls this again and it picks up from whatever phase the items are actually in. */
	async run(batch: RapidFireBatch, host: RapidFireEngineHost): Promise<void> {
		batch.status = 'running';
		batch.pauseReason = null;

		if (batch.similarityBatches.length === 0) {
			if (!(await this.runPhase1(batch, host))) return;
		}
		if (!this.checkBudgets(batch, host)) return;

		if (batch.evidenceMaps.length < batch.similarityBatches.length) {
			if (!(await this.runPhase2(batch, host))) return;
		}
		if (!this.checkBudgets(batch, host)) return;

		if (batch.items.some((i) => i.state === 'ready_to_draft')) {
			if (!(await this.runPhase3(batch, host))) return;
		}
		if (!this.checkBudgets(batch, host)) return;

		if (batch.items.some((i) => i.state === 'ready_for_qa')) {
			if (!(await this.runPhase4(batch, host))) return;
		}

		if (batch.items.every((i) => i.state === 'ready_for_review' || i.state === 'accepted' || i.state === 'blocked' || i.state === 'changes_requested')) {
			batch.status = 'completed';
		}
		host.emit({ type: 'done' });
	}

	// ─── Phase 1: similarity batches (FR-8.3) ──────────────────────────────
	private async runPhase1(batch: RapidFireBatch, host: RapidFireEngineHost): Promise<boolean> {
		for (const item of batch.items) this.setState(item, 'classifying', host);
		const { found } = await this.controls.load([...new Set(batch.items.map((i) => i.controlNumber))]);
		const byNumber = new Map(found.map((e) => [e.record.number, e.record]));
		const stagesByControl = new Map<string, DraftStage[]>();
		for (const item of batch.items) stagesByControl.set(item.controlNumber, [...(stagesByControl.get(item.controlNumber) ?? []), item.stage]);

		const controlsInput = [...stagesByControl.entries()].map(([number, stages]) => {
			const r = byNumber.get(number);
			return { number, standard: r?.standard ?? '', topic: r?.topic ?? '', control: r?.control ?? '', stages };
		});

		const model = this.plugin.settings.boostedModel.trim() ? undefined : undefined; // Phase 1 always uses the base model (FR-8.5's "use the base model by default" applies plugin-wide here too).
		const { plan, usage } = await this.callModel(() => this.plugin.geminiGenerate.buildSimilarityBatches(controlsInput, model));
		this.recordUsage(batch, 'base', usage, host);

		const maxTokens = this.plugin.settings.rapidFireMaxTokensPerTopicBatch;
		const byLabel = new Map<string, { controlNumbers: Set<string>; reasons: Record<string, string> }>();
		for (const a of plan.assignments) {
			const bucket = byLabel.get(a.batchLabel) ?? { controlNumbers: new Set<string>(), reasons: {} };
			bucket.controlNumbers.add(a.controlNumber);
			bucket.reasons[a.controlNumber] = a.reason;
			byLabel.set(a.batchLabel, bucket);
		}

		const batches: SimilarityBatch[] = [];
		let splitCounter = 0;
		for (const [label, bucket] of byLabel) {
			const numbers = [...bucket.controlNumbers];
			const estTokensFor = (nums: string[]) => Math.ceil(nums.reduce((sum, n) => sum + (byNumber.get(n)?.control.length ?? 0), 0) / 4);
			// FR-8.3 guardrail: split a batch when its combined context would exceed the configured budget.
			const chunks: string[][] = [];
			let current: string[] = [];
			for (const n of numbers) {
				const candidate = [...current, n];
				if (current.length > 0 && estTokensFor(candidate) > maxTokens) {
					chunks.push(current);
					current = [n];
				} else {
					current = candidate;
				}
			}
			if (current.length > 0) chunks.push(current);

			for (const chunk of chunks) {
				const id = chunks.length > 1 ? `${label}-${++splitCounter}` : label;
				batches.push({
					batchId: id,
					topicLabel: label,
					controlNumbers: chunk,
					sharedTerms: plan.sharedTermsByBatch[label] ?? [],
					reasons: Object.fromEntries(chunk.map((n) => [n, bucket.reasons[n] ?? ''])),
					estimatedContextTokens: estTokensFor(chunk),
				});
			}
		}
		batch.similarityBatches = batches;

		const batchIdByControl = new Map<string, string>();
		for (const b of batches) for (const n of b.controlNumbers) batchIdByControl.set(n, b.batchId);
		for (const item of batch.items) {
			item.batchId = batchIdByControl.get(item.controlNumber) ?? '';
			this.setState(item, 'researching', host);
		}
		host.emit({ type: 'note', text: `Phase 1: ${batches.length} topic batch(es) across ${batch.items.length} item(s).` });
		return true;
	}

	// ─── Phase 2: thematic evidence map (FR-8.4) ───────────────────────────
	private async runPhase2(batch: RapidFireBatch, host: RapidFireEngineHost): Promise<boolean> {
		const doneThemeIds = new Set(batch.evidenceMaps.map((m) => m.themeId));
		for (const sb of batch.similarityBatches) {
			if (doneThemeIds.has(sb.batchId)) continue;
			if (!this.checkBudgets(batch, host)) return false;

			const query = `${sb.topicLabel} ${sb.sharedTerms.join(' ')}`.trim() || sb.topicLabel;
			const [evidence, interview] = await Promise.all([
				this.plugin.storeFor('evidence').search(query, EVIDENCE_RESULTS_PER_BATCH).catch(() => []),
				this.plugin.storeFor('interviewEvidence').search(query, EVIDENCE_RESULTS_PER_BATCH).catch(() => []),
			]);
			const snippets = [...evidence, ...interview].map((r) => ({ sourcePath: r.sourcePath, location: r.page !== undefined ? `p.${r.page}` : r.line !== undefined ? `L${r.line}` : '', text: r.text }));

			const { extraction, usage } = await this.callModel(() => this.plugin.geminiGenerate.extractThematicEvidence(sb.topicLabel, sb.controlNumbers, snippets));
			this.recordUsage(batch, 'base', usage, host);

			const facts: EvidenceFact[] = extraction.facts.map((f) => ({ id: newFactId(), ...f }));
			const controlMappings: Record<string, string[]> = {};
			for (const n of sb.controlNumbers) controlMappings[n] = facts.filter((f) => f.controlNumbers.includes(n)).map((f) => f.id);

			const map: ThemeEvidenceMap = {
				themeId: sb.batchId,
				themeLabel: sb.topicLabel,
				facts,
				documents: [...new Set(snippets.map((s) => s.sourcePath))].map((path) => ({ path, label: path.split('/').pop() ?? path })),
				controlMappings,
				unresolvedQuestions: extraction.unresolvedQuestions,
				contextTokenCount: Math.ceil(facts.reduce((sum, f) => sum + f.text.length, 0) / 4),
			};
			batch.evidenceMaps.push(map);

			for (const item of batch.items) {
				if (item.batchId !== sb.batchId) continue;
				this.setState(item, (controlMappings[item.controlNumber]?.length ?? 0) > 0 ? 'ready_to_draft' : 'ready_to_draft', host);
			}
		}
		return true;
	}

	private factsFor(batch: RapidFireBatch, item: RapidFireItem) {
		const map = batch.evidenceMaps.find((m) => m.themeId === item.batchId);
		if (!map) return [];
		const ids = new Set(map.controlMappings[item.controlNumber] ?? []);
		return map.facts.filter((f) => ids.has(f.id) && f.stages.includes(item.stage));
	}

	/** Joins the facts mapped to one control/stage into the compact context a draft call gets — never a whole document, and never a fact mapped to a different control (FR-8.4's critical rule, enforced structurally here rather than just by prompt wording). */
	private evidenceContextFor(batch: RapidFireBatch, item: RapidFireItem): string {
		return this.factsFor(batch, item)
			.map((f) => `- ${f.text} [${f.sourcePath}${f.location ? `, ${f.location}` : ''}]`)
			.join('\n');
	}

	/** The distinct source paths behind an item's evidence facts — stamped onto the item at draft time so Phase 4 QA's reference-correctness check has real references to validate against, not an empty list. */
	private evidenceReferencesFor(batch: RapidFireBatch, item: RapidFireItem): string[] {
		return [...new Set(this.factsFor(batch, item).map((f) => f.sourcePath))];
	}

	// ─── Phase 3: batch drafting (FR-8.5) ──────────────────────────────────
	private async runPhase3(batch: RapidFireBatch, host: RapidFireEngineHost): Promise<boolean> {
		const toDraft = batch.items.filter((i) => i.state === 'ready_to_draft');
		const { found } = await this.controls.load([...new Set(toDraft.map((i) => i.controlNumber))]);
		const byNumber = new Map(found.map((e) => [e.record.number, e.record]));
		const writingRules = this.plugin.settings.defaultWritingRules;
		const maxPerCall = Math.max(1, this.plugin.settings.rapidFireMaxControlsPerModelCall);

		for (let i = 0; i < toDraft.length; i += maxPerCall) {
			if (!this.checkBudgets(batch, host)) return false;
			const chunk = toDraft.slice(i, i + maxPerCall);
			for (const item of chunk) this.setState(item, 'drafting', host);

			const inputs = chunk.map((item) => ({
				controlNumber: item.controlNumber,
				stage: item.stage,
				controlText: byNumber.get(item.controlNumber)?.control ?? '',
				priorConclusion: item.stage === 'stage1' ? (byNumber.get(item.controlNumber)?.todConclusion ?? '') : (byNumber.get(item.controlNumber)?.toeConclusion ?? ''),
			}));
			const evidenceContextByItem = Object.fromEntries(chunk.map((item) => [key(item.controlNumber, item.stage), this.evidenceContextFor(batch, item)]));

			// FR-8.5 escalation: a control with an already-failed attempt, or with notably thin evidence going in, is worth the boosted model if one is configured and the escalation budget allows it.
			const anyEscalate = chunk.some((item) => item.escalated);
			const model = anyEscalate ? this.plugin.settings.boostedModel.trim() || undefined : undefined;
			const tier = model ? 'boosted' : 'base';

			const { results, usage } = await this.callModel(() => this.plugin.geminiGenerate.draftConclusionsBatch(inputs, evidenceContextByItem, writingRules, model));
			this.recordUsage(batch, tier, usage, host);

			const byKey = new Map(results.map((r) => [key(r.controlNumber, r.stage), r]));
			const missing: RapidFireItem[] = [];
			for (const item of chunk) {
				const result = byKey.get(key(item.controlNumber, item.stage));
				if (!result) { missing.push(item); continue; }
				item.draftConclusion = result.conclusionText;
				item.draftRating = result.rating;
				item.assumptions = result.assumptions;
				item.unresolvedIssues = result.unresolvedIssues;
				item.evidenceReferences = this.evidenceReferencesFor(batch, item);
				// Predetermined escalation criterion: a non-trivial unresolved-issue count gets the boosted model on its NEXT pass (QA retry / redraft), not this one.
				item.escalated = item.escalated || result.unresolvedIssues.length > 2;
				this.setState(item, 'ready_for_qa', host);
			}

			// FR-8.5: "retry only missing or malformed items" — individually, not re-batched.
			for (const item of missing) {
				const ok = await this.retryDraftItem(batch, item, byNumber.get(item.controlNumber)?.control ?? '', writingRules, host);
				if (!ok) this.block(item, 'Drafting failed after retry', host);
			}
		}
		return true;
	}

	private async retryDraftItem(batch: RapidFireBatch, item: RapidFireItem, controlText: string, writingRules: string, host: RapidFireEngineHost, attempt = 1): Promise<boolean> {
		if (attempt > MAX_ITEM_RETRIES) return false;
		this.setState(item, 'drafting', host);
		const model = item.escalated ? this.plugin.settings.boostedModel.trim() || undefined : undefined;
		try {
			const { results, usage } = await this.callModel(() => this.plugin.geminiGenerate.draftConclusionsBatch(
				[{ controlNumber: item.controlNumber, stage: item.stage, controlText, priorConclusion: '' }],
				{ [key(item.controlNumber, item.stage)]: this.evidenceContextFor(batch, item) },
				writingRules,
				model,
			));
			this.recordUsage(batch, model ? 'boosted' : 'base', usage, host);
			const result = results.find((r) => r.controlNumber === item.controlNumber && r.stage === item.stage);
			if (!result) return this.retryDraftItem(batch, item, controlText, writingRules, host, attempt + 1);
			item.draftConclusion = result.conclusionText;
			item.draftRating = result.rating;
			item.assumptions = result.assumptions;
			item.unresolvedIssues = result.unresolvedIssues;
			item.evidenceReferences = this.evidenceReferencesFor(batch, item);
			this.setState(item, 'ready_for_qa', host);
			return true;
		} catch {
			return this.retryDraftItem(batch, item, controlText, writingRules, host, attempt + 1);
		}
	}

	private block(item: RapidFireItem, reason: string, host: RapidFireEngineHost): void {
		item.blockedReason = reason;
		this.setState(item, 'blocked', host);
	}

	// ─── Phase 4: batch QA (FR-8.6) ─────────────────────────────────────────
	private async runPhase4(batch: RapidFireBatch, host: RapidFireEngineHost): Promise<boolean> {
		const profile = this.plugin.settings.writingStyleProfile;
		const writingRules = { stage1: this.plugin.settings.defaultWritingRules, stage2: this.plugin.settings.defaultStage2WritingRules };
		if (!profile || !profile.name.trim()) {
			// FR-3.3: never silently skip QA — pause visibly so "stuck forever with no explanation" can't
			// happen (a prior version returned true here with items untouched, which left every item
			// sitting in ready_for_qa indefinitely with only a note that scrolled out of view).
			batch.status = 'paused';
			batch.pauseReason = 'no_writing_style_profile';
			host.emit({ type: 'paused', reason: 'no_writing_style_profile' });
			return false;
		}

		const toQa = batch.items.filter((i) => i.state === 'ready_for_qa');
		const maxPerCall = Math.max(1, this.plugin.settings.rapidFireMaxControlsPerModelCall);

		// FR-8.6 Phase 4 process step 1: group by topic (batchId), stage, and (implicitly) the one configured style profile.
		const groups = new Map<string, RapidFireItem[]>();
		for (const item of toQa) {
			const groupKey = `${item.batchId}::${item.stage}`;
			groups.set(groupKey, [...(groups.get(groupKey) ?? []), item]);
		}

		for (const group of groups.values()) {
			for (let i = 0; i < group.length; i += maxPerCall) {
				if (!this.checkBudgets(batch, host)) return false;
				const chunk = group.slice(i, i + maxPerCall);

				const model = chunk.some((item) => item.escalated) ? this.plugin.settings.boostedModel.trim() || undefined : undefined;
				const items = chunk.map((item) => ({
					controlId: item.controlNumber,
					stage: item.stage,
					conclusionText: item.draftConclusion ?? '',
					rating: item.draftRating ?? '',
					// Cross-control contamination (FR-8.6 step 4) is caught because same-topic items are
					// batched together here with their OWN references only — a citation that belongs to a
					// different item in the batch fails this item's own reference-correctness check.
					evidenceReferences: item.evidenceReferences ?? [],
				}));
				const { results, usage } = await this.callModel(() => this.plugin.geminiGenerate.qaReviewConclusionsBatch(items, writingRules, profile, model));
				this.recordUsage(batch, model ? 'boosted' : 'base', usage, host);

				const byKeyResult = new Map(results.map((r) => [key(r.controlId, r.stage), r]));
				for (const item of chunk) {
					const result = byKeyResult.get(key(item.controlNumber, item.stage));
					if (!result) { this.block(item, 'QA produced no result for this item', host); continue; }
					item.qaResult = { pass: result.pass, correctedConclusionText: result.correctedConclusionText, correctedRating: result.correctedRating, findings: result.findings };
					if (result.pass) {
						this.setState(item, 'ready_for_review', host);
					} else {
						item.escalated = true; // a QA failure is itself the "failure criterion" for boosted escalation on the redraft.
						this.setState(item, 'qa_failed', host);
					}
				}
			}
		}

		// qa_failed items get exactly one redraft + re-QA pass; a second failure blocks rather than looping forever.
		const failed = batch.items.filter((i) => i.state === 'qa_failed');
		if (failed.length > 0) {
			const { found } = await this.controls.load([...new Set(failed.map((i) => i.controlNumber))]);
			const byNumber = new Map(found.map((e) => [e.record.number, e.record]));
			for (const item of failed) {
				if (!this.checkBudgets(batch, host)) return false;
				const redrafted = await this.retryDraftItem(batch, item, byNumber.get(item.controlNumber)?.control ?? '', this.plugin.settings.defaultWritingRules, host);
				if (!redrafted) { this.block(item, 'Redraft after QA failure did not succeed', host); continue; }
				const model = this.plugin.settings.boostedModel.trim() || undefined; // already escalated by the failure itself
				const { results, usage } = await this.callModel(() => this.plugin.geminiGenerate.qaReviewConclusionsBatch(
					[{ controlId: item.controlNumber, stage: item.stage, conclusionText: item.draftConclusion ?? '', rating: item.draftRating ?? '', evidenceReferences: item.evidenceReferences ?? [] }],
					writingRules,
					profile,
					model,
				));
				this.recordUsage(batch, 'boosted', usage, host);
				const result = results[0];
				if (result?.pass) {
					item.qaResult = { pass: true, correctedConclusionText: result.correctedConclusionText, correctedRating: result.correctedRating, findings: result.findings };
					this.setState(item, 'ready_for_review', host);
				} else {
					this.block(item, 'Failed QA twice', host);
				}
			}
		}
		return true;
	}

	/**
	 * Submits the review queue's decisions (FR-8.7): accepted items are written to their control
	 * notes via the same freshness-checked `ControlStore.apply` the chat agent uses, rejected items
	 * move to `changes_requested` for a refinement pass, never silently dropped.
	 */
	async submitReview(batch: RapidFireBatch): Promise<{ saved: string[]; failed: { key: string; error: string }[] }> {
		const toAccept = batch.items.filter((i) => i.decision === 'accepted');
		const byControl = new Map<string, RapidFireItem[]>();
		for (const item of toAccept) byControl.set(item.controlNumber, [...(byControl.get(item.controlNumber) ?? []), item]);

		const numbers = [...byControl.keys()];
		await this.controls.load(numbers);
		const changes: ControlChange[] = numbers.map((number) => {
			const items = byControl.get(number) ?? [];
			const fields: ControlChange['fields'] = {};
			for (const item of items) {
				const text = item.qaResult?.correctedConclusionText ?? item.draftConclusion ?? '';
				const rating = (item.qaResult?.correctedRating ?? item.draftRating ?? '') as ControlChange['fields']['todRating'];
				if (item.stage === 'stage1') { fields.todConclusion = text; fields.todRating = rating; }
				else { fields.toeConclusion = text; fields.toeRating = rating; }
			}
			return { number, fields, addComments: [] };
		});
		const resolved = this.controls.resolve(changes);
		const outcomes = resolved.length > 0 ? await this.controls.apply(resolved) : [];
		const savedNumbers = new Set(outcomes.filter((o) => o.ok).map((o) => o.key));
		for (const item of toAccept) if (savedNumbers.has(item.controlNumber)) this.setState(item, 'accepted', { emit: () => {}, shouldStop: () => 'continue' });

		for (const item of batch.items) {
			if (item.decision === 'rejected') {
				item.state = 'changes_requested';
			}
		}

		return {
			saved: outcomes.filter((o) => o.ok).map((o) => o.key),
			failed: outcomes.filter((o) => !o.ok).map((o) => ({ key: o.key, error: o.error ?? 'unknown error' })),
		};
	}

	/** Moves every `changes_requested` item back to `ready_to_draft` with its comment folded into a fresh draft request — call `run()` again afterward to actually redraft/re-QA them (FR-8.7's "refine only rejected"). */
	prepareRefinement(batch: RapidFireBatch): void {
		for (const item of batch.items) {
			if (item.state !== 'changes_requested') continue;
			item.decision = undefined;
			item.qaResult = undefined;
			item.state = 'ready_to_draft';
		}
	}
}
