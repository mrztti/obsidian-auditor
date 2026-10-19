/** Every distinct agent *type* in the swarm (writers share one type/color regardless of pool index) — used to keep one consistent color per role everywhere an agent's name is shown. */
export type AgentType = 'coordinator' | 'writer' | 'evidence-reader' | 'standards-reader' | 'controls-reader' | 'verifier';

/** Maps a concrete `agentId` (e.g. "writer-2") to its type/color key — all writers share "writer" since the pool is one role played by several instances. */
export function agentTypeOf(agentId: string): AgentType {
	if (agentId === 'coordinator') return 'coordinator';
	if (agentId.startsWith('writer-')) return 'writer';
	if (agentId === 'evidence-reader') return 'evidence-reader';
	if (agentId === 'standards-reader') return 'standards-reader';
	if (agentId === 'controls-reader') return 'controls-reader';
	return 'verifier';
}

const READABLE_LABEL: Record<AgentType, string> = {
	coordinator: 'Coordinator',
	writer: 'Writer',
	'evidence-reader': 'Evidence reader',
	'standards-reader': 'Standards reader',
	'controls-reader': 'Controls reader',
	verifier: 'Verifier',
};

/**
 * A human-readable label for `agentId` — "Writer 1" rather than "writer-1", "Evidence reader"
 * rather than "evidence-reader". Falls back to the raw id for anything unrecognized.
 */
export function agentLabel(agentId: string): string {
	const type = agentTypeOf(agentId);
	if (type === 'writer') {
		const n = agentId.split('-')[1];
		return n ? `Writer ${n}` : agentId;
	}
	return READABLE_LABEL[type] ?? agentId;
}

/**
 * Appends a small colored badge for `agentId`, colored by its type (`styles.css`'s
 * `.auditor-agent-badge.type-*` rules) — the one place that renders an agent's name, so every
 * mention of it (graph nodes, the activity feed, task lists, the outbox) uses the same color. Shows
 * the human-readable label (`agentLabel`) by default; pass `text` to show something else (e.g. the
 * raw id) while keeping the same color.
 */
export function renderAgentBadge(parent: HTMLElement, agentId: string, text?: string, cls = ''): HTMLElement {
	return parent.createSpan({ text: text ?? agentLabel(agentId), cls: `auditor-agent-badge type-${agentTypeOf(agentId)}${cls ? ` ${cls}` : ''}` });
}
