import { Type } from '@google/genai';
import { ResearchCache } from '../researchCache';
import { clampInt, str, truncate, type AgentTool } from './types';

const RESULT_WARNING = 'STYLE ONLY — a finalized, closed past engagement. Do not treat this as evidence, as fact, or as the current status of anything in this audit.';

export const searchReferenceStyleTool: AgentTool = {
	declaration: {
		name: 'search_reference_style',
		description:
			'Search finalized audit reports from past, closed engagements — for WORDING AND STRUCTURE reference ONLY, never as evidence and never as a source of facts about the current audit. Use it only to see how a Stage 1/Stage 2 conclusion was phrased for a similar kind of control: sentence structure, tone, level of detail, how findings/observations/recommendations read. These reports say nothing about the current, up-to-date state of the control you are working on — every result is prefixed with a warning restating that. You must independently verify current compliance or remediation status from "evidence" and "interviewEvidence" (via search_documents / get_session_plan) before writing or changing a conclusion or rating; a match here is never a substitute for that, and nothing retrieved here may be copied, paraphrased as fact, or cited in a conclusion.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				query: { type: Type.STRING, description: 'Keyword-dense description of the kind of control/requirement whose write-up style you want to see (not the current control\'s facts).' },
				limit: { type: Type.INTEGER, description: 'Max results (default 5, max 10).' },
			},
			required: ['query'],
		},
	},
	label: (a) => `Checking wording style in past reports: ${str(a.query)}`,
	run: async (args, ctx) => {
		const query = str(args.query).trim();
		if (!query) return { ok: false, output: { error: 'query is required.' }, summary: 'Empty query' };
		const limit = clampInt(args.limit, 5, 1, 10);
		const cacheKey = ResearchCache.key('search_reference_style', { query, limit });
		const { value: results, hit } = await ctx.plugin.researchCache.getOrFetch(cacheKey, async () => {
			const value = await ctx.plugin.referenceReportsIndex.search(query, limit);
			return { value, sourceFiles: [...new Set(value.map((r) => r.sourcePath))] };
		});
		return {
			output: {
				warning: 'Every result below is from a closed, past engagement. It may inform WORDING and STRUCTURE only. Do not copy or infer any fact, finding, date, or rating from it, and never cite it in a conclusion.',
				resultCount: results.length,
				results: results.map((r) => ({ path: r.sourcePath, warning: RESULT_WARNING, text: truncate(r.text, 1200) })),
				...(results.length === 0 ? { hint: 'No stylistic precedent found — write directly from the requirement and current evidence.' } : {}),
				reminder: 'Before writing or changing a conclusion or rating, verify the CURRENT status with search_documents against "evidence" and/or "interviewEvidence" (and get_session_plan) — this is required and checked before propose_control_changes will accept a conclusion/rating change.',
			},
			summary: `${results.length} style reference${results.length === 1 ? '' : 's'} found (not evidence)${hit ? ' (cached)' : ''}`,
		};
	},
};
