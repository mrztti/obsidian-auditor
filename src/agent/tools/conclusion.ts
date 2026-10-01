import { Type } from '@google/genai';
import type { DraftStage } from '../types';
import { str, type AgentTool } from './types';

const STAGE_LABEL: Record<DraftStage, string> = { stage1: 'Stage 1', stage2: 'Stage 2' };
const VALID_STAGES: DraftStage[] = ['stage1', 'stage2'];
const VALID_RATINGS = new Set(['C', 'C*', 'NC']);

/**
 * The agent's single, explicit way to draft a Stage 1/Stage 2 conclusion — replaces free-form
 * prompting (FR-2.1). Takes a compact, already-researched evidence context (the agent is expected
 * to have done its own research via search_documents/read_document first and condense it here,
 * rather than this tool re-researching or the agent pasting full documents in) plus the control
 * text, and produces a structured draft per requested stage: conclusion text, rating, and —
 * critically — assumptions and unresolved issues kept SEPARATE from the conclusion itself, so a
 * gap can never be silently read as "satisfied" just because the conclusion text reads cleanly.
 * This never writes anything; the draft still has to pass QA and then propose_control_changes.
 */
export const prepareControlConclusionTool: AgentTool = {
	declaration: {
		name: 'prepare_control_conclusion',
		description:
			'Draft a control\'s Stage 1 and/or Stage 2 conclusion. This is the ONLY way to draft a conclusion — use it instead of writing the conclusion text yourself in a tool call or reply. Pass a compact synthesis of what you already found (cachedEvidenceContext), not full documents — you should have already gathered the evidence with search_documents/read_document/get_session_plan before calling this. Returns a draft per stage with its own assumptions and unresolvedIssues kept separate from the conclusion text — a gap is never silently folded into "looks fine". The draft is NOT saved and does not pass QA by itself: call qa_review_conclusions_batch (or qa_review_conclusion) on the result next, then propose_control_changes. To revise after a rejection, call this again with priorConclusion and requestedChanges set from the reviewer\'s comment — only for the rejected stage(s), not the whole control.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				controlId: { type: Type.STRING, description: 'Exact control number (must have been read with get_controls).' },
				stages: { type: Type.ARRAY, items: { type: Type.STRING, enum: VALID_STAGES }, description: 'Which stage(s) to draft in this one call — both at once if you have evidence for both.' },
				controlText: { type: Type.STRING, description: 'The control/requirement text, as read from get_controls.' },
				evidenceReferences: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'File paths / document names actually backing this draft — every one must be something you retrieved, never invented. Echoed back on the result for traceability.' },
				cachedEvidenceContext: { type: Type.STRING, description: 'Your own compact synthesis of the relevant evidence/interview findings/session-plan captures — references and key facts, not full document dumps.' },
				priorConclusion: { type: Type.STRING, description: 'The existing conclusion text, when revising one that already exists (e.g. after a rejection, or extending prior work). Empty for a first draft.' },
				requestedChanges: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Specific changes to make, e.g. a reviewer\'s rejection comment. Only set when revising.' },
				writingStyleProfileId: { type: Type.STRING, description: 'The configured writing-style profile id this draft is intended to pass QA under (informational — QA itself always uses whatever is currently configured in settings).' },
			},
			required: ['controlId', 'stages', 'controlText', 'evidenceReferences'],
		},
	},
	label: (a) => `Drafting ${Array.isArray(a.stages) ? (a.stages as string[]).map((s) => STAGE_LABEL[s as DraftStage] ?? s).join(' + ') : 'conclusion'} for ${str(a.controlId)}`,
	run: async (args, ctx) => {
		const controlId = str(args.controlId).trim();
		const controlText = str(args.controlText).trim();
		if (!controlId) return { ok: false, output: { error: 'controlId is required.' }, summary: 'Missing control id' };
		if (!controlText) return { ok: false, output: { error: 'controlText is required — read it with get_controls first.' }, summary: 'Missing control text' };

		const rawStages = Array.isArray(args.stages) ? (args.stages as unknown[]) : [];
		const stages = rawStages.filter((s): s is DraftStage => VALID_STAGES.includes(s as DraftStage));
		if (stages.length === 0) return { ok: false, output: { error: 'stages must include at least one of "stage1", "stage2".' }, summary: 'No stage requested' };

		if (!ctx.hasCurrentEvidence()) {
			return {
				ok: false,
				output: { error: 'This run has not looked at any current evidence yet — call search_documents/read_document (against "evidence" and/or "interviewEvidence") or get_session_plan before drafting.' },
				summary: 'Blocked: no current evidence gathered',
			};
		}

		const evidenceReferences = Array.isArray(args.evidenceReferences) ? (args.evidenceReferences as unknown[]).filter((v): v is string => typeof v === 'string') : [];
		const requestedChanges = Array.isArray(args.requestedChanges) ? (args.requestedChanges as unknown[]).filter((v): v is string => typeof v === 'string') : [];
		const priorConclusion = str(args.priorConclusion);
		const cachedEvidenceContext = str(args.cachedEvidenceContext);

		const writingRules = stages.includes('stage2') && !stages.includes('stage1')
			? ctx.plugin.settings.defaultStage2WritingRules
			: ctx.plugin.settings.defaultWritingRules;
		const guidance = (await ctx.controls.load([controlId])).found[0]?.record.auditGuidance ?? '';

		const model = ctx.isBurnActive() ? ctx.plugin.settings.boostedModel.trim() || undefined : undefined;
		const result = await ctx.callWithRecovery(() => ctx.plugin.geminiGenerate.prepareControlConclusion(
			controlText,
			stages,
			cachedEvidenceContext,
			priorConclusion,
			requestedChanges,
			writingRules,
			guidance,
			model,
		));
		ctx.recordUsage(result.usage);
		ctx.markCurrentEvidence();

		const stagesOut = result.stages.map((s) => ({
			controlId,
			stage: s.stage,
			conclusionText: s.conclusionText,
			rating: VALID_RATINGS.has(s.rating) ? s.rating : 'NC',
			evidenceReferences,
			assumptions: s.assumptions,
			unresolvedIssues: s.unresolvedIssues,
		}));
		const gaps = stagesOut.filter((s) => s.unresolvedIssues.length > 0);

		return {
			output: {
				controlId,
				stages: stagesOut,
				nextStep: 'Not saved yet. Call qa_review_conclusions_batch (or qa_review_conclusion) for each stage drafted here before proposing it.',
				...(gaps.length > 0 ? { warning: `${gaps.length} stage(s) have unresolved issues — reflect them honestly in the rating/comments, do not paper over them.` } : {}),
			},
			summary: `Drafted ${controlId}: ${stagesOut.map((s) => `${STAGE_LABEL[s.stage]}=${s.rating}`).join(', ')}`,
		};
	},
};
