import { Type } from '@google/genai';
import { TFile } from 'obsidian';
import { str, truncate, type AgentTool } from './types';

export const listSessionsTool: AgentTool = {
	declaration: {
		name: 'list_sessions',
		description:
			'List the audit sessions (interview/meeting sessions) that controls are assigned to, with how many controls each has and whether a session plan (evidence goals to capture) exists for it. Use it to find which session a control belongs to or to answer "what is planned for …".',
		parameters: { type: Type.OBJECT, properties: {} },
	},
	label: () => 'Listing sessions',
	run: async (_args, ctx) => {
		const entries = await ctx.controls.listAll();
		const counts = new Map<string, number>();
		for (const e of entries) {
			const s = e.record.session.trim();
			if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
		}
		const sessions = [...counts.entries()]
			.sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
			.map(([session, controlCount]) => ({
				session,
				controlCount,
				hasPlan: ctx.plugin.app.vault.getAbstractFileByPath(ctx.plugin.sessionPlanPath(session)) instanceof TFile,
			}));
		return { output: { sessions }, summary: `${sessions.length} sessions` };
	},
};

export const getSessionPlanTool: AgentTool = {
	declaration: {
		name: 'get_session_plan',
		description:
			'Get a session\'s meeting plan: its ordered Evidence Goals (what to capture, questions to ask, which controls each backs, domain group) and — with includeResults — the notes captured during the session for each goal. Provide either the session name or a control number (its session is looked up).',
		parameters: {
			type: Type.OBJECT,
			properties: {
				session: { type: Type.STRING, description: 'Exact session name, as in list_sessions.' },
				controlNumber: { type: Type.STRING, description: 'Alternative to session: only the goals that back this control, from its session.' },
				includeResults: { type: Type.BOOLEAN, description: 'Include captured interview notes per goal (default true).' },
			},
		},
	},
	label: (a) => `Reading session plan: ${str(a.session) || str(a.controlNumber)}`,
	run: async (args, ctx) => {
		let session = str(args.session).trim();
		const controlNumber = str(args.controlNumber).trim();
		if (!session && controlNumber) {
			const { found } = await ctx.controls.load([controlNumber]);
			session = found[0]?.record.session.trim() ?? '';
			if (!found[0]) return { ok: false, output: { error: `Control "${controlNumber}" not found.` }, summary: `Control not found: ${controlNumber}` };
			if (!session) return { ok: false, output: { error: `Control "${controlNumber}" has no session assigned.` }, summary: 'Control has no session' };
		}
		if (!session) return { ok: false, output: { error: 'Provide session or controlNumber.' }, summary: 'No session given' };

		const plan = await ctx.sessionPlans.read(session);
		if (plan.evidenceGoals.length === 0) {
			return { output: { session, evidenceGoals: [], note: 'No session plan exists for this session yet.' }, summary: `No plan for "${session}"` };
		}
		const includeResults = args.includeResults !== false;
		const groupTitle = new Map(plan.groups.map((g) => [g.id, g.title]));
		const goals = [];
		for (const [index, eg] of plan.evidenceGoals.entries()) {
			if (controlNumber && !eg.controlNumbers.includes(controlNumber)) continue;
			const result = includeResults ? await ctx.plugin.loadEvidenceResult(eg.id) : null;
			goals.push({
				position: index + 1,
				id: eg.id,
				name: eg.name,
				groupId: eg.groupId,
				group: groupTitle.get(eg.groupId) ?? '',
				type: eg.type,
				controls: eg.controlNumbers,
				description: eg.description,
				questions: eg.questions,
				...(result ? { capturedNotes: truncate(result.notes, 2500) || '(none captured yet)', screenshots: result.screenshotPaths.length } : {}),
			});
		}
		const limited = goals.slice(0, 40);
		return {
			output: { session, groups: plan.groups, evidenceGoalCount: goals.length, evidenceGoals: limited, note: 'position and question order are 1-based; use goal ids and group ids from here when editing with propose_session_plan_changes.' },
			summary: `Plan "${session}": ${goals.length} evidence goals`,
		};
	},
};
