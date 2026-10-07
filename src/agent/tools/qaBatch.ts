import { Type } from '@google/genai';
import { EMPTY_WRITING_STYLE_PROFILE } from '../../settings';
import type { DraftStage } from '../types';
import { str, type AgentTool } from './types';

const VALID_STAGES: DraftStage[] = ['stage1', 'stage2'];
/** The agent may hand QA more items than this in one call; they are reviewed in bounded chunks of this size (shared style profile + a single context budget per Gemini call) rather than one unbounded prompt — see FR-3.2. */
const MAX_ITEMS_PER_QA_CALL = 6;

function isConfigured(profile: { name: string }): boolean {
	return profile.name.trim() !== '';
}

/**
 * Genuine, independent QA for one or more drafted conclusions at once — the batched counterpart to
 * `qa_review_conclusion` (FR-3.2). Unlike that tool (the model's own self-attestation, free), this
 * makes its own separate Gemini call(s) against the SAME structural writing rules
 * (`defaultWritingRules`/`defaultStage2WritingRules`) the drafting pipeline already uses, plus the
 * centrally-configured writing-style profile's prohibited wording (FR-3.3) — nothing here is a
 * second copy of either. Returns a structured pass/fail plus a corrected version of the
 * text/rating per item. Marks each passing (control, stage) the same way qa_review_conclusion
 * does, so propose_control_changes accepts it.
 */
export const qaReviewBatchTool: AgentTool = {
	declaration: {
		name: 'qa_review_conclusions_batch',
		description:
			'Independently QA-reviews one or more drafted conclusions (from prepare_control_conclusion) in as few calls as practical. Validates evidence alignment, unsupported claims, internal consistency, required structure, the configured writing style, prohibited wording, control/evidence-reference correctness, AND — critically — that the conclusion addresses ONLY what the control\'s own text actually specifies, never drifting onto related-but-unspecified topics just because evidence happens to touch on them. Checked against the single writing-style profile configured in Auditor settings, never a profile you define yourself. Marks each passing (control, stage) as cleared for propose_control_changes, same as qa_review_conclusion. If no writing-style profile is configured in settings, this refuses outright — configure one (or tell the user to) rather than proceeding without one. Returns, per item, pass/fail, a corrected conclusion/rating (use these — they reflect the QA pass), and specific, actionable findings naming exactly what must change to pass.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				items: {
					type: Type.ARRAY,
					description: `Up to ${MAX_ITEMS_PER_QA_CALL * 4} items; reviewed internally in bounded batches.`,
					items: {
						type: Type.OBJECT,
						properties: {
							controlId: { type: Type.STRING },
							stage: { type: Type.STRING, enum: VALID_STAGES },
							controlText: { type: Type.STRING, description: 'The exact control/requirement text, as read from get_controls — QA checks the conclusion against this to catch scope drift onto anything the control itself does not actually specify.' },
							conclusionText: { type: Type.STRING, description: 'The draft text from prepare_control_conclusion.' },
							rating: { type: Type.STRING, description: 'The draft rating from prepare_control_conclusion.' },
							evidenceReferences: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Same list echoed back by prepare_control_conclusion for this item.' },
						},
						required: ['controlId', 'stage', 'controlText', 'conclusionText', 'rating', 'evidenceReferences'],
					},
				},
			},
			required: ['items'],
		},
	},
	label: (a) => `QA review (batch): ${Array.isArray(a.items) ? a.items.length : 0} item(s)`,
	run: async (args, ctx) => {
		const profile = ctx.plugin.settings.writingStyleProfile ?? EMPTY_WRITING_STYLE_PROFILE;
		if (!isConfigured(profile)) {
			return {
				ok: false,
				output: {
					error: 'No writing-style profile is configured in Auditor settings (Writing style profile section) — this stops here rather than silently using a default. Tell the user to configure one, or ask them to, before conclusions can be QA-reviewed and presented for final review.',
				},
				summary: 'Blocked: no writing-style profile configured',
			};
		}

		const rawItems = Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : [];
		if (rawItems.length === 0) return { ok: false, output: { error: 'items must be a non-empty array.' }, summary: 'No items given' };

		const items = rawItems
			.map((it) => ({
				controlId: str(it.controlId).trim(),
				stage: str(it.stage) as DraftStage,
				controlText: str(it.controlText),
				conclusionText: str(it.conclusionText),
				rating: str(it.rating),
				evidenceReferences: Array.isArray(it.evidenceReferences) ? (it.evidenceReferences as unknown[]).filter((v): v is string => typeof v === 'string') : [],
			}))
			.filter((it) => it.controlId && VALID_STAGES.includes(it.stage) && it.conclusionText.trim() !== '');
		if (items.length === 0) return { ok: false, output: { error: 'No valid items — each needs controlId, stage ("stage1"/"stage2"), controlText, and non-empty conclusionText.' }, summary: 'No valid items' };
		const missingControlText = items.filter((it) => !it.controlText.trim());
		if (missingControlText.length > 0) {
			return {
				ok: false,
				output: { error: `controlText is required for every item so scope can be checked against it — missing for: ${missingControlText.map((it) => it.controlId).join(', ')}.` },
				summary: 'Missing controlText',
			};
		}

		const model = ctx.isBurnActive() ? ctx.plugin.settings.boostedModel.trim() || undefined : undefined;
		const writingRules = { stage1: ctx.plugin.settings.defaultWritingRules, stage2: ctx.plugin.settings.defaultStage2WritingRules };
		const results: { controlId: string; stage: DraftStage; pass: boolean; correctedConclusionText: string; correctedRating: string; findings: string[] }[] = [];
		for (let i = 0; i < items.length; i += MAX_ITEMS_PER_QA_CALL) {
			const chunk = items.slice(i, i + MAX_ITEMS_PER_QA_CALL);
			const result = await ctx.callWithRecovery(() => ctx.plugin.geminiGenerate.qaReviewConclusionsBatch(chunk, writingRules, profile, model));
			ctx.recordUsage(result.usage);
			results.push(...result.results);
		}

		for (const r of results) {
			if (r.pass) ctx.markQaReview(r.controlId, r.stage);
		}

		const passed = results.filter((r) => r.pass);
		const failed = results.filter((r) => !r.pass);
		return {
			output: {
				profileId: profile.id,
				profileVersion: profile.version,
				results: results.map((r) => ({
					controlId: r.controlId,
					stage: r.stage,
					pass: r.pass,
					correctedConclusionText: r.correctedConclusionText,
					correctedRating: r.correctedRating,
					findings: r.findings,
				})),
				nextStep: failed.length > 0
					? 'For every failed item, use its correctedConclusionText/correctedRating as a starting point, address its findings, redraft with prepare_control_conclusion, and re-run QA on it before proposing. Items that passed are cleared — use THEIR correctedConclusionText/correctedRating (not your original draft) in propose_control_changes.'
					: 'All items passed — use each item\'s correctedConclusionText/correctedRating (not your original draft) in propose_control_changes.',
			},
			summary: `QA (batch, v${profile.version}): ${passed.length} passed${failed.length > 0 ? `, ${failed.length} failed` : ''}`,
		};
	},
};
