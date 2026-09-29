import type { TFile } from 'obsidian';
import type { ControlRecord } from '../controlNote';

export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed';

export interface PlanStep {
	id: string;
	title: string;
	status: PlanStepStatus;
}

/** The agent's working plan — rewritten by the model via `update_plan` and mirrored live in the chat UI. */
export interface AgentPlan {
	objective: string;
	steps: PlanStep[];
}

/** Fields the agent may change on a control. `number` is deliberately absent: it is the note's filename. */
export const EDITABLE_CONTROL_FIELDS = [
	'standard', 'topic', 'control', 'session', 'assignedMember', 'status',
	'todConclusion', 'todRating', 'todReady',
	'toeConclusion', 'toeRating', 'toeReady',
] as const;

export type EditableControlField = typeof EDITABLE_CONTROL_FIELDS[number];

export type DraftStage = 'stage1' | 'stage2';

/** Which drafting stage a status-asserting field belongs to — used to require a matching `qa_review_conclusion` call before that stage's conclusion/rating can be proposed. */
export const STAGE_FOR_FIELD: Partial<Record<EditableControlField, DraftStage>> = {
	todConclusion: 'stage1',
	todRating: 'stage1',
	toeConclusion: 'stage2',
	toeRating: 'stage2',
};

export const FIELD_LABELS: Record<EditableControlField | 'comments', string> = {
	standard: 'Standard',
	topic: 'Topic',
	control: 'Control',
	session: 'Session',
	assignedMember: 'Assigned member',
	status: 'Status',
	todConclusion: 'Stage 1 conclusion',
	todRating: 'ToD rating',
	todReady: 'Stage 1 ready',
	toeConclusion: 'Stage 2 conclusion',
	toeRating: 'ToE rating',
	toeReady: 'Stage 2 ready',
	comments: 'Comments',
};

/** What the model asks for: a partial update to one control, plus comments to append. */
export interface ControlChange {
	number: string;
	fields: Partial<Pick<ControlRecord, EditableControlField>>;
	addComments: string[];
}

/** A `ControlChange` resolved against the control as it currently is on disk — what the user reviews. */
export interface ResolvedChange {
	number: string;
	file: TFile;
	before: ControlRecord;
	after: ControlRecord;
	/** Raw note content when the agent read it — used to refuse the write if the note changed since. */
	baseContent: string;
	changedFields: (EditableControlField | 'comments')[];
}

/** How a `DiffEntry`'s "after" value can be hand-edited before approving — its own get/set instead of a plain value, so an edit writes straight into the underlying record the same `resolve()`/`apply()` path will save. */
export type DiffEntryEdit =
	| { kind: 'text'; get: () => string; set: (v: string) => void }
	| { kind: 'select'; options: string[]; get: () => string; set: (v: string) => void }
	| { kind: 'boolean'; get: () => boolean; set: (v: boolean) => void };

/** One labelled before/after pair shown as a diff — the unit both control edits and session-plan edits are reviewed in. */
export interface DiffEntry {
	label: string;
	before: string;
	after: string;
	/** Present when the user can hand-edit this entry's value before approving — controls' fields, not session-plan diffs (those are multi-operation summaries with no single settable value). */
	edit?: DiffEntryEdit;
}

/** One thing the user can approve or reject independently (a control, or a whole session plan). */
export interface ReviewItem {
	key: string;
	title: string;
	subtitle: string;
	entries: DiffEntry[];
	/** Link shown next to the title that takes the user to the thing being changed (a control note, or the session plan view). */
	open?: { label: string; run: () => void };
}

export interface ReviewProposal {
	heading: string;
	summary: string;
	items: ReviewItem[];
}

export interface ApprovalDecision {
	approved: string[];
	rejected: string[];
	/** Free-text guidance the user typed when rejecting, passed back to the agent. */
	feedback: string;
}

export interface ApplyOutcome {
	key: string;
	ok: boolean;
	error?: string;
}

export type AgentEvent =
	| { type: 'plan'; plan: AgentPlan }
	| { type: 'note'; text: string }
	| { type: 'tool_start'; id: number; name: string; label: string }
	| { type: 'tool_end'; id: number; ok: boolean; summary: string }
	| { type: 'final'; text: string; askedUser: boolean }
	| { type: 'error'; message: string };

export interface AgentHost {
	emit(event: AgentEvent): void;
	/** Shows the proposed diffs and resolves once the user has approved/rejected each one. */
	requestApproval(proposal: ReviewProposal): Promise<ApprovalDecision>;
	/** Called after approved changes were written, so the UI can mark the proposal as applied. */
	reportApplied(outcomes: ApplyOutcome[]): void;
}
