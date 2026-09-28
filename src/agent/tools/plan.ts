import { Type } from '@google/genai';
import type { PlanStep, PlanStepStatus } from '../types';
import { str, type AgentTool } from './types';

const STATUSES: PlanStepStatus[] = ['pending', 'in_progress', 'done', 'skipped', 'failed'];

/** Keys models sometimes use instead of "title" — accepted so a slightly off plan still renders instead of showing blank steps. */
const TITLE_KEYS = ['title', 'name', 'step', 'description', 'text', 'task', 'action'];

function stepTitle(raw: unknown): string {
	if (typeof raw === 'string') return raw.trim();
	if (raw && typeof raw === 'object') {
		for (const key of TITLE_KEYS) {
			const v = (raw as Record<string, unknown>)[key];
			if (typeof v === 'string' && v.trim()) return v.trim();
		}
	}
	return '';
}

export const updatePlanTool: AgentTool = {
	declaration: {
		name: 'update_plan',
		description:
			'Create or revise your working plan. The user sees this plan live in the chat, so call it FIRST (before any other tool) with the full step list, and call it again every time a step starts, finishes, or the plan changes. Always send the complete list of steps, not a diff.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				objective: { type: Type.STRING, description: 'One sentence: what the user wants achieved.' },
				steps: {
					type: Type.ARRAY,
					description: 'Ordered steps. Keep ids stable between calls.',
					items: {
						type: Type.OBJECT,
						properties: {
							id: { type: Type.STRING, description: 'Short stable id, e.g. "s1".' },
							title: { type: Type.STRING, description: 'Imperative, under ~12 words.' },
							status: { type: Type.STRING, enum: STATUSES, description: 'At most one step should be in_progress. Use failed for a step that could not be completed.' },
						},
						required: ['id', 'title', 'status'],
					},
				},
			},
			required: ['objective', 'steps'],
		},
	},
	label: () => 'Updating plan',
	run: async (args, ctx) => {
		const rawSteps: unknown[] = Array.isArray(args.steps) ? args.steps : [];
		const steps: PlanStep[] = [];
		for (const [i, raw] of rawSteps.entries()) {
			const title = stepTitle(raw);
			if (!title) continue;
			const rawStatus = raw && typeof raw === 'object' ? str((raw as Record<string, unknown>).status) : '';
			const id = raw && typeof raw === 'object' ? str((raw as Record<string, unknown>).id) : '';
			steps.push({ id: id || `s${i + 1}`, title, status: STATUSES.includes(rawStatus as PlanStepStatus) ? (rawStatus as PlanStepStatus) : 'pending' });
		}
		if (steps.length === 0) {
			return { ok: false, output: { error: 'Every step needs a non-empty "title" (imperative, under ~12 words). Send the plan again as steps: [{id, title, status}, ...].' }, summary: 'Plan rejected: steps had no titles' };
		}
		ctx.setPlan({ objective: str(args.objective), steps });
		const done = steps.filter((s) => s.status !== 'pending' && s.status !== 'in_progress').length;
		return { output: { status: 'plan updated' }, summary: `Plan: ${done}/${steps.length} steps complete` };
	},
};

export const askUserTool: AgentTool = {
	declaration: {
		name: 'ask_user',
		description:
			'Stop and ask the user a clarifying question — use when the request is ambiguous (e.g. several controls plausibly match and you cannot tell which one they mean) or you need a decision only they can make. Ends your turn; their answer arrives as the next message. Do not use it for questions you could answer by searching.',
		parameters: {
			type: Type.OBJECT,
			properties: { question: { type: Type.STRING, description: 'The question, with concrete options where possible.' } },
			required: ['question'],
		},
	},
	label: () => 'Asking you a question',
	run: (args) => Promise.resolve({ terminal: true, output: { question: str(args.question) }, summary: 'Waiting for your answer' }),
};
