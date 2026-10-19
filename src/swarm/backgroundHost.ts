import type { AgentEvent, AgentHost, ApplyOutcome, ApprovalDecision, ErrorRecoverySnapshot, ExecutionDecision, ExecutionSnapshot, ReviewProposal } from '../agent/types';
import type { AgentBus } from './bus';
import type { OutboxStore } from './outboxStore';

/**
 * The `AgentHost` a background swarm agent runs with — nobody is watching a chat transcript live,
 * so routine checkpoints and error-recovery pauses auto-continue (the bounded retry/backoff inside
 * `RoleAgent` itself already handles transient failures; this just means a background run doesn't
 * stall waiting for a click that will never come). The one pause that must NOT be skipped is
 * `requestApproval` — nothing a background writer drafts is ever written to a control note without
 * a human decision, so this stages the proposal into the shared `OutboxStore` and returns the same
 * kind of pending promise the interactive chat's `RunView.showProposal` does, just resolved from the
 * outbox view instead of a chat card.
 */
export function createBackgroundHost(agentId: string, bus: AgentBus, outbox: OutboxStore): AgentHost {
	/** Set by `requestApproval`, read by the `reportApplied` that always follows it within the same `propose_control_changes` call — see `agent/tools/controls.ts`. */
	let lastEntryId: string | null = null;
	return {
		emit: (event: AgentEvent) => {
			bus.event(agentId, '*', { kind: 'agentEvent', event });
		},
		requestApproval: (proposal: ReviewProposal): Promise<ApprovalDecision> => {
			bus.event(agentId, '*', { kind: 'proposalStaged', itemCount: proposal.items.length });
			const { id, decision } = outbox.add(agentId, proposal);
			lastEntryId = id;
			return decision;
		},
		reportApplied: (outcomes: ApplyOutcome[]) => {
			if (lastEntryId) outbox.reportOutcomes(lastEntryId, outcomes);
			bus.event(agentId, '*', { kind: 'proposalApplied', outcomes });
		},
		requestCheckpoint: (_info: ExecutionSnapshot): Promise<ExecutionDecision> => Promise.resolve('continue'),
		requestErrorRecovery: (_info: ErrorRecoverySnapshot): Promise<ExecutionDecision> => Promise.resolve('continue'),
	};
}
