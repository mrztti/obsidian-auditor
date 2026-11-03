import type { ControlRecord } from './controlNote';

type Rating = 'C' | 'C*' | 'NC' | 'Not rated';
type Stage = 'todRating' | 'toeRating';

const RATINGS: Rating[] = ['C', 'C*', 'NC', 'Not rated'];
const STAGES: { key: Stage; label: string }[] = [
	{ key: 'todRating', label: 'Stage 1' },
	{ key: 'toeRating', label: 'Stage 2' },
];
const RATING_COLOR: Record<Rating, string> = {
	C: 'var(--color-green, #4caf50)',
	'C*': 'var(--color-blue, #2196f3)',
	NC: 'var(--color-red, #e53935)',
	'Not rated': 'var(--text-faint)',
};
const NO_SESSION = 'No session';
const SVG_SIZE = 42;
const RADIUS = 15.9155; // circumference = 100, so dash lengths read directly as percentages
const STROKE = 4.2;

type Counts = Record<Rating, number>;

/** Counts how many of `records` carry each rating in `stage`; an empty rating counts as "Not rated", while "-" (explicitly not applicable) is left out. */
function tally(records: ControlRecord[], stage: Stage): Counts {
	const counts: Counts = { C: 0, 'C*': 0, NC: 0, 'Not rated': 0 };
	for (const record of records) {
		const value = record[stage];
		if (value === 'C' || value === 'C*' || value === 'NC') counts[value]++;
		else if (value === '') counts['Not rated']++;
	}
	return counts;
}

function circle(svg: SVGElement, color: string, dash?: { share: number; offset: number }): void {
	const el = svg.createSvg('circle', { attr: { cx: String(SVG_SIZE / 2), cy: String(SVG_SIZE / 2), r: String(RADIUS), fill: 'none', 'stroke-width': String(STROKE) } });
	el.style.stroke = color;
	if (dash) {
		el.setAttribute('stroke-dasharray', `${dash.share} ${100 - dash.share}`);
		el.setAttribute('stroke-dashoffset', String(dash.offset));
	}
}

function renderStageChart(parent: HTMLElement, label: string, counts: Counts, size: 'large' | 'small'): void {
	const total = RATINGS.reduce((sum, r) => sum + counts[r], 0);
	const chart = parent.createDiv(`auditor-dash-chart auditor-dash-chart-${size}`);
	chart.createDiv({ text: label, cls: 'auditor-dash-chart-label' });

	const donut = chart.createDiv('auditor-dash-donut');
	const svg = donut.createSvg('svg', { attr: { viewBox: `0 0 ${SVG_SIZE} ${SVG_SIZE}`, width: '100%', height: '100%' } });
	circle(svg, 'var(--background-modifier-border)');
	let offset = 25; // start at 12 o'clock
	for (const rating of RATINGS) {
		if (counts[rating] === 0) continue;
		const share = (counts[rating] / total) * 100;
		circle(svg, RATING_COLOR[rating], { share, offset });
		offset -= share;
	}
	const centre = donut.createDiv('auditor-dash-donut-centre');
	centre.createDiv({ text: String(total), cls: 'auditor-dash-donut-total' });

	const legend = chart.createDiv('auditor-dash-legend');
	for (const rating of RATINGS) {
		const row = legend.createDiv('auditor-dash-legend-row');
		row.createSpan({ cls: 'auditor-dash-dot' }).style.background = RATING_COLOR[rating];
		row.createSpan({ text: rating, cls: 'auditor-dash-legend-label' });
		row.createSpan({ text: String(counts[rating]), cls: 'auditor-dash-legend-count' });
	}
}

function renderCard(parent: HTMLElement, title: string, records: ControlRecord[], size: 'large' | 'small', cls = ''): void {
	const card = parent.createDiv(`auditor-dash-card ${cls}`.trim());
	card.createEl('h3', { text: title, cls: 'auditor-dash-card-title' });
	const charts = card.createDiv('auditor-dash-charts');
	for (const stage of STAGES) renderStageChart(charts, stage.label, tally(records, stage.key), size);
}

function sessionSort(a: string, b: string): number {
	if (a === NO_SESSION) return 1;
	if (b === NO_SESSION) return -1;
	return a.localeCompare(b, undefined, { numeric: true });
}

/** Renders the rating dashboard into `container` (emptied first): an all-sessions card, then one card per session — each with separate Stage 1 and Stage 2 charts. */
export function renderControlsDashboard(container: HTMLElement, records: ControlRecord[]): void {
	container.empty();
	renderCard(container, 'All sessions', records, 'large', 'auditor-dash-card-overall');

	const bySession = new Map<string, ControlRecord[]>();
	for (const record of records) {
		const key = record.session.trim() || NO_SESSION;
		const list = bySession.get(key);
		if (list) list.push(record);
		else bySession.set(key, [record]);
	}
	const grid = container.createDiv('auditor-dash-grid');
	for (const session of [...bySession.keys()].sort(sessionSort)) {
		renderCard(grid, session === NO_SESSION ? session : `Session ${session}`, bySession.get(session) ?? [], 'small');
	}
}
