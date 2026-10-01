import type { TFile } from 'obsidian';
import type { ControlRecord } from '../controlNote';
import type { StepUsage, UsageTotals } from './usage';

export type PlanStepStatus = 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed';

export interface PlanStep {
	id: string;
	title: string;
	status: PlanStepStatus;
	/** "Burn Mode": the agent's own judgment that this step is quality-sensitive enough (QA, planning, drafting a conclusion) to warrant the boosted model — used only while the current step is `in_progress`, only when the user has switched Burn Mode on in the chat, and only when a boosted model is actually configured. */
	burn?: boolean;
	/** Every model call attributed to this step (one per completed call, retries included as separate entries) — see `StepUsage`. Absent until the first call lands while this step is current. */
	usage?: StepUsage[];
}

/** The agent's working plan — rewritten by the model via `update_plan` and mirrored live in the chat UI. */
export interface AgentPlan {
	objective: string;
	steps: PlanStep[];
}

/** Fields the agent may change on a control. `number` is deliberately absent: it is the note's filename. */
export const EDITABLE_CONTROL_FIELDS = [
	'standard', 'topic', 'control', 'auditGuidance', 'session', 'assignedMember', 'status',
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
	auditGuidance: 'Audit guidance',
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
	/** Whether Burn Mode (the boosted model) was active when this proposal was generated — shown as a gradient frame around the review card. */
	burn?: boolean;
}

export interface ApprovalDecision {
	approved: string[];
	rejected: string[];
	/**
	 * Per-item (`ReviewItem.key`) comment — required by the review UI for every rejected item (so a
	 * refinement pass always has something concrete to act on), optional for an accepted one. A key
	 * with no comment is simply absent, not an empty string.
	 */
	comments: Record<string, string>;
}

export interface ApplyOutcome {
	key: string;
	ok: boolean;
	error?: string;
}

/**
 * A snapshot of where a run currently stands — shown whenever execution pauses for the user,
 * whether that's a routine checkpoint (FR-4.1) or recovering from a provider error (FR-4.2).
 * Nothing it describes is reconstructed after the fact: it is read directly off the plan and the
 * usage totals already being tracked live, so what's shown is exactly the state execution resumes
 * from — no step here is re-run, no evidence/draft/QA result is regenerated, by continuing.
 */
export interface ExecutionSnapshot {
	completed: number;
	pending: number;
	failed: number;
	skipped: number;
	runTotals: UsageTotals;
	sessionTotals: UsageTotals;
}

/** `ExecutionSnapshot` plus which automatic-retry attempt this is — see `AgentHost.requestErrorRecovery`. */
export interface ErrorRecoverySnapshot extends ExecutionSnapshot {
	attempt: number;
}

export type ExecutionDecision = 'continue' | 'stop';

export type ContextStatus = 'normal' | 'approaching' | 'compaction_required';

/**
 * Where the active context stands against the configured base-model budget (FR-6.2). `currentTokens`
 * is the real `promptTokenCount` Gemini reported for the most recent call when available (the
 * authoritative number), or a character-based estimate right after a compaction pass, before the
 * next real call confirms it.
 */
export interface ContextUsageSnapshot {
	currentTokens: number;
	/** Whether `currentTokens` is the real figure from the provider or a character-based estimate (only true briefly, right after a compaction, until the next model call confirms the real count). */
	estimated: boolean;
	maxTokens: number;
	/** `maxTokens` minus the reserved output and system/tool budgets — what `currentTokens` is actually measured against. */
	usableInputBudget: number;
	reservedTokens: number;
	percentUsed: number;
	status: ContextStatus;
	lastCompactionAt: string | null;
	lastCompactionStep: number | null;
}

export type ContextScope = 'run' | 'session';

export type AgentContextEvent =
	| { type: 'context'; scope: ContextScope; usage: ContextUsageSnapshot }
	/** Fired once per compaction pass, in addition to the plain `context` update — the before/after token estimate the UI shows as a passive note (FR-6.4's "users can see compaction occurred without being interrupted"). */
	| { type: 'compaction'; beforeTokens: number; afterTokens: number; duplicatesRemoved: number; elided: number };

export type AgentEvent =
	| { type: 'plan'; plan: AgentPlan }
	| { type: 'note'; text: string }
	| { type: 'tool_start'; id: number; name: string; label: string; burn: boolean }
	| { type: 'tool_end'; id: number; ok: boolean; summary: string }
	/** Emitted right after each completed model call, with that call's own usage plus running totals for the current run and the whole chat session — see `usage.ts`. */
	| { type: 'usage'; stepId: string; usage: StepUsage; runTotals: UsageTotals; sessionTotals: UsageTotals }
	| AgentContextEvent
	| { type: 'final'; text: string; askedUser: boolean; burn: boolean }
	| { type: 'error'; message: string };

export interface AgentHost {
	emit(event: AgentEvent): void;
	/** Shows the proposed diffs and resolves once the user has approved/rejected each one. */
	requestApproval(proposal: ReviewProposal): Promise<ApprovalDecision>;
	/** Called after approved changes were written, so the UI can mark the proposal as applied. */
	reportApplied(outcomes: ApplyOutcome[]): void;
	/**
	 * Routine execution checkpoint (FR-4.1): fired every `CHECKPOINT_INTERVAL` completed steps
	 * instead of the run simply being cut off. The run is genuinely paused here — history, plan,
	 * QA/evidence state and usage totals are all untouched and still in scope — resolving
	 * `'continue'` picks the very next pending step back up; `'stop'` ends the run cleanly (not as
	 * an error) with everything reached so far left exactly as it is.
	 */
	requestCheckpoint(info: ExecutionSnapshot): Promise<ExecutionDecision>;
	/**
	 * Fired when a model call fails with a retryable provider-capacity error (FR-4.2) after its
	 * bounded automatic backoff has already been exhausted. Shown only in plain terms (the model is
	 * temporarily unavailable) — never the raw provider error. `'continue'` retries only the one
	 * failed call; everything completed earlier (evidence, drafts, QA results, usage totals) is
	 * untouched. `'stop'` ends the run cleanly.
	 */
	requestErrorRecovery(info: ErrorRecoverySnapshot): Promise<ExecutionDecision>;
}
