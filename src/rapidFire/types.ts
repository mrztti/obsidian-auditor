import type { DraftStage } from '../agent/types';
import type { StepUsage, UsageTotals } from '../agent/usage';

/** FR-8.2's control-state machine — one state per (control, stage) pair, not per control, since Stage 1 and Stage 2 progress independently (FR-8.2: "keep Stage 1 and Stage 2 statuses separate"). */
export type RapidFireState =
	| 'queued'
	| 'classifying'
	| 'researching'
	| 'ready_to_draft'
	| 'drafting'
	| 'ready_for_qa'
	| 'qa_failed'
	| 'ready_for_review'
	| 'changes_requested'
	| 'accepted'
	| 'blocked';

export const RAPID_FIRE_STATE_LABELS: Record<RapidFireState, string> = {
	queued: 'Queued',
	classifying: 'Classifying',
	researching: 'Researching',
	ready_to_draft: 'Ready to draft',
	drafting: 'Drafting',
	ready_for_qa: 'Ready for QA',
	qa_failed: 'QA failed',
	ready_for_review: 'Ready for review',
	changes_requested: 'Changes requested',
	accepted: 'Accepted',
	blocked: 'Blocked',
};

/** One (control, stage) unit of work moving through the pipeline — see `RapidFireState`. */
export interface RapidFireItem {
	controlNumber: string;
	stage: DraftStage;
	state: RapidFireState;
	/** The topic-batch this item belongs to (Phase 1) — empty until classified. */
	batchId: string;
	draftConclusion?: string;
	draftRating?: string;
	assumptions?: string[];
	unresolvedIssues?: string[];
	/** Set once QA has run — the corrected text/rating to actually use, independent of whether it passed. */
	qaResult?: { pass: boolean; correctedConclusionText: string; correctedRating: string; findings: string[] };
	/** The user's review decision, once the item reaches the review queue. */
	decision?: 'accepted' | 'rejected';
	comment?: string;
	blockedReason?: string;
	/** Whether this item was escalated to the boosted model (predetermined complexity/failure criteria — see the engine). */
	escalated: boolean;
	/** Source document paths actually mapped to this item's evidence facts at draft time — carried into Phase 4 QA so its reference-correctness check has something real to validate against. */
	evidenceReferences?: string[];
}

/** Phase 1 output — see FR-8.3. */
export interface SimilarityBatch {
	batchId: string;
	topicLabel: string;
	controlNumbers: string[];
	sharedTerms: string[];
	/** Why each control landed in this batch — one entry per control, for the "keep an explanation" guardrail. */
	reasons: Record<string, string>;
	estimatedContextTokens: number;
}

/** One fact extracted during Phase 2, mapped to the specific controls/stages it actually supports — FR-8.4's "shared evidence may be reused only when explicitly mapped", never by topic similarity alone. */
export interface EvidenceFact {
	id: string;
	text: string;
	sourcePath: string;
	location: string;
	controlNumbers: string[];
	stages: DraftStage[];
}

export interface EvidenceDocumentRef {
	path: string;
	label: string;
}

/** Phase 2 output, one per `SimilarityBatch` — see FR-8.4. */
export interface ThemeEvidenceMap {
	themeId: string;
	themeLabel: string;
	facts: EvidenceFact[];
	documents: EvidenceDocumentRef[];
	/** controlNumber -> fact ids applicable to it. */
	controlMappings: Record<string, string[]>;
	unresolvedQuestions: string[];
	contextTokenCount: number;
}

export type RapidFireBatchStatus = 'queued' | 'running' | 'paused' | 'cancelled' | 'completed';

/** Why a running batch is currently paused — surfaced in the UI with a Continue/Stop-style control, same spirit as the chat agent's checkpoint/error-recovery pauses (FR-4.1/4.2), never a silent stop. */
export type RapidFirePauseReason = 'user' | 'max_batch_cost' | 'max_boosted_escalation' | 'error' | 'no_writing_style_profile';

export interface RapidFireCostEstimate {
	retrievalTokens: number;
	draftingTokens: number;
	qaTokens: number;
	totalProjectedUsd: number;
}

/**
 * One export-to-Rapid-Fire run — a frozen snapshot (FR-8.1: "later filter changes do not silently
 * alter the running batch") of the controls/stages selected at export time, moving through the
 * five-phase pipeline (FR-8.3–8.7) with its own cost tracking (FR-8.8).
 */
export interface RapidFireBatch {
	id: string;
	createdAt: string;
	/** Human-readable summary of the filters active at export time (FR-8.1) — display only, not re-evaluated. */
	filtersSummary: string;
	status: RapidFireBatchStatus;
	pauseReason: RapidFirePauseReason | null;
	items: RapidFireItem[];
	similarityBatches: SimilarityBatch[];
	evidenceMaps: ThemeEvidenceMap[];
	estimate: RapidFireCostEstimate | null;
	usage: StepUsage[];
	boostedUsageUsd: number;
}

export function emptyUsageTotals(): UsageTotals {
	return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalCost: 0 };
}
