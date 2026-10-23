import type AuditorPlugin from '../main';
import { ControlStore } from '../agent/controlStore';
import { AgentMemoryStore } from '../agent/memory';
import { AgentBus } from './bus';
import { createBackgroundHost } from './backgroundHost';
import type { DraftStage } from '../agent/types';
import { ControlsReaderAgent } from './controlsReaderAgent';
import { CoordinatorReviewer, COORDINATOR_ID } from './coordinatorReviewer';
import { OutboxStore } from './outboxStore';
import { buildWriterPrompt } from './prompts';
import { ReaderAgent } from './readerAgent';
import { RoleAgent } from './roleAgent';
import { WRITER_TOOLS } from './roles';
import { SubmitterAgent, SUBMITTER_AGENT_ID } from './submitterAgent';
import { EVIDENCE_READER_ID, STANDARDS_READER_ID } from './tools';
import { TaskQueue } from './taskQueue';
import { VerifierAgent, VERIFIER_AGENT_ID } from './verifierAgent';

export interface WriterHandle {
	agentId: string;
	agent: RoleAgent;
	queue: TaskQueue<string>;
}

export type SwarmStatus = 'idle' | 'running';

type Listener = () => void;

/** Agent ids whose Burn Mode defaults to ON — the verifier and the coordinator's own QA pass are meant to use the more capable model by default. The submitter deliberately defaults OFF: it's a strict, mechanical rule check, not a step that benefits from the boosted model, and the user has asked for it to stay on the base model unless explicitly switched on. Everything else defaults off too (same as the main chat). */
const BURN_DEFAULT_ON = new Set<string>([COORDINATOR_ID, VERIFIER_AGENT_ID]);

/**
 * The master agent: not an LLM loop itself (round-robin dispatch is deterministic, nothing here
 * needs a model call), it resolves the user's request to a list of controls, splits them across the
 * writer pool, and lets each writer's own `RoleAgent` loop (evidence/standards/similar-controls all
 * reached via the bus — see `roles.ts`/`prompts.ts`) do the actual drafting work. A writer never
 * proposes anything itself: it submits its finished, verified draft to `CoordinatorReviewer`, which
 * runs one more authoritative QA pass, routes it through `SubmitterAgent`'s strict final check, and
 * only then has the final say on what reaches the shared `OutboxStore`.
 */
export class SwarmOrchestrator {
	readonly bus = new AgentBus();
	readonly outbox = new OutboxStore();
	readonly evidenceReader: ReaderAgent;
	readonly standardsReader: ReaderAgent;
	readonly controlsReader: ControlsReaderAgent;
	readonly verifier: VerifierAgent;
	readonly submitter: SubmitterAgent;
	readonly coordinatorReviewer: CoordinatorReviewer;
	private writers: WriterHandle[] = [];
	private status: SwarmStatus = 'idle';
	private listeners = new Set<Listener>();
	/** Per-agent Burn Mode toggle (graph view checkboxes) — in-memory only, same lifetime as the rest of the swarm's live state. */
	private burnMode = new Map<string, boolean>();

	constructor(private plugin: AuditorPlugin) {
		this.evidenceReader = new ReaderAgent(plugin, EVIDENCE_READER_ID, ['evidence', 'interviewEvidence'], this.bus);
		this.standardsReader = new ReaderAgent(plugin, STANDARDS_READER_ID, ['standards'], this.bus);
		this.controlsReader = new ControlsReaderAgent(plugin, this.bus);
		this.verifier = new VerifierAgent(plugin, this.bus, () => this.burnModeFor(this.verifier.agentId));
		this.submitter = new SubmitterAgent(plugin, this.bus, () => this.burnModeFor(SUBMITTER_AGENT_ID));
		this.coordinatorReviewer = new CoordinatorReviewer(
			plugin, this.bus, this.outbox,
			() => this.burnModeFor(COORDINATOR_ID),
			(writerId, controlId, stage, comment) => this.requestRevision(writerId, controlId, stage, comment),
		);
		// Marks a writer's per-control task "done" the moment it's actually submitted to the
		// coordinator, instead of only once that writer's whole assigned batch finishes — see
		// `submitToCoordinatorTool`'s `controlSubmitted` event.
		this.bus.subscribe((msg) => {
			if (msg.kind !== 'event') return;
			const payload = msg.payload as { kind?: string; controlId?: string };
			if (payload.kind !== 'controlSubmitted' || !payload.controlId) return;
			const writer = this.writers.find((w) => w.agentId === msg.from);
			const task = writer?.queue.list().find((t) => t.payload === payload.controlId && t.status === 'in_progress');
			if (writer && task) writer.queue.setStatus(task.id, 'done');
		});
	}

	getStatus(): SwarmStatus {
		return this.status;
	}

	getWriters(): WriterHandle[] {
		return [...this.writers];
	}

	/** Every non-writer specialist, for the graph view's task-list/summary panel — writers are listed separately via `getWriters()` since they also carry a live `RoleAgent`, not just a task queue. */
	getSpecialists(): { agentId: string; tasks: TaskQueue<string>; getSummary: () => string }[] {
		return [
			{ agentId: this.evidenceReader.agentId, tasks: this.evidenceReader.tasks, getSummary: () => this.evidenceReader.getSummary() },
			{ agentId: this.standardsReader.agentId, tasks: this.standardsReader.tasks, getSummary: () => this.standardsReader.getSummary() },
			{ agentId: this.controlsReader.agentId, tasks: this.controlsReader.tasks, getSummary: () => this.controlsReader.getSummary() },
			{ agentId: this.verifier.agentId, tasks: this.verifier.tasks, getSummary: () => this.verifier.getSummary() },
			{ agentId: this.submitter.agentId, tasks: this.submitter.tasks, getSummary: () => this.submitter.getSummary() },
			{ agentId: COORDINATOR_ID, tasks: this.coordinatorReviewer.tasks, getSummary: () => this.coordinatorReviewer.getSummary() },
		];
	}

	/** Whether `agentId` should use the boosted model when it's configured — the verifier and the coordinator default to true, every other agent defaults to false (the user flips these per-agent in the graph view). */
	burnModeFor(agentId: string): boolean {
		return this.burnMode.get(agentId) ?? BURN_DEFAULT_ON.has(agentId);
	}

	setBurnMode(agentId: string, value: boolean): void {
		this.burnMode.set(agentId, value);
		this.notify();
	}

	onChange(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => { this.listeners.delete(fn); };
	}

	private notify(): void {
		for (const fn of this.listeners) fn();
	}

	/** Builds one writer's launch prompt for its assigned slice of controls, folding in the user's free-text instructions. */
	private buildWriterTask(controlNumbers: string[], instructions: string): string {
		const lines = controlNumbers.map((n, i) => `${i + 1}. Control ${n}`);
		return [
			`Write up the following ${controlNumbers.length} control${controlNumbers.length === 1 ? '' : 's'}, one at a time, in the order listed.`,
			instructions.trim() ? `Instructions from the user: ${instructions.trim()}` : '',
			'',
			'Controls:',
			lines.join('\n'),
		].filter(Boolean).join('\n');
	}

	/**
	 * Resolves `controlQuery` (exact numbers, comma/space separated, or a free-text topic matched via
	 * `ControlStore.find`) to concrete control numbers for the orchestrator to dispatch.
	 */
	async resolveControls(controlQuery: string): Promise<string[]> {
		const controls = new ControlStore(this.plugin);
		const direct = controlQuery.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
		const { found } = await controls.load(direct);
		if (found.length > 0) return found.map((e) => e.record.number);
		const { matches } = await controls.find(controlQuery, {}, 50);
		return matches.map((m) => m.entry.record.number);
	}

	/** Spins up (or reuses) the reader/verifier/coordinator-reviewer/writer agents and dispatches `controlNumbers` round-robin across the pool. Only one swarm run at a time. */
	start(controlNumbers: string[], instructions: string, poolSize: number): void {
		if (this.status === 'running') throw new Error('The swarm is already running.');
		if (controlNumbers.length === 0) throw new Error('No controls resolved to dispatch.');
		this.status = 'running';

		this.evidenceReader.start();
		this.standardsReader.start();
		this.controlsReader.start();
		this.verifier.start();
		this.submitter.start();
		this.coordinatorReviewer.start();

		const clampedPoolSize = Math.max(1, Math.min(poolSize, controlNumbers.length));
		this.writers = Array.from({ length: clampedPoolSize }, (_, i) => {
			const agentId = `writer-${i + 1}`;
			const agent = new RoleAgent(this.plugin, {
				agentId,
				tools: WRITER_TOOLS,
				systemPrompt: buildWriterPrompt(),
				memory: new AgentMemoryStore(this.plugin, agentId),
			});
			return { agentId, agent, queue: new TaskQueue<string>() };
		});

		// Round-robin so an even split is as close as possible without any writer idling while another has a long tail.
		for (const [i, controlNumber] of controlNumbers.entries()) {
			this.writers[i % this.writers.length]!.queue.add(controlNumber);
		}

		this.notify();
		for (const writer of this.writers) void this.runWriter(writer, instructions);
	}

	private async runWriter(writer: WriterHandle, instructions: string): Promise<void> {
		const assigned = writer.queue.list().map((t) => t.payload);
		for (const task of writer.queue.list()) writer.queue.setStatus(task.id, 'in_progress');
		this.bus.event(writer.agentId, '*', { kind: 'status', status: 'drafting', controls: assigned }, `Drafting ${assigned.length} control(s)`);
		const host = createBackgroundHost(writer.agentId, this.bus, this.outbox);
		try {
			await writer.agent.run(this.buildWriterTask(assigned, instructions), host, () => this.burnModeFor(writer.agentId));
			for (const task of writer.queue.list()) writer.queue.setStatus(task.id, 'done');
			this.bus.event(writer.agentId, '*', { kind: 'status', status: 'idle' }, 'Idle');
		} catch (e) {
			for (const task of writer.queue.list()) writer.queue.setStatus(task.id, 'failed', e instanceof Error ? e.message : String(e));
			this.bus.event(writer.agentId, '*', { kind: 'status', status: 'failed', error: e instanceof Error ? e.message : String(e) }, 'Failed');
		}
		if (this.writers.every((w) => !w.agent.isRunning)) {
			this.status = 'idle';
			this.notify();
		}
	}

	/**
	 * Called by `CoordinatorReviewer` when the user rejects a staged proposal — routes it back to the
	 * control's originating writer with the rejection comment, so it can redraft and resubmit, closing
	 * the loop a rejection used to just drop. If that writer is still mid-run (rare — it would mean
	 * the user reviewed a proposal while the writer had already moved on to another control), the
	 * feedback is queued via `steer()` instead of starting a second concurrent run.
	 */
	private requestRevision(writerId: string, controlId: string, stage: DraftStage, comment: string): void {
		const writer = this.writers.find((w) => w.agentId === writerId);
		if (!writer) {
			this.bus.event(COORDINATOR_ID, writerId, { status: 'failed', controlId }, `${writerId} is no longer available to revise ${controlId}`);
			return;
		}
		const task = writer.queue.add(controlId);
		if (writer.agent.isRunning) {
			writer.agent.steer(`The coordinator rejected your submission for control ${controlId} (${stage}): "${comment}". Revise it — gather more evidence if needed, redraft with prepare_control_conclusion, verify with request_verification, and submit_to_coordinator again — then come back to whatever you were doing.`);
			writer.queue.setStatus(task.id, 'in_progress');
			return;
		}
		if (this.status === 'idle') {
			this.status = 'running';
			this.notify();
		}
		void this.runRevision(writer, task.id, controlId, stage, comment);
	}

	private async runRevision(writer: WriterHandle, taskId: string, controlId: string, stage: DraftStage, comment: string): Promise<void> {
		writer.queue.setStatus(taskId, 'in_progress');
		const prompt = `The coordinator rejected your earlier submission for control ${controlId} (${stage}) with this feedback: "${comment}". Revise it: gather any further evidence/standards/similar-controls you need, redraft with prepare_control_conclusion, verify with request_verification, and submit_to_coordinator again.`;
		const host = createBackgroundHost(writer.agentId, this.bus, this.outbox);
		try {
			await writer.agent.run(prompt, host, () => this.burnModeFor(writer.agentId));
			writer.queue.setStatus(taskId, 'done');
		} catch (e) {
			writer.queue.setStatus(taskId, 'failed', e instanceof Error ? e.message : String(e));
		}
		if (this.writers.every((w) => !w.agent.isRunning)) {
			this.status = 'idle';
			this.notify();
		}
	}

	/** Stops every writer, tears down the reader/verifier/submitter/coordinator-reviewer listeners, and cancels any in-flight bus requests. Staged outbox entries are left as-is — they're independent of the run that produced them. */
	stop(): void {
		for (const w of this.writers) w.agent.stop();
		this.evidenceReader.stop();
		this.standardsReader.stop();
		this.controlsReader.stop();
		this.verifier.stop();
		this.submitter.stop();
		this.coordinatorReviewer.stop();
		this.bus.clear();
		this.status = 'idle';
		this.notify();
	}
}
