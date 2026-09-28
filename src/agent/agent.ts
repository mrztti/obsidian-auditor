import type { Content, Part } from '@google/genai';
import type AuditorPlugin from '../main';
import { ControlStore } from './controlStore';
import { SessionPlanStore } from './sessionPlanStore';
import { buildSystemPrompt } from './prompt';
import { AGENT_TOOLS, TOOLS_BY_NAME } from './tools';
import type { ToolContext, ToolResult } from './tools/types';
import type { AgentHost, AgentPlan } from './types';

/** Hard stop on model round-trips per user message, so a confused run can never spin forever. */
const MAX_ITERATIONS = 30;
/** How many times the agent is pushed back to work when it stops with plan steps still open. */
const MAX_PLAN_NUDGES = 2;
/** Tool results from earlier turns larger than this are elided to keep the running context small. */
const COMPACT_THRESHOLD_CHARS = 1500;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The chat's tool-using agent. Holds the conversation across turns; each `run` drives the
 * model ⇄ tools loop until the model stops calling tools (objective achieved), asks the user a
 * question, is stopped, or hits the iteration cap.
 */
export class ChatAgent {
	private history: Content[] = [];
	private plan: AgentPlan | null = null;
	private controls: ControlStore;
	private sessionPlans: SessionPlanStore;
	private steering: string[] = [];
	private stopped = false;
	private running = false;
	private toolCallId = 0;

	constructor(private plugin: AuditorPlugin) {
		this.controls = new ControlStore(plugin);
		this.sessionPlans = new SessionPlanStore(plugin, this.controls);
	}

	get isRunning(): boolean {
		return this.running;
	}

	/** Forgets the conversation and plan. */
	reset(): void {
		this.history = [];
		this.plan = null;
		this.steering = [];
		this.controls.resetSnapshots();
		this.sessionPlans.resetSnapshots();
	}

	/** Asks the current run to end after its in-flight tool call. */
	stop(): void {
		this.stopped = true;
	}

	/** Queues a message the user typed mid-run; it is shown to the model before its next step. */
	steer(text: string): void {
		this.steering.push(text);
	}

	async run(userText: string, host: AgentHost): Promise<void> {
		if (this.running) throw new Error('The agent is already running.');
		this.running = true;
		this.stopped = false;
		this.plan = null;
		this.compactHistory();
		this.controls.resetSnapshots();
		this.sessionPlans.resetSnapshots();
		this.history.push({ role: 'user', parts: [{ text: userText }] });

		const ctx: ToolContext = {
			plugin: this.plugin,
			controls: this.controls,
			sessionPlans: this.sessionPlans,
			host,
			getPlan: () => this.plan,
			setPlan: (plan) => {
				this.plan = plan;
				host.emit({ type: 'plan', plan });
			},
		};
		const declarations = AGENT_TOOLS.map((t) => t.declaration);
		const systemPrompt = buildSystemPrompt();
		let nudges = 0;
		let planEnforced = false;

		try {
			for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
				if (this.stopped) {
					this.history.push({ role: 'model', parts: [{ text: '(Stopped by the user.)' }] });
					host.emit({ type: 'final', text: 'Stopped.', askedUser: false });
					return;
				}
				this.drainSteering();

				const response = await this.plugin.geminiGenerate.agentStep(this.history, systemPrompt, declarations);
				const content = response.candidates?.[0]?.content;
				if (!content?.parts?.length) {
					throw new Error(response.promptFeedback?.blockReason ? `The model blocked the request (${response.promptFeedback.blockReason}).` : 'The model returned an empty response.');
				}
				this.history.push(content);

				const calls = response.functionCalls ?? [];
				const text = content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();

				if (calls.length === 0) {
					const open = this.openPlanSteps();
					if (open.length > 0 && nudges < MAX_PLAN_NUDGES && !this.stopped) {
						nudges++;
						this.history.push({
							role: 'user',
							parts: [{ text: `[system] Your plan still has unfinished steps: ${open.map((s) => `"${s.title}"`).join(', ')}. If the objective is achieved, mark them done or skipped with update_plan and give your final answer. Otherwise continue working — do not stop early.` }],
						});
						if (text) host.emit({ type: 'note', text });
						continue;
					}
					host.emit({ type: 'final', text: text || 'Done.', askedUser: false });
					return;
				}

				if (text) host.emit({ type: 'note', text });

				// The user watches the plan, so the first tool use of a run must be update_plan: bounce anything else once.
				if (this.plan === null && !planEnforced && !calls.some((c) => c.name === 'update_plan')) {
					planEnforced = true;
					this.history.push({
						role: 'user',
						parts: calls.map((c) => ({ functionResponse: { id: c.id, name: c.name ?? '', response: { error: 'Not executed. Call update_plan first — with your objective and 3–7 steps, each with a non-empty title — then repeat this call.' } } })),
					});
					continue;
				}

				const responseParts: Part[] = [];
				let askedQuestion: string | null = null;
				for (const call of calls) {
					const name = call.name ?? '';
					const args = call.args ?? {};
					const tool = TOOLS_BY_NAME.get(name);
					const id = ++this.toolCallId;
					host.emit({ type: 'tool_start', id, name, label: tool ? tool.label(args) : `Unknown tool ${name}` });

					let result: ToolResult;
					if (!tool) {
						result = { ok: false, output: { error: `Unknown tool "${name}".` }, summary: `Unknown tool ${name}` };
					} else {
						try {
							result = await tool.run(args, ctx);
						} catch (e) {
							console.error('[Auditor] tool failed', name, e);
							result = { ok: false, output: { error: errorMessage(e) }, summary: `Failed: ${errorMessage(e)}` };
						}
					}
					host.emit({ type: 'tool_end', id, ok: result.ok !== false, summary: result.summary });
					if (result.terminal && typeof result.output.question === 'string') askedQuestion = result.output.question;
					responseParts.push({ functionResponse: { id: call.id, name, response: result.output } });
				}
				this.history.push({ role: 'user', parts: responseParts });

				if (askedQuestion !== null) {
					this.history.push({ role: 'model', parts: [{ text: askedQuestion }] });
					host.emit({ type: 'final', text: askedQuestion, askedUser: true });
					return;
				}
			}
			host.emit({ type: 'error', message: `Stopped after ${MAX_ITERATIONS} steps without finishing. Send a message to let me continue, or narrow the request.` });
		} catch (e) {
			console.error('[Auditor] agent run failed', e);
			host.emit({ type: 'error', message: errorMessage(e) });
		} finally {
			this.dropDanglingToolCall();
			this.running = false;
		}
	}

	private openPlanSteps() {
		return this.plan?.steps.filter((s) => s.status === 'pending' || s.status === 'in_progress') ?? [];
	}

	/** Adds any messages the user typed while the agent was working, merged into the trailing user turn when there is one. */
	private drainSteering(): void {
		if (this.steering.length === 0) return;
		const parts: Part[] = this.steering.splice(0).map((t) => ({ text: `[The user added while you were working]: ${t}` }));
		const last = this.history[this.history.length - 1];
		if (last?.role === 'user') last.parts = [...(last.parts ?? []), ...parts];
		else this.history.push({ role: 'user', parts });
	}

	/** If a run died between the model requesting tools and their results being recorded, remove that request — an unanswered function call makes every later request invalid. */
	private dropDanglingToolCall(): void {
		const last = this.history[this.history.length - 1];
		if (last?.role === 'model' && last.parts?.some((p) => p.functionCall)) this.history.pop();
	}

	/** Shrinks big tool results from previous turns to a stub; the agent re-fetches if it needs them again. */
	private compactHistory(): void {
		for (const content of this.history) {
			for (const part of content.parts ?? []) {
				const fr = part.functionResponse;
				if (fr && JSON.stringify(fr.response ?? {}).length > COMPACT_THRESHOLD_CHARS) {
					fr.response = { output: '[Large result from an earlier turn elided — call the tool again if you need it.]' };
				}
			}
		}
	}
}
