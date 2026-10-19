import { Type } from '@google/genai';
import { clampInt, str, type AgentTool } from '../agent/tools/types';

/** The coordinator's own way to launch the writer pool — replaces the old one-shot launch modal: the user describes the request in chat, the coordinator resolves it and dispatches. */
export const dispatchSwarmTool: AgentTool = {
	declaration: {
		name: 'dispatch_swarm',
		description:
			'Launches the control-writing swarm: resolves controlQuery to concrete controls (exact numbers, or a free-text topic/filter — use find_controls first if you need to confirm what matches), then splits them round-robin across a pool of writer agents. Each writer independently gathers evidence/standards/similar-controls, drafts, gets independent verification, and proposes changes into the outbox for the user to review — nothing is written automatically. Refuses if the swarm is already running; call stop_swarm first if you need to redirect it.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				controlQuery: { type: Type.STRING, description: 'Exact control numbers (comma/newline separated) or a topic/filter phrase.' },
				instructions: { type: Type.STRING, description: 'Extra guidance passed to every writer, e.g. "focus on stage 1 only". Optional.' },
				poolSize: { type: Type.INTEGER, description: 'Number of writer agents to split the work across (2-3). Default 2.' },
			},
			required: ['controlQuery'],
		},
	},
	label: (a) => `Dispatching swarm: ${str(a.controlQuery)}`,
	run: async (args, ctx) => {
		const controlQuery = str(args.controlQuery).trim();
		if (!controlQuery) return { ok: false, output: { error: 'controlQuery is required.' }, summary: 'Empty control query' };
		if (ctx.plugin.swarm.getStatus() === 'running') {
			return { ok: false, output: { error: 'The swarm is already running. Call stop_swarm first if you need to redirect it.' }, summary: 'Swarm already running' };
		}
		const poolSize = clampInt(args.poolSize, 2, 1, 3);
		const numbers = await ctx.plugin.swarm.resolveControls(controlQuery);
		if (numbers.length === 0) return { ok: false, output: { error: 'No controls matched that query.' }, summary: 'No controls matched' };
		ctx.plugin.swarm.start(numbers, str(args.instructions), poolSize);
		return {
			output: { dispatchedControls: numbers, poolSize: Math.min(poolSize, numbers.length) },
			summary: `Dispatched ${numbers.length} control(s) across ${Math.min(poolSize, numbers.length)} writer(s)`,
		};
	},
};

export const getSwarmStatusTool: AgentTool = {
	declaration: {
		name: 'get_swarm_status',
		description: 'Reports the swarm\'s current status: overall running/idle, and each writer/reader/verifier\'s own task queue (pending/in_progress/done/failed).',
		parameters: { type: Type.OBJECT, properties: {} },
	},
	label: () => 'Checking swarm status',
	run: (_args, ctx) => {
		const swarm = ctx.plugin.swarm;
		const writers = swarm.getWriters().map((w) => ({
			agentId: w.agentId,
			running: w.agent.isRunning,
			tasks: w.queue.list().map((t) => ({ control: t.payload, status: t.status, error: t.error })),
		}));
		const specialists = swarm.getSpecialists().map((s) => ({
			agentId: s.agentId,
			tasks: s.tasks.list().map((t) => ({ topic: t.payload, status: t.status, error: t.error })),
		}));
		return Promise.resolve({
			output: { status: swarm.getStatus(), writers, specialists, outboxSize: swarm.outbox.size },
			summary: `Swarm: ${swarm.getStatus()} (${writers.length} writer(s), ${swarm.outbox.size} item(s) in outbox)`,
		});
	},
};

export const stopSwarmTool: AgentTool = {
	declaration: {
		name: 'stop_swarm',
		description: 'Stops every writer and tears down the reader/verifier agents. Anything already staged in the outbox is left untouched — only the running agents stop.',
		parameters: { type: Type.OBJECT, properties: {} },
	},
	label: () => 'Stopping the swarm',
	run: (_args, ctx) => {
		ctx.plugin.swarm.stop();
		return Promise.resolve({ output: { status: 'stopped' }, summary: 'Swarm stopped' });
	},
};
