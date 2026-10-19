import { Type } from '@google/genai';
import type { DraftStage } from '../agent/types';
import { str, truncate, type AgentTool } from '../agent/tools/types';
import type { ReaderDocument } from './readerAgent';
import { CONTROLS_READER_ID, type SimilarControl } from './controlsReaderAgent';
import { COORDINATOR_ID } from './coordinatorReviewer';
import { VERIFIER_AGENT_ID, type VerificationItemInput, type VerificationItemResult } from './verifierAgent';

export const EVIDENCE_READER_ID = 'evidence-reader';
export const STANDARDS_READER_ID = 'standards-reader';
export const VERIFIER_ID = VERIFIER_AGENT_ID;

const VALID_STAGES: DraftStage[] = ['stage1', 'stage2'];

/** Fired when a reader agent can't be reached in time — never invents documents in its place. */
function timeoutOutput(readerId: string, e: unknown): { error: string } {
	return { error: `${readerId} did not respond: ${e instanceof Error ? e.message : String(e)}` };
}

function formatDocuments(documents: ReaderDocument[]): Record<string, unknown>[] {
	return documents.map((d) => ({ path: d.path, location: d.location, score: Number(d.score.toFixed(3)), text: truncate(d.text, 1500) }));
}

/**
 * Builds a writer's "ask the evidence/standards reader" tool — replaces the chat agent's own
 * `search_documents` for the swarm's writer role, so a given topic's evidence/standards lookup is
 * centralized (and memoized per `readerAgent.ts`'s own memory) in one reader agent rather than every
 * writer re-searching the same topic independently. Routes through `plugin.swarmBus.request`, which
 * is how one swarm agent waits on another's response.
 */
function makeRequestTool(name: string, description: string, readerId: string, titlePrefix: string, marksCurrentEvidence: boolean): AgentTool {
	return {
		declaration: {
			name,
			description,
			parameters: {
				type: Type.OBJECT,
				properties: {
					topic: { type: Type.STRING, description: 'Keyword-dense topic/query — the reader searches its index for this and remembers the mapping for next time.' },
				},
				required: ['topic'],
			},
		},
		label: (a) => `Asking ${readerId}: ${str(a.topic)}`,
		run: async (args, ctx) => {
			const topic = str(args.topic).trim();
			if (!topic) return { ok: false, output: { error: 'topic is required.' }, summary: 'Empty topic' };
			let reply: unknown;
			try {
				reply = await ctx.plugin.swarmBus.request(ctx.agentId, readerId, { topic }, { title: `${titlePrefix}: ${topic}` });
			} catch (e) {
				return { ok: false, output: timeoutOutput(readerId, e), summary: `No reply from ${readerId}` };
			}
			const { documents } = reply as { documents: ReaderDocument[] };
			if (marksCurrentEvidence && documents.length > 0) ctx.markCurrentEvidence();
			return {
				output: {
					resultCount: documents.length,
					documents: formatDocuments(documents),
					...(documents.length === 0 ? { hint: `${readerId} found nothing for this topic. Try a different phrasing.` } : {}),
				},
				summary: `${documents.length} document(s) from ${readerId}`,
			};
		},
	};
}

export const requestEvidenceTool: AgentTool = makeRequestTool(
	'request_evidence',
	'Ask the evidence reader agent for every document (evidence + interview evidence) relevant to a topic. It lists ALL matching documents, not just the top one, and remembers topic → documents so repeat requests for the same topic are instant. Use this instead of searching evidence yourself.',
	EVIDENCE_READER_ID,
	'Evidence',
	true,
);

export const requestStandardsTool: AgentTool = makeRequestTool(
	'request_standards',
	'Ask the standards reader agent for every standards clause relevant to a topic. It lists ALL matching clauses, not just the top one, and remembers topic → documents so repeat requests for the same topic are instant. Use this instead of searching standards yourself.',
	STANDARDS_READER_ID,
	'Standards',
	false,
);

/**
 * Asks the controls-reader specialist what existing controls already cover a topic — structured
 * prior-art (control number, requirement text, current ratings) rather than raw document chunks, so
 * a writer can match the wording/structure/rating pattern of similar already-written controls
 * instead of drafting a topic in isolation.
 */
export const requestSimilarControlsTool: AgentTool = {
	declaration: {
		name: 'request_similar_controls',
		description: 'Ask the controls-reader agent which existing controls already cover a topic — returns each match\'s number, requirement text and current ratings, so you can match the style/structure of similar already-written controls.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				topic: { type: Type.STRING, description: 'Keyword-dense topic/query.' },
			},
			required: ['topic'],
		},
	},
	label: (a) => `Asking ${CONTROLS_READER_ID}: ${str(a.topic)}`,
	run: async (args, ctx) => {
		const topic = str(args.topic).trim();
		if (!topic) return { ok: false, output: { error: 'topic is required.' }, summary: 'Empty topic' };
		let reply: unknown;
		try {
			reply = await ctx.plugin.swarmBus.request(ctx.agentId, CONTROLS_READER_ID, { topic }, { title: `Similar controls: ${topic}` });
		} catch (e) {
			return { ok: false, output: timeoutOutput(CONTROLS_READER_ID, e), summary: `No reply from ${CONTROLS_READER_ID}` };
		}
		const { controls } = reply as { controls: SimilarControl[] };
		return {
			output: {
				resultCount: controls.length,
				controls,
				...(controls.length === 0 ? { hint: 'No similar controls found for this topic.' } : {}),
			},
			summary: `${controls.length} similar control(s)`,
		};
	},
};

/**
 * A quick, non-blocking QA pass routed to the independent verifier agent — a genuine second
 * opinion, since the actual QA model call happens in `VerifierAgent`, reached only through the bus,
 * never inside this agent's own tool loop. Unlike a gate, a "fail" here is never a signal to redraft
 * and resubmit: ALWAYS use the returned correctedConclusionText/correctedRating and move on to
 * submit_to_coordinator — `findings` are kept only as a transparency note (the coordinator sees them
 * too, in its own later QA pass). Marks every item as cleared regardless of pass/fail, since nothing
 * downstream of this blocks on it looping back here.
 */
export const requestVerificationTool: AgentTool = {
	declaration: {
		name: 'request_verification',
		description:
			'Sends one or more drafted conclusions (from prepare_control_conclusion) to the independent verifier agent for QA. This is a correction pass, not a gate: it ALWAYS returns a corrected conclusion/rating per item — use those, then call submit_to_coordinator. Never redraft-and-resubmit in a loop over a failed item; its findings are kept as a transparency note, not a blocker.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				items: {
					type: Type.ARRAY,
					items: {
						type: Type.OBJECT,
						properties: {
							controlId: { type: Type.STRING },
							stage: { type: Type.STRING, enum: VALID_STAGES },
							controlText: { type: Type.STRING, description: 'The exact control/requirement text, as read from get_controls.' },
							conclusionText: { type: Type.STRING, description: 'The draft text from prepare_control_conclusion.' },
							rating: { type: Type.STRING, description: 'The draft rating from prepare_control_conclusion.' },
							evidenceReferences: { type: Type.ARRAY, items: { type: Type.STRING } },
						},
						required: ['controlId', 'stage', 'controlText', 'conclusionText', 'rating', 'evidenceReferences'],
					},
				},
			},
			required: ['items'],
		},
	},
	label: (a) => `Requesting verification: ${Array.isArray(a.items) ? a.items.length : 0} item(s)`,
	run: async (args, ctx) => {
		const rawItems = Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : [];
		const items: VerificationItemInput[] = rawItems
			.map((it) => ({
				controlId: str(it.controlId).trim(),
				stage: str(it.stage) as DraftStage,
				controlText: str(it.controlText),
				conclusionText: str(it.conclusionText),
				rating: str(it.rating),
				evidenceReferences: Array.isArray(it.evidenceReferences) ? (it.evidenceReferences as unknown[]).filter((v): v is string => typeof v === 'string') : [],
			}))
			.filter((it) => it.controlId && VALID_STAGES.includes(it.stage) && it.conclusionText.trim() !== '' && it.controlText.trim() !== '');
		if (items.length === 0) return { ok: false, output: { error: 'No valid items — each needs controlId, stage, controlText and non-empty conclusionText.' }, summary: 'No valid items' };

		let reply: { results?: VerificationItemResult[]; error?: string };
		try {
			reply = (await ctx.plugin.swarmBus.request(ctx.agentId, VERIFIER_AGENT_ID, { items }, { title: `Verify: ${items.length} item(s)`, meta: { count: items.length } })) as { results?: VerificationItemResult[]; error?: string };
		} catch (e) {
			return { ok: false, output: timeoutOutput(VERIFIER_AGENT_ID, e), summary: 'No reply from verifier' };
		}
		if (reply.error || !reply.results) return { ok: false, output: { error: reply.error ?? 'Verifier returned no results.' }, summary: 'Verification failed' };

		// Every item is cleared, pass or fail — this tool corrects, it never gates (see doc comment above).
		for (const r of reply.results) ctx.markQaReview(r.controlId, r.stage);
		const passed = reply.results.filter((r) => r.pass).length;
		return {
			output: {
				results: reply.results,
				nextStep: 'Use each item\'s correctedConclusionText/correctedRating (not your original draft) and call submit_to_coordinator for each — do not redraft and re-verify an item just because it failed here.',
			},
			summary: `Verification: ${passed}/${reply.results.length} passed cleanly, corrected text applied for all`,
		};
	},
};

/**
 * Hands a finished, QA-corrected (control, stage) conclusion off to the coordinator — the ONLY way
 * a writer's work reaches a user-facing proposal. The coordinator runs its own authoritative QA pass
 * and decides what actually gets staged into the outbox; writers never call propose_control_changes
 * or write anything themselves.
 */
export const submitToCoordinatorTool: AgentTool = {
	declaration: {
		name: 'submit_to_coordinator',
		description: 'Submit one finished, verified (control, stage) conclusion to the coordinator. The coordinator runs a final QA pass and has the final say on whether/how it is presented to the user — this is the only way to hand off finished drafting work; never call propose_control_changes yourself.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				controlId: { type: Type.STRING },
				stage: { type: Type.STRING, enum: VALID_STAGES },
				controlText: { type: Type.STRING, description: 'The exact control/requirement text, as read from get_controls.' },
				conclusionText: { type: Type.STRING, description: 'The corrected conclusion text from request_verification (or the draft text, if request_verification was skipped).' },
				rating: { type: Type.STRING, description: 'The corrected rating from request_verification.' },
				evidenceReferences: { type: Type.ARRAY, items: { type: Type.STRING } },
			},
			required: ['controlId', 'stage', 'controlText', 'conclusionText', 'rating', 'evidenceReferences'],
		},
	},
	label: (a) => `Submitting ${str(a.controlId)} (${str(a.stage)}) to the coordinator`,
	run: async (args, ctx) => {
		const controlId = str(args.controlId).trim();
		const stage = str(args.stage) as DraftStage;
		const controlText = str(args.controlText);
		const conclusionText = str(args.conclusionText);
		const rating = str(args.rating);
		if (!controlId || !VALID_STAGES.includes(stage) || !controlText.trim() || !conclusionText.trim()) {
			return { ok: false, output: { error: 'controlId, stage, controlText and conclusionText are all required.' }, summary: 'Missing fields' };
		}
		if (!ctx.hasQaReview(controlId, stage)) {
			return { ok: false, output: { error: `Call request_verification for ${controlId} (${stage}) before submitting it.` }, summary: 'Not verified yet' };
		}
		const evidenceReferences = Array.isArray(args.evidenceReferences) ? (args.evidenceReferences as unknown[]).filter((v): v is string => typeof v === 'string') : [];
		try {
			await ctx.plugin.swarmBus.request(ctx.agentId, COORDINATOR_ID, { writerId: ctx.agentId, controlId, stage, controlText, conclusionText, rating, evidenceReferences }, { title: `Draft: ${controlId} (${stage})` });
		} catch (e) {
			return { ok: false, output: timeoutOutput(COORDINATOR_ID, e), summary: 'No reply from coordinator' };
		}
		// Lets the orchestrator mark this specific control's task done immediately, rather than only
		// once this writer's entire assigned batch finishes — see `SwarmOrchestrator`'s subscription.
		ctx.plugin.swarmBus.event(ctx.agentId, '*', { kind: 'controlSubmitted', controlId }, `Submitted ${controlId}`);
		return { output: { status: 'submitted' }, summary: `Submitted ${controlId} (${stage}) to the coordinator` };
	},
};
