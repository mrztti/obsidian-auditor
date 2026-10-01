import { Type } from '@google/genai';
import type { PlanOp } from '../sessionPlanStore';
import { str, type AgentTool } from './types';

const OPS = ['add_group', 'rename_group', 'delete_group', 'add_goal', 'update_goal', 'delete_goal', 'move_goal', 'add_question', 'update_question', 'remove_question'];

export const proposeSessionPlanChangesTool: AgentTool = {
	declaration: {
		name: 'propose_session_plan_changes',
		description:
			'Edit a session\'s meeting plan (its groups, evidence goals and their questions). Nothing is written until the user approves the resulting diff in the chat. Read the plan with get_session_plan first — ids, positions and question numbers come from it. Send ALL edits for the session as one ordered list of small operations; they are applied in order. Prefer the fine-grained operations (update_question, add_question, …) over rewriting a whole goal, so the diff stays minimal. Positions and question indexes are 1-based. Empty groups are dropped on save. The result says whether the user applied the changes; if rejected with feedback, revise and propose again.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				session: { type: Type.STRING, description: 'Exact session name.' },
				summary: { type: Type.STRING, description: 'Two or three sentences for the user: what you changed and why.' },
				operations: {
					type: Type.ARRAY,
					description: 'Ordered edit operations.',
					items: {
						type: Type.OBJECT,
						properties: {
							op: {
								type: Type.STRING,
								enum: OPS,
								description: 'add_group{title,groupRef?}; rename_group{groupId,title}; delete_group{groupId} (its goals become ungrouped); add_goal{name,description?,type?,questions?,controlNumbers?,groupId|groupRef?,position?}; update_goal{goalId, any of name/description/type/questions(full replace)/controlNumbers(full replace)/groupId (empty string = ungroup)/groupRef}; delete_goal{goalId}; move_goal{goalId, position and/or groupId|groupRef}; add_question{goalId,question,questionIndex?}; update_question{goalId,questionIndex,question}; remove_question{goalId,questionIndex}.',
							},
							goalId: { type: Type.STRING },
							groupId: { type: Type.STRING, description: 'Existing group id. Empty string means no group.' },
							groupRef: { type: Type.STRING, description: 'A label you choose in add_group, reused by later operations to refer to that new group.' },
							title: { type: Type.STRING, description: 'Group title.' },
							name: { type: Type.STRING, description: 'Evidence goal name.' },
							description: { type: Type.STRING },
							type: { type: Type.STRING, enum: ['screenshot', 'file'] },
							controlNumbers: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Exact control numbers this goal is evidence for.' },
							questions: { type: Type.ARRAY, items: { type: Type.STRING } },
							question: { type: Type.STRING, description: 'Text of a single question.' },
							questionIndex: { type: Type.INTEGER, description: '1-based question number.' },
							position: { type: Type.INTEGER, description: '1-based position in the whole session order.' },
						},
						required: ['op'],
					},
				},
			},
			required: ['session', 'summary', 'operations'],
		},
	},
	label: (a) => `Preparing session plan changes: ${str(a.session)}`,
	run: async (args, ctx) => {
		const session = str(args.session).trim();
		const ops = Array.isArray(args.operations) ? (args.operations as PlanOp[]) : [];
		const resolved = await ctx.sessionPlans.resolve(session, ops);
		if ('error' in resolved) return { ok: false, output: { error: resolved.error }, summary: `Invalid plan edit: ${resolved.error}` };

		const decision = await ctx.host.requestApproval({
			heading: `Review session plan changes: ${session}`,
			summary: str(args.summary),
			items: [resolved.item],
			burn: ctx.isBurnActive(),
		});
		if (!decision.approved.includes(session)) {
			ctx.host.reportApplied([]);
			return {
				output: { saved: false, rejectedByUser: true, ...(decision.comments[session] ? { userFeedback: decision.comments[session] } : {}), nextStep: 'Nothing was saved. Address the feedback and propose again, or explain to the user.' },
				summary: 'Plan changes rejected',
			};
		}
		const outcome = await ctx.sessionPlans.apply(session, resolved.after);
		ctx.host.reportApplied([outcome.ok ? { key: session, ok: true } : { key: session, ok: false, error: outcome.error }]);
		return outcome.ok
			? { output: { saved: true, nextStep: 'Saved. Write a short final summary for the user.' }, summary: `Saved plan changes for "${session}"` }
			: { ok: false, output: { saved: false, error: outcome.error }, summary: `Could not save: ${outcome.error}` };
	},
};
