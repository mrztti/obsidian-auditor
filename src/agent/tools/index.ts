import type { AgentTool } from './types';
import { askUserTool, updatePlanTool } from './plan';
import { findControlsTool, getControlsTool, proposeChangesTool } from './controls';
import { prepareControlConclusionTool } from './conclusion';
import { listDocumentsTool, readDocumentTool, searchDocumentsTool } from './documents';
import { searchReferenceStyleTool } from './referenceStyle';
import { getSessionPlanTool, listSessionsTool } from './sessions';
import { proposeSessionPlanChangesTool } from './sessionEdit';
import { qaReviewTool } from './qaReview';
import { qaReviewBatchTool } from './qaBatch';
import { recallMemoryTool, rememberFactTool } from './memory';

export const AGENT_TOOLS: AgentTool[] = [
	updatePlanTool,
	recallMemoryTool,
	findControlsTool,
	getControlsTool,
	searchDocumentsTool,
	listDocumentsTool,
	readDocumentTool,
	searchReferenceStyleTool,
	listSessionsTool,
	getSessionPlanTool,
	prepareControlConclusionTool,
	qaReviewTool,
	qaReviewBatchTool,
	proposeChangesTool,
	proposeSessionPlanChangesTool,
	rememberFactTool,
	askUserTool,
];

export const TOOLS_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.declaration.name ?? '', t]));
