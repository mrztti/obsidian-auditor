import type { FunctionDeclaration } from '@google/genai';
import type AuditorPlugin from '../../main';
import type { ControlStore } from '../controlStore';
import type { SessionPlanStore } from '../sessionPlanStore';
import type { AgentHost, AgentPlan } from '../types';

export interface ToolContext {
	plugin: AuditorPlugin;
	controls: ControlStore;
	sessionPlans: SessionPlanStore;
	host: AgentHost;
	getPlan(): AgentPlan | null;
	setPlan(plan: AgentPlan): void;
}

export interface ToolResult {
	/** Sent back to the model. */
	output: Record<string, unknown>;
	/** One line shown in the chat's activity log. */
	summary: string;
	ok?: boolean;
	/** Ends the agent's turn after this tool (used by `ask_user`). */
	terminal?: boolean;
}

export interface AgentTool {
	declaration: FunctionDeclaration;
	/** Short present-tense description of this call for the activity log, e.g. "Looking up controls: access review". */
	label(args: Record<string, unknown>): string;
	run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);

export function clampInt(v: unknown, fallback: number, min: number, max: number): number {
	const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
	return Math.min(max, Math.max(min, n));
}

export function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}… [truncated ${text.length - max} chars]` : text;
}
