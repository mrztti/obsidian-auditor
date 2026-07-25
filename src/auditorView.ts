import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from './main';
import type { StoreKind } from './main';
import type { ControlAnalysis, FinalizationPlan, ResearchAssessment } from './geminiGenerate';
import type { IndexSummary, SearchResult } from './vectorStore';
import type { ThroughputSample } from './rateLimiter';
import {
	emptyControlRecord,
	buildControlNoteContent,
	parseControlNoteContent,
	sanitizeFileTitle,
	statusSlug,
	type ControlRecord,
} from './controlNote';
import { renderControlRecordFields } from './controlFields';
import { EditControlModal } from './editControlModal';
import { ImportControlsModal } from './importControlsModal';

const GRAPH_WINDOW_SECONDS = 60;

export const AUDITOR_VIEW_TYPE = 'auditor-main-view';

type TabName = 'indexes' | 'search' | 'pipeline' | 'controls';

const TAB_LABELS: Record<TabName, string> = {
	indexes: 'Indexes',
	search: 'Document search',
	pipeline: 'Control drafting',
	controls: 'Controls',
};

const DEFAULT_SEARCH_TOP_K = 20;

interface StepLogEntry {
	label: string;
	timestamp: number;
}

interface PipelineState {
	controlInput: string;
	standardsResults: SearchResult[];
	analysis: ControlAnalysis | null;
	targetSelection: Set<number>;
	/** Evidence RAG results per target-document index, from the "Search for documents" step — accumulates across retries. */
	evidenceFindings: Map<number, SearchResult[]>;
	researchAssessment: ResearchAssessment | null;
	/** Prior research assessments, oldest first, kept so "Retry with feedback" can show its own history. */
	researchHistory: ResearchAssessment[];
	/** The running "current memory" carried between steps — starts as the Step 2 memorySummary, then is overwritten by each research assessment's updatedMemory. */
	currentMemory: string;
	userFeedback: string;
	userFeedbackHistory: string[];
	similarResults: SearchResult[];
	selectedSimilar: Set<number>;
	finalizationPlan: FinalizationPlan | null;
	/** Indices into the combined (evidence + selected-controls) list built for finalization, checked = included in the final draft. */
	selectedFinalItems: Set<number>;
	writingRules: string;
	finalizationGuidance: string;
	/** The drafted control record; `control` is seeded from the pipeline input, ToD fields from the drafting model, everything else filled in manually before saving. */
	draftRecord: ControlRecord;
	stepsPerformed: StepLogEntry[];
}

function emptyPipelineState(controlInput: string, defaultWritingRules: string): PipelineState {
	return {
		controlInput,
		standardsResults: [],
		analysis: null,
		targetSelection: new Set(),
		evidenceFindings: new Map(),
		researchAssessment: null,
		researchHistory: [],
		currentMemory: '',
		userFeedback: '',
		userFeedbackHistory: [],
		similarResults: [],
		selectedSimilar: new Set(),
		finalizationPlan: null,
		selectedFinalItems: new Set(),
		writingRules: defaultWritingRules,
		finalizationGuidance: '',
		draftRecord: { ...emptyControlRecord(), control: controlInput },
		stepsPerformed: [],
	};
}

/** Combined (evidence + selected-controls) list used for the Finalizing step's checklist, in a stable index order. */
interface FinalizationCandidate {
	index: number;
	label: string;
	kind: 'evidence' | 'control';
	text: string;
	result: SearchResult;
}

function buildFinalizationCandidates(state: PipelineState): FinalizationCandidate[] {
	const evidenceItems = [...state.evidenceFindings.values()].flat();
	const controlItems = state.similarResults.filter((_, i) => state.selectedSimilar.has(i));
	let index = 0;
	const candidates: FinalizationCandidate[] = [];
	for (const result of evidenceItems) {
		candidates.push({ index: index++, label: sourceLabel(result), kind: 'evidence', text: result.text, result });
	}
	for (const result of controlItems) {
		candidates.push({ index: index++, label: sourceLabel(result), kind: 'control', text: result.text, result });
	}
	return candidates;
}

const SEARCH_STORE_LABELS: Record<StoreKind, string> = {
	standards: 'Standards',
	evidence: 'Evidence',
	writtenControls: 'Written controls',
};

function sourceLabel(result: SearchResult): string {
	if (result.page !== undefined) return `${result.sourcePath} (p. ${result.page})`;
	if (result.line !== undefined) return `${result.sourcePath} (L${result.line})`;
	return result.sourcePath;
}

/** Builds the text passed downstream (similar-controls search, draft prompt) from the structured Step 1 analysis. */
function buildControlUnderstandingText(state: PipelineState): string {
	const analysis = state.analysis;
	if (!analysis) return '';
	const selectedText = analysis.selected
		.map((s) => {
			const result = state.standardsResults[s.index];
			const loc = result ? sourceLabel(result) : '';
			const clause = s.controlNumber ? ` (${s.controlNumber})` : '';
			return `[${loc}]${clause} ${s.excerpt}`;
		})
		.join('\n\n');
	const refsText = analysis.references
		.map((r) => `${r.standardName}${r.controlNumber ? ` ${r.controlNumber}` : ''}: ${r.excerpt}`)
		.join('\n');
	const memory = state.currentMemory || analysis.memorySummary;
	return [
		selectedText,
		refsText ? `Referenced standards:\n${refsText}` : '',
		memory ? `Requirements to verify:\n${memory}` : '',
	].filter(Boolean).join('\n\n');
}

/** Concatenates evidence findings per target document, for the research-progress assessment call. */
function buildFindingsText(state: PipelineState): string {
	if (!state.analysis) return '';
	const parts: string[] = [];
	for (const [docIndex, results] of state.evidenceFindings) {
		const doc = state.analysis.targetDocuments[docIndex];
		if (!doc) continue;
		const resultsText = results.length > 0
			? results.map((r) => `- [${sourceLabel(r)}] ${r.text}`).join('\n')
			: '(no results found)';
		parts.push(`## ${doc.file}\n${resultsText}`);
	}
	return parts.join('\n\n');
}

/**
 * Single full-tab view with three tabs: re-indexing controls, a one-shot Document search
 * (keyword synthesis → RAG → LLM reranking with thinking), and the manual
 * control-drafting pipeline.
 */
export class AuditorView extends ItemView {
	private plugin: AuditorPlugin;
	private pipelineEl!: HTMLElement;
	private pipelineHistoryEl!: HTMLElement;
	private pipelineState: PipelineState = emptyPipelineState('', '');
	private searchStoreKind: StoreKind = 'evidence';
	private unsubscribeThroughput: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: AuditorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return AUDITOR_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Auditor';
	}

	getIcon(): string {
		return 'search';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-view-container');
		container.createEl('h3', { text: 'Auditor' });

		const tabBar = container.createDiv('auditor-tab-bar');
		const tabContents: Record<TabName, HTMLElement> = {
			indexes: container.createDiv('auditor-tab-content'),
			search: container.createDiv('auditor-tab-content'),
			pipeline: container.createDiv('auditor-tab-content'),
			controls: container.createDiv('auditor-tab-content'),
		};

		const tabButtons: Record<TabName, HTMLButtonElement> = {} as Record<TabName, HTMLButtonElement>;
		const setActiveTab = (name: TabName) => {
			(Object.keys(tabContents) as TabName[]).forEach((key) => {
				tabContents[key].toggleClass('auditor-tab-hidden', key !== name);
				tabButtons[key].toggleClass('is-active', key === name);
			});
		};

		(Object.keys(TAB_LABELS) as TabName[]).forEach((name) => {
			const btn = tabBar.createEl('button', { text: TAB_LABELS[name], cls: 'auditor-tab-btn' });
			btn.addEventListener('click', () => { setActiveTab(name); });
			tabButtons[name] = btn;
		});

		this.renderIndexesTab(tabContents.indexes);
		this.renderSearchTab(tabContents.search);
		this.pipelineEl = tabContents.pipeline;
		this.renderPipelineStart();
		this.renderControlsTab(tabContents.controls);

		setActiveTab('indexes');
	}

	async onClose(): Promise<void> {
		this.unsubscribeThroughput?.();
	}

	// ─── Indexes tab ────────────────────────────────────────────────────────

	private renderIndexesTab(container: HTMLElement): void {
		const reindexRow = container.createDiv('auditor-reindex-row');
		this.createReindexButton(reindexRow, 'Re-index standards', 'standards');
		this.createReindexButton(reindexRow, 'Re-index evidence', 'evidence');
		this.createReindexButton(reindexRow, 'Re-index written controls', 'writtenControls');

		const rateRow = container.createDiv('auditor-rate-row');
		const rampLabel = rateRow.createEl('label', { cls: 'auditor-search-store-option' });
		const rampToggle = rampLabel.createEl('input', { type: 'checkbox' });
		rampToggle.checked = this.plugin.settings.gradualRampUp;
		rampToggle.addEventListener('change', () => {
			void (async () => {
				this.plugin.settings.gradualRampUp = rampToggle.checked;
				this.plugin.rateLimiter.updateConfig(this.plugin.settings.maxRequestsPerSecond, rampToggle.checked);
				await this.plugin.saveSettings();
			})();
		});
		rampLabel.createSpan({ text: 'Gradual increase (ramp up request rate instead of starting at full speed)' });

		this.renderThroughputGraph(container);
	}

	/** Small live graph of embedding-call network throughput (KB/s) and request rate, fed by the shared RateLimiter. */
	private renderThroughputGraph(container: HTMLElement): void {
		const graphEl = container.createDiv('auditor-throughput-graph');
		const statsEl = graphEl.createDiv('auditor-throughput-stats');
		const svgNs = 'http://www.w3.org/2000/svg';
		const svg = graphEl.doc.createElementNS(svgNs, 'svg');
		svg.setAttribute('viewBox', '0 0 300 60');
		svg.addClass('auditor-throughput-svg');
		const requestsPath = graphEl.doc.createElementNS(svgNs, 'polyline');
		requestsPath.addClass('auditor-throughput-line-requests');
		const kbPath = graphEl.doc.createElementNS(svgNs, 'polyline');
		kbPath.addClass('auditor-throughput-line-tokens');
		svg.appendChild(kbPath);
		svg.appendChild(requestsPath);
		graphEl.appendChild(svg);

		const legend = graphEl.createDiv('auditor-throughput-legend');
		legend.createSpan({ text: '— requests/s', cls: 'auditor-throughput-legend-requests' });
		legend.createSpan({ text: '— KB/s', cls: 'auditor-throughput-legend-tokens' });

		const draw = () => {
			const samples = this.plugin.rateLimiter.getSamples().slice(-GRAPH_WINDOW_SECONDS);
			if (samples.length === 0) {
				statsEl.setText('No embedding activity yet.');
				requestsPath.setAttribute('points', '');
				kbPath.setAttribute('points', '');
				return;
			}

			const kbPerSecond = samples.map((s) => s.bytes / 1024);
			const maxRequests = Math.max(1, ...samples.map((s) => s.requests));
			const maxKb = Math.max(1, ...kbPerSecond);
			const toPoints = (values: number[], maxY: number) =>
				values
					.map((v, i) => {
						const x = (i / Math.max(1, GRAPH_WINDOW_SECONDS - 1)) * 300;
						const y = 58 - (v / maxY) * 56;
						return `${x.toFixed(1)},${y.toFixed(1)}`;
					})
					.join(' ');
			// Left-pad so the line always ends at the right edge, growing from an empty window.
			const padded: ThroughputSample[] = [
				...Array<ThroughputSample | null>(Math.max(0, GRAPH_WINDOW_SECONDS - samples.length)).fill(null),
				...samples,
			].map((s) => s ?? { time: 0, requests: 0, tokens: 0, bytes: 0 });
			requestsPath.setAttribute('points', toPoints(padded.map((s) => s.requests), maxRequests));
			kbPath.setAttribute('points', toPoints(padded.map((s) => s.bytes / 1024), maxKb));

			const last = samples[samples.length - 1]!;
			statsEl.setText(`${last.requests} req/s, ${(last.bytes / 1024).toFixed(1)} KB/s`);
		};

		draw();
		this.unsubscribeThroughput?.();
		this.unsubscribeThroughput = this.plugin.rateLimiter.onChange(draw);
	}

	private createReindexButton(container: HTMLElement, label: string, kind: StoreKind): void {
		const wrapper = container.createDiv('auditor-reindex-item');
		const btn = wrapper.createEl('button', { text: label, cls: 'mod-muted' });
		const status = wrapper.createDiv('auditor-reindex-status');

		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				status.setText('Starting…');
				const summary = await this.plugin.runIndexing(kind, (done, total, indexLabel) => {
					status.setText(`${indexLabel} (${done}/${total})`);
				});
				btn.disabled = false;
				status.setText(summary ? this.formatSummary(summary) : 'Indexing failed — see notice.');
			})();
		});
	}

	/** Recap text: how many files were newly indexed vs. skipped, and why. */
	private formatSummary(summary: IndexSummary): string {
		const parts = [`${summary.indexed} indexed`, `${summary.skippedUnchanged} unchanged (skipped)`];
		if (summary.skippedUnreadable > 0) parts.push(`${summary.skippedUnreadable} unreadable (skipped)`);
		if (summary.removed > 0) parts.push(`${summary.removed} removed`);
		const prefix = summary.cancelled ? 'Cancelled — ' : '';
		return `${prefix}${summary.totalFiles} files: ${parts.join(', ')}.`;
	}

	// ─── Document search tab ────────────────────────────────────────────────

	private renderSearchTab(container: HTMLElement): void {
		const promptEl = container.createEl('textarea', { cls: 'auditor-pipeline-textarea' });
		promptEl.rows = 3;
		promptEl.placeholder = 'What are you looking for?';

		const controlsRow = container.createDiv('auditor-search-controls-row');

		const storeRow = controlsRow.createDiv('auditor-search-store-row');
		(['standards', 'evidence', 'writtenControls'] as StoreKind[]).forEach((kind) => {
			const label = storeRow.createEl('label', { cls: 'auditor-search-store-option' });
			const radio = label.createEl('input', { type: 'radio', attr: { name: 'auditor-search-store' } });
			radio.checked = kind === this.searchStoreKind;
			radio.addEventListener('change', () => { if (radio.checked) this.searchStoreKind = kind; });
			label.createSpan({ text: SEARCH_STORE_LABELS[kind] });
		});

		const topKWrapper = controlsRow.createDiv('auditor-search-topk');
		topKWrapper.createSpan({ text: 'Top K:' });
		const topKInput = topKWrapper.createEl('input', { type: 'number' });
		topKInput.value = String(DEFAULT_SEARCH_TOP_K);
		topKInput.min = '1';
		topKInput.max = '50';

		const searchBtn = container.createEl('button', { text: 'Search', cls: 'mod-cta' });
		const resultsEl = container.createDiv('auditor-search-results');

		searchBtn.addEventListener('click', () => {
			const prompt = promptEl.value.trim();
			if (!prompt) return;
			const topK = Math.max(1, Number(topKInput.value) || DEFAULT_SEARCH_TOP_K);
			void this.runDocumentSearch(prompt, this.searchStoreKind, topK, searchBtn, resultsEl);
		});
	}

	/** Full automatic chain: keyword synthesis → RAG search → LLM reranking (structured output + thinking). */
	private async runDocumentSearch(
		prompt: string,
		storeKind: StoreKind,
		topK: number,
		searchBtn: HTMLButtonElement,
		resultsEl: HTMLElement,
	): Promise<void> {
		resultsEl.empty();
		searchBtn.disabled = true;
		const status = this.showStatus(resultsEl, 'Generating search keywords…');
		try {
			const keywords = await this.plugin.geminiGenerate.generateSearchKeywords(prompt);

			const keywordsEl = resultsEl.createDiv('auditor-search-keywords');
			keywordsEl.createEl('h5', { text: 'Search description' });
			keywordsEl.createEl('p', { text: keywords, cls: 'auditor-status' });

			status.setText('Searching…');
			const store = this.plugin.storeFor(storeKind);
			const results = await store.search(keywords, topK);

			if (results.length === 0) {
				status.setText('No results found.');
				searchBtn.disabled = false;
				return;
			}

			status.setText('Asking Gemini to select the most relevant snippets…');
			const rerank = await this.plugin.geminiGenerate.rerankSnippets(
				prompt,
				results.map((r, i) => ({ index: i, label: sourceLabel(r), text: r.text })),
			);
			status.remove();

			this.renderThinking(resultsEl, rerank.thinking);

			if (rerank.response) {
				const responseEl = resultsEl.createDiv('auditor-search-response');
				responseEl.createEl('h5', { text: 'Answer' });
				responseEl.createEl('p', { text: rerank.response });
			}

			const relevantResults = rerank.relevant
				.map(({ index, excerpt, reason }) => ({ result: results[index], excerpt, reason }))
				.filter((r): r is { result: SearchResult; excerpt: string; reason: string } => r.result !== undefined);

			if (relevantResults.length > 0) {
				const filesEl = resultsEl.createDiv('auditor-search-files');
				filesEl.createEl('h5', { text: 'Files' });
				const uniquePaths = [...new Set(relevantResults.map((r) => r.result.sourcePath))];
				const filesList = filesEl.createDiv('auditor-search-files-list');
				for (const path of uniquePaths) {
					const file = this.app.vault.getFileByPath(path);
					if (!file) {
						filesList.createDiv({ text: path, cls: 'auditor-search-file-item' });
						continue;
					}
					const link = filesList.createEl('a', { text: path, cls: 'auditor-search-file-item auditor-file-link' });
					link.addEventListener('click', (e) => {
						e.preventDefault();
						void this.app.workspace.getLeaf('tab').openFile(file);
					});
				}
			}

			const list = resultsEl.createDiv('auditor-results');
			if (relevantResults.length === 0) {
				this.showStatus(list, 'Gemini found no relevant snippets among the retrieved results.');
			}
			for (const { result, excerpt, reason } of relevantResults) {
				const card = list.createDiv('auditor-evidence-chip');
				const main = card.createDiv('auditor-evidence-chip-main');
				this.createFileLink(main, result);
				main.createEl('p', { text: reason, cls: 'auditor-evidence-chip-reason' });
				main.createEl('p', { text: excerpt || result.text, cls: 'auditor-evidence-chip-passage' });
			}
		} catch (e) {
			status.setText(`Search failed: ${String(e)}`);
		} finally {
			searchBtn.disabled = false;
		}
	}

	/** Source label that opens the underlying file in a new tab when clicked. */
	private createFileLink(container: HTMLElement, result: SearchResult): void {
		const text = `${sourceLabel(result)} (${(result.score * 100).toFixed(0)}%)`;
		const file = this.app.vault.getFileByPath(result.sourcePath);
		if (!file) {
			container.createSpan({ text, cls: 'auditor-evidence-chip-label' });
			return;
		}
		const link = container.createEl('a', { text, cls: 'auditor-evidence-chip-label auditor-file-link' });
		link.addEventListener('click', (e) => {
			e.preventDefault();
			void this.app.workspace.getLeaf('tab').openFile(file);
		});
	}

	/** Renders a collapsed-by-default "Model reasoning" block from a thought summary, if present. */
	private renderThinking(container: HTMLElement, thinking: string): void {
		if (!thinking) return;
		const thinkingEl = container.createEl('details', { cls: 'auditor-thinking' });
		thinkingEl.createEl('summary', { text: 'Model reasoning' });
		thinkingEl.createEl('p', { text: thinking, cls: 'auditor-thinking-text' });
	}

	// ─── Control-drafting pipeline tab ──────────────────────────────────────

	/** Step 1: free-text control/requirement input. */
	private renderPipelineStart(): void {
		this.pipelineEl.empty();
		this.pipelineHistoryEl = this.pipelineEl.createEl('details', { cls: 'auditor-thinking' });
		this.pipelineHistoryEl.createEl('summary', { text: 'Pipeline history' });
		this.renderStepsLog();

		const step = this.pipelineEl.createDiv('auditor-pipeline-step');
		step.createEl('h4', { text: '1. Audit control / requirement' });

		const input = step.createEl('textarea', { cls: 'auditor-pipeline-textarea' });
		input.rows = 3;
		input.placeholder = 'Paste or describe the audit control / requirement to draft…';
		input.value = this.pipelineState.controlInput;

		const startBtn = step.createEl('button', { text: 'Search standards', cls: 'mod-cta' });
		startBtn.addEventListener('click', () => {
			this.pipelineState = emptyPipelineState(input.value.trim(), this.plugin.settings.defaultWritingRules);
			if (!this.pipelineState.controlInput) return;
			this.logStep(`Started pipeline for: "${this.pipelineState.controlInput}"`);
			void this.runStandardsAnalysis();
		});
	}

	private clearStepsAfter(step: number): void {
		const steps = this.pipelineEl.querySelectorAll('.auditor-pipeline-step');
		steps.forEach((el, i) => {
			if (i > step) el.remove();
		});
	}

	private showStatus(parent: HTMLElement, msg: string): HTMLElement {
		return parent.createEl('p', { text: msg, cls: 'auditor-status' });
	}

	/** Appends a step to the running pipeline state log and refreshes its display. */
	private logStep(label: string): void {
		this.pipelineState.stepsPerformed.push({ label, timestamp: Date.now() });
		this.renderStepsLog();
	}

	private renderStepsLog(): void {
		this.pipelineHistoryEl.empty();
		this.pipelineHistoryEl.createEl('summary', { text: 'Pipeline history' });
		if (this.pipelineState.stepsPerformed.length === 0) {
			this.pipelineHistoryEl.createEl('p', { text: 'No steps performed yet.', cls: 'auditor-status' });
			return;
		}
		const list = this.pipelineHistoryEl.createEl('ol', { cls: 'auditor-history-list' });
		for (const entry of this.pipelineState.stepsPerformed) {
			const time = new Date(entry.timestamp).toLocaleTimeString();
			list.createEl('li', { text: `${time} — ${entry.label}` });
		}
	}

	/**
	 * Step 2 ("Control understanding"): RAG over Standards, then Gemini selects the relevant
	 * chunks, extracts clause nomenclature, pulls out references to other standards, and plans
	 * the evidence documents to look for next — all as one structured (thinking + JSON) call.
	 */
	private async runStandardsAnalysis(): Promise<void> {
		this.clearStepsAfter(0);
		const step = this.pipelineEl.createDiv('auditor-pipeline-step');
		step.createEl('h4', { text: '2. Control understanding' });
		const status = this.showStatus(step, 'Searching standards…');
		try {
			this.pipelineState.standardsResults = await this.plugin.standardsIndex.search(
				this.pipelineState.controlInput,
				this.plugin.settings.maxResults,
			);

			status.setText('Asking Gemini to analyze the control…');
			this.pipelineState.analysis = await this.plugin.geminiGenerate.analyzeControl(
				this.pipelineState.controlInput,
				this.pipelineState.standardsResults.map((r, i) => ({ index: i, label: sourceLabel(r), text: r.text })),
			);
			this.pipelineState.targetSelection = new Set(
				this.pipelineState.analysis.targetDocuments.map((_, i) => i),
			);
			this.pipelineState.currentMemory = this.pipelineState.analysis.memorySummary;
			this.logStep('Searched standards and analyzed the control');
			status.remove();
			this.renderControlUnderstandingStep(step);
		} catch (e) {
			status.setText(`Analysis failed: ${String(e)}`);
		}
	}

	private renderControlUnderstandingStep(step: HTMLElement): void {
		const analysis = this.pipelineState.analysis;
		if (!analysis) return;

		this.renderThinking(step, analysis.thinking);

		const selectedList = step.createDiv('auditor-results');
		if (analysis.selected.length === 0) {
			this.showStatus(selectedList, 'No relevant chunks selected.');
		}
		for (const s of analysis.selected) {
			const result = this.pipelineState.standardsResults[s.index];
			if (!result) continue;
			const card = selectedList.createDiv('auditor-evidence-chip');
			const main = card.createDiv('auditor-evidence-chip-main');
			this.createFileLink(main, result);
			if (s.controlNumber) main.createSpan({ text: ` — ${s.controlNumber}`, cls: 'auditor-control-number' });
			main.createEl('p', { text: s.reason, cls: 'auditor-evidence-chip-reason' });
			main.createEl('p', { text: s.excerpt, cls: 'auditor-evidence-chip-passage' });
		}

		if (analysis.references.length > 0) {
			const refsContainer = step.createDiv('auditor-references-container');
			refsContainer.createEl('h5', { text: 'References' });
			for (const r of analysis.references) {
				const card = refsContainer.createDiv('auditor-evidence-chip');
				const main = card.createDiv('auditor-evidence-chip-main');
				main.createSpan({
					text: r.controlNumber ? `${r.standardName} — ${r.controlNumber}` : r.standardName,
					cls: 'auditor-evidence-chip-label',
				});
				main.createEl('p', { text: r.excerpt, cls: 'auditor-evidence-chip-passage' });
			}
		}

		const targetsContainer = step.createDiv('auditor-target-docs');
		targetsContainer.createEl('h5', { text: 'Documents to inspect' });
		const targetsList = targetsContainer.createDiv('auditor-target-docs-list');
		analysis.targetDocuments.forEach((doc, i) => {
			const item = targetsList.createDiv('auditor-target-doc-item');
			const label = item.createEl('label', { cls: 'auditor-target-doc-label' });
			const checkbox = label.createEl('input', { type: 'checkbox' });
			checkbox.checked = this.pipelineState.targetSelection.has(i);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) this.pipelineState.targetSelection.add(i);
				else this.pipelineState.targetSelection.delete(i);
			});
			label.createSpan({ text: doc.file });
			item.createEl('p', { text: doc.keywords.join(', '), cls: 'auditor-target-doc-keywords' });
		});

		if (analysis.memorySummary) {
			const memoryEl = step.createDiv('auditor-memory-summary');
			memoryEl.createEl('h5', { text: 'Requirements to verify' });
			memoryEl.createEl('p', { text: analysis.memorySummary });
		}

		const searchBtn = step.createEl('button', { text: 'Search for documents', cls: 'mod-cta' });
		searchBtn.addEventListener('click', () => { void this.runDocumentsResearch(searchBtn); });
	}

	/**
	 * Step 3 ("Research"): runs one RAG search per selected target document, concatenates all
	 * findings, and asks Gemini (with the Step 2 memory) to assess progress and identify gaps.
	 */
	private async runDocumentsResearch(searchBtn: HTMLButtonElement): Promise<void> {
		const analysis = this.pipelineState.analysis;
		if (!analysis) return;
		this.clearStepsAfter(1);
		const step = this.pipelineEl.createDiv('auditor-pipeline-step');
		step.createEl('h4', { text: '3. Research' });
		const body = step.createDiv('auditor-research-body');
		const status = this.showStatus(body, 'Searching evidence for each document…');
		searchBtn.disabled = true;
		try {
			this.pipelineState.evidenceFindings = new Map();
			const targets = analysis.targetDocuments
				.map((doc, i) => ({ doc, i }))
				.filter(({ i }) => this.pipelineState.targetSelection.has(i));

			for (const { doc, i } of targets) {
				status.setText(`Searching for “${doc.file}”…`);
				const results = await this.plugin.evidenceIndex.search(doc.keywords.join(', '), this.plugin.settings.maxResults);
				this.pipelineState.evidenceFindings.set(i, results);
			}

			status.setText('Asking Gemini to assess research progress…');
			this.pipelineState.researchAssessment = await this.plugin.geminiGenerate.assessResearchProgress(
				this.pipelineState.currentMemory || analysis.memorySummary,
				buildFindingsText(this.pipelineState),
			);
			this.pipelineState.currentMemory = this.pipelineState.researchAssessment.updatedMemory;
			this.logStep(`Searched evidence for ${targets.length} document(s) and assessed progress`);
			status.remove();
			this.renderResearchStep(body);
		} catch (e) {
			status.setText(`Research failed: ${String(e)}`);
		} finally {
			searchBtn.disabled = false;
		}
	}

	/**
	 * "Retry with feedback": re-runs the research assessment (the last LLM step), giving the model
	 * its own previous progress/gaps plus the auditor's feedback, so it can refine rather than
	 * start over. Does not re-run the vector searches — only the assessment.
	 */
	private async retryResearchWithFeedback(body: HTMLElement): Promise<void> {
		const previous = this.pipelineState.researchAssessment;
		if (!previous) return;
		body.empty();
		const status = this.showStatus(body, 'Refining research assessment with your feedback…');
		try {
			this.pipelineState.researchHistory.push(previous);
			this.pipelineState.userFeedbackHistory.push(this.pipelineState.userFeedback);
			this.pipelineState.researchAssessment = await this.plugin.geminiGenerate.assessResearchProgress(
				this.pipelineState.currentMemory,
				buildFindingsText(this.pipelineState),
				{
					previousProgress: previous.progress,
					previousGaps: previous.gaps,
					userFeedback: this.pipelineState.userFeedback,
				},
			);
			this.pipelineState.currentMemory = this.pipelineState.researchAssessment.updatedMemory;
			this.logStep('Retried research assessment with feedback');
			status.remove();
			this.renderResearchStep(body);
		} catch (e) {
			status.setText(`Retry failed: ${String(e)}`);
		}
	}

	private renderResearchStep(body: HTMLElement): void {
		const analysis = this.pipelineState.analysis;
		const assessment = this.pipelineState.researchAssessment;
		if (!analysis || !assessment) return;

		this.renderThinking(body, assessment.thinking);

		for (const [docIndex, results] of this.pipelineState.evidenceFindings) {
			const doc = analysis.targetDocuments[docIndex];
			if (!doc) continue;
			const docEl = body.createDiv('auditor-research-doc');
			docEl.createEl('h5', { text: doc.file });
			this.renderResultList(docEl, results);
		}

		const progressEl = body.createDiv('auditor-search-response');
		progressEl.createEl('h5', { text: 'Research progress' });
		progressEl.createEl('p', { text: assessment.progress });

		if (assessment.gaps.length > 0) {
			const gapsEl = body.createDiv('auditor-research-gaps');
			gapsEl.createEl('h5', { text: 'Missing gaps' });
			const gapsList = gapsEl.createEl('ul');
			for (const gap of assessment.gaps) gapsList.createEl('li', { text: gap });
		}

		body.createEl('h5', { text: 'Your input on the current progress' });
		const feedback = body.createEl('textarea', { cls: 'auditor-pipeline-textarea' });
		feedback.rows = 4;
		feedback.value = this.pipelineState.userFeedback;
		feedback.addEventListener('input', () => { this.pipelineState.userFeedback = feedback.value; });

		const actionsRow = body.createDiv('auditor-research-actions');
		const retryBtn = actionsRow.createEl('button', { text: 'Retry with feedback', cls: 'mod-muted' });
		retryBtn.addEventListener('click', () => { void this.retryResearchWithFeedback(body); });

		const nextBtn = actionsRow.createEl('button', { text: 'Continue with search for existing controls', cls: 'mod-cta' });
		nextBtn.addEventListener('click', () => { void this.runSimilarControlsSearch(); });
	}

	/** Step 4: RAG over Written controls, user selects which to use as style reference. */
	private async runSimilarControlsSearch(): Promise<void> {
		this.clearStepsAfter(2);
		const step = this.pipelineEl.createDiv('auditor-pipeline-step');
		step.createEl('h4', { text: '4. Similar written controls' });
		const status = this.showStatus(step, 'Searching written controls…');
		try {
			this.pipelineState.similarResults = await this.plugin.writtenControlsIndex.search(
				buildControlUnderstandingText(this.pipelineState),
				this.plugin.settings.maxResults,
			);
			this.pipelineState.selectedSimilar = new Set(this.pipelineState.similarResults.map((_, i) => i));
			this.logStep('Searched for existing written controls');
			status.remove();
			this.renderSimilarControlsStep(step);
		} catch (e) {
			status.setText(`Search failed: ${String(e)}`);
		}
	}

	private renderSimilarControlsStep(step: HTMLElement): void {
		this.renderSelectableResultList(step, this.pipelineState.similarResults, this.pipelineState.selectedSimilar);

		const nextBtn = step.createEl('button', { text: 'Continue to finalizing', cls: 'mod-cta' });
		nextBtn.addEventListener('click', () => { void this.runFinalizationPlan(nextBtn); });
	}

	/**
	 * Step 5 ("Finalizing"): given all gathered evidence and the selected existing controls, has
	 * Gemini plan (by index, structured + thinking) what finding will be drawn from each one, shown
	 * to the auditor as a checklist to include/exclude before the draft is actually generated.
	 */
	private async runFinalizationPlan(nextBtn: HTMLButtonElement): Promise<void> {
		this.clearStepsAfter(3);
		const step = this.pipelineEl.createDiv('auditor-pipeline-step');
		step.createEl('h4', { text: '5. Finalizing' });
		const status = this.showStatus(step, 'Asking Gemini to plan the findings…');
		nextBtn.disabled = true;
		try {
			const candidates = buildFinalizationCandidates(this.pipelineState);
			this.pipelineState.finalizationPlan = await this.plugin.geminiGenerate.planFinalization(
				buildControlUnderstandingText(this.pipelineState),
				candidates.map((c) => ({ index: c.index, label: c.label, kind: c.kind, text: c.text })),
			);
			// Only pre-check what the LLM actually deemed relevant, not every candidate it was given.
			this.pipelineState.selectedFinalItems = new Set(this.pipelineState.finalizationPlan.items.map((i) => i.index));
			this.logStep(
				`Planned findings for finalization (${this.pipelineState.finalizationPlan.items.length}/${candidates.length} kept)`,
			);
			status.remove();
			this.renderFinalizationStep(step);
		} catch (e) {
			status.setText(`Finalization planning failed: ${String(e)}`);
		} finally {
			nextBtn.disabled = false;
		}
	}

	private renderFinalizationStep(step: HTMLElement): void {
		const plan = this.pipelineState.finalizationPlan;
		if (!plan) return;
		const candidates = buildFinalizationCandidates(this.pipelineState);

		this.renderThinking(step, plan.thinking);

		const list = step.createDiv('auditor-results');
		if (plan.items.length === 0) {
			this.showStatus(list, 'No documents or existing controls to finalize.');
		}

		const byIndex = new Map(candidates.map((c) => [c.index, c]));
		const kept = plan.items
			.map((item) => ({ item, candidate: byIndex.get(item.index) }))
			.filter((x): x is { item: typeof plan.items[number]; candidate: FinalizationCandidate } => x.candidate !== undefined);

		// Evidence chunks are grouped by their source file, with a master checkbox to toggle the
		// whole file at once, while each chunk stays individually toggleable underneath it.
		const evidenceGroups = new Map<string, { item: typeof plan.items[number]; candidate: FinalizationCandidate }[]>();
		for (const entry of kept.filter((x) => x.candidate.kind === 'evidence')) {
			const path = entry.candidate.result.sourcePath;
			const group = evidenceGroups.get(path);
			if (group) group.push(entry);
			else evidenceGroups.set(path, [entry]);
		}

		for (const [, entries] of evidenceGroups) {
			const groupEl = list.createDiv('auditor-finalization-group');
			const headerEl = groupEl.createDiv('auditor-finalization-group-header');
			const masterCheckbox = headerEl.createEl('input', { type: 'checkbox' });
			const firstEntry = entries[0]!;
			headerEl.createSpan({ text: firstEntry.candidate.result.sourcePath, cls: 'auditor-finalization-group-title' });

			const chunkCheckboxes: HTMLInputElement[] = [];
			const syncMaster = () => {
				const checkedCount = entries.filter((e) => this.pipelineState.selectedFinalItems.has(e.item.index)).length;
				masterCheckbox.checked = checkedCount === entries.length;
				masterCheckbox.indeterminate = checkedCount > 0 && checkedCount < entries.length;
			};
			masterCheckbox.addEventListener('change', () => {
				for (const entry of entries) {
					if (masterCheckbox.checked) this.pipelineState.selectedFinalItems.add(entry.item.index);
					else this.pipelineState.selectedFinalItems.delete(entry.item.index);
				}
				chunkCheckboxes.forEach((cb) => { cb.checked = masterCheckbox.checked; });
				masterCheckbox.indeterminate = false;
			});

			const chunksEl = groupEl.createDiv('auditor-finalization-group-chunks');
			for (const { item, candidate } of entries) {
				const card = chunksEl.createDiv('auditor-evidence-chip');
				const checkbox = card.createEl('input', { type: 'checkbox' });
				checkbox.checked = this.pipelineState.selectedFinalItems.has(item.index);
				chunkCheckboxes.push(checkbox);
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) this.pipelineState.selectedFinalItems.add(item.index);
					else this.pipelineState.selectedFinalItems.delete(item.index);
					syncMaster();
				});

				const main = card.createDiv('auditor-evidence-chip-main');
				this.createFileLink(main, candidate.result);
				main.createEl('p', { text: item.plannedFinding, cls: 'auditor-evidence-chip-reason' });
			}
			syncMaster();
		}

		for (const { item, candidate } of kept.filter((x) => x.candidate.kind === 'control')) {
			const card = list.createDiv('auditor-evidence-chip');
			const checkbox = card.createEl('input', { type: 'checkbox' });
			checkbox.checked = this.pipelineState.selectedFinalItems.has(item.index);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) this.pipelineState.selectedFinalItems.add(item.index);
				else this.pipelineState.selectedFinalItems.delete(item.index);
			});

			const main = card.createDiv('auditor-evidence-chip-main');
			this.createFileLink(main, candidate.result);
			main.createSpan({ text: ' — existing control', cls: 'auditor-control-number' });
			main.createEl('p', { text: item.plannedFinding, cls: 'auditor-evidence-chip-reason' });
		}

		step.createEl('h5', { text: 'Writing rules' });
		const rulesEl = step.createEl('textarea', { cls: 'auditor-pipeline-textarea auditor-rules-textarea' });
		rulesEl.rows = 16;
		rulesEl.value = this.pipelineState.writingRules;
		rulesEl.addEventListener('input', () => { this.pipelineState.writingRules = rulesEl.value; });

		step.createEl('h5', { text: 'Guidance for finalizing the report' });
		const guidanceEl = step.createEl('textarea', { cls: 'auditor-pipeline-textarea' });
		guidanceEl.rows = 4;
		guidanceEl.placeholder = 'Anything else the drafting model should take into account…';
		guidanceEl.value = this.pipelineState.finalizationGuidance;
		guidanceEl.addEventListener('input', () => { this.pipelineState.finalizationGuidance = guidanceEl.value; });

		const nextBtn = step.createEl('button', { text: 'Draft control', cls: 'mod-cta' });
		nextBtn.addEventListener('click', () => { void this.runDraft(); });
	}

	/** Step 6: Gemini drafts the final control from the curated, finalization-checklist-filtered context; result can be saved as a new note. */
	private async runDraft(): Promise<void> {
		this.clearStepsAfter(4);
		const step = this.pipelineEl.createDiv('auditor-pipeline-step');
		step.createEl('h4', { text: '6. Draft' });
		const status = this.showStatus(step, 'Drafting control…');
		try {
			const assessment = this.pipelineState.researchAssessment;
			const understanding = [
				buildControlUnderstandingText(this.pipelineState),
				assessment ? `Research progress:\n${assessment.progress}` : '',
				assessment && assessment.gaps.length > 0 ? `Remaining gaps:\n${assessment.gaps.join('\n')}` : '',
				this.pipelineState.userFeedback ? `Auditor's notes:\n${this.pipelineState.userFeedback}` : '',
			].filter(Boolean).join('\n\n');

			const included = buildFinalizationCandidates(this.pipelineState)
				.filter((c) => this.pipelineState.selectedFinalItems.has(c.index));
			const evidenceContext = included
				.filter((c) => c.kind === 'evidence')
				.map((c) => `[${c.label}]\n${c.text}`)
				.join('\n\n');
			const similarContext = included
				.filter((c) => c.kind === 'control')
				.map((c) => `[${c.label}]\n${c.text}`)
				.join('\n\n');
			const drafted = await this.plugin.geminiGenerate.draftControl(
				understanding,
				evidenceContext,
				similarContext,
				this.pipelineState.writingRules,
				this.pipelineState.finalizationGuidance,
			);
			this.pipelineState.draftRecord = {
				...this.pipelineState.draftRecord,
				standard: drafted.standard,
				topic: drafted.topic,
				todFinding: drafted.todFinding,
				todRecommendation: drafted.todRecommendation,
				todRating: drafted.todRating,
			};
			this.logStep('Drafted the control');
			status.remove();
			this.renderThinking(step, drafted.thinking);
			this.renderDraftStep(step);
		} catch (e) {
			status.setText(`Draft failed: ${String(e)}`);
		}
	}

	private renderDraftStep(step: HTMLElement): void {
		renderControlRecordFields(step, this.pipelineState.draftRecord);

		const saveBtn = step.createEl('button', { text: 'Save as new note', cls: 'mod-cta' });
		const statusEl = step.createDiv();
		saveBtn.addEventListener('click', () => {
			void (async () => {
				try {
					await this.plugin.saveControlNote(this.pipelineState.draftRecord);
					this.logStep('Saved the draft as a new note');
					statusEl.setText('Saved.');
				} catch (e) {
					statusEl.setText(`Save failed: ${String(e)}`);
				}
			})();
		});
	}

	// ─── Controls tab ───────────────────────────────────────────────────────

	private ratingClass(rating: string): string {
		if (rating === 'NC') return 'auditor-rating-nc';
		if (rating === 'C*') return 'auditor-rating-cstar';
		if (rating === 'C') return 'auditor-rating-c';
		return 'auditor-rating-none';
	}

	private renderControlsTab(container: HTMLElement): void {
		const toolbar = container.createDiv('auditor-controls-toolbar');
		const searchInput = toolbar.createEl('input', { type: 'text', placeholder: 'Filter by number, standard, topic, status…' });
		const importBtn = toolbar.createEl('button', { text: 'Import controls' });
		const refreshBtn = toolbar.createEl('button', { text: 'Refresh' });
		const status = container.createDiv();
		const grid = container.createDiv('auditor-controls-grid');

		let allEntries: { file: TFile; record: ControlRecord }[] = [];

		const applyFilter = () => {
			const query = searchInput.value.trim().toLowerCase();
			grid.empty();
			const filtered = query
				? allEntries.filter((e) =>
					[e.record.number, e.record.standard, e.record.topic, e.record.status]
						.some((f) => f.toLowerCase().includes(query)))
				: allEntries;
			if (filtered.length === 0) {
				this.showStatus(grid, 'No controls found.');
				return;
			}
			for (const entry of filtered) this.renderControlCard(grid, entry);
		};

		const load = async () => {
			status.setText('Loading controls…');
			grid.empty();
			const folder = this.plugin.settings.writtenControlsFolder;
			const files = this.app.vault.getFiles()
				.filter((f) => f.extension === 'md' && (!folder || f.path === folder || f.path.startsWith(`${folder}/`)));
			const entries: { file: TFile; record: ControlRecord }[] = [];
			for (const file of files) {
				const content = await this.app.vault.cachedRead(file);
				entries.push({ file, record: parseControlNoteContent(content, file.basename) });
			}
			entries.sort((a, b) => a.record.number.localeCompare(b.record.number, undefined, { numeric: true }));
			allEntries = entries;
			status.setText(`${entries.length} control(s).`);
			applyFilter();
		};

		searchInput.addEventListener('input', applyFilter);
		refreshBtn.addEventListener('click', () => { void load(); });
		importBtn.addEventListener('click', () => {
			new ImportControlsModal(this.app, this.plugin, () => { void load(); }).open();
		});
		void load();
	}

	private renderControlCard(grid: HTMLElement, entry: { file: TFile; record: ControlRecord }): void {
		const card = grid.createDiv(`auditor-control-card auditor-status-${statusSlug(entry.record.status)}`);
		const summary = card.createDiv('auditor-control-card-summary');
		summary.createSpan({ text: entry.record.number || '(no number)', cls: 'auditor-control-card-number' });
		summary.createSpan({ text: entry.record.status, cls: 'auditor-control-card-status' });
		card.createDiv({ cls: 'auditor-control-card-standard', text: entry.record.standard });
		card.createDiv({ cls: 'auditor-control-card-topic', text: entry.record.topic });
		const metaRow = card.createDiv('auditor-control-card-meta');
		metaRow.createSpan({ text: `Session: ${entry.record.session || '—'}` });
		metaRow.createSpan({ text: `Assigned: ${entry.record.assignedMember || '—'}` });
		const ratingsRow = card.createDiv('auditor-control-card-ratings');
		ratingsRow.createSpan({ text: `ToD: ${entry.record.todRating || '—'}`, cls: `auditor-rating-badge ${this.ratingClass(entry.record.todRating)}` });
		ratingsRow.createSpan({ text: `ToE: ${entry.record.toeRating || '—'}`, cls: `auditor-rating-badge ${this.ratingClass(entry.record.toeRating)}` });

		card.addEventListener('click', () => {
			new EditControlModal(this.app, entry.record, async (updated) => {
				const folder = this.plugin.settings.writtenControlsFolder;
				const safeNumber = sanitizeFileTitle(updated.number || entry.file.basename);
				const newPath = folder ? `${folder}/${safeNumber}.md` : `${safeNumber}.md`;
				if (newPath !== entry.file.path) {
					await this.app.fileManager.renameFile(entry.file, newPath);
				}
				await this.app.vault.modify(entry.file, buildControlNoteContent(updated));
				entry.record = updated;
				this.logStep(`Saved changes to control ${updated.number}`);
				void this.plugin.runIndexing('writtenControls');
				card.remove();
				this.renderControlCard(grid, entry);
			}).open();
		});
	}

	/** Read-only result list. */
	private renderResultList(container: HTMLElement, results: SearchResult[]): void {
		const list = container.createDiv('auditor-results');
		if (results.length === 0) {
			this.showStatus(list, 'No results found.');
			return;
		}
		for (const result of results) {
			const card = list.createDiv('auditor-evidence-chip');
			const main = card.createDiv('auditor-evidence-chip-main');
			this.createFileLink(main, result);
			main.createEl('p', {
				text: result.text.length > 600 ? `${result.text.slice(0, 600)}…` : result.text,
				cls: 'auditor-evidence-chip-passage',
			});
		}
	}

	/** Checkbox-selectable result list (used for the Similar-controls step). */
	private renderSelectableResultList(container: HTMLElement, results: SearchResult[], selected: Set<number>): void {
		const list = container.createDiv('auditor-results');
		if (results.length === 0) {
			this.showStatus(list, 'No results found.');
			return;
		}
		results.forEach((result, i) => {
			const card = list.createDiv('auditor-evidence-chip');
			const checkbox = card.createEl('input', { type: 'checkbox' });
			checkbox.checked = selected.has(i);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) selected.add(i);
				else selected.delete(i);
			});

			const main = card.createDiv('auditor-evidence-chip-main');
			this.createFileLink(main, result);
			main.createEl('p', {
				text: result.text.length > 600 ? `${result.text.slice(0, 600)}…` : result.text,
				cls: 'auditor-evidence-chip-passage',
			});
		});
	}
}
