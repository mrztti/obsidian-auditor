import { Type } from '@google/genai';
import type { DraftStage } from '../types';
import { str, type AgentTool } from './types';

const STAGE_LABEL: Record<DraftStage, string> = { stage1: 'Stage 1 (Test of Design)', stage2: 'Stage 2 (Test of Effectiveness)' };

export const qaReviewTool: AgentTool = {
	declaration: {
		name: 'qa_review_conclusion',
		description:
			'Required self-QA gate: call this once you have a draft conclusion and rating for one control\'s Stage 1 or Stage 2, BEFORE including it in propose_control_changes. It does not write anything by itself — it is where you slow down and actually check your own work. propose_control_changes refuses to change a conclusion/rating for a (control, stage) that has not passed this here in the current run. If passesQa is false, do not proceed to propose it: go back, close the gap (more research, a corrected rating, a revised conclusion, or an honest gap statement), and call this again before proposing.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				controlNumber: { type: Type.STRING, description: 'Exact control number.' },
				stage: { type: Type.STRING, enum: ['stage1', 'stage2'], description: 'Which conclusion this review is for.' },
				requirement: { type: Type.STRING, description: 'One or two sentences: what this control/requirement actually demands, in your own words.' },
				evidenceSummary: { type: Type.STRING, description: 'What the CURRENT evidence you retrieved this run actually shows, with sources (file/location) — not a restatement of the requirement.' },
				ratingJustification: { type: Type.STRING, description: 'Why the rating you are about to propose follows from that evidence, specifically — not a generic statement.' },
				citationsVerified: { type: Type.BOOLEAN, description: 'True only if you rechecked that every citation/reference in the drafted conclusion text corresponds to something you actually retrieved this run — no citation invented, no reference-report content cited as fact.' },
				gaps: { type: Type.STRING, description: 'What is missing, uncertain, or not fully evidenced — empty string only if genuinely none.' },
				passesQa: { type: Type.BOOLEAN, description: 'Your honest verdict: does this draft meet the writing conventions and rest entirely on verified current evidence? False if unsure.' },
			},
			required: ['controlNumber', 'stage', 'requirement', 'evidenceSummary', 'ratingJustification', 'citationsVerified', 'gaps', 'passesQa'],
		},
	},
	label: (a) => `QA review: ${str(a.controlNumber)} — ${STAGE_LABEL[str(a.stage) as DraftStage] ?? str(a.stage)}`,
	run: (args, ctx) => {
		const controlNumber = str(args.controlNumber).trim();
		const stage = str(args.stage) as DraftStage;
		if (!controlNumber) return Promise.resolve({ ok: false, output: { error: 'controlNumber is required.' }, summary: 'Missing control number' });
		if (stage !== 'stage1' && stage !== 'stage2') return Promise.resolve({ ok: false, output: { error: 'stage must be "stage1" or "stage2".' }, summary: 'Invalid stage' });

		const passes = args.passesQa === true && args.citationsVerified === true;
		if (passes) {
			ctx.markQaReview(controlNumber, stage);
			return Promise.resolve({
				output: { status: 'passed', note: `Cleared to propose ${controlNumber}'s ${STAGE_LABEL[stage]} conclusion.` },
				summary: `QA passed: ${controlNumber} — ${STAGE_LABEL[stage]}`,
			});
		}
		const reason = args.citationsVerified !== true ? 'citations were not verified against what was actually retrieved' : 'the draft did not pass its own QA check';
		return Promise.resolve({
			ok: false,
			output: {
				status: 'failed',
				error: `QA did not pass (${reason}). Do not propose this yet — address it (more research, a corrected citation/rating/conclusion, or an honest gap statement) and call qa_review_conclusion again once it genuinely holds up.`,
			},
			summary: `QA failed: ${controlNumber} — ${STAGE_LABEL[stage]} (${reason})`,
		});
	},
};
