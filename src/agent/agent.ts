import { ApiError, type Content, type Part } from '@google/genai';
import type AuditorPlugin from '../main';
import { ControlStore } from './controlStore';
import { SessionPlanStore } from './sessionPlanStore';
import { buildSystemPrompt } from './prompt';
import { AGENT_TOOLS, TOOLS_BY_NAME } from './tools';
import type { ToolContext, ToolResult } from './tools/types';
import type { AgentHost, AgentPlan, ContextStatus, ContextUsageSnapshot, ExecutionSnapshot } from './types';
import { computeStepUsage, sumUsage, type ModelTier, type StepUsage } from './usage';

/**
 * The run pauses for a routine checkpoint every this many completed steps (FR-4.1) — this is the
 * limit that used to simply cut a run off; now it is a resumable pause instead. See
 * `AgentHost.requestCheckpoint`.
 */
const CHECKPOINT_INTERVAL = 30;
/** True hard stop, far beyond anything a normal task (even one the user keeps approving checkpoints through) should reach — the last-resort guard against a genuinely runaway loop. */
const ABSOLUTE_MAX_ITERATIONS = CHECKPOINT_INTERVAL * 10;
/** How many times a retryable provider error (503/overloaded/rate-limited) is retried silently, with backoff, before the user is asked (FR-4.2). */
const MAX_AUTO_RETRIES = 2;
/** Backoff before each silent auto-retry, in ms — the last value repeats if `MAX_AUTO_RETRIES` is raised beyond this list's length. */
const AUTO_BACKOFF_MS = [1000, 3000];
/** How many times the agent is pushed back to work when it stops with plan steps still open. */
const MAX_PLAN_NUDGES = 2;
/** Tool results from earlier turns larger than this are elided to keep the running context small. */
const COMPACT_THRESHOLD_CHARS = 1500;

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Thrown to unwind out of a model call (however deeply nested inside a tool) when the user chooses to stop while being asked to recover from a provider error — caught once, at the top of `run()`, and turned into the same clean "Stopped." finish a mid-run Stop click produces. */
class StoppedDuringRecovery extends Error {}

/**
 * Whether `e` is the kind of transient provider-capacity error FR-4.2 is about — Gemini's own
 * 503 UNAVAILABLE being the primary case, generalized slightly to the other common
 * capacity/rate-limit signals the SDK can surface the same way. Never matches a genuine request
 * error (bad input, auth, etc.) — those should still fail immediately, not retry.
 */
function isRetryableProviderError(e: unknown): boolean {
	if (e instanceof ApiError) return e.status === 503 || e.status === 429;
	const msg = e instanceof Error ? e.message : String(e);
	return /\b(503|429)\b|\bUNAVAILABLE\b|\bRESOURCE_EXHAUSTED\b|overloaded|rate.?limit/i.test(msg);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Tool responses whose most recent occurrence is never elided by compaction — they carry rejected-review comments, QA findings or unresolved issues that FR-6.4 explicitly requires compaction to preserve. */
const CRITICAL_TOOL_NAMES = new Set(['propose_control_changes', 'propose_session_plan_changes', 'qa_review_conclusions_batch', 'qa_review_conclusion', 'prepare_control_conclusion']);
/** The most recent this many `Content` entries are never touched by compaction, regardless of size — "current execution state" per FR-6.4. */
const PRESERVE_RECENT_ENTRIES = 6;

/** Rough token estimate (chars / 4) for the whole history — used right after a compaction pass, before the next real model call reports an authoritative `promptTokenCount`. */
function estimateTokens(history: Content[]): number {
	let chars = 0;
	for (const c of history) {
		for (const p of c.parts ?? []) {
			if (p.text) chars += p.text.length;
			if (p.functionCall) chars += JSON.stringify(p.functionCall.args ?? {}).length;
			if (p.functionResponse) chars += JSON.stringify(p.functionResponse.response ?? {}).length;
		}
	}
	return Math.ceil(chars / 4);
}

function contextStatusFor(percentUsed: number, thresholdPercent: number): ContextStatus {
	if (percentUsed >= thresholdPercent) return 'compaction_required';
	if (percentUsed >= thresholdPercent - 10) return 'approaching';
	return 'normal';
}

/**
 * The chat's tool-using agent. Holds the conversation across turns; each `run` drives the
 * model ⇄ tools loop until the model stops calling tools (objective achieved), asks the user a
 * question, is stopped, or hits the iteration cap.
 *
 * No step here ever triggers an extra model call purely to summarize what a previous step did —
 * `update_plan` is pure bookkeeping (no model call of its own; see tools/plan.ts), and the "FINISH
 * with a short summary" the system prompt asks for is the model's own final text on the turn that
 * already ends the run, not a separate round-trip. A summary only ever costs tokens as part of a
 * call the model was making anyway (research, drafting, QA) — never on its own.
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
	/** Whether this run has looked at any current evidence/interview notes — reset per run; see `ToolContext.hasCurrentEvidence`. */
	private evidenceGathered = false;
	/** `"<controlNumber>:<stage>"` pairs that passed `qa_review_conclusion` this run — reset per run; see `ToolContext.hasQaReview`. */
	private qaPassed = new Set<string>();
	/** Every model call's usage this chat session, across every run — only cleared by `reset()` (a new chat), never by a single `run()`, so the session total in the UI stays meaningful across follow-up messages. */
	private sessionUsage: StepUsage[] = [];
	/** Incremented once per loop iteration across every run in this chat session (not reset per `run()`) — gives `lastCompactionStep` a meaningful, monotonic number to report. */
	private totalSteps = 0;
	private lastCompactionAt: string | null = null;
	private lastCompactionStep: number | null = null;

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
		this.sessionUsage = [];
		this.totalSteps = 0;
		this.lastCompactionAt = null;
		this.lastCompactionStep = null;
	}

	/** Asks the current run to end after its in-flight tool call. */
	stop(): void {
		this.stopped = true;
	}

	/** Queues a message the user typed mid-run; it is shown to the model before its next step. */
	steer(text: string): void {
		this.steering.push(text);
	}

	/**
	 * @param isBurnModeEnabled Read live before every model turn (not captured once), so flipping the
	 * chat's Burn Mode toggle mid-run takes effect on the very next turn rather than needing a new run.
	 */
	async run(userText: string, host: AgentHost, isBurnModeEnabled: () => boolean = () => false): Promise<void> {
		if (this.running) throw new Error('The agent is already running.');
		this.running = true;
		this.stopped = false;
		this.plan = null;
		this.evidenceGathered = false;
		this.qaPassed.clear();
		this.compactForContext();
		this.controls.resetSnapshots();
		this.sessionPlans.resetSnapshots();
		this.history.push({ role: 'user', parts: [{ text: userText }] });

		/** Recomputed once per model turn, just before calling it — see `currentTurnModel`. */
		let burnActiveThisTurn = false;
		/** Mirrors the `currentStep` computed at the top of each loop iteration — tools call `ctx.recordUsage` for their OWN model calls (e.g. `prepare_control_conclusion`), attributed to whatever step is current at that moment, same as the agent's own turns. */
		let currentStepId = '_setup';
		/** Every model call's usage for this one run — reset per `run()` call (unlike `sessionUsage`), so "this run" totals in the UI only ever cover the task just launched. */
		const runUsage: StepUsage[] = [];
		const recordUsage = (tier: ModelTier, meta: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number } | undefined): StepUsage => {
			const record = computeStepUsage({
				stepId: currentStepId,
				modelTier: tier,
				inputTokens: meta?.promptTokenCount ?? 0,
				cachedInputTokens: meta?.cachedContentTokenCount,
				outputTokens: meta?.candidatesTokenCount ?? 0,
			}, this.plugin.settings);
			this.sessionUsage.push(record);
			runUsage.push(record);
			const step = this.plan?.steps.find((s) => s.id === currentStepId);
			if (step) step.usage = [...(step.usage ?? []), record];
			host.emit({ type: 'usage', stepId: currentStepId, usage: record, runTotals: sumUsage(runUsage), sessionTotals: sumUsage(this.sessionUsage) });
			return record;
		};
		/** Built from either a real `promptTokenCount` (after a model call) or a character estimate (right after compacting) — see `ContextUsageSnapshot`. */
		const buildContextSnapshot = (currentTokens: number, estimated: boolean): ContextUsageSnapshot => {
			const s = this.plugin.settings;
			const reservedTokens = s.reservedOutputTokens + s.reservedSystemToolTokens;
			const usableInputBudget = Math.max(1, s.baseModelMaxContextTokens - reservedTokens);
			const percentUsed = Math.round((currentTokens / usableInputBudget) * 1000) / 10;
			return {
				currentTokens,
				estimated,
				maxTokens: s.baseModelMaxContextTokens,
				usableInputBudget,
				reservedTokens,
				percentUsed,
				status: contextStatusFor(percentUsed, s.compactionThresholdPercent),
				lastCompactionAt: this.lastCompactionAt,
				lastCompactionStep: this.lastCompactionStep,
			};
		};
		/** Boxed (rather than a bare `let`) so reading `.status` after `emitContext` runs isn't narrowed away to the initializer's literal type by TS's closure analysis. */
		const contextState: { status: ContextUsageSnapshot['status'] } = { status: 'normal' };
		const emitContext = (currentTokens: number, estimated: boolean): ContextUsageSnapshot => {
			const snapshot = buildContextSnapshot(currentTokens, estimated);
			contextState.status = snapshot.status;
			host.emit({ type: 'context', scope: 'session', usage: snapshot });
			return snapshot;
		};

		/** Read fresh on every pause (checkpoint or error-recovery) — nothing here is reconstructed, it's the same plan/usage state the loop itself has been maintaining all along. */
		const buildSnapshot = (): ExecutionSnapshot => {
			const steps = this.plan?.steps ?? [];
			return {
				completed: steps.filter((s) => s.status === 'done').length,
				pending: steps.filter((s) => s.status === 'pending' || s.status === 'in_progress').length,
				failed: steps.filter((s) => s.status === 'failed').length,
				skipped: steps.filter((s) => s.status === 'skipped').length,
				runTotals: sumUsage(runUsage),
				sessionTotals: sumUsage(this.sessionUsage),
			};
		};

		/**
		 * Wraps one model call with bounded silent backoff, then — only if still failing — a plain,
		 * non-technical pause asking the user whether to keep trying (FR-4.2). Nothing the call's
		 * caller was holding onto is touched while this retries: it's the exact same `fn` re-invoked,
		 * not a restart of whatever produced its arguments.
		 */
		const withRecovery = async <T>(fn: () => Promise<T>): Promise<T> => {
			let attempt = 0;
			for (;;) {
				try {
					return await fn();
				} catch (e) {
					if (!isRetryableProviderError(e)) throw e;
					attempt++;
					if (attempt <= MAX_AUTO_RETRIES) {
						await delay(AUTO_BACKOFF_MS[attempt - 1] ?? AUTO_BACKOFF_MS[AUTO_BACKOFF_MS.length - 1] ?? 1000);
						continue;
					}
					const decision = await host.requestErrorRecovery({ ...buildSnapshot(), attempt });
					if (decision === 'stop') throw new StoppedDuringRecovery();
					attempt = 0; // give the next failure its own fresh bounded-backoff cycle before asking again
				}
			}
		};

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
			hasCurrentEvidence: () => this.evidenceGathered,
			markCurrentEvidence: () => { this.evidenceGathered = true; },
			hasQaReview: (controlNumber, stage) => this.qaPassed.has(`${controlNumber}:${stage}`),
			markQaReview: (controlNumber, stage) => { this.qaPassed.add(`${controlNumber}:${stage}`); },
			isBurnActive: () => burnActiveThisTurn,
			recordUsage: (meta) => recordUsage(burnActiveThisTurn ? 'boosted' : 'base', meta),
			callWithRecovery: withRecovery,
		};
		const declarations = AGENT_TOOLS.map((t) => t.declaration);
		const systemPrompt = buildSystemPrompt();
		let nudges = 0;
		let planEnforced = false;

		try {
			for (let iteration = 0; iteration < ABSOLUTE_MAX_ITERATIONS; iteration++) {
				if (this.stopped) {
					this.history.push({ role: 'model', parts: [{ text: '(Stopped by the user.)' }] });
					host.emit({ type: 'final', text: 'Stopped.', askedUser: false, burn: false });
					return;
				}
				this.drainSteering();
				this.totalSteps++;

				// Context compaction (FR-6.4): triggered by the status computed from the LAST known token
				// count, before spending another model call — never interrupts the user, just a passive note.
				if (contextState.status === 'compaction_required') {
					const { before, after, duplicatesRemoved, elided } = this.compactForContext();
					this.lastCompactionAt = new Date().toISOString();
					this.lastCompactionStep = this.totalSteps;
					host.emit({ type: 'compaction', beforeTokens: before, afterTokens: after, duplicatesRemoved, elided });
					emitContext(after, true);
				}

				const currentStep = this.openPlanSteps().find((s) => s.status === 'in_progress');
				currentStepId = currentStep?.id ?? '_setup';
				const boostedModel = this.plugin.settings.boostedModel.trim();
				burnActiveThisTurn = isBurnModeEnabled() && !!currentStep?.burn && boostedModel !== '';
				const response = await withRecovery(() => this.plugin.geminiGenerate.agentStep(this.history, systemPrompt, declarations, burnActiveThisTurn ? boostedModel : undefined));
				const content = response.candidates?.[0]?.content;
				if (!content?.parts?.length) {
					throw new Error(response.promptFeedback?.blockReason ? `The model blocked the request (${response.promptFeedback.blockReason}).` : 'The model returned an empty response.');
				}
				this.history.push(content);

				if (response.usageMetadata) recordUsage(burnActiveThisTurn ? 'boosted' : 'base', response.usageMetadata);
				emitContext(response.usageMetadata?.promptTokenCount ?? estimateTokens(this.history), !response.usageMetadata?.promptTokenCount);

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
					host.emit({ type: 'final', text: text || 'Done.', askedUser: false, burn: burnActiveThisTurn });
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
					host.emit({ type: 'tool_start', id, name, label: tool ? tool.label(args) : `Unknown tool ${name}`, burn: burnActiveThisTurn });

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
					host.emit({ type: 'final', text: askedQuestion, askedUser: true, burn: burnActiveThisTurn });
					return;
				}

				// Routine checkpoint (FR-4.1): pause every CHECKPOINT_INTERVAL steps instead of just running out.
				// Nothing below is reset — the next loop iteration (on 'continue') picks up exactly where this left off.
				if ((iteration + 1) % CHECKPOINT_INTERVAL === 0) {
					const decision = await host.requestCheckpoint(buildSnapshot());
					if (decision === 'stop' || this.stopped) {
						this.history.push({ role: 'model', parts: [{ text: '(Stopped by the user at a checkpoint.)' }] });
						host.emit({ type: 'final', text: 'Stopped.', askedUser: false, burn: false });
						return;
					}
				}
			}
			host.emit({ type: 'error', message: `Stopped after ${ABSOLUTE_MAX_ITERATIONS} steps without finishing, well beyond the normal checkpoint cadence — this needs a narrower request rather than more continuing.` });
		} catch (e) {
			if (e instanceof StoppedDuringRecovery) {
				this.history.push({ role: 'model', parts: [{ text: '(Stopped by the user while the model was temporarily unavailable.)' }] });
				host.emit({ type: 'final', text: 'Stopped.', askedUser: false, burn: false });
				return;
			}
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

	/**
	 * Context compaction (FR-6.4). Runs the sequence the FR specifies, as far as it applies to this
	 * history's actual shape:
	 *  1. Duplicate tool results (byte-identical JSON) are elided after their first occurrence.
	 *  2/3. Oversized tool results are shrunk to a stub referencing the tool to re-call — this is
	 *     also how "replace full documents with references" and "drop stale diagnostics" apply here,
	 *     since a tool result already IS the retrieved reference/diagnostic, not a raw document.
	 * Preserved unconditionally, regardless of size: the most recent `PRESERVE_RECENT_ENTRIES`
	 * history entries (current execution state), and the LAST occurrence of any `CRITICAL_TOOL_NAMES`
	 * result (accepted/rejected decisions, QA findings, unresolved issues, source references) —
	 * never both the first-seen-wins dedup nor the size-based elision touch those.
	 */
	private compactForContext(): { before: number; after: number; duplicatesRemoved: number; elided: number } {
		const before = estimateTokens(this.history);
		const total = this.history.length;

		// Find the LAST index of each critical tool's functionResponse, so only that occurrence is protected.
		const lastCriticalIndex = new Map<string, number>();
		this.history.forEach((content, i) => {
			for (const part of content.parts ?? []) {
				if (part.functionResponse?.name && CRITICAL_TOOL_NAMES.has(part.functionResponse.name)) {
					lastCriticalIndex.set(`${i}:${part.functionResponse.id ?? ''}:${part.functionResponse.name}`, i);
				}
			}
		});
		const protectedIndices = new Set(lastCriticalIndex.values());

		let duplicatesRemoved = 0;
		let elided = 0;
		const seenResponseJson = new Set<string>();
		this.history.forEach((content, i) => {
			if (i >= total - PRESERVE_RECENT_ENTRIES || protectedIndices.has(i)) return;
			for (const part of content.parts ?? []) {
				const fr = part.functionResponse;
				if (!fr) continue;
				const json = JSON.stringify(fr.response ?? {});
				if (seenResponseJson.has(json)) {
					fr.response = { output: '[Duplicate of an earlier identical result, elided — call the tool again if you need it restated.]' };
					duplicatesRemoved++;
					continue;
				}
				seenResponseJson.add(json);
				if (json.length > COMPACT_THRESHOLD_CHARS) {
					fr.response = { output: '[Large result from an earlier turn elided — call the tool again if you need it.]' };
					elided++;
				}
			}
		});

		const after = estimateTokens(this.history);
		return { before, after, duplicatesRemoved, elided };
	}
}
