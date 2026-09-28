import type AuditorPlugin from '../main';
import type { ControlStore } from './controlStore';
import {
	generateEvidenceGoalGroupId,
	generateEvidenceGoalId,
	type EvidenceGoal,
	type EvidenceGoalType,
	type InterviewSessionPlan,
} from '../evidenceGoal';
import type { DiffEntry, ReviewItem } from './types';

export type PlanOp = Record<string, unknown>;

const GOAL_TYPES: EvidenceGoalType[] = ['screenshot', 'file'];

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null);

/** The exact state used to detect that a plan changed between the agent reading it and the user approving edits. */
const fingerprint = (plan: InterviewSessionPlan): string => JSON.stringify({ g: plan.groups, e: plan.evidenceGoals });

/** Reads, edits (in memory), diffs and writes interview session plans on behalf of the agent. */
export class SessionPlanStore {
	private snapshots = new Map<string, InterviewSessionPlan>();

	constructor(private plugin: AuditorPlugin, private controls: ControlStore) {}

	resetSnapshots(): void {
		this.snapshots.clear();
	}

	/** Loads a plan and remembers it, so later edits are validated against — and checked for staleness against — what the agent saw. */
	async read(session: string): Promise<InterviewSessionPlan> {
		const plan = await this.plugin.loadSessionPlan(session);
		this.snapshots.set(session, structuredClone(plan));
		return plan;
	}

	hasSnapshot(session: string): boolean {
		return this.snapshots.has(session);
	}

	/**
	 * Applies `ops` in order to a copy of the plan the agent read. Positions and question indexes
	 * are 1-based, as shown by get_session_plan. Returns the edited plan plus a reviewable diff, or
	 * an error naming the failing operation so the model can correct it.
	 */
	async resolve(session: string, ops: PlanOp[]): Promise<{ error: string } | { after: InterviewSessionPlan; item: ReviewItem }> {
		const before = this.snapshots.get(session);
		if (!before) return { error: `Session plan "${session}" has not been read in this run — call get_session_plan first.` };
		if (ops.length === 0) return { error: 'operations must be a non-empty array.' };

		const validControls = new Set((await this.controls.listAll()).map((e) => e.record.number));
		const plan = structuredClone(before);
		const groupRefs = new Map<string, string>();

		const resolveGroupId = (op: PlanOp): string | { error: string } | undefined => {
			const ref = str(op.groupRef);
			if (ref) {
				const id = groupRefs.get(ref);
				return id ?? { error: `groupRef "${ref}" was not created by an earlier add_group operation.` };
			}
			if (op.groupId === undefined) return undefined;
			const id = str(op.groupId);
			if (id && !plan.groups.some((g) => g.id === id)) return { error: `Unknown groupId "${id}". Existing groups: ${plan.groups.map((g) => `${g.id} (${g.title})`).join(', ') || 'none'}.` };
			return id;
		};
		const findGoal = (op: PlanOp): EvidenceGoal | { error: string } => {
			const id = str(op.goalId);
			return plan.evidenceGoals.find((g) => g.id === id) ?? { error: `Unknown goalId "${id}".` };
		};
		const checkControls = (nums: string[]): string | null => {
			const bad = nums.filter((n) => !validControls.has(n));
			return bad.length > 0 ? `Unknown control number(s): ${bad.join(', ')}.` : null;
		};
		const insertAt = (goal: EvidenceGoal, position: number | null): void => {
			const idx = position === null ? plan.evidenceGoals.length : Math.min(Math.max(position - 1, 0), plan.evidenceGoals.length);
			plan.evidenceGoals.splice(idx, 0, goal);
		};

		for (const [i, op] of ops.entries()) {
			const fail = (msg: string) => ({ error: `Operation ${i + 1} (${str(op.op) || 'missing op'}): ${msg}` });
			switch (str(op.op)) {
				case 'add_group': {
					const title = str(op.title).trim();
					if (!title) return fail('title is required.');
					const id = generateEvidenceGoalGroupId();
					plan.groups.push({ id, title });
					const ref = str(op.groupRef);
					if (ref) groupRefs.set(ref, id);
					break;
				}
				case 'rename_group': {
					const group = plan.groups.find((g) => g.id === str(op.groupId));
					if (!group) return fail(`unknown groupId "${str(op.groupId)}".`);
					const title = str(op.title).trim();
					if (!title) return fail('title is required.');
					group.title = title;
					break;
				}
				case 'delete_group': {
					const id = str(op.groupId);
					if (!plan.groups.some((g) => g.id === id)) return fail(`unknown groupId "${id}".`);
					plan.groups = plan.groups.filter((g) => g.id !== id);
					for (const g of plan.evidenceGoals) if (g.groupId === id) g.groupId = '';
					break;
				}
				case 'add_goal': {
					const name = str(op.name).trim();
					if (!name) return fail('name is required.');
					const groupId = resolveGroupId(op);
					if (typeof groupId === 'object') return fail(groupId.error);
					const controls = strList(op.controlNumbers) ?? [];
					const badControls = checkControls(controls);
					if (badControls) return fail(badControls);
					const type = str(op.type) as EvidenceGoalType;
					insertAt({
						id: generateEvidenceGoalId(),
						session,
						name,
						description: str(op.description).trim(),
						questions: strList(op.questions) ?? [],
						type: GOAL_TYPES.includes(type) ? type : 'screenshot',
						controlNumbers: controls,
						groupId: groupId ?? '',
					}, int(op.position));
					break;
				}
				case 'update_goal': {
					const goal = findGoal(op);
					if ('error' in goal) return fail(goal.error);
					if (op.name !== undefined) {
						if (!str(op.name).trim()) return fail('name cannot be empty.');
						goal.name = str(op.name).trim();
					}
					if (op.description !== undefined) goal.description = str(op.description).trim();
					if (op.type !== undefined) {
						if (!GOAL_TYPES.includes(str(op.type) as EvidenceGoalType)) return fail(`type must be one of ${GOAL_TYPES.join(', ')}.`);
						goal.type = str(op.type) as EvidenceGoalType;
					}
					const controls = strList(op.controlNumbers);
					if (controls) {
						const badControls = checkControls(controls);
						if (badControls) return fail(badControls);
						goal.controlNumbers = controls;
					}
					const questions = strList(op.questions);
					if (questions) goal.questions = questions;
					const groupId = resolveGroupId(op);
					if (typeof groupId === 'object') return fail(groupId.error);
					if (groupId !== undefined) goal.groupId = groupId;
					break;
				}
				case 'delete_goal': {
					const goal = findGoal(op);
					if ('error' in goal) return fail(goal.error);
					plan.evidenceGoals = plan.evidenceGoals.filter((g) => g !== goal);
					break;
				}
				case 'move_goal': {
					const goal = findGoal(op);
					if ('error' in goal) return fail(goal.error);
					const groupId = resolveGroupId(op);
					if (typeof groupId === 'object') return fail(groupId.error);
					const position = int(op.position);
					if (position === null && groupId === undefined) return fail('give a position and/or a groupId.');
					if (groupId !== undefined) goal.groupId = groupId;
					if (position !== null) {
						plan.evidenceGoals = plan.evidenceGoals.filter((g) => g !== goal);
						insertAt(goal, position);
					}
					break;
				}
				case 'add_question':
				case 'update_question':
				case 'remove_question': {
					const goal = findGoal(op);
					if ('error' in goal) return fail(goal.error);
					const kind = str(op.op);
					const text = str(op.question).trim();
					const index = int(op.questionIndex);
					if (kind === 'add_question') {
						if (!text) return fail('question text is required.');
						const at = index === null ? goal.questions.length : Math.min(Math.max(index - 1, 0), goal.questions.length);
						goal.questions.splice(at, 0, text);
					} else {
						if (index === null || index < 1 || index > goal.questions.length) return fail(`questionIndex must be between 1 and ${goal.questions.length} (1-based).`);
						if (kind === 'update_question') {
							if (!text) return fail('question text is required.');
							goal.questions[index - 1] = text;
						} else {
							goal.questions.splice(index - 1, 1);
						}
					}
					break;
				}
				default:
					return fail('unknown op. Use add_group, rename_group, delete_group, add_goal, update_goal, delete_goal, move_goal, add_question, update_question or remove_question.');
			}
		}

		// Mirror saveSessionPlan: a group with no goals left in it is dropped on save.
		const used = new Set(plan.evidenceGoals.map((g) => g.groupId).filter(Boolean));
		plan.groups = plan.groups.filter((g) => used.has(g.id));

		const entries = this.diff(before, plan);
		if (entries.length === 0) return { error: 'The operations result in no change to the plan.' };
		return { after: plan, item: { key: session, title: `Session plan: ${session}`, subtitle: `${entries.length} change${entries.length === 1 ? '' : 's'}`, entries, open: { label: 'Open plan', run: () => { void this.plugin.openSessionPlan(session); } } } };
	}

	private diff(before: InterviewSessionPlan, after: InterviewSessionPlan): DiffEntry[] {
		const entries: DiffEntry[] = [];
		const groupTitle = (plan: InterviewSessionPlan, id: string): string => plan.groups.find((g) => g.id === id)?.title ?? '';
		const describe = (plan: InterviewSessionPlan, g: EvidenceGoal): string => [
			`Type: ${g.type}`,
			`Group: ${groupTitle(plan, g.groupId) || '(ungrouped)'}`,
			`Controls: ${g.controlNumbers.join(', ') || '(none)'}`,
			`Description: ${g.description || '(none)'}`,
			...g.questions.map((q, i) => `Question ${i + 1}: ${q}`),
		].join('\n');

		for (const group of after.groups) {
			const old = before.groups.find((g) => g.id === group.id);
			if (!old) entries.push({ label: 'New group', before: '', after: group.title });
			else if (old.title !== group.title) entries.push({ label: 'Group renamed', before: old.title, after: group.title });
		}
		for (const old of before.groups) {
			if (!after.groups.some((g) => g.id === old.id)) entries.push({ label: 'Group removed', before: old.title, after: '' });
		}

		const beforeById = new Map(before.evidenceGoals.map((g) => [g.id, g]));
		const afterById = new Map(after.evidenceGoals.map((g) => [g.id, g]));
		for (const goal of after.evidenceGoals) {
			const old = beforeById.get(goal.id);
			if (!old) { entries.push({ label: `New evidence goal: ${goal.name}`, before: '', after: `${describe(after, goal)}` }); continue; }
			const label = `"${goal.name}"`;
			if (old.name !== goal.name) entries.push({ label: `${label} — name`, before: old.name, after: goal.name });
			if (old.type !== goal.type) entries.push({ label: `${label} — type`, before: old.type, after: goal.type });
			if (old.description !== goal.description) entries.push({ label: `${label} — description`, before: old.description, after: goal.description });
			if (old.controlNumbers.join(', ') !== goal.controlNumbers.join(', ')) entries.push({ label: `${label} — controls`, before: old.controlNumbers.join(', '), after: goal.controlNumbers.join(', ') });
			const oldGroup = groupTitle(before, old.groupId);
			const newGroup = groupTitle(after, goal.groupId);
			if (oldGroup !== newGroup) entries.push({ label: `${label} — group`, before: oldGroup || '(ungrouped)', after: newGroup || '(ungrouped)' });
			const count = Math.max(old.questions.length, goal.questions.length);
			for (let q = 0; q < count; q++) {
				const a = old.questions[q] ?? '';
				const b = goal.questions[q] ?? '';
				if (a !== b) entries.push({ label: `${label} — question ${q + 1}`, before: a, after: b });
			}
		}
		for (const old of before.evidenceGoals) {
			if (!afterById.has(old.id)) entries.push({ label: `Evidence goal removed: ${old.name}`, before: describe(before, old), after: '' });
		}

		// Relative order of goals present on both sides (so an insertion elsewhere is not reported as everything else moving).
		const common = (plan: InterviewSessionPlan, other: Map<string, EvidenceGoal>) => plan.evidenceGoals.filter((g) => other.has(g.id));
		const orderBefore = common(before, afterById).map((g) => g.id);
		const orderAfter = common(after, beforeById).map((g) => g.id);
		orderAfter.forEach((id, i) => {
			if (orderBefore[i] !== id) {
				const goal = afterById.get(id)!;
				entries.push({ label: `"${goal.name}" — position`, before: String(orderBefore.indexOf(id) + 1), after: String(i + 1) });
			}
		});
		return entries;
	}

	/** Writes the edited plan, refusing if the saved plan is no longer what the agent read. */
	async apply(session: string, after: InterviewSessionPlan): Promise<{ ok: true } | { ok: false; error: string }> {
		const base = this.snapshots.get(session);
		if (!base) return { ok: false, error: 'Plan was never read.' };
		try {
			const current = await this.plugin.loadSessionPlan(session);
			if (fingerprint(current) !== fingerprint(base)) {
				return { ok: false, error: 'The session plan was edited after the agent read it — nothing was written. Ask the agent to try again.' };
			}
			await this.plugin.saveSessionPlan(after);
			const previous = new Map(base.evidenceGoals.map((g) => [g.id, JSON.stringify(g)]));
			for (const eg of after.evidenceGoals) {
				if (previous.get(eg.id) !== JSON.stringify(eg)) void this.plugin.evidenceGoalIndex.upsert(eg);
			}
			this.snapshots.set(session, structuredClone(after));
			this.plugin.refreshSessionPlanViews(session);
			return { ok: true };
		} catch (e) {
			return { ok: false, error: String(e) };
		}
	}
}
