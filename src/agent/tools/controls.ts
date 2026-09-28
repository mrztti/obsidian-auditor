import { Type } from '@google/genai';
import type AuditorPlugin from '../../main';
import { CONTROL_RATINGS, CONTROL_STATUSES } from '../../controlNote';
import { summarizeControl } from '../controlStore';
import { EDITABLE_CONTROL_FIELDS, FIELD_LABELS, type ResolvedChange, type ReviewItem } from '../types';
import { clampInt, str, type AgentTool } from './types';

export const findControlsTool: AgentTool = {
	declaration: {
		name: 'find_controls',
		description:
			'Resolve what the user is talking about to concrete controls. Give it the user\'s own words (a control number like "4.2.1", a topic, a phrase from the control text) and/or filters. Ranks by control number, keyword and semantic match. Returns short summaries only — call get_controls to read the full records. NEVER guess control numbers; always resolve them here first.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				query: { type: Type.STRING, description: 'Free-text description or control number(s). Optional if filters are given.' },
				session: { type: Type.STRING, description: 'Only controls in this exact session.' },
				status: { type: Type.STRING, enum: CONTROL_STATUSES, description: 'Only controls with this status.' },
				standard: { type: Type.STRING, description: 'Only controls whose standard contains this text.' },
				rating: { type: Type.STRING, enum: CONTROL_RATINGS.filter(Boolean), description: 'Only controls whose ToD or ToE rating equals this.' },
				limit: { type: Type.INTEGER, description: 'Max results (default 15, max 50).' },
			},
		},
	},
	label: (a) => `Looking up controls${str(a.query) ? `: ${str(a.query)}` : ' by filter'}`,
	run: async (args, ctx) => {
		const limit = clampInt(args.limit, 15, 1, 50);
		const { matches, total } = await ctx.controls.find(
			str(args.query),
			{ session: str(args.session), status: str(args.status), standard: str(args.standard), rating: str(args.rating) },
			limit,
		);
		return {
			output: {
				totalMatches: total,
				returned: matches.length,
				controls: matches.map((m) => ({ ...summarizeControl(m.entry), matchScore: Math.round(m.score), matchedOn: m.reason })),
				...(matches.length === 0 ? { hint: 'No matches. Try different wording, fewer words, or drop filters.' } : {}),
			},
			summary: matches.length === 0 ? 'No controls matched' : `${matches.length} of ${total} controls: ${matches.slice(0, 5).map((m) => m.entry.record.number).join(', ')}${matches.length > 5 ? '…' : ''}`,
		};
	},
};

export const getControlsTool: AgentTool = {
	declaration: {
		name: 'get_controls',
		description:
			'Read the full, current record of one or more controls (requirement text, Stage 1 / Stage 2 conclusions, ratings, ready flags, status, session, dated comments). Required before proposing changes to a control — your edit is checked against what you read here.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				numbers: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Exact control numbers, as returned by find_controls (max 10).' },
			},
			required: ['numbers'],
		},
	},
	label: (a) => `Reading controls: ${Array.isArray(a.numbers) ? (a.numbers as string[]).join(', ') : ''}`,
	run: async (args, ctx) => {
		const numbers = (Array.isArray(args.numbers) ? (args.numbers as unknown[]) : []).filter((n): n is string => typeof n === 'string').slice(0, 10);
		if (numbers.length === 0) return { ok: false, output: { error: 'numbers must be a non-empty array of strings.' }, summary: 'No control numbers given' };
		const { found, missing } = await ctx.controls.load(numbers);
		return {
			ok: found.length > 0,
			output: {
				controls: found.map((e) => ({ ...e.record, comments: e.record.comments.map((c) => (c.date ? `${c.date}: ${c.text}` : c.text)) })),
				...(missing.length > 0 ? { notFound: missing, hint: 'Use find_controls to resolve the right numbers.' } : {}),
			},
			summary: `Read ${found.map((e) => e.record.number).join(', ') || 'nothing'}${missing.length > 0 ? ` (not found: ${missing.join(', ')})` : ''}`,
		};
	},
};

const display = (v: string | boolean): string => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : v);

function toReviewItem(change: ResolvedChange, plugin: AuditorPlugin): ReviewItem {
	return {
		key: change.number,
		title: change.number,
		subtitle: change.after.topic || change.after.control.slice(0, 60),
		open: { label: 'Open note', run: () => { void plugin.app.workspace.getLeaf('tab').openFile(change.file); } },
		entries: change.changedFields.map((field) => field === 'comments'
			? { label: FIELD_LABELS.comments, before: '', after: change.after.comments.slice(change.before.comments.length).map((c) => `${c.date}: ${c.text}`).join('\n') }
			: { label: FIELD_LABELS[field], before: display(change.before[field]), after: display(change.after[field]) }),
	};
}

export const proposeChangesTool: AgentTool = {
	declaration: {
		name: 'propose_control_changes',
		description:
			`Save your work: submit the final edits for the user to review. This is the ONLY way to modify controls, and nothing is written until the user approves it in the chat. Call it once, only when the objective is achieved and you have gathered enough evidence to justify every edit. The result tells you which controls were approved (and saved) or rejected, plus any feedback; if rejected with feedback, revise and propose again. Send only the fields you want to change. Editable fields: ${EDITABLE_CONTROL_FIELDS.map((f) => FIELD_LABELS[f]).join(', ')}.`,
		parameters: {
			type: Type.OBJECT,
			properties: {
				summary: { type: Type.STRING, description: 'Two or three sentences for the user: what you changed and why.' },
				changes: {
					type: Type.ARRAY,
					items: {
						type: Type.OBJECT,
						properties: {
							number: { type: Type.STRING, description: 'Exact control number (must have been read with get_controls).' },
							fields: {
								type: Type.OBJECT,
								description: 'Only the fields to change, with their complete new values (not diffs).',
								properties: {
									standard: { type: Type.STRING },
									topic: { type: Type.STRING },
									control: { type: Type.STRING },
									session: { type: Type.STRING },
									assignedMember: { type: Type.STRING },
									status: { type: Type.STRING, enum: CONTROL_STATUSES },
									todConclusion: { type: Type.STRING, description: 'Complete new Stage 1 conclusion text.' },
									todRating: { type: Type.STRING, description: 'One of "C", "C*", "NC", "-", or "" (empty string) for not yet rated.' },
									todReady: { type: Type.BOOLEAN },
									toeConclusion: { type: Type.STRING, description: 'Complete new Stage 2 conclusion text.' },
									toeRating: { type: Type.STRING, description: 'One of "C", "C*", "NC", "-", or "" (empty string) for not yet rated.' },
									toeReady: { type: Type.BOOLEAN },
								},
							},
							addComments: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Single-line comments to append (dated automatically). Comments are append-only.' },
						},
						required: ['number'],
					},
				},
			},
			required: ['summary', 'changes'],
		},
	},
	label: () => 'Preparing changes for your review',
	run: async (args, ctx) => {
		const parsed = ctx.controls.parseChanges(args.changes);
		if ('error' in parsed) return { ok: false, output: { error: parsed.error }, summary: `Invalid proposal: ${parsed.error}` };
		const resolved = ctx.controls.resolve(parsed.changes);
		if (resolved.length === 0) return { ok: false, output: { error: 'None of the proposed values differ from the current content — nothing to change.' }, summary: 'Proposal contained no actual changes' };

		const decision = await ctx.host.requestApproval({ heading: `Review proposed changes (${resolved.length} control${resolved.length === 1 ? '' : 's'})`, summary: str(args.summary), items: resolved.map((c) => toReviewItem(c, ctx.plugin)) });
		const toApply = resolved.filter((c) => decision.approved.includes(c.number));
		const outcomes = toApply.length > 0 ? await ctx.controls.apply(toApply) : [];
		ctx.host.reportApplied(outcomes);

		const saved = outcomes.filter((o) => o.ok).map((o) => o.key);
		const failed = outcomes.filter((o) => !o.ok);
		return {
			output: {
				saved,
				rejectedByUser: decision.rejected,
				...(failed.length > 0 ? { failedToSave: failed } : {}),
				...(decision.feedback ? { userFeedback: decision.feedback } : {}),
				nextStep: decision.rejected.length > 0 || failed.length > 0
					? 'Some changes were not saved. Address the user feedback or the errors (re-read controls if needed) and propose again, or explain to the user if you should stop.'
					: 'All changes saved. Write a short final summary for the user.',
			},
			summary: `Saved ${saved.length}${decision.rejected.length > 0 ? `, rejected ${decision.rejected.length}` : ''}${failed.length > 0 ? `, failed ${failed.length}` : ''}`,
		};
	},
};
