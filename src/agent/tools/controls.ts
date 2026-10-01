import { Type } from '@google/genai';
import type AuditorPlugin from '../../main';
import { CONTROL_RATINGS, CONTROL_STATUSES, todayIsoDate } from '../../controlNote';
import { summarizeControl } from '../controlStore';
import { EDITABLE_CONTROL_FIELDS, FIELD_LABELS, STAGE_FOR_FIELD, type ApplyOutcome, type DiffEntry, type DraftStage, type EditableControlField, type ResolvedChange, type ReviewItem } from '../types';
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

/** Fields that assert the control's current compliance/remediation status — changing any of these requires both current evidence (see `hasCurrentEvidence`) and a passed `qa_review_conclusion` for that (control, stage). */
const STATUS_FIELDS = ['todConclusion', 'toeConclusion', 'todRating', 'toeRating'] as const;

const STAGE_LABEL: Record<DraftStage, string> = { stage1: 'Stage 1', stage2: 'Stage 2' };

const SELECT_OPTIONS: Partial<Record<EditableControlField, readonly string[]>> = {
	status: CONTROL_STATUSES,
	todRating: CONTROL_RATINGS,
	toeRating: CONTROL_RATINGS,
};

/** Builds one field's diff entry, with a hand-edit descriptor that writes straight into `change.after` — so a refinement the user types in the review card is exactly what `apply()` saves, no separate plumbing needed. */
function fieldEntry(change: ResolvedChange, field: EditableControlField): DiffEntry {
	const before = display(change.before[field]);
	const options = SELECT_OPTIONS[field];
	const label = FIELD_LABELS[field];
	if (typeof change.after[field] === 'boolean') {
		return {
			label,
			before,
			after: display(change.after[field]),
			edit: { kind: 'boolean', get: () => change.after[field] as boolean, set: (v) => { (change.after as unknown as Record<string, unknown>)[field] = v; } },
		};
	}
	if (options) {
		return {
			label,
			before,
			after: display(change.after[field]),
			edit: { kind: 'select', options: [...options], get: () => change.after[field] as string, set: (v) => { (change.after as unknown as Record<string, unknown>)[field] = v; } },
		};
	}
	return {
		label,
		before,
		after: display(change.after[field]),
		edit: { kind: 'text', get: () => change.after[field] as string, set: (v) => { (change.after as unknown as Record<string, unknown>)[field] = v; } },
	};
}

/** The comments entry is special: only the newly-appended comments (one per line) are editable, each still auto-dated on save — the already-existing history above them is untouched either way. */
function commentsEntry(change: ResolvedChange): DiffEntry {
	const priorCount = change.before.comments.length;
	return {
		label: FIELD_LABELS.comments,
		before: '',
		after: change.after.comments.slice(priorCount).map((c) => `${c.date}: ${c.text}`).join('\n'),
		edit: {
			kind: 'text',
			get: () => change.after.comments.slice(priorCount).map((c) => c.text).join('\n'),
			set: (v) => {
				const lines = v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
				change.after.comments = [...change.before.comments, ...lines.map((text) => ({ date: todayIsoDate(), text }))];
			},
		},
	};
}

/** Which `DraftStage` (if any) a changed field belongs to — fields outside `STAGE_FOR_FIELD` (and `comments`) are "general". */
const stageOf = (field: EditableControlField | 'comments'): DraftStage | 'general' => (field === 'comments' ? 'general' : STAGE_FOR_FIELD[field] ?? 'general');

/** One independently reviewable slice of a `ResolvedChange` — either its general (non-stage) fields, or one stage's fields — so Stage 1 and Stage 2 (and any plain field edits) can be accepted or rejected separately per FR-2.1/FR-3.4, even when they were drafted and proposed together. */
export interface ControlSubItem {
	key: string;
	controlNumber: string;
	stage: DraftStage | 'general';
	fields: (EditableControlField | 'comments')[];
	reviewItem: ReviewItem;
}

/**
 * Splits one control's resolved change into up to three sub-items (general / Stage 1 / Stage 2),
 * each its own reviewable card. A control touched on only one "lane" (the common case — e.g. a
 * single-field edit) gets exactly one sub-item, keyed by the plain control number so its behavior
 * and the diff/outcome keying are unchanged from before this split existed.
 */
function splitIntoSubItems(change: ResolvedChange, plugin: AuditorPlugin): ControlSubItem[] {
	const lanes: (DraftStage | 'general')[] = ['general', 'stage1', 'stage2'];
	const groups = lanes
		.map((lane) => ({ lane, fields: change.changedFields.filter((f) => stageOf(f) === lane) }))
		.filter((g) => g.fields.length > 0);
	const multi = groups.length > 1;

	return groups.map(({ lane, fields }) => {
		const key = multi ? `${change.number}::${lane}` : change.number;
		const title = lane === 'general' ? change.number : `${change.number} · ${STAGE_LABEL[lane]}`;
		return {
			key,
			controlNumber: change.number,
			stage: lane,
			fields,
			reviewItem: {
				key,
				title,
				subtitle: change.after.topic || change.after.control.slice(0, 60),
				open: { label: 'Open note', run: () => { void plugin.app.workspace.getLeaf('tab').openFile(change.file); } },
				entries: fields.map((field) => (field === 'comments' ? commentsEntry(change) : fieldEntry(change, field))),
			},
		};
	});
}

/**
 * Rebuilds one `ResolvedChange` per control number from only the sub-items that were actually
 * accepted — so a control where Stage 1 was accepted and Stage 2 rejected gets exactly its Stage 1
 * fields written, never a wholesale overwrite with the rejected Stage 2 draft along for the ride.
 */
function buildAcceptedChanges(resolved: ResolvedChange[], subItems: ControlSubItem[], approvedKeys: string[]): ResolvedChange[] {
	const approved = new Set(approvedKeys);
	const out: ResolvedChange[] = [];
	for (const change of resolved) {
		const acceptedFields = new Set(
			subItems.filter((s) => s.controlNumber === change.number && approved.has(s.key)).flatMap((s) => s.fields),
		);
		if (acceptedFields.size === 0) continue;
		const after = { ...change.before, comments: [...change.before.comments] };
		for (const field of acceptedFields) {
			if (field === 'comments') after.comments = [...change.after.comments];
			else (after as unknown as Record<string, unknown>)[field] = (change.after as unknown as Record<string, unknown>)[field];
		}
		out.push({ ...change, after, changedFields: [...acceptedFields] });
	}
	return out;
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
									auditGuidance: { type: Type.STRING, description: 'House instructions for how this specific control should be assessed/written up — edit only if the user asks you to change the guidance itself, not as part of drafting a conclusion from it.' },
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

		const touchesStatus = resolved.some((c) => c.changedFields.some((f) => (STATUS_FIELDS as readonly string[]).includes(f)));
		if (touchesStatus && !ctx.hasCurrentEvidence()) {
			return {
				ok: false,
				output: {
					error: 'This proposal changes a conclusion or rating, but this run has not looked at any current evidence — call search_documents (or list_documents/read_document) against "evidence" and/or "interviewEvidence", or get_session_plan, first. Reference reports (search_reference_style) are wording examples only and do not satisfy this — they never establish current compliance or remediation status.',
				},
				summary: 'Blocked: no current evidence gathered for a conclusion/rating change',
			};
		}

		const missingQa: string[] = [];
		for (const c of resolved) {
			const stages = new Set(c.changedFields.map((f) => (f === 'comments' ? undefined : STAGE_FOR_FIELD[f])).filter((s): s is DraftStage => s !== undefined));
			for (const stage of stages) {
				if (!ctx.hasQaReview(c.number, stage)) missingQa.push(`${c.number} (${STAGE_LABEL[stage]})`);
			}
		}
		if (missingQa.length > 0) {
			return {
				ok: false,
				output: {
					error: `qa_review_conclusion has not passed this run for: ${missingQa.join(', ')}. Call it for each, with passesQa true and citationsVerified true, before proposing its conclusion/rating.`,
				},
				summary: `Blocked: QA not passed for ${missingQa.join(', ')}`,
			};
		}

		const subItems = resolved.flatMap((c) => splitIntoSubItems(c, ctx.plugin));
		const decision = await ctx.host.requestApproval({
			heading: `Review proposed changes (${subItems.length} item${subItems.length === 1 ? '' : 's'} across ${resolved.length} control${resolved.length === 1 ? '' : 's'})`,
			summary: str(args.summary),
			items: subItems.map((s) => s.reviewItem),
			burn: ctx.isBurnActive(),
		});

		const toApply = buildAcceptedChanges(resolved, subItems, decision.approved);
		const outcomes = toApply.length > 0 ? await ctx.controls.apply(toApply) : [];
		ctx.host.reportApplied(reKeyOutcomesBySubItem(outcomes, subItems, decision.approved));

		const saved = outcomes.filter((o) => o.ok).map((o) => o.key);
		const failed = outcomes.filter((o) => !o.ok);
		const rejectedItems = subItems.filter((s) => decision.rejected.includes(s.key));
		await recordDecisionMemory(ctx, subItems, resolved, decision, new Set(saved));
		return {
			output: {
				saved,
				rejectedByUser: rejectedItems.map((s) => ({ controlNumber: s.controlNumber, stage: s.stage, comment: decision.comments[s.key] ?? '' })),
				...(failed.length > 0 ? { failedToSave: failed } : {}),
				nextStep: saved.length === 0 || rejectedItems.length > 0 || failed.length > 0
					? 'Some items were not saved. For each entry in rejectedByUser, use its "comment" as the requestedChanges when re-drafting ONLY that control/stage with prepare_control_conclusion — do not touch or re-propose anything that already saved. Re-run QA only for what changed, then propose again. If nothing is listed in rejectedByUser either, the run was stopped before a decision — stop as well.'
					: 'All changes saved. Write a short final summary for the user.',
			},
			summary: `Saved ${saved.length}${rejectedItems.length > 0 ? `, rejected ${rejectedItems.length}` : ''}${failed.length > 0 ? `, failed ${failed.length}` : ''}`,
		};
	},
};

/**
 * Records each genuinely-decided sub-item into persistent memory (FR-6.3's "accepted user
 * decisions"/"accepted conclusions") — never the draft text itself, only the outcome: which
 * control/stage, what was decided, and (for a saved stage conclusion) the rating, so a future chat
 * session can see at a glance what was already settled without re-reading the full note. Items that
 * were approved but failed to actually save are skipped — nothing was accepted in the vault yet.
 */
async function recordDecisionMemory(
	ctx: Parameters<AgentTool['run']>[1],
	subItems: ControlSubItem[],
	resolved: ResolvedChange[],
	decision: { approved: string[]; rejected: string[]; comments: Record<string, string> },
	savedKeys: Set<string>,
): Promise<void> {
	const byNumber = new Map(resolved.map((c) => [c.number, c]));
	for (const s of subItems) {
		const wasApproved = decision.approved.includes(s.key);
		const wasRejected = decision.rejected.includes(s.key);
		if (!wasApproved && !wasRejected) continue;
		if (wasApproved && !savedKeys.has(s.key)) continue; // approved but failed to write — nothing was actually accepted

		const stageLabel = s.stage === 'general' ? 'general fields' : STAGE_LABEL[s.stage];
		const comment = decision.comments[s.key];
		await ctx.plugin.agentMemory.remember(
			'acceptedDecision',
			wasApproved
				? `${s.controlNumber} (${stageLabel}): user accepted.${comment ? ` Note: ${comment}` : ''}`
				: `${s.controlNumber} (${stageLabel}): user rejected. Reason: ${comment ?? '(no comment)'}`,
			s.controlNumber,
		);

		if (wasApproved && (s.stage === 'stage1' || s.stage === 'stage2')) {
			const ratingField = s.stage === 'stage1' ? 'todRating' : 'toeRating';
			const rating = byNumber.get(s.controlNumber)?.after[ratingField];
			if (typeof rating === 'string' && rating) {
				await ctx.plugin.agentMemory.remember(
					'acceptedConclusion',
					`${s.controlNumber} ${STAGE_LABEL[s.stage]}: rated ${rating} (user-approved conclusion saved to the control note).`,
					s.controlNumber,
				);
			}
		}
	}
}

/** Outcomes come back keyed by control number (one write per control); the UI needs them keyed by sub-item so each independently-reviewed card (general/Stage 1/Stage 2) shows its own Saved/Failed/Not applied status. A sub-item that was never approved simply gets no entry, same as before this split existed. */
function reKeyOutcomesBySubItem(outcomes: ApplyOutcome[], subItems: ControlSubItem[], approvedKeys: string[]): ApplyOutcome[] {
	const byNumber = new Map(outcomes.map((o) => [o.key, o]));
	const approved = new Set(approvedKeys);
	return subItems
		.filter((s) => approved.has(s.key))
		.map((s): ApplyOutcome | null => {
			const outcome = byNumber.get(s.controlNumber);
			return outcome ? { ...outcome, key: s.key } : null;
		})
		.filter((o): o is ApplyOutcome => o !== null);
}
