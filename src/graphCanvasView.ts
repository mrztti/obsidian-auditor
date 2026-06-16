import { ItemView, WorkspaceLeaf, type ViewStateResult } from 'obsidian';
import type AuditorPlugin from './main';

export const GRAPH_CANVAS_VIEW_TYPE = 'auditor-graph-canvas-view';

export interface GraphNodeDef {
	id: string;
	label: string;
	kind: 'phrase' | 'document';
	filePath?: string;
}

export interface GraphEdgeDef {
	source: string;
	target: string;
}

interface SimNode extends GraphNodeDef {
	x: number;
	y: number;
	vx: number;
	vy: number;
	fx: number | null;
	fy: number | null;
	r: number;
}

interface GraphCanvasState extends Record<string, unknown> {
	nodes: GraphNodeDef[];
	edges: GraphEdgeDef[];
}

const REPEL = 9000;
const SPRING = 0.006;
const SPRING_MARGIN = 120;
const CENTER_PULL = 0.006;
const DAMPING = 0.82;
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

// Document nodes are a fixed size. Phrase nodes always start bigger than any
// document node and grow with however many documents link to them.
const DOC_RADIUS = 7;
const PHRASE_MIN_RADIUS = 22;
const PHRASE_RADIUS_PER_DOC = 3.5;
const PHRASE_MAX_RADIUS = 70;
const DOC_LABEL_MAX_CHARS = 20;

function truncateLabel(label: string): string {
	return label.length > DOC_LABEL_MAX_CHARS ? `${label.slice(0, DOC_LABEL_MAX_CHARS)}...` : label;
}

/**
 * Renders an interactive, force-directed phrase/document graph in the main
 * workspace area, opened by GraphView's "Build graph" button. Obsidian's
 * native graph view isn't a public API plugins can embed, so this is a small
 * self-contained force simulation styled to match it: draggable nodes,
 * wheel-to-zoom, drag-to-pan, and hover highlighting of connected nodes.
 */
export class GraphCanvasView extends ItemView {
	private plugin: AuditorPlugin;
	private nodes: SimNode[] = [];
	private edges: GraphEdgeDef[] = [];
	private svg!: SVGSVGElement;
	private viewport!: SVGGElement;
	private nodeEls = new Map<string, SVGGElement>();
	private edgeEls = new Map<GraphEdgeDef, SVGLineElement>();
	private rafHandle: number | null = null;
	private scale = 1;
	private panX = 0;
	private panY = 0;
	private dragNode: SimNode | null = null;
	private panning = false;
	private lastPointer = { x: 0, y: 0 };
	private hoveredId: string | null = null;
	private isolatedId: string | null = null;
	private readonly onPointerMove = (e: PointerEvent): void => { this.handlePointerMove(e); };
	private readonly onPointerUp = (): void => { this.handlePointerUp(); };

	constructor(leaf: WorkspaceLeaf, plugin: AuditorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return GRAPH_CANVAS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Phrase graph';
	}

	getIcon(): string {
		return 'share-2';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-graph-canvas-container');

		this.svg = container.createSvg('svg', { cls: 'auditor-graph-canvas-svg' });
		this.viewport = this.svg.createSvg('g', { cls: 'auditor-graph-viewport' });

		this.svg.addEventListener('wheel', (e) => { this.handleWheel(e); }, { passive: false });
		this.svg.addEventListener('pointerdown', (e) => { this.handleBackgroundPointerDown(e); });
		window.addEventListener('pointermove', this.onPointerMove);
		window.addEventListener('pointerup', this.onPointerUp);

		if (this.nodes.length > 0) {
			this.renderSkeleton();
			this.startSimulation();
		}
	}

	async onClose(): Promise<void> {
		if (this.rafHandle !== null) window.cancelAnimationFrame(this.rafHandle);
		window.removeEventListener('pointermove', this.onPointerMove);
		window.removeEventListener('pointerup', this.onPointerUp);
	}

	getState(): GraphCanvasState {
		return {
			nodes: this.nodes.map(({ id, label, kind, filePath }) => ({ id, label, kind, filePath })),
			edges: this.edges,
		};
	}

	async setState(state: GraphCanvasState, result: ViewStateResult): Promise<void> {
		await super.setState(state, result);
		if (state?.nodes?.length) this.setGraphData(state.nodes, state.edges);
	}

	/** Entry point used by GraphView once a phrase search completes. */
	setGraphData(nodeDefs: GraphNodeDef[], edgeDefs: GraphEdgeDef[]): void {
		const width = this.svg?.clientWidth || 800;
		const height = this.svg?.clientHeight || 600;
		const cx = width / 2;
		const cy = height / 2;

		const connections = new Map<string, number>();
		for (const edge of edgeDefs) {
			connections.set(edge.source, (connections.get(edge.source) ?? 0) + 1);
			connections.set(edge.target, (connections.get(edge.target) ?? 0) + 1);
		}

		this.nodes = nodeDefs.map((n, i) => {
			const angle = (2 * Math.PI * i) / Math.max(nodeDefs.length, 1);
			const r = n.kind === 'document'
				? DOC_RADIUS
				: Math.min(PHRASE_MAX_RADIUS, PHRASE_MIN_RADIUS + (connections.get(n.id) ?? 0) * PHRASE_RADIUS_PER_DOC);
			return {
				...n,
				x: cx + Math.cos(angle) * 150 + (Math.random() - 0.5) * 30,
				y: cy + Math.sin(angle) * 150 + (Math.random() - 0.5) * 30,
				vx: 0,
				vy: 0,
				fx: null,
				fy: null,
				r,
			};
		});
		this.edges = edgeDefs;
		this.isolatedId = null;

		if (this.svg) {
			this.renderSkeleton();
			this.startSimulation();
		}
	}

	/** (Re)builds the DOM nodes/edges; physics positions are written every tick. */
	private renderSkeleton(): void {
		this.viewport.empty();
		this.nodeEls.clear();
		this.edgeEls.clear();

		for (const edge of this.edges) {
			const line = this.viewport.createSvg('line', { cls: 'auditor-graph-edge' });
			this.edgeEls.set(edge, line);
		}

		for (const node of this.nodes) {
			const group = this.viewport.createSvg('g', {
				cls: ['auditor-graph-node', `auditor-graph-node-${node.kind}`],
			});
			group.createSvg('circle', { attr: { r: String(node.r) } });
			const text = group.createSvg('text', { attr: { y: String(-(node.r + 6)) } });
			text.textContent = node.kind === 'document' ? truncateLabel(node.label) : node.label;

			group.addEventListener('pointerdown', (e) => { this.handleNodePointerDown(e, node); });
			group.addEventListener('pointerenter', () => { this.setHovered(node.id); });
			group.addEventListener('pointerleave', () => { this.setHovered(null); });
			if (node.kind === 'document' && node.filePath) {
				group.addEventListener('click', () => {
					const file = this.app.vault.getFileByPath(node.filePath!);
					if (file) void this.app.workspace.getLeaf(false).openFile(file);
				});
			}
			if (node.kind === 'phrase') {
				group.addEventListener('dblclick', (e) => {
					e.stopPropagation();
					this.toggleIsolate(node.id);
				});
			}
			this.nodeEls.set(node.id, group);
		}
		this.applyTransform();
		this.applyIsolation();
	}

	/** Double-clicking a phrase node isolates its connected subgraph; double-clicking again restores the full graph. */
	private toggleIsolate(id: string): void {
		this.isolatedId = this.isolatedId === id ? null : id;
		this.applyIsolation();
	}

	private connectedTo(id: string): Set<string> {
		const connected = new Set<string>([id]);
		for (const edge of this.edges) {
			if (edge.source === id) connected.add(edge.target);
			if (edge.target === id) connected.add(edge.source);
		}
		return connected;
	}

	private applyIsolation(): void {
		const id = this.isolatedId;
		const connected = id ? this.connectedTo(id) : null;
		for (const [nodeId, el] of this.nodeEls) {
			el.classList.toggle('is-isolated-out', connected !== null && !connected.has(nodeId));
		}
		for (const [edge, el] of this.edgeEls) {
			const touches = id !== null && (edge.source === id || edge.target === id);
			el.classList.toggle('is-isolated-out', connected !== null && !touches);
		}
	}

	private setHovered(id: string | null): void {
		this.hoveredId = id;
		const connected = new Set<string>();
		if (id) {
			connected.add(id);
			for (const edge of this.edges) {
				if (edge.source === id) connected.add(edge.target);
				if (edge.target === id) connected.add(edge.source);
			}
		}
		for (const [nodeId, el] of this.nodeEls) {
			const isHovered = nodeId === id;
			el.classList.toggle('is-dimmed', id !== null && !connected.has(nodeId));
			el.classList.toggle('is-hovered', isHovered);
			const node = this.nodes.find((n) => n.id === nodeId);
			const circle = el.querySelector('circle');
			if (node && circle) circle.setAttribute('r', String(isHovered ? node.r * 1.25 : node.r));
			if (node?.kind === 'document') {
				const text = el.querySelector('text');
				if (text) text.textContent = isHovered ? node.label : truncateLabel(node.label);
			}
		}
		for (const [edge, el] of this.edgeEls) {
			const touches = id !== null && (edge.source === id || edge.target === id);
			el.classList.toggle('is-dimmed', id !== null && !touches);
			el.classList.toggle('is-hovered', touches);
		}
	}

	private startSimulation(): void {
		if (this.rafHandle !== null) return;
		const tick = () => {
			const settled = this.step();
			this.draw();
			if (!settled || this.dragNode) {
				this.rafHandle = window.requestAnimationFrame(tick);
			} else {
				this.rafHandle = null;
			}
		};
		this.rafHandle = window.requestAnimationFrame(tick);
	}

	/** One physics step. Returns true once the layout has settled. */
	private step(): boolean {
		const { nodes, edges } = this;
		for (let i = 0; i < nodes.length; i++) {
			const a = nodes[i]!;
			if (a.fx !== null) continue;
			for (let j = i + 1; j < nodes.length; j++) {
				const b = nodes[j]!;
				const dx = a.x - b.x;
				const dy = a.y - b.y;
				const minDist = a.r + b.r;
				const distSq = Math.max(dx * dx + dy * dy, minDist * minDist * 0.25);
				const force = (REPEL * (1 + (a.r + b.r) / 40)) / distSq;
				const dist = Math.sqrt(distSq);
				const fx = (dx / dist) * force;
				const fy = (dy / dist) * force;
				a.vx += fx;
				a.vy += fy;
				if (b.fx === null) {
					b.vx -= fx;
					b.vy -= fy;
				}
			}
		}

		for (const edge of edges) {
			const a = this.nodes.find((n) => n.id === edge.source);
			const b = this.nodes.find((n) => n.id === edge.target);
			if (!a || !b) continue;
			const dx = b.x - a.x;
			const dy = b.y - a.y;
			const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
			const restLength = a.r + b.r + SPRING_MARGIN;
			const force = SPRING * (dist - restLength);
			const fx = (dx / dist) * force;
			const fy = (dy / dist) * force;
			if (a.fx === null) { a.vx += fx; a.vy += fy; }
			if (b.fx === null) { b.vx -= fx; b.vy -= fy; }
		}

		const width = this.svg.clientWidth || 800;
		const height = this.svg.clientHeight || 600;
		const cx = width / 2;
		const cy = height / 2;

		let maxSpeed = 0;
		for (const n of nodes) {
			if (n.fx !== null) {
				n.x = n.fx;
				n.y = n.fy!;
				n.vx = 0;
				n.vy = 0;
				continue;
			}
			n.vx += (cx - n.x) * CENTER_PULL;
			n.vy += (cy - n.y) * CENTER_PULL;
			n.vx *= DAMPING;
			n.vy *= DAMPING;
			n.x += n.vx;
			n.y += n.vy;
			maxSpeed = Math.max(maxSpeed, Math.abs(n.vx), Math.abs(n.vy));
		}
		return maxSpeed < 0.05;
	}

	private draw(): void {
		for (const node of this.nodes) {
			const el = this.nodeEls.get(node.id);
			el?.setAttribute('transform', `translate(${node.x},${node.y})`);
		}
		for (const edge of this.edges) {
			const a = this.nodes.find((n) => n.id === edge.source);
			const b = this.nodes.find((n) => n.id === edge.target);
			const el = this.edgeEls.get(edge);
			if (!a || !b || !el) continue;
			el.setAttribute('x1', String(a.x));
			el.setAttribute('y1', String(a.y));
			el.setAttribute('x2', String(b.x));
			el.setAttribute('y2', String(b.y));
		}
	}

	private applyTransform(): void {
		this.viewport.setAttribute('transform', `translate(${this.panX},${this.panY}) scale(${this.scale})`);
	}

	private toGraphSpace(screenX: number, screenY: number): { x: number; y: number } {
		const rect = this.svg.getBoundingClientRect();
		return {
			x: (screenX - rect.left - this.panX) / this.scale,
			y: (screenY - rect.top - this.panY) / this.scale,
		};
	}

	private handleWheel(e: WheelEvent): void {
		e.preventDefault();
		const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
		const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
		const rect = this.svg.getBoundingClientRect();
		const px = e.clientX - rect.left;
		const py = e.clientY - rect.top;
		this.panX = px - ((px - this.panX) * newScale) / this.scale;
		this.panY = py - ((py - this.panY) * newScale) / this.scale;
		this.scale = newScale;
		this.applyTransform();
	}

	private handleBackgroundPointerDown(e: PointerEvent): void {
		if (this.dragNode) return;
		this.panning = true;
		this.lastPointer = { x: e.clientX, y: e.clientY };
	}

	private handleNodePointerDown(e: PointerEvent, node: SimNode): void {
		e.stopPropagation();
		this.dragNode = node;
		const { x, y } = this.toGraphSpace(e.clientX, e.clientY);
		node.fx = x;
		node.fy = y;
		this.startSimulation();
	}

	private handlePointerMove(e: PointerEvent): void {
		if (this.dragNode) {
			const { x, y } = this.toGraphSpace(e.clientX, e.clientY);
			this.dragNode.fx = x;
			this.dragNode.fy = y;
			return;
		}
		if (this.panning) {
			this.panX += e.clientX - this.lastPointer.x;
			this.panY += e.clientY - this.lastPointer.y;
			this.lastPointer = { x: e.clientX, y: e.clientY };
			this.applyTransform();
		}
	}

	private handlePointerUp(): void {
		if (this.dragNode) {
			this.dragNode.fx = null;
			this.dragNode.fy = null;
			this.dragNode = null;
		}
		this.panning = false;
	}
}
