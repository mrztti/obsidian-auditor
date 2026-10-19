import type { AgentTool } from '../agent/tools/types';
import { findControlsTool, getControlsTool } from '../agent/tools/controls';
import { prepareControlConclusionTool } from '../agent/tools/conclusion';
import { recallMemoryTool, rememberFactTool } from '../agent/tools/memory';
import { updatePlanTool } from '../agent/tools/plan';
import { requestEvidenceTool, requestSimilarControlsTool, requestStandardsTool, requestVerificationTool, submitToCoordinatorTool } from './tools';

/**
 * A writer's tool subset: today's drafting tools, minus direct document search (routed through the
 * reader agents via `request_evidence`/`request_standards`/`request_similar_controls`), minus
 * self-QA (routed to the verifier via `request_verification`, a correction pass, not a gate), and
 * minus proposing changes directly — a writer's finished work goes to `submit_to_coordinator`, which
 * has the final say — see `prompts.ts` for the matching system prompt.
 */
export const WRITER_TOOLS: AgentTool[] = [
	updatePlanTool,
	recallMemoryTool,
	findControlsTool,
	getControlsTool,
	requestEvidenceTool,
	requestStandardsTool,
	requestSimilarControlsTool,
	prepareControlConclusionTool,
	requestVerificationTool,
	submitToCoordinatorTool,
	rememberFactTool,
];
