import type { AgentTool } from './types';
import { askUserTool, updatePlanTool } from './plan';
import { findControlsTool, getControlsTool, proposeChangesTool } from './controls';
import { listDocumentsTool, readDocumentTool, searchDocumentsTool } from './documents';
import { getSessionPlanTool, listSessionsTool } from './sessions';
import { proposeSessionPlanChangesTool } from './sessionEdit';

export const AGENT_TOOLS: AgentTool[] = [
	updatePlanTool,
	findControlsTool,
	getControlsTool,
	searchDocumentsTool,
	listDocumentsTool,
	readDocumentTool,
	listSessionsTool,
	getSessionPlanTool,
	proposeChangesTool,
	proposeSessionPlanChangesTool,
	askUserTool,
];

export const TOOLS_BY_NAME = new Map(AGENT_TOOLS.map((t) => [t.declaration.name ?? '', t]));
