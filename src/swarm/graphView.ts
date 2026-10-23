import { ItemView, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from '../main';
import { agentTypeOf, renderAgentBadge } from './agentColors';
import type { AgentMessage } from './bus';
import type { TaskQueue } from './taskQueue';
import { EVIDENCE_READER_ID, STANDARDS_READER_ID, VERIFIER_ID } from './tools';
import { CONTROLS_READER_ID } from './controlsReaderAgent';
import { COORDINATOR_AGENT_ID } from './coordinatorAgent';
import { SUBMITTER_AGENT_ID } from './submitterAgent';

/** Agents that actually call a generation model, and so get a Burn Mode checkbox in the graph — the readers only do vector search/embeddings, so a burn toggle on them would be a no-op. */
const BURN_CAPABLE = new Set<string>([COORDINATOR_AGENT_ID, VERIFIER_ID, SUBMITTER_AGENT_ID]);
const isBurnCapable = (agentId: string): boolean => BURN_CAPABLE.has(agentId) || agentId.startsWith('writer-');

export const SWARM_GRAPH_VIEW_TYPE = 'auditor-swarm-graph-view';

interface NodeInfo {
	id: string;
	label: string;
	col: 'left' | 'center' | 'right' | 'top';
	status: string;
}

/** Cap on how many feed rows / per-node log lines are kept — a live glance, not an audit trail (that's what `AgentMemoryStore`/the outbox are for). */
const MAX_FEED_ITEMS = 300;
const MAX_LOG_LINES = 200;

interface FeedItem {
	id: string;
	title: string;
	from: string;
	to: string;
	at: number;
	kind: 'request' | 'response';
	payload: unknown;
	meta?: Record<string, unknown>;
	expanded: boolean;
}

/**
 * A live view of the swarm: one node per agent (coordinator, the three readers, the verifier, each
 * writer) laid out by role, with a line flashing between two nodes whenever a message passes
 * between them on the bus, a notification-style feed of every titled request/response (collapsed
 * to one line, expandable to the full payload), and per-node controls (stop/steer a writer, see its
 * task list). Plain DOM + inline SVG — no graph/charting dependency.
 */
export class SwarmGraphView extends ItemView {
	private unsubscribeBus: (() => void) | null = null;
	private unsubscribeOrchestrator: (() => void) | null = null;
	private unsubscribeQueue: (() => void) | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private redrawScheduled = false;
	private svg!: SVGSVGElement;
	private nodeEls = new Map<string, HTMLElement>();
	private statusEls = new Map<string, HTMLElement>();
	private logs = new Map<string, string[]>();
	private feed: FeedItem[] = [];
	private selected: string | null = null;
	private feedEl!: HTMLElement;
	private detailEl!: HTMLElement;
	private canvas!: HTMLElement;
	/** The selected node's status-summary paragraph and activity-log list — kept as fields so `refreshSummary()`/`appendLogLine()` can update them in place without a full `renderDetail()` rebuild. Reset (to null) at the top of every `renderDetail()` call, which recreates them. */
	private summaryEl: HTMLElement | null = null;
	private logListEl: HTMLElement | null = null;
	/** The coordinator node's control-status panel — only set while it's the selected node (see `renderDetail`/`refreshControlStatuses`). */
	private controlStatusEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: AuditorPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return SWARM_GRAPH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Swarm graph';
	}

	getIcon(): string {
		return 'git-branch';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-swarm-graph-view');
		this.render(container);
		this.unsubscribeBus = this.plugin.swarm.bus.subscribe((msg) => this.onMessage(msg));
		this.unsubscribeOrchestrator = this.plugin.swarm.onChange(() => this.rebuildNodes());
		this.resizeObserver = new ResizeObserver(() => this.scheduleRedraw());
		this.resizeObserver.observe(this.canvas);
		this.rebuildNodes();
		this.renderDetail();
		await Promise.resolve();
	}

	async onClose(): Promise<void> {
		this.unsubscribeBus?.();
		this.unsubscribeBus = null;
		this.unsubscribeOrchestrator?.();
		this.unsubscribeOrchestrator = null;
		this.unsubscribeQueue?.();
		this.unsubscribeQueue = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		await Promise.resolve();
	}

	private render(container: HTMLElement): void {
		const toolbar = container.createDiv('auditor-swarm-graph-toolbar');
		toolbar.createSpan({ text: 'Agent swarm', cls: 'auditor-chat-toolbar-title' });
		const body = container.createDiv('auditor-swarm-graph-body');
		const left = body.createDiv('auditor-swarm-graph-left');
		this.canvas = left.createDiv('auditor-swarm-graph-canvas');
		this.svg = this.canvas.createSvg('svg', { cls: 'auditor-swarm-graph-lines' });
		const right = body.createDiv('auditor-swarm-graph-right');
		right.createEl('h4', { text: 'Activity feed' });
		this.feedEl = right.createDiv('auditor-swarm-feed');
		right.createEl('h4', { text: 'Selected agent' });
		this.detailEl = right.createDiv('auditor-swarm-graph-detail');
	}

	private nodeDefs(): NodeInfo[] {
		const writers = this.plugin.swarm.getWriters();
		return [
			{ id: COORDINATOR_AGENT_ID, label: 'Coordinator', col: 'top', status: this.plugin.swarm.getStatus() },
			{ id: EVIDENCE_READER_ID, label: 'Evidence reader', col: 'left', status: 'idle' },
			{ id: STANDARDS_READER_ID, label: 'Standards reader', col: 'left', status: 'idle' },
			{ id: CONTROLS_READER_ID, label: 'Controls reader', col: 'left', status: 'idle' },
			{ id: VERIFIER_ID, label: 'Verifier', col: 'right', status: 'idle' },
			{ id: SUBMITTER_AGENT_ID, label: 'Submitter', col: 'right', status: 'idle' },
			...writers.map((w): NodeInfo => ({ id: w.agentId, label: w.agentId, col: 'center', status: w.agent.isRunning ? 'drafting' : 'idle' })),
		];
	}

	private rebuildNodes(): void {
		this.canvas.querySelectorAll('.auditor-swarm-col').forEach((el) => el.remove());
		this.nodeEls.clear();
		this.statusEls.clear();
		const byCol: Record<NodeInfo['col'], NodeInfo[]> = { top: [], left: [], center: [], right: [] };
		for (const n of this.nodeDefs()) byCol[n.col].push(n);

		for (const col of ['top', 'left', 'center', 'right'] as const) {
			const colEl = this.canvas.createDiv(`auditor-swarm-col auditor-swarm-col-${col}`);
			for (const n of byCol[col]) this.renderNode(colEl, n);
		}
		this.scheduleRedraw();
	}

	private renderNode(parent: HTMLElement, info: NodeInfo): void {
		const node = parent.createDiv(`auditor-swarm-node type-${agentTypeOf(info.id)}`);
		if (this.selected === info.id) node.addClass('is-selected');
		const labelRow = node.createDiv('auditor-swarm-node-label');
		renderAgentBadge(labelRow, info.id);
		const status = node.createDiv({ text: info.status, cls: 'auditor-swarm-node-status' });
		if (isBurnCapable(info.id)) {
			const burnLabel = node.createEl('label', { cls: 'auditor-swarm-burn-label' });
			const checkbox = burnLabel.createEl('input', { type: 'checkbox' });
			checkbox.checked = this.plugin.swarm.burnModeFor(info.id);
			checkbox.addEventListener('click', (e) => e.stopPropagation());
			checkbox.addEventListener('change', () => { this.plugin.swarm.setBurnMode(info.id, checkbox.checked); });
			burnLabel.createSpan({ text: 'Burn' });
		}
		node.addEventListener('click', () => {
			this.selected = info.id;
			for (const el of this.nodeEls.values()) el.removeClass('is-selected');
			node.addClass('is-selected');
			this.renderDetail();
		});
		this.nodeEls.set(info.id, node);
		this.statusEls.set(info.id, status);
	}

	/** Debounced to one redraw per animation frame — a `ResizeObserver` can fire many times in quick succession while a pane is being dragged. */
	private scheduleRedraw(): void {
		if (this.redrawScheduled) return;
		this.redrawScheduled = true;
		window.requestAnimationFrame(() => {
			this.redrawScheduled = false;
			this.drawEdges();
		});
	}

	/** Lines between every writer and the readers/verifier it can talk to, plus coordinator→writer — purely illustrative of the swarm's topology, not driven by whether a message has actually happened yet (those flash instead; see `onMessage`). Recomputed on every resize (`scheduleRedraw`) so the lines never drift from the actual node positions when the pane is resized. */
	private drawEdges(): void {
		this.svg.empty();
		const canvasRect = this.canvas.getBoundingClientRect();
		this.svg.setAttr('width', String(canvasRect.width));
		this.svg.setAttr('height', String(canvasRect.height));
		const center = (el: HTMLElement): { x: number; y: number } => {
			const r = el.getBoundingClientRect();
			return { x: r.left + r.width / 2 - canvasRect.left, y: r.top + r.height / 2 - canvasRect.top };
		};
		const writers = this.plugin.swarm.getWriters().map((w) => w.agentId);
		const pairs: [string, string][] = [
			...writers.map((w): [string, string] => [COORDINATOR_AGENT_ID, w]),
			...writers.map((w): [string, string] => [w, EVIDENCE_READER_ID]),
			...writers.map((w): [string, string] => [w, STANDARDS_READER_ID]),
			...writers.map((w): [string, string] => [w, CONTROLS_READER_ID]),
			...writers.map((w): [string, string] => [w, VERIFIER_ID]),
			[COORDINATOR_AGENT_ID, SUBMITTER_AGENT_ID],
		];
		for (const [a, b] of pairs) {
			const elA = this.nodeEls.get(a);
			const elB = this.nodeEls.get(b);
			if (!elA || !elB) continue;
			const pa = center(elA);
			const pb = center(elB);
			const line = activeDocument.createElementNS('http://www.w3.org/2000/svg', 'line');
			line.setAttr('x1', String(pa.x));
			line.setAttr('y1', String(pa.y));
			line.setAttr('x2', String(pb.x));
			line.setAttr('y2', String(pb.y));
			line.addClass('auditor-swarm-edge');
			line.addClass(`type-${agentTypeOf(a === COORDINATOR_AGENT_ID ? a : b)}`);
			line.id = `edge-${a}-${b}`;
			this.svg.appendChild(line);
		}
	}

	private flashEdge(a: string, b: string): void {
		for (const id of [`edge-${a}-${b}`, `edge-${b}-${a}`]) {
			const el = this.svg.querySelector<SVGLineElement>(`#${id}`);
			if (!el) continue;
			el.addClass('is-active');
			window.setTimeout(() => el.removeClass('is-active'), 600);
		}
	}

	private log(agentId: string, line: string): void {
		const lines = this.logs.get(agentId) ?? [];
		lines.push(line);
		if (lines.length > MAX_LOG_LINES) lines.shift();
		this.logs.set(agentId, lines);
		if (this.selected !== agentId) return;
		this.refreshSummary();
		this.appendLogLine(line);
		this.refreshControlStatuses();
	}

	/** Recomputes and redraws just the selected agent's status-summary paragraph — called on every log line and task-list change, so it reads as continuously live rather than only refreshing on a full `renderDetail()` re-render (e.g. right after a task finishes). */
	private refreshSummary(): void {
		if (!this.selected || !this.summaryEl) return;
		const writer = this.plugin.swarm.getWriters().find((w) => w.agentId === this.selected);
		const specialist = this.plugin.swarm.getSpecialists().find((s) => s.agentId === this.selected);
		const text = writer ? writer.agent.getSummary() : specialist?.getSummary();
		this.summaryEl.setText(text ?? '');
	}

	/** Appends one line to the already-rendered activity log without rebuilding the whole detail panel — `renderDetail()` still does a full rebuild on selection change. */
	private appendLogLine(line: string): void {
		if (!this.logListEl) return;
		this.logListEl.querySelector('.auditor-field-description')?.remove();
		const el = this.logListEl.createDiv({ text: line, cls: 'auditor-swarm-log-line' });
		this.logListEl.prepend(el);
	}

	/** Redraws the coordinator's control-status panel in place (see `renderControlStatuses`) — a no-op while any other node is selected. */
	private refreshControlStatuses(): void {
		if (this.selected !== COORDINATOR_AGENT_ID || !this.controlStatusEl) return;
		this.drawControlStatuses(this.controlStatusEl);
	}

	/**
	 * Every (control, stage) the coordinator has ever tracked (`ControlTaskStatusEntry`), with a
	 * Retry button for anything stuck at `needs_attention` — this is the coordinator's own view of
	 * "ensure every task finishes": nothing it has touched just disappears, it either reaches
	 * `staged`/`applied` or sits here, visibly, until retried.
	 */
	private renderControlStatuses(parent: HTMLElement): void {
		parent.createEl('h5', { text: 'Control status' });
		this.controlStatusEl = parent.createDiv('auditor-swarm-control-status-list');
		this.drawControlStatuses(this.controlStatusEl);
	}

	private drawControlStatuses(container: HTMLElement): void {
		container.empty();
		const entries = this.plugin.swarm.coordinatorReviewer.getControlStatuses().sort((a, b) => b.updatedAt - a.updatedAt);
		if (entries.length === 0) {
			container.createEl('p', { text: 'Nothing tracked yet.', cls: 'auditor-field-description' });
			return;
		}
		for (const entry of entries) {
			const row = container.createDiv(`auditor-swarm-control-status is-${entry.status}`);
			const head = row.createDiv('auditor-swarm-control-status-head');
			head.createSpan({ text: `${entry.controlId} (${entry.stage})`, cls: 'auditor-swarm-task-label' });
			head.createSpan({ text: entry.status.replace('_', ' '), cls: 'auditor-swarm-task-status' });
			if (entry.attempts > 0) head.createSpan({ text: `attempt ${entry.attempts}`, cls: 'auditor-swarm-task-status' });
			if (entry.status === 'needs_attention') {
				const retryBtn = head.createEl('button', { text: 'Retry' });
				retryBtn.addEventListener('click', () => { void this.plugin.swarm.coordinatorReviewer.retry(entry.controlId, entry.stage); });
			}
			if (entry.note) row.createDiv({ text: entry.note, cls: 'auditor-swarm-task-error' });
		}
	}

	private addFeedItem(item: Omit<FeedItem, 'expanded'>): void {
		this.feed.unshift({ ...item, expanded: false });
		if (this.feed.length > MAX_FEED_ITEMS) this.feed.length = MAX_FEED_ITEMS;
		this.renderFeed();
	}

	private onMessage(msg: AgentMessage): void {
		const statusEl = this.statusEls.get(msg.from);
		if (msg.to !== '*') this.flashEdge(msg.from, msg.to);

		if (msg.kind === 'request' || msg.kind === 'response') {
			this.addFeedItem({ id: msg.id, title: msg.title, from: msg.from, to: msg.to, at: msg.at, kind: msg.kind, payload: msg.payload, meta: msg.meta });
		} else if (msg.kind === 'event') {
			const payload = msg.payload as { kind?: string; status?: string; event?: { type?: string; text?: string; name?: string; summary?: string } };
			if (payload.kind === 'agentEvent' && payload.event) {
				const e = payload.event;
				if (e.type === 'plan') this.log(msg.from, 'updated its plan');
				else if (e.type === 'tool_start') this.log(msg.from, `→ ${e.name ?? 'tool'}`);
				else if (e.type === 'tool_end') this.log(msg.from, `✓ ${e.summary ?? ''}`);
				else if (e.type === 'final') this.log(msg.from, `done: ${e.text ?? ''}`);
				else if (e.type === 'error') this.log(msg.from, `error: ${e.text ?? ''}`);
			} else if (payload.status && statusEl) {
				statusEl.setText(payload.status);
				this.log(msg.from, `status: ${payload.status}`);
			} else {
				this.log(msg.from, truncateJson(msg.payload));
			}
		}
	}

	private renderFeed(): void {
		this.feedEl.empty();
		if (this.feed.length === 0) {
			this.feedEl.createEl('p', { text: 'No requests yet.', cls: 'auditor-field-description' });
			return;
		}
		for (const item of this.feed) this.renderFeedRow(item);
	}

	private renderFeedRow(item: FeedItem): void {
		const row = this.feedEl.createDiv(`auditor-swarm-feed-row is-${item.kind}`);
		const head = row.createDiv('auditor-swarm-feed-head');
		head.createSpan({ text: item.title, cls: 'auditor-swarm-feed-title' });
		const route = head.createSpan('auditor-swarm-feed-route');
		renderAgentBadge(route, item.from);
		route.createSpan({ text: ' → ' });
		if (item.to === '*') route.createSpan({ text: 'all' });
		else renderAgentBadge(route, item.to);
		head.createSpan({ text: new Date(item.at).toLocaleTimeString(), cls: 'auditor-swarm-feed-time' });
		head.addEventListener('click', () => {
			item.expanded = !item.expanded;
			detail.toggleClass('auditor-agent-hidden', !item.expanded);
		});
		const detail = row.createDiv('auditor-swarm-feed-detail auditor-agent-hidden');
		if (item.meta) detail.createEl('pre', { text: JSON.stringify(item.meta, null, 2) });
		detail.createEl('pre', { text: JSON.stringify(item.payload, null, 2) });
	}

	private renderDetail(): void {
		this.unsubscribeQueue?.();
		this.unsubscribeQueue = null;
		this.detailEl.empty();
		this.summaryEl = null;
		this.logListEl = null;
		this.controlStatusEl = null;
		if (!this.selected) {
			this.detailEl.createEl('p', { text: 'Select an agent to see its task list and activity.', cls: 'auditor-field-description' });
			return;
		}
		const header = this.detailEl.createDiv('auditor-swarm-detail-header');
		renderAgentBadge(header, this.selected);

		this.summaryEl = this.detailEl.createEl('p', { cls: 'auditor-swarm-node-summary' });
		const writer = this.plugin.swarm.getWriters().find((w) => w.agentId === this.selected);
		const specialistForSummary = this.plugin.swarm.getSpecialists().find((s) => s.agentId === this.selected);
		this.refreshSummary();

		if (writer) {
			const controls = this.detailEl.createDiv('auditor-swarm-controls');
			const stopBtn = controls.createEl('button', { text: 'Stop' });
			stopBtn.disabled = !writer.agent.isRunning;
			stopBtn.addEventListener('click', () => { writer.agent.stop(); });
			const steerRow = controls.createDiv('auditor-swarm-steer-row');
			const steerInput = steerRow.createEl('input', { type: 'text', placeholder: 'Send a message while it works…' });
			const sendBtn = steerRow.createEl('button', { text: 'Send' });
			const sendSteer = () => {
				const text = steerInput.value.trim();
				if (!text) return;
				writer.agent.steer(text);
				steerInput.value = '';
			};
			sendBtn.addEventListener('click', sendSteer);
			steerInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendSteer(); });
			this.renderTaskList(writer.queue);
		} else if (specialistForSummary) {
			this.renderTaskList(specialistForSummary.tasks);
		}

		if (this.selected === COORDINATOR_AGENT_ID) this.renderControlStatuses(this.detailEl);

		this.detailEl.createEl('h5', { text: 'Recent activity' });
		const lines = this.logs.get(this.selected) ?? [];
		this.logListEl = this.detailEl.createDiv('auditor-swarm-log');
		if (lines.length === 0) this.logListEl.createEl('p', { text: 'No activity yet.', cls: 'auditor-field-description' });
		for (const line of lines.slice().reverse()) this.logListEl.createDiv({ text: line, cls: 'auditor-swarm-log-line' });
	}

	/**
	 * Renders `queue`'s current tasks and keeps re-rendering while this node stays selected —
	 * `unsubscribeQueue` is torn down by `renderDetail` itself on the next selection change or view
	 * close. Also refreshes the status-summary paragraph on every change, so finishing one task (out
	 * of several assigned to this agent) updates the summary immediately rather than only once the
	 * whole batch ends.
	 */
	private renderTaskList(queue: TaskQueue<string>): void {
		this.detailEl.createEl('h5', { text: 'Task list' });
		const list = this.detailEl.createDiv('auditor-swarm-task-list');
		const draw = () => {
			list.empty();
			const tasks = queue.list();
			if (tasks.length === 0) {
				list.createEl('p', { text: 'Nothing queued.', cls: 'auditor-field-description' });
			} else {
				for (const task of tasks) {
					const row = list.createDiv(`auditor-swarm-task is-${task.status}`);
					row.createSpan({ text: String(task.payload), cls: 'auditor-swarm-task-label' });
					row.createSpan({ text: task.status, cls: 'auditor-swarm-task-status' });
					if (task.error) row.createSpan({ text: task.error, cls: 'auditor-swarm-task-error' });
				}
			}
			this.refreshSummary();
		};
		draw();
		this.unsubscribeQueue = queue.onChange(draw);
	}
}

function truncateJson(payload: unknown): string {
	const text = JSON.stringify(payload);
	return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}
