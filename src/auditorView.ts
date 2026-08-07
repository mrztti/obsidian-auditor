import { ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from './main';
import type { StoreKind } from './main';
import type {
	ControlAnalysis,
	FinalizationPlan,
	ResearchAssessment,
} from './geminiGenerate';
import type { IndexSummary, SearchResult } from './vectorStore';
import type { ThroughputSample } from './rateLimiter';
import {
	emptyControlRecord,
	buildControlNoteContent,
	parseControlNoteContent,
	type ControlRecord,
} from './controlNote';
import { renderControlRecordFields } from './controlFields';
import { renderChatMarkdownInto } from './markdown';
import {
	emptyEvidenceGoal,
	generateEvidenceGoalGroupId,
	type EvidenceGoal,
	type InterviewSessionPlan,
} from './evidenceGoal';

const GRAPH_WINDOW_SECONDS = 60;

export const AUDITOR_VIEW_TYPE = 'auditor-main-view';

type TabName =
	| 'indexes'
	| 'search'
	| 'pipeline'
	| 'stage2'
	| 'prepareSession'
	| 'chat';

const TAB_LABELS: Record<TabName, string> = {
	indexes: 'Indexes',
	search: 'Document search',
	pipeline: 'Control drafting',
	stage2: 'Stage 2 evidence',
	prepareSession: 'Prepare session',
	chat: 'Chat',
};

const DEFAULT_SEARCH_TOP_K = 20;
/** Combined retrieval budget for the Chat tab, across all indexes (standards/evidence/written-controls/interview-evidence). */
const CHAT_RETRIEVAL_TOP_K = 30;

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

/** `seedRecord`, if given, is used as the starting point for `draftRecord` instead of a blank one — used when the pipeline is drafting Stage 1 for an already-existing control, so its number/standard/topic/session/status/comments/Stage 2 fields etc. all survive into the final save instead of being blanked out. */
function emptyPipelineState(
	controlInput: string,
	defaultWritingRules: string,
	seedRecord?: ControlRecord,
): PipelineState {
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
		draftRecord: { ...(seedRecord ?? emptyControlRecord()), control: controlInput },
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

function buildFinalizationCandidates(
	state: PipelineState,
): FinalizationCandidate[] {
	const evidenceItems = [...state.evidenceFindings.values()].flat();
	const controlItems = state.similarResults.filter((_, i) =>
		state.selectedSimilar.has(i),
	);
	let index = 0;
	const candidates: FinalizationCandidate[] = [];
	for (const result of evidenceItems) {
		candidates.push({
			index: index++,
			label: sourceLabel(result),
			kind: 'evidence',
			text: result.text,
			result,
		});
	}
	for (const result of controlItems) {
		candidates.push({
			index: index++,
			label: sourceLabel(result),
			kind: 'control',
			text: result.text,
			result,
		});
	}
	return candidates;
}

const SEARCH_STORE_LABELS: Record<StoreKind, string> = {
	standards: 'Standards',
	evidence: 'Evidence',
	writtenControls: 'Written controls',
	interviewEvidence: 'Interview evidence',
};

function sourceLabel(result: SearchResult): string {
	if (result.page !== undefined)
		return `${result.sourcePath} (p. ${result.page})`;
	if (result.line !== undefined)
		return `${result.sourcePath} (L${result.line})`;
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
		.map(
			(r) =>
				`${r.standardName}${r.controlNumber ? ` ${r.controlNumber}` : ''}: ${r.excerpt}`,
		)
		.join('\n');
	const memory = state.currentMemory || analysis.memorySummary;
	return [
		selectedText,
		refsText ? `Referenced standards:\n${refsText}` : '',
		memory ? `Requirements to verify:\n${memory}` : '',
	]
		.filter(Boolean)
		.join('\n\n');
}

/** Concatenates evidence findings per target document, for the research-progress assessment call. */
function buildFindingsText(state: PipelineState): string {
	if (!state.analysis) return '';
	const parts: string[] = [];
	for (const [docIndex, results] of state.evidenceFindings) {
		const doc = state.analysis.targetDocuments[docIndex];
		if (!doc) continue;
		const resultsText =
			results.length > 0
				? results
						.map((r) => `- [${sourceLabel(r)}] ${r.text}`)
						.join('\n')
				: '(no results found)';
		parts.push(`## ${doc.file}\n${resultsText}`);
	}
	return parts.join('\n\n');
}

interface ChatMessage {
	role: 'user' | 'assistant';
	text: string;
	/** Retrieved chunks used to ground this reply, shown as a collapsible "Sources" list — only set for assistant messages. */
	sources?: { result: SearchResult; kind: StoreKind }[];
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
	/** When on, each pipeline step advances to the next automatically (using default selections) instead of waiting for the user to click "Continue" — up to the final draft step. */
	private autoMode = false;
	private chatMessages: ChatMessage[] = [];
	/** When set, the pipeline's final "Save" step updates this existing control's file (its Stage 1 fields only) instead of creating a new note — set by `startPipelineForControl`. */
	private pipelineTargetFile: TFile | null = null;

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
			stage2: container.createDiv('auditor-tab-content'),
			prepareSession: container.createDiv('auditor-tab-content'),
			chat: container.createDiv('auditor-tab-content'),
		};

		const tabButtons: Record<TabName, HTMLButtonElement> = {} as Record<
			TabName,
			HTMLButtonElement
		>;
		const setActiveTab = (name: TabName) => {
			(Object.keys(tabContents) as TabName[]).forEach((key) => {
				tabContents[key].toggleClass(
					'auditor-tab-hidden',
					key !== name,
				);
				tabButtons[key].toggleClass('is-active', key === name);
			});
		};

		(Object.keys(TAB_LABELS) as TabName[]).forEach((name) => {
			const btn = tabBar.createEl('button', {
				text: TAB_LABELS[name],
				cls: 'auditor-tab-btn',
			});
			btn.addEventListener('click', () => {
				setActiveTab(name);
			});
			tabButtons[name] = btn;
		});

		this.renderIndexesTab(tabContents.indexes);
		this.renderSearchTab(tabContents.search);
		this.pipelineEl = tabContents.pipeline;
		this.renderPipelineStart();
		this.renderStage2Tab(tabContents.stage2);
		this.renderPrepareSessionTab(tabContents.prepareSession);
		this.renderChatTab(tabContents.chat);

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
		this.createReindexButton(
			reindexRow,
			'Re-index written controls',
			'writtenControls',
		);
		this.createReindexButton(
			reindexRow,
			'Re-index interview evidence',
			'interviewEvidence',
		);
		this.createEvidenceGoalReindexButton(reindexRow);

		const rateRow = container.createDiv('auditor-rate-row');
		const rampLabel = rateRow.createEl('label', {
			cls: 'auditor-search-store-option',
		});
		const rampToggle = rampLabel.createEl('input', { type: 'checkbox' });
		rampToggle.checked = this.plugin.settings.gradualRampUp;
		rampToggle.addEventListener('change', () => {
			void (async () => {
				this.plugin.settings.gradualRampUp = rampToggle.checked;
				this.plugin.rateLimiter.updateConfig(
					this.plugin.settings.maxRequestsPerSecond,
					rampToggle.checked,
				);
				await this.plugin.saveSettings();
			})();
		});
		rampLabel.createSpan({
			text: 'Gradual increase (ramp up request rate instead of starting at full speed)',
		});

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
		legend.createSpan({
			text: '— requests/s',
			cls: 'auditor-throughput-legend-requests',
		});
		legend.createSpan({
			text: '— KB/s',
			cls: 'auditor-throughput-legend-tokens',
		});

		const draw = () => {
			const samples = this.plugin.rateLimiter
				.getSamples()
				.slice(-GRAPH_WINDOW_SECONDS);
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
						const x =
							(i / Math.max(1, GRAPH_WINDOW_SECONDS - 1)) * 300;
						const y = 58 - (v / maxY) * 56;
						return `${x.toFixed(1)},${y.toFixed(1)}`;
					})
					.join(' ');
			// Left-pad so the line always ends at the right edge, growing from an empty window.
			const padded: ThroughputSample[] = [
				...Array<ThroughputSample | null>(
					Math.max(0, GRAPH_WINDOW_SECONDS - samples.length),
				).fill(null),
				...samples,
			].map((s) => s ?? { time: 0, requests: 0, tokens: 0, bytes: 0 });
			requestsPath.setAttribute(
				'points',
				toPoints(
					padded.map((s) => s.requests),
					maxRequests,
				),
			);
			kbPath.setAttribute(
				'points',
				toPoints(
					padded.map((s) => s.bytes / 1024),
					maxKb,
				),
			);

			const last = samples[samples.length - 1]!;
			statsEl.setText(
				`${last.requests} req/s, ${(last.bytes / 1024).toFixed(1)} KB/s`,
			);
		};

		draw();
		this.unsubscribeThroughput?.();
		this.unsubscribeThroughput = this.plugin.rateLimiter.onChange(draw);
	}

	private createReindexButton(
		container: HTMLElement,
		label: string,
		kind: StoreKind,
	): void {
		const wrapper = container.createDiv('auditor-reindex-item');
		const btn = wrapper.createEl('button', {
			text: label,
			cls: 'mod-muted',
		});
		const status = wrapper.createDiv('auditor-reindex-status');
		const activeList = wrapper.createDiv('auditor-active-files');

		const renderActiveFiles = (activePaths: string[]) => {
			activeList.empty();
			for (const path of activePaths) {
				const row = activeList.createDiv('auditor-active-file-row');
				row.createDiv('auditor-spinner');
				row.createSpan({ text: path, cls: 'auditor-active-file-path' });
			}
		};

		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				status.setText('Starting…');
				const summary = await this.plugin.runIndexing(
					kind,
					(done, total, indexLabel) => {
						status.setText(`${indexLabel} (${done}/${total})`);
					},
					renderActiveFiles,
				);
				btn.disabled = false;
				renderActiveFiles([]);
				status.setText(
					summary
						? this.formatSummary(summary)
						: 'Indexing failed — see notice.',
				);
			})();
		});
	}

	/** Unlike `createReindexButton`, the evidence-goal index isn't a `StoreKind`/`AuditVectorStore` — it's a small, always-full-rebuild index over session plan notes, so this just wraps `plugin.reindexEvidenceGoals()`. */
	private createEvidenceGoalReindexButton(container: HTMLElement): void {
		const wrapper = container.createDiv('auditor-reindex-item');
		const btn = wrapper.createEl('button', { text: 'Re-index evidence goals', cls: 'mod-muted' });
		const status = wrapper.createDiv('auditor-reindex-status');
		btn.addEventListener('click', () => {
			void (async () => {
				btn.disabled = true;
				status.setText('Indexing…');
				await this.plugin.reindexEvidenceGoals();
				btn.disabled = false;
				status.setText('Done.');
			})();
		});
	}

	/** Recap text: how many files were newly indexed vs. skipped, and why. */
	private formatSummary(summary: IndexSummary): string {
		const parts = [
			`${summary.indexed} indexed`,
			`${summary.skippedUnchanged} unchanged (skipped)`,
		];
		if (summary.skippedUnreadable > 0)
			parts.push(`${summary.skippedUnreadable} unreadable (skipped)`);
		if (summary.removed > 0) parts.push(`${summary.removed} removed`);
		const prefix = summary.cancelled ? 'Cancelled — ' : '';
		return `${prefix}${summary.totalFiles} files: ${parts.join(', ')}.`;
	}

	// ─── Document search tab ────────────────────────────────────────────────

	private renderSearchTab(container: HTMLElement): void {
		const promptEl = container.createEl('textarea', {
			cls: 'auditor-pipeline-textarea',
		});
		promptEl.rows = 3;
		promptEl.placeholder = 'What are you looking for?';

		const controlsRow = container.createDiv('auditor-search-controls-row');

		const storeRow = controlsRow.createDiv('auditor-search-store-row');
		(['standards', 'evidence', 'writtenControls'] as StoreKind[]).forEach(
			(kind) => {
				const label = storeRow.createEl('label', {
					cls: 'auditor-search-store-option',
				});
				const radio = label.createEl('input', {
					type: 'radio',
					attr: { name: 'auditor-search-store' },
				});
				radio.checked = kind === this.searchStoreKind;
				radio.addEventListener('change', () => {
					if (radio.checked) this.searchStoreKind = kind;
				});
				label.createSpan({ text: SEARCH_STORE_LABELS[kind] });
			},
		);

		const topKWrapper = controlsRow.createDiv('auditor-search-topk');
		topKWrapper.createSpan({ text: 'Top K:' });
		const topKInput = topKWrapper.createEl('input', { type: 'number' });
		topKInput.value = String(DEFAULT_SEARCH_TOP_K);
		topKInput.min = '1';
		topKInput.max = '50';

		const searchBtn = container.createEl('button', {
			text: 'Search',
			cls: 'mod-cta',
		});
		const resultsEl = container.createDiv('auditor-search-results');

		searchBtn.addEventListener('click', () => {
			const prompt = promptEl.value.trim();
			if (!prompt) return;
			const topK = Math.max(
				1,
				Number(topKInput.value) || DEFAULT_SEARCH_TOP_K,
			);
			void this.runDocumentSearch(
				prompt,
				this.searchStoreKind,
				topK,
				searchBtn,
				resultsEl,
			);
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
		const status = this.showStatus(
			resultsEl,
			'Generating search keywords…',
		);
		try {
			const keywords =
				await this.plugin.geminiGenerate.generateSearchKeywords(prompt);

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

			status.setText('Selecting the most relevant snippets…');
			const rerank = await this.plugin.geminiGenerate.rerankSnippets(
				prompt,
				results.map((r, i) => ({
					index: i,
					label: sourceLabel(r),
					text: r.text,
				})),
			);
			status.remove();

			this.renderThinking(resultsEl, rerank.thinking);

			if (rerank.response) {
				const responseEl = resultsEl.createDiv(
					'auditor-search-response',
				);
				responseEl.createEl('h5', { text: 'Answer' });
				responseEl.createEl('p', { text: rerank.response });
			}

			const relevantResults = rerank.relevant
				.map(({ index, excerpt, reason }) => ({
					result: results[index],
					excerpt,
					reason,
				}))
				.filter(
					(
						r,
					): r is {
						result: SearchResult;
						excerpt: string;
						reason: string;
					} => r.result !== undefined,
				);

			if (relevantResults.length > 0) {
				const filesEl = resultsEl.createDiv('auditor-search-files');
				filesEl.createEl('h5', { text: 'Files' });
				const uniquePaths = [
					...new Set(relevantResults.map((r) => r.result.sourcePath)),
				];
				const filesList = filesEl.createDiv(
					'auditor-search-files-list',
				);
				for (const path of uniquePaths) {
					const file = this.app.vault.getFileByPath(path);
					if (!file) {
						filesList.createDiv({
							text: path,
							cls: 'auditor-search-file-item',
						});
						continue;
					}
					const link = filesList.createEl('a', {
						text: path,
						cls: 'auditor-search-file-item auditor-file-link',
					});
					link.addEventListener('click', (e) => {
						e.preventDefault();
						void this.app.workspace.getLeaf('tab').openFile(file);
					});
				}
			}

			const list = resultsEl.createDiv('auditor-results');
			if (relevantResults.length === 0) {
				this.showStatus(
					list,
					'Gemini found no relevant snippets among the retrieved results.',
				);
			}
			for (const { result, excerpt, reason } of relevantResults) {
				const card = list.createDiv('auditor-evidence-chip');
				const main = card.createDiv('auditor-evidence-chip-main');
				this.createFileLink(main, result);
				main.createEl('p', {
					text: reason,
					cls: 'auditor-evidence-chip-reason',
				});
				main.createEl('p', {
					text: excerpt || result.text,
					cls: 'auditor-evidence-chip-passage',
				});
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
		const link = container.createEl('a', {
			text,
			cls: 'auditor-evidence-chip-label auditor-file-link',
		});
		link.addEventListener('click', (e) => {
			e.preventDefault();
			void this.app.workspace.getLeaf('tab').openFile(file);
		});
	}

	/** Renders a collapsed-by-default "Model reasoning" block from a thought summary, if present. */
	private renderThinking(container: HTMLElement, thinking: string): void {
		if (!thinking) return;
		const thinkingEl = container.createEl('details', {
			cls: 'auditor-thinking',
		});
		thinkingEl.createEl('summary', { text: 'Model reasoning' });
		thinkingEl.createEl('p', {
			text: thinking,
			cls: 'auditor-thinking-text',
		});
	}

	// ─── Control-drafting pipeline tab ──────────────────────────────────────

	/**
	 * Entry point for drafting Stage 1 directly on an existing control (e.g. from the Controls view),
	 * instead of starting the pipeline from scratch with free text. Seeds the pipeline from the
	 * control's own text, runs it fully in auto-mode (RAG → analysis → research → finalize → draft,
	 * no manual steps), and targets the control's own file for the final save — see
	 * `pipelineTargetFile` and the save handler in `renderDraftStep`.
	 */
	startPipelineForControl(file: TFile, record: ControlRecord): void {
		// Deliberately does NOT switch to the pipeline tab — this runs in the background (the Auditor
		// view/leaf may not even be visible), so the pipeline steps still render into `pipelineEl`
		// underneath, but nothing steals focus from wherever the user actually is.
		this.pipelineTargetFile = file;
		this.autoMode = true;
		this.pipelineState = emptyPipelineState(record.control, this.plugin.settings.defaultWritingRules, record);
		this.renderPipelineStart();
		this.logStep(`Started Stage 1 draft for existing control ${record.number || '(no number)'}`);
		void this.runStandardsAnalysis();
	}

	/** Step 1: free-text control/requirement input. */
	private renderPipelineStart(): void {
		this.pipelineEl.empty();

		const autoModeRow = this.pipelineEl.createDiv('auditor-automode-row');
		const autoModeLabel = autoModeRow.createEl('label', {
			cls: 'auditor-search-store-option',
		});
		const autoModeToggle = autoModeLabel.createEl('input', {
			type: 'checkbox',
		});
		autoModeToggle.checked = this.autoMode;
		autoModeToggle.addEventListener('change', () => {
			this.autoMode = autoModeToggle.checked;
		});
		autoModeLabel.createSpan({
			text: 'Auto-mode (automatically continue through each step, using default selections, until the draft is ready)',
		});

		this.pipelineHistoryEl = this.pipelineEl.createEl('details', {
			cls: 'auditor-thinking',
		});
		this.pipelineHistoryEl.createEl('summary', {
			text: 'Pipeline history',
		});
		this.renderStepsLog();

		const step = this.pipelineEl.createDiv('auditor-pipeline-step');
		step.createEl('h4', { text: '1. Audit control / requirement' });

		const input = step.createEl('textarea', {
			cls: 'auditor-pipeline-textarea',
		});
		input.rows = 3;
		input.placeholder =
			'Paste or describe the audit control / requirement to draft…';
		input.value = this.pipelineState.controlInput;

		const startBtn = step.createEl('button', {
			text: 'Search standards',
			cls: 'mod-cta',
		});
		startBtn.addEventListener('click', () => {
			this.pipelineTargetFile = null;
			this.pipelineState = emptyPipelineState(
				input.value.trim(),
				this.plugin.settings.defaultWritingRules,
			);
			if (!this.pipelineState.controlInput) return;
			this.logStep(
				`Started pipeline for: "${this.pipelineState.controlInput}"`,
			);
			void this.runStandardsAnalysis();
		});
	}

	private clearStepsAfter(step: number): void {
		const steps = this.pipelineEl.querySelectorAll(
			'.auditor-pipeline-step',
		);
		steps.forEach((el, i) => {
			if (i > step) el.remove();
		});
	}

	private showStatus(parent: HTMLElement, msg: string): HTMLElement {
		return parent.createEl('p', { text: msg, cls: 'auditor-status' });
	}

	/** Scrolls a newly-rendered step into view (bottom-aligned) so its "Continue" button is always visible once results land — in both manual and auto mode. */
	private scrollStepIntoView(step: HTMLElement): void {
		step.scrollIntoView({ behavior: 'smooth', block: 'end' });
	}

	/** Beeps once, using the Web Audio API (no bundled asset needed) — signals that auto-mode reached the final draft step. */
	private playNotificationSound(): void {
		try {
			const AudioCtx =
				window.AudioContext ??
				(
					window as unknown as {
						webkitAudioContext?: typeof AudioContext;
					}
				).webkitAudioContext;
			if (!AudioCtx) return;
			const ctx = new AudioCtx();
			const oscillator = ctx.createOscillator();
			const gain = ctx.createGain();
			oscillator.connect(gain);
			gain.connect(ctx.destination);
			oscillator.frequency.setValueAtTime(880, ctx.currentTime);
			oscillator.frequency.exponentialRampToValueAtTime(
				1320,
				ctx.currentTime + 0.15,
			);
			gain.gain.setValueAtTime(0.15, ctx.currentTime);
			gain.gain.exponentialRampToValueAtTime(
				0.001,
				ctx.currentTime + 0.4,
			);
			oscillator.start();
			oscillator.stop(ctx.currentTime + 0.4);
			window.setTimeout(() => {
				void ctx.close();
			}, 500);
		} catch (e) {
			console.error('[Auditor] failed to play notification sound', e);
		}
	}

	/** Appends a step to the running pipeline state log and refreshes its display. */
	private logStep(label: string): void {
		this.pipelineState.stepsPerformed.push({
			label,
			timestamp: Date.now(),
		});
		this.renderStepsLog();
	}

	private renderStepsLog(): void {
		this.pipelineHistoryEl.empty();
		this.pipelineHistoryEl.createEl('summary', {
			text: 'Pipeline history',
		});
		if (this.pipelineState.stepsPerformed.length === 0) {
			this.pipelineHistoryEl.createEl('p', {
				text: 'No steps performed yet.',
				cls: 'auditor-status',
			});
			return;
		}
		const list = this.pipelineHistoryEl.createEl('ol', {
			cls: 'auditor-history-list',
		});
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
			this.pipelineState.standardsResults =
				await this.plugin.standardsIndex.search(
					this.pipelineState.controlInput,
					this.plugin.settings.maxResults,
				);

			status.setText('Analyzing the control…');
			this.pipelineState.analysis =
				await this.plugin.geminiGenerate.analyzeControl(
					this.pipelineState.controlInput,
					this.pipelineState.standardsResults.map((r, i) => ({
						index: i,
						label: sourceLabel(r),
						text: r.text,
					})),
				);
			this.pipelineState.targetSelection = new Set(
				this.pipelineState.analysis.targetDocuments.map((_, i) => i),
			);
			this.pipelineState.currentMemory =
				this.pipelineState.analysis.memorySummary;
			this.logStep('Searched standards and analyzed the control');
			status.remove();
			this.renderControlUnderstandingStep(step);
			this.scrollStepIntoView(step);
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
			if (s.controlNumber)
				main.createSpan({
					text: ` — ${s.controlNumber}`,
					cls: 'auditor-control-number',
				});
			main.createEl('p', {
				text: s.reason,
				cls: 'auditor-evidence-chip-reason',
			});
			main.createEl('p', {
				text: s.excerpt,
				cls: 'auditor-evidence-chip-passage',
			});
		}

		if (analysis.references.length > 0) {
			const refsContainer = step.createDiv(
				'auditor-references-container',
			);
			refsContainer.createEl('h5', { text: 'References' });
			for (const r of analysis.references) {
				const card = refsContainer.createDiv('auditor-evidence-chip');
				const main = card.createDiv('auditor-evidence-chip-main');
				main.createSpan({
					text: r.controlNumber
						? `${r.standardName} — ${r.controlNumber}`
						: r.standardName,
					cls: 'auditor-evidence-chip-label',
				});
				main.createEl('p', {
					text: r.excerpt,
					cls: 'auditor-evidence-chip-passage',
				});
			}
		}

		const targetsContainer = step.createDiv('auditor-target-docs');
		targetsContainer.createEl('h5', { text: 'Documents to inspect' });
		const targetsList = targetsContainer.createDiv(
			'auditor-target-docs-list',
		);
		analysis.targetDocuments.forEach((doc, i) => {
			const item = targetsList.createDiv('auditor-target-doc-item');
			const label = item.createEl('label', {
				cls: 'auditor-target-doc-label',
			});
			const checkbox = label.createEl('input', { type: 'checkbox' });
			checkbox.checked = this.pipelineState.targetSelection.has(i);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) this.pipelineState.targetSelection.add(i);
				else this.pipelineState.targetSelection.delete(i);
			});
			label.createSpan({ text: doc.file });
			item.createEl('p', {
				text: doc.keywords.join(', '),
				cls: 'auditor-target-doc-keywords',
			});
		});

		if (analysis.memorySummary) {
			const memoryEl = step.createDiv('auditor-memory-summary');
			memoryEl.createEl('h5', { text: 'Requirements to verify' });
			memoryEl.createEl('p', { text: analysis.memorySummary });
		}

		const searchBtn = step.createEl('button', {
			text: 'Search for documents',
			cls: 'mod-cta',
		});
		searchBtn.addEventListener('click', () => {
			void this.runDocumentsResearch(searchBtn);
		});

		if (this.autoMode) void this.runDocumentsResearch(searchBtn);
	}

	/**
	 * Step 3 ("Research"): runs one RAG search per selected target document, concatenates all
	 * findings, and asks Gemini (with the Step 2 memory) to assess progress and identify gaps.
	 */
	private async runDocumentsResearch(
		searchBtn: HTMLButtonElement,
	): Promise<void> {
		const analysis = this.pipelineState.analysis;
		if (!analysis) return;
		this.clearStepsAfter(1);
		const step = this.pipelineEl.createDiv('auditor-pipeline-step');
		step.createEl('h4', { text: '3. Research' });
		const body = step.createDiv('auditor-research-body');
		const status = this.showStatus(
			body,
			'Searching evidence for each document…',
		);
		searchBtn.disabled = true;
		try {
			this.pipelineState.evidenceFindings = new Map();
			const targets = analysis.targetDocuments
				.map((doc, i) => ({ doc, i }))
				.filter(({ i }) => this.pipelineState.targetSelection.has(i));

			for (const { doc, i } of targets) {
				status.setText(`Searching for “${doc.file}”…`);
				const results = await this.plugin.evidenceIndex.search(
					doc.keywords.join(', '),
					this.plugin.settings.maxResults,
				);
				this.pipelineState.evidenceFindings.set(i, results);
			}

			status.setText('Assessing research progress…');
			this.pipelineState.researchAssessment =
				await this.plugin.geminiGenerate.assessResearchProgress(
					this.pipelineState.currentMemory || analysis.memorySummary,
					buildFindingsText(this.pipelineState),
				);
			this.pipelineState.currentMemory =
				this.pipelineState.researchAssessment.updatedMemory;
			this.logStep(
				`Searched evidence for ${targets.length} document(s) and assessed progress`,
			);
			status.remove();
			this.renderResearchStep(body);
			this.scrollStepIntoView(step);
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
		const status = this.showStatus(
			body,
			'Refining research assessment with your feedback…',
		);
		try {
			this.pipelineState.researchHistory.push(previous);
			this.pipelineState.userFeedbackHistory.push(
				this.pipelineState.userFeedback,
			);
			this.pipelineState.researchAssessment =
				await this.plugin.geminiGenerate.assessResearchProgress(
					this.pipelineState.currentMemory,
					buildFindingsText(this.pipelineState),
					{
						previousProgress: previous.progress,
						previousGaps: previous.gaps,
						userFeedback: this.pipelineState.userFeedback,
					},
				);
			this.pipelineState.currentMemory =
				this.pipelineState.researchAssessment.updatedMemory;
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
			for (const gap of assessment.gaps)
				gapsList.createEl('li', { text: gap });
		}

		body.createEl('h5', { text: 'Your input on the current progress' });
		const feedback = body.createEl('textarea', {
			cls: 'auditor-pipeline-textarea',
		});
		feedback.rows = 4;
		feedback.value = this.pipelineState.userFeedback;
		feedback.addEventListener('input', () => {
			this.pipelineState.userFeedback = feedback.value;
		});

		const actionsRow = body.createDiv('auditor-research-actions');
		const retryBtn = actionsRow.createEl('button', {
			text: 'Retry with feedback',
			cls: 'mod-muted',
		});
		retryBtn.addEventListener('click', () => {
			void this.retryResearchWithFeedback(body);
		});

		const nextBtn = actionsRow.createEl('button', {
			text: 'Continue with search for existing controls',
			cls: 'mod-cta',
		});
		nextBtn.addEventListener('click', () => {
			void this.runSimilarControlsSearch();
		});

		if (this.autoMode) void this.runSimilarControlsSearch();
	}

	/** Step 4: RAG over Written controls, user selects which to use as style reference. */
	private async runSimilarControlsSearch(): Promise<void> {
		this.clearStepsAfter(2);
		const step = this.pipelineEl.createDiv('auditor-pipeline-step');
		step.createEl('h4', { text: '4. Similar written controls' });
		const status = this.showStatus(step, 'Searching written controls…');
		try {
			this.pipelineState.similarResults =
				await this.plugin.writtenControlsIndex.search(
					buildControlUnderstandingText(this.pipelineState),
					this.plugin.settings.maxResults,
				);
			this.pipelineState.selectedSimilar = new Set(
				this.pipelineState.similarResults.map((_, i) => i),
			);
			this.logStep('Searched for existing written controls');
			status.remove();
			this.renderSimilarControlsStep(step);
			this.scrollStepIntoView(step);
		} catch (e) {
			status.setText(`Search failed: ${String(e)}`);
		}
	}

	private renderSimilarControlsStep(step: HTMLElement): void {
		this.renderSelectableResultList(
			step,
			this.pipelineState.similarResults,
			this.pipelineState.selectedSimilar,
		);

		const nextBtn = step.createEl('button', {
			text: 'Continue to finalizing',
			cls: 'mod-cta',
		});
		nextBtn.addEventListener('click', () => {
			void this.runFinalizationPlan(nextBtn);
		});

		if (this.autoMode) void this.runFinalizationPlan(nextBtn);
	}

	/**
	 * Step 5 ("Finalizing"): given all gathered evidence and the selected existing controls, has
	 * Gemini plan (by index, structured + thinking) what finding will be drawn from each one, shown
	 * to the auditor as a checklist to include/exclude before the draft is actually generated.
	 */
	private async runFinalizationPlan(
		nextBtn: HTMLButtonElement,
	): Promise<void> {
		this.clearStepsAfter(3);
		const step = this.pipelineEl.createDiv('auditor-pipeline-step');
		step.createEl('h4', { text: '5. Finalizing' });
		const status = this.showStatus(step, 'Planning the findings…');
		nextBtn.disabled = true;
		try {
			const candidates = buildFinalizationCandidates(this.pipelineState);
			this.pipelineState.finalizationPlan =
				await this.plugin.geminiGenerate.planFinalization(
					buildControlUnderstandingText(this.pipelineState),
					candidates.map((c) => ({
						index: c.index,
						label: c.label,
						kind: c.kind,
						text: c.text,
					})),
				);
			// Only pre-check what the LLM actually deemed relevant, not every candidate it was given.
			this.pipelineState.selectedFinalItems = new Set(
				this.pipelineState.finalizationPlan.items.map((i) => i.index),
			);
			this.logStep(
				`Planned findings for finalization (${this.pipelineState.finalizationPlan.items.length}/${candidates.length} kept)`,
			);
			status.remove();
			this.renderFinalizationStep(step);
			this.scrollStepIntoView(step);
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
			this.showStatus(
				list,
				'No documents or existing controls to finalize.',
			);
		}

		const byIndex = new Map(candidates.map((c) => [c.index, c]));
		const kept = plan.items
			.map((item) => ({ item, candidate: byIndex.get(item.index) }))
			.filter(
				(
					x,
				): x is {
					item: (typeof plan.items)[number];
					candidate: FinalizationCandidate;
				} => x.candidate !== undefined,
			);

		// Evidence chunks are grouped by their source file, with a master checkbox to toggle the
		// whole file at once, while each chunk stays individually toggleable underneath it.
		const evidenceGroups = new Map<
			string,
			{
				item: (typeof plan.items)[number];
				candidate: FinalizationCandidate;
			}[]
		>();
		for (const entry of kept.filter(
			(x) => x.candidate.kind === 'evidence',
		)) {
			const path = entry.candidate.result.sourcePath;
			const group = evidenceGroups.get(path);
			if (group) group.push(entry);
			else evidenceGroups.set(path, [entry]);
		}

		for (const [, entries] of evidenceGroups) {
			const groupEl = list.createDiv('auditor-finalization-group');
			const headerEl = groupEl.createDiv(
				'auditor-finalization-group-header',
			);
			const masterCheckbox = headerEl.createEl('input', {
				type: 'checkbox',
			});
			const firstEntry = entries[0]!;
			headerEl.createSpan({
				text: firstEntry.candidate.result.sourcePath,
				cls: 'auditor-finalization-group-title',
			});

			const chunkCheckboxes: HTMLInputElement[] = [];
			const syncMaster = () => {
				const checkedCount = entries.filter((e) =>
					this.pipelineState.selectedFinalItems.has(e.item.index),
				).length;
				masterCheckbox.checked = checkedCount === entries.length;
				masterCheckbox.indeterminate =
					checkedCount > 0 && checkedCount < entries.length;
			};
			masterCheckbox.addEventListener('change', () => {
				for (const entry of entries) {
					if (masterCheckbox.checked)
						this.pipelineState.selectedFinalItems.add(
							entry.item.index,
						);
					else
						this.pipelineState.selectedFinalItems.delete(
							entry.item.index,
						);
				}
				chunkCheckboxes.forEach((cb) => {
					cb.checked = masterCheckbox.checked;
				});
				masterCheckbox.indeterminate = false;
			});

			const chunksEl = groupEl.createDiv(
				'auditor-finalization-group-chunks',
			);
			for (const { item, candidate } of entries) {
				const card = chunksEl.createDiv('auditor-evidence-chip');
				const checkbox = card.createEl('input', { type: 'checkbox' });
				checkbox.checked = this.pipelineState.selectedFinalItems.has(
					item.index,
				);
				chunkCheckboxes.push(checkbox);
				checkbox.addEventListener('change', () => {
					if (checkbox.checked)
						this.pipelineState.selectedFinalItems.add(item.index);
					else
						this.pipelineState.selectedFinalItems.delete(
							item.index,
						);
					syncMaster();
				});

				const main = card.createDiv('auditor-evidence-chip-main');
				this.createFileLink(main, candidate.result);
				main.createEl('p', {
					text: item.plannedFinding,
					cls: 'auditor-evidence-chip-reason',
				});
			}
			syncMaster();
		}

		for (const { item, candidate } of kept.filter(
			(x) => x.candidate.kind === 'control',
		)) {
			const card = list.createDiv('auditor-evidence-chip');
			const checkbox = card.createEl('input', { type: 'checkbox' });
			checkbox.checked = this.pipelineState.selectedFinalItems.has(
				item.index,
			);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked)
					this.pipelineState.selectedFinalItems.add(item.index);
				else this.pipelineState.selectedFinalItems.delete(item.index);
			});

			const main = card.createDiv('auditor-evidence-chip-main');
			this.createFileLink(main, candidate.result);
			main.createSpan({
				text: ' — existing control',
				cls: 'auditor-control-number',
			});
			main.createEl('p', {
				text: item.plannedFinding,
				cls: 'auditor-evidence-chip-reason',
			});
		}

		step.createEl('h5', { text: 'Writing rules' });
		const rulesEl = step.createEl('textarea', {
			cls: 'auditor-pipeline-textarea auditor-rules-textarea',
		});
		rulesEl.rows = 16;
		rulesEl.value = this.pipelineState.writingRules;
		rulesEl.addEventListener('input', () => {
			this.pipelineState.writingRules = rulesEl.value;
		});

		step.createEl('h5', { text: 'Guidance for finalizing the report' });
		const guidanceEl = step.createEl('textarea', {
			cls: 'auditor-pipeline-textarea',
		});
		guidanceEl.rows = 4;
		guidanceEl.placeholder =
			'Anything else the drafting model should take into account…';
		guidanceEl.value = this.pipelineState.finalizationGuidance;
		guidanceEl.addEventListener('input', () => {
			this.pipelineState.finalizationGuidance = guidanceEl.value;
		});

		const nextBtn = step.createEl('button', {
			text: 'Draft control',
			cls: 'mod-cta',
		});
		nextBtn.addEventListener('click', () => {
			void this.runDraft();
		});

		if (this.autoMode) void this.runDraft();
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
				assessment && assessment.gaps.length > 0
					? `Remaining gaps:\n${assessment.gaps.join('\n')}`
					: '',
				this.pipelineState.userFeedback
					? `Auditor's notes:\n${this.pipelineState.userFeedback}`
					: '',
			]
				.filter(Boolean)
				.join('\n\n');

			const included = buildFinalizationCandidates(
				this.pipelineState,
			).filter((c) => this.pipelineState.selectedFinalItems.has(c.index));
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
				todConclusion: drafted.todConclusion,
				todRating: drafted.todRating,
			};
			this.logStep('Drafted the control');
			status.remove();
			this.renderThinking(step, drafted.thinking);
			const statusEl = this.renderDraftStep(step);
			this.scrollStepIntoView(step);
			if (this.autoMode) this.playNotificationSound();
			// Started from an existing control (see `startPipelineForControl`) — the whole point is to
			// run unattended and land the result on the control with no further clicks needed.
			if (this.pipelineTargetFile) void this.saveDraftToTargetFile(this.pipelineTargetFile, statusEl);
		} catch (e) {
			status.setText(`Draft failed: ${String(e)}`);
		}
	}

	/** Writes the current draft's Stage 1 fields into an existing control's file (used both by the "Save Stage 1 to ..." button and automatically when the pipeline was started from a control). */
	private async saveDraftToTargetFile(targetFile: TFile, statusEl: HTMLElement): Promise<void> {
		try {
			statusEl.setText('Saving…');
			await this.app.vault.modify(targetFile, buildControlNoteContent(this.pipelineState.draftRecord));
			void this.plugin.runIndexing('writtenControls');
			this.logStep(`Saved Stage 1 to ${this.pipelineState.draftRecord.number || targetFile.basename}`);
			this.plugin.refreshControlsViews();
			statusEl.setText('Saved.');
		} catch (e) {
			statusEl.setText(`Save failed: ${String(e)}`);
		}
	}

	private renderDraftStep(step: HTMLElement): HTMLElement {
		renderControlRecordFields(step, this.pipelineState.draftRecord);

		const targetFile = this.pipelineTargetFile;
		const saveBtn = step.createEl('button', {
			text: targetFile ? `Save Stage 1 to ${this.pipelineState.draftRecord.number || targetFile.basename}` : 'Save as new note',
			cls: 'mod-cta',
		});
		const statusEl = step.createDiv();
		saveBtn.addEventListener('click', () => {
			void (async () => {
				if (targetFile) {
					await this.saveDraftToTargetFile(targetFile, statusEl);
				} else {
					try {
						await this.plugin.saveControlNote(this.pipelineState.draftRecord);
						this.logStep('Saved the draft as a new note');
						statusEl.setText('Saved.');
					} catch (e) {
						statusEl.setText(`Save failed: ${String(e)}`);
					}
				}
			})();
		});
		return statusEl;
	}

	/** Read-only result list. */
	private renderResultList(
		container: HTMLElement,
		results: SearchResult[],
	): void {
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
				text:
					result.text.length > 600
						? `${result.text.slice(0, 600)}…`
						: result.text,
				cls: 'auditor-evidence-chip-passage',
			});
		}
	}

	/** Checkbox-selectable result list (used for the Similar-controls step). */
	private renderSelectableResultList(
		container: HTMLElement,
		results: SearchResult[],
		selected: Set<number>,
	): void {
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
				text:
					result.text.length > 600
						? `${result.text.slice(0, 600)}…`
						: result.text,
				cls: 'auditor-evidence-chip-passage',
			});
		});
	}

	// ─── Stage 2 evidence tab ───────────────────────────────────────────────

	/**
	 * Batch Stage 2 flow: pick any number of controls via checklist, then run the entire
	 * pipeline (standards → interview evidence → related controls → draft → save) for every
	 * selected control fully automatically, concurrently (bounded by `maxConcurrentStage2`). The
	 * UI only ever shows each control's current step, never the full intermediate results.
	 */
	private renderStage2Tab(container: HTMLElement): void {
		const toolbar = container.createDiv('auditor-controls-toolbar');
		const refreshBtn = toolbar.createEl('button', { text: 'Refresh' });
		const runBtn = toolbar.createEl('button', {
			text: 'Run selected',
			cls: 'mod-cta',
		});
		runBtn.disabled = true;

		const status = container.createDiv();
		const checklistEl = container.createDiv('auditor-stage2-checklist');
		const progressEl = container.createDiv('auditor-stage2-progress');

		let entries: { file: TFile; record: ControlRecord }[] = [];
		const selected = new Set<string>();

		const renderChecklist = () => {
			checklistEl.empty();
			for (const entry of entries) {
				const row = checklistEl.createDiv(
					'auditor-stage2-checklist-row',
				);
				const checkbox = row.createEl('input', { type: 'checkbox' });
				checkbox.checked = selected.has(entry.file.path);
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) selected.add(entry.file.path);
					else selected.delete(entry.file.path);
					runBtn.disabled = selected.size === 0;
				});
				row.createSpan({
					text: entry.record.number || '(no number)',
					cls: 'auditor-control-card-number',
				});
				row.createSpan({
					text: entry.record.standard,
					cls: 'auditor-stage2-row-meta',
				});
				row.createSpan({
					text: entry.record.topic,
					cls: 'auditor-stage2-row-meta',
				});
				if (entry.record.toeConclusion.trim()) {
					row.createSpan({
						text: 'Has Stage 2',
						cls: 'auditor-chip auditor-chip-has-stage2',
					});
				}
			}
		};

		const load = async () => {
			status.setText('Loading controls…');
			const folder = this.plugin.settings.writtenControlsFolder;
			const files = this.app.vault
				.getFiles()
				.filter(
					(f) =>
						f.extension === 'md' &&
						(!folder ||
							f.path === folder ||
							f.path.startsWith(`${folder}/`)),
				);
			const loaded: { file: TFile; record: ControlRecord }[] = [];
			for (const file of files) {
				const content = await this.app.vault.cachedRead(file);
				loaded.push({
					file,
					record: parseControlNoteContent(content, file.basename),
				});
			}
			loaded.sort((a, b) =>
				a.record.number.localeCompare(b.record.number, undefined, {
					numeric: true,
				}),
			);
			entries = loaded;
			status.setText(`${entries.length} control(s).`);
			renderChecklist();
		};

		refreshBtn.addEventListener('click', () => {
			void load();
		});
		runBtn.addEventListener('click', () => {
			const targets = entries.filter((e) => selected.has(e.file.path));
			void this.runStage2Batch(targets, progressEl, runBtn);
		});

		void load();
	}

	/** Runs the full automatic Stage 2 pipeline for every target control, `maxConcurrentStage2` at a time, writing each conclusion straight to its file. */
	private async runStage2Batch(
		targets: { file: TFile; record: ControlRecord }[],
		progressEl: HTMLElement,
		runBtn: HTMLButtonElement,
	): Promise<void> {
		if (targets.length === 0) return;
		runBtn.disabled = true;
		progressEl.empty();

		const rowRefs = new Map<
			string,
			{ spinner: HTMLElement; label: HTMLElement }
		>();
		for (const { file } of targets) {
			const row = progressEl.createDiv('auditor-active-file-row');
			const spinner = row.createDiv('auditor-spinner');
			const label = row.createSpan({ text: `${file.basename}: Queued…` });
			rowRefs.set(file.path, { spinner, label });
		}

		let anySaved = false;
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < targets.length) {
				const target = targets[cursor++]!;
				const refs = rowRefs.get(target.file.path)!;
				const setStep = (text: string) => {
					refs.label.setText(`${target.file.basename}: ${text}`);
				};
				try {
					await this.runStage2Auto(
						target.file,
						target.record,
						setStep,
					);
					anySaved = true;
					setStep('Done');
					refs.spinner.removeClass('auditor-spinner');
					refs.spinner.addClass('auditor-step-done');
				} catch (e) {
					setStep(`Failed: ${String(e)}`);
					refs.spinner.removeClass('auditor-spinner');
					refs.spinner.addClass('auditor-step-failed');
				}
			}
		};

		const workerCount = Math.max(
			1,
			Math.min(this.plugin.settings.maxConcurrentStage2, targets.length),
		);
		await Promise.all(Array.from({ length: workerCount }, worker));

		if (anySaved) void this.plugin.runIndexing('writtenControls');
		runBtn.disabled = false;
	}

	/** One control's full Stage 2 pipeline: supporting-standards + interview-evidence + related-controls RAG (all results used, none manually curated), draft, then save straight to the file. */
	private async runStage2Auto(
		file: TFile,
		record: ControlRecord,
		onStep: (text: string) => void,
	): Promise<void> {
		const query = [record.control, record.todConclusion]
			.filter(Boolean)
			.join('\n\n');

		onStep('Searching standards…');
		const standardsResults = await this.plugin.standardsIndex.search(
			query,
			this.plugin.settings.maxResults,
		);

		onStep('Searching interview evidence…');
		const interviewResults =
			await this.plugin.interviewEvidenceIndex.search(
				query,
				this.plugin.settings.maxResults,
			);

		onStep('Searching related controls…');
		const relatedRaw = await this.plugin.writtenControlsIndex.search(
			query,
			this.plugin.settings.maxResults + 1,
		);
		const relatedResults = relatedRaw.filter(
			(r) => r.sourcePath !== file.path,
		);

		onStep('Drafting…');
		const standardsContext = standardsResults
			.map((r) => `[${sourceLabel(r)}]\n${r.text}`)
			.join('\n\n');
		const interviewContext = interviewResults
			.map((r) => `[${sourceLabel(r)}]\n${r.text}`)
			.join('\n\n');
		const relatedContext = relatedResults
			.map((r) => `[${sourceLabel(r)}]\n${r.text}`)
			.join('\n\n');
		const draft = await this.plugin.geminiGenerate.draftStage2Control(
			record.control,
			record.todConclusion,
			standardsContext,
			interviewContext,
			relatedContext,
			this.plugin.settings.defaultStage2WritingRules,
			'',
		);

		onStep('Saving…');
		const updated: ControlRecord = {
			...record,
			toeConclusion: draft.toeConclusion,
			toeRating: draft.toeRating,
		};
		await this.app.vault.modify(file, buildControlNoteContent(updated));
	}

	/**
	 * Entry point for drafting Stage 2 directly on an existing control in the background (e.g. from
	 * the Controls view) — `runStage2Auto` is already fully headless (no UI rendering, just RAG +
	 * draft + save), so this just runs it and refreshes/notifies once done, without needing to touch
	 * any tab.
	 */
	async draftStage2InBackground(file: TFile, record: ControlRecord): Promise<void> {
		try {
			await this.runStage2Auto(file, record, () => {});
			void this.plugin.runIndexing('writtenControls');
			this.plugin.refreshControlsViews();
			new Notice(`Auditor: drafted Stage 2 for ${record.number || file.basename}`);
		} catch (e) {
			new Notice(`Auditor: Stage 2 draft failed for ${record.number || file.basename} — ${String(e)}`);
		}
	}

	// ─── Prepare session tab ────────────────────────────────────────────────

	/**
	 * Builds Evidence Goals (EGs) for every control in a session, one control at a time and strictly
	 * in order — each control's planning step sees every EG created/modified by the controls before
	 * it (via the EG index), so the LLM can genuinely reuse or broaden an existing EG instead of
	 * creating a near-duplicate. A final compression pass then looks for merges across the finished
	 * set. Deliberately sequential, unlike the concurrent Stage 2 batch pipeline — concurrency here
	 * would mean controls processed in parallel can't see each other's new EGs, defeating the point.
	 */
	private renderPrepareSessionTab(container: HTMLElement): void {
		const setupField = container.createDiv('auditor-field');
		setupField.createEl('label', { text: 'Client setup description', cls: 'auditor-field-label' });
		setupField.createEl('p', {
			text: 'A Markdown note describing what the client\'s setup looks like in practice, to the best of our knowledge — used to ground evidence-goal descriptions and questions in what realistically exists.',
			cls: 'auditor-field-description',
		});
		const setupSelect = setupField.createEl('select');
		setupSelect.createEl('option', { text: '— choose a file —', value: '' });
		for (const file of this.app.vault.getFiles().filter((f) => f.extension === 'md')) {
			setupSelect.createEl('option', { text: file.path, value: file.path });
		}

		const toolbar = container.createDiv('auditor-controls-toolbar');
		const sessionSelect = toolbar.createEl('select');
		sessionSelect.createEl('option', { text: '— choose a session —', value: '' });
		const startBtn = toolbar.createEl('button', { text: 'Prepare session', cls: 'mod-cta' });
		startBtn.disabled = true;
		const viewPlanBtn = toolbar.createEl('button', { text: 'View session plan' });
		viewPlanBtn.disabled = true;
		viewPlanBtn.addEventListener('click', () => {
			if (sessionSelect.value) void this.plugin.openSessionPlan(sessionSelect.value);
		});

		const status = container.createDiv('auditor-status');
		const progressEl = container.createDiv('auditor-stage2-progress');
		const resultsEl = container.createDiv();

		let allControls: { file: TFile; record: ControlRecord }[] = [];

		const updateStartEnabled = () => {
			startBtn.disabled = !sessionSelect.value || !setupSelect.value;
			viewPlanBtn.disabled = !sessionSelect.value;
		};

		const loadSessions = async () => {
			status.setText('Loading sessions…');
			const folder = this.plugin.settings.writtenControlsFolder;
			const files = this.app.vault
				.getFiles()
				.filter((f) => f.extension === 'md' && (!folder || f.path === folder || f.path.startsWith(`${folder}/`)));
			const loaded: { file: TFile; record: ControlRecord }[] = [];
			for (const file of files) {
				const content = await this.app.vault.cachedRead(file);
				loaded.push({ file, record: parseControlNoteContent(content, file.basename) });
			}
			allControls = loaded;
			const sessions = [...new Set(loaded.map((e) => e.record.session).filter((s) => s.trim()))].sort((a, b) => a.localeCompare(b));
			const currentValue = sessionSelect.value;
			sessionSelect.empty();
			sessionSelect.createEl('option', { text: '— choose a session —', value: '' });
			for (const session of sessions) sessionSelect.createEl('option', { text: session, value: session });
			sessionSelect.value = sessions.includes(currentValue) ? currentValue : '';
			updateStartEnabled();
			status.setText(`${sessions.length} session(s) across ${loaded.length} control(s).`);
		};

		sessionSelect.addEventListener('change', updateStartEnabled);
		setupSelect.addEventListener('change', updateStartEnabled);
		startBtn.addEventListener('click', () => {
			void (async () => {
				if (!sessionSelect.value || !setupSelect.value) return;
				const setupFile = this.app.vault.getAbstractFileByPath(setupSelect.value);
				const setupContext = setupFile instanceof TFile ? await this.app.vault.cachedRead(setupFile) : '';
				const targets = allControls.filter((e) => e.record.session === sessionSelect.value);
				void this.runPrepareSession(sessionSelect.value, setupContext, targets, progressEl, resultsEl, startBtn);
			})();
		});

		void loadSessions();
	}

	/** Plain-text context an EG-planning call sees for one control: standard/topic/control text, plus Stage 1/Stage 2 conclusions when present. */
	private buildEgControlContext(record: ControlRecord): string {
		return [
			`Control ${record.number}`,
			`Standard: ${record.standard}`,
			`Topic: ${record.topic}`,
			'',
			'Control text:',
			record.control,
			...(record.todConclusion.trim() ? ['', 'Stage 1 (Test of Design) conclusion:', record.todConclusion] : []),
			...(record.toeConclusion.trim() ? ['', 'Stage 2 (Test of Effectiveness) conclusion:', record.toeConclusion] : []),
		].join('\n');
	}

	private async runPrepareSession(
		session: string,
		setupContext: string,
		targets: { file: TFile; record: ControlRecord }[],
		progressEl: HTMLElement,
		resultsEl: HTMLElement,
		startBtn: HTMLButtonElement,
	): Promise<void> {
		startBtn.disabled = true;
		progressEl.empty();
		resultsEl.empty();

		let plan: InterviewSessionPlan = await this.plugin.loadSessionPlan(session);

		for (const { record } of targets) {
			const row = progressEl.createDiv('auditor-active-file-row');
			const spinner = row.createDiv('auditor-spinner');
			const label = row.createSpan({ text: `${record.number}: Starting…` });
			const setStep = (text: string) => { label.setText(`${record.number}: ${text}`); };

			try {
				const query = [record.control, record.todConclusion, record.toeConclusion].filter(Boolean).join('\n\n');

				setStep('Searching standards…');
				const standardsResults = await this.plugin.standardsIndex.search(query, this.plugin.settings.maxResults);
				const standardsContext = standardsResults.map((r) => `[${sourceLabel(r)}]\n${r.text}`).join('\n\n');

				setStep('Searching evidence…');
				const evidenceResults = await this.plugin.evidenceIndex.search(query, this.plugin.settings.maxResults);
				const evidenceContext = evidenceResults.map((r) => `[${sourceLabel(r)}]\n${r.text}`).join('\n\n');

				setStep('Looking for similar evidence goals…');
				const candidateMatches = await this.plugin.evidenceGoalIndex.search(query, 8, session);
				const candidateIds = new Set(candidateMatches.map((m) => m.id));

				setStep('Deciding…');
				const controlContext = this.buildEgControlContext(record);
				const candidates = plan.evidenceGoals
					.filter((eg) => candidateIds.has(eg.id))
					.map((eg) => ({ id: eg.id, name: eg.name, description: eg.description, questions: eg.questions, type: eg.type, controlNumbers: eg.controlNumbers }));
				const result = await this.plugin.geminiGenerate.planEvidenceGoal(controlContext, standardsContext, setupContext, evidenceContext, candidates);

				// A control can need more than one evidence goal (e.g. two distinct config screens) —
				// apply every decision in turn, against the same in-progress plan, so later decisions in
				// this same control still see EGs the earlier ones just touched.
				const touchedNames: string[] = [];
				for (const decision of result.decisions) {
					let touchedEg: EvidenceGoal;
					if (decision.action === 'create') {
						touchedEg = { ...emptyEvidenceGoal(session, record.number), name: decision.name, description: decision.description, questions: decision.questions, type: decision.type };
						plan.evidenceGoals.push(touchedEg);
						touchedNames.push(`Created "${touchedEg.name}"`);
					} else {
						const target = plan.evidenceGoals.find((eg) => eg.id === decision.targetId);
						if (!target) {
							// The model referenced an EG that isn't actually in the candidate set — fall back to
							// creating a new one rather than silently dropping this piece of evidence.
							touchedEg = { ...emptyEvidenceGoal(session, record.number), name: decision.name || `Evidence for ${record.number}`, description: decision.description, questions: decision.questions, type: decision.type || 'screenshot' };
							plan.evidenceGoals.push(touchedEg);
							touchedNames.push(`Created "${touchedEg.name}" (target not found)`);
						} else {
							if (decision.action === 'modify_and_link') {
								target.name = decision.name || target.name;
								target.description = decision.description || target.description;
								target.questions = decision.questions.length > 0 ? decision.questions : target.questions;
								target.type = decision.type || target.type;
							}
							if (!target.controlNumbers.includes(record.number)) target.controlNumbers.push(record.number);
							touchedEg = target;
							touchedNames.push(`${decision.action === 'link' ? 'Linked to' : 'Merged into'} "${touchedEg.name}"`);
						}
					}
					void this.plugin.evidenceGoalIndex.upsert(touchedEg);
				}

				await this.plugin.saveSessionPlan(plan);
				setStep(touchedNames.join('; ') || 'No evidence goal needed');

				spinner.removeClass('auditor-spinner');
				spinner.addClass('auditor-step-done');
			} catch (e) {
				setStep(`Failed: ${String(e)}`);
				spinner.removeClass('auditor-spinner');
				spinner.addClass('auditor-step-failed');
			}
		}

		// Step 4: a final pass over the whole finished set, looking for further compression.
		const compressRow = progressEl.createDiv('auditor-active-file-row');
		const compressSpinner = compressRow.createDiv('auditor-spinner');
		const compressLabel = compressRow.createSpan({ text: 'Compressing evidence goals…' });
		try {
			// `plan` already reflects every save from the loop above (mutated + persisted in place),
			// so no need to re-read it from disk here.
			if (plan.evidenceGoals.length > 1) {
				const compression = await this.plugin.geminiGenerate.compressEvidenceGoals(
					plan.evidenceGoals.map((eg) => ({ id: eg.id, name: eg.name, description: eg.description, questions: eg.questions, type: eg.type, controlNumbers: eg.controlNumbers })),
				);
				let mergedCount = 0;
				for (const merge of compression.merges) {
					const sources = plan.evidenceGoals.filter((eg) => merge.sourceIds.includes(eg.id));
					if (sources.length < 2) continue;
					const survivor = sources[0]!;
					survivor.name = merge.name;
					survivor.description = merge.description;
					survivor.questions = merge.questions;
					survivor.type = merge.type;
					survivor.controlNumbers = [...new Set(sources.flatMap((eg) => eg.controlNumbers))];
					const otherIds = new Set(sources.slice(1).map((eg) => eg.id));
					plan.evidenceGoals = plan.evidenceGoals.filter((eg) => !otherIds.has(eg.id));
					mergedCount += sources.length - 1;
				}
				if (mergedCount > 0) {
					await this.plugin.saveSessionPlan(plan);
					await this.plugin.evidenceGoalIndex.rebuildAll(this.app.vault, this.plugin.evidenceGoalsSubfolder());
				}
				compressLabel.setText(mergedCount > 0 ? `Compressed ${mergedCount} evidence goal(s) away.` : 'No further compression found.');
			} else {
				compressLabel.setText('Nothing to compress.');
			}
			compressSpinner.removeClass('auditor-spinner');
			compressSpinner.addClass('auditor-step-done');
		} catch (e) {
			compressLabel.setText(`Compression failed: ${String(e)}`);
			compressSpinner.removeClass('auditor-spinner');
			compressSpinner.addClass('auditor-step-failed');
		}

		// Step 5: organize the finished EGs into domain/topic groups for the interview to walk through.
		const groupRow = progressEl.createDiv('auditor-active-file-row');
		const groupSpinner = groupRow.createDiv('auditor-spinner');
		const groupLabel = groupRow.createSpan({ text: 'Grouping evidence goals by domain…' });
		try {
			if (plan.evidenceGoals.length > 0) {
				await this.applyDomainGrouping(plan);
				await this.plugin.saveSessionPlan(plan);
				groupLabel.setText(`Organized into ${plan.groups.length} group(s).`);
			} else {
				groupLabel.setText('Nothing to group.');
			}
			groupSpinner.removeClass('auditor-spinner');
			groupSpinner.addClass('auditor-step-done');
		} catch (e) {
			groupLabel.setText(`Grouping failed: ${String(e)}`);
			groupSpinner.removeClass('auditor-spinner');
			groupSpinner.addClass('auditor-step-failed');
		}

		this.renderPrepareSessionResults(resultsEl, plan);
		startBtn.disabled = false;
	}

	/** Asks the LLM to sort every EG in `plan` into domain/topic groups, replacing whatever grouping it had before. Mutates `plan` in place; caller is responsible for persisting it. */
	private async applyDomainGrouping(plan: InterviewSessionPlan): Promise<void> {
		const grouping = await this.plugin.geminiGenerate.groupEvidenceGoalsByDomain(
			plan.evidenceGoals.map((eg) => ({ id: eg.id, name: eg.name, description: eg.description, controlNumbers: eg.controlNumbers })),
		);
		const groups: { id: string; title: string }[] = [];
		const assignedGroupId = new Map<string, string>();
		for (const group of grouping.groups) {
			if (group.evidenceGoalIds.length === 0) continue;
			const groupId = generateEvidenceGoalGroupId();
			groups.push({ id: groupId, title: group.title });
			for (const egId of group.evidenceGoalIds) assignedGroupId.set(egId, groupId);
		}
		for (const eg of plan.evidenceGoals) eg.groupId = assignedGroupId.get(eg.id) ?? '';
		plan.groups = groups;
	}

	private renderPrepareSessionResults(resultsEl: HTMLElement, plan: InterviewSessionPlan): void {
		resultsEl.empty();
		resultsEl.createEl('h4', { text: `${plan.evidenceGoals.length} evidence goal(s) for "${plan.session}"` });
		const renderEg = (eg: EvidenceGoal) => {
			const card = resultsEl.createDiv('auditor-eg-card');
			card.createEl('strong', { text: eg.name || '(untitled)' });
			card.createDiv({ cls: 'auditor-field-description', text: `Controls: ${eg.controlNumbers.join(', ')}` });
			card.createDiv({ cls: 'auditor-eg-also-used-by', text: eg.description });
		};
		if (plan.groups.length === 0) {
			for (const eg of plan.evidenceGoals) renderEg(eg);
			return;
		}
		for (const group of plan.groups) {
			resultsEl.createEl('h5', { text: group.title });
			for (const eg of plan.evidenceGoals.filter((e) => e.groupId === group.id)) renderEg(eg);
		}
		const ungrouped = plan.evidenceGoals.filter((eg) => !eg.groupId);
		if (ungrouped.length > 0) {
			resultsEl.createEl('h5', { text: 'Ungrouped' });
			for (const eg of ungrouped) renderEg(eg);
		}
	}

	// ─── Chat tab ────────────────────────────────────────────────────────────

	/** Free-form chat with the LLM, grounded by RAG retrieval (top 30 combined) across every index on each message. */
	private renderChatTab(container: HTMLElement): void {
		const messagesEl = container.createDiv('auditor-chat-messages');
		const inputRow = container.createDiv('auditor-chat-input-row');
		const input = inputRow.createEl('textarea', {
			cls: 'auditor-pipeline-textarea',
		});
		input.rows = 3;
		input.placeholder =
			'Ask anything about your standards, evidence, written controls, or interview evidence…';
		const sendBtn = inputRow.createEl('button', {
			text: 'Send',
			cls: 'mod-cta',
		});

		const send = () => {
			const question = input.value.trim();
			if (!question) return;
			input.value = '';
			void this.runChatTurn(question, messagesEl, sendBtn);
		};
		sendBtn.addEventListener('click', send);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				send();
			}
		});

		this.renderChatMessages(messagesEl);
	}

	/** LLM replies are markdown, so render them (headings, lists, bold/italic, code, links) instead of dumping raw text. */
	private renderChatMessages(messagesEl: HTMLElement): void {
		messagesEl.empty();
		for (const message of this.chatMessages) {
			const row = messagesEl.createDiv(
				`auditor-chat-message auditor-chat-message-${message.role}`,
			);
			const textEl = row.createDiv('auditor-chat-message-text');
			renderChatMarkdownInto(textEl, message.text);
			if (message.sources && message.sources.length > 0) {
				const sourcesEl = row.createEl('details', {
					cls: 'auditor-thinking',
				});
				sourcesEl.createEl('summary', {
					text: `Sources (${message.sources.length})`,
				});
				const list = sourcesEl.createDiv('auditor-search-files-list');
				for (const { result, kind } of message.sources) {
					const item = list.createDiv('auditor-search-file-item');
					this.createFileLink(item, result);
					item.createSpan({
						text: ` — ${SEARCH_STORE_LABELS[kind]}`,
						cls: 'auditor-control-number',
					});
				}
			}
		}
		messagesEl.scrollTo({
			top: messagesEl.scrollHeight,
			behavior: 'smooth',
		});
	}

	/** Searches every index with the same query and merges results by score, capped at CHAT_RETRIEVAL_TOP_K combined. */
	private async retrieveChatContext(
		query: string,
	): Promise<{ result: SearchResult; kind: StoreKind }[]> {
		const kinds: StoreKind[] = [
			'standards',
			'evidence',
			'writtenControls',
			'interviewEvidence',
		];
		const perStore = await Promise.all(
			kinds.map((kind) =>
				this.plugin.storeFor(kind).search(query, CHAT_RETRIEVAL_TOP_K),
			),
		);
		const combined = perStore.flatMap((results, i) =>
			results.map((result) => ({ result, kind: kinds[i]! })),
		);
		combined.sort((a, b) => b.result.score - a.result.score);
		return combined.slice(0, CHAT_RETRIEVAL_TOP_K);
	}

	private async runChatTurn(
		question: string,
		messagesEl: HTMLElement,
		sendBtn: HTMLButtonElement,
	): Promise<void> {
		this.chatMessages.push({ role: 'user', text: question });
		this.renderChatMessages(messagesEl);

		sendBtn.disabled = true;
		const statusEl = this.showStatus(messagesEl, 'Planning search…');
		try {
			const history = this.chatMessages
				.slice(0, -1)
				.map((m) => ({ role: m.role, text: m.text }));

			// Step 1: decide whether/what to search for — a keyword-dense query, not just the raw message.
			const plan = await this.plugin.geminiGenerate.planChatSearch(
				history,
				question,
			);

			// Step 2: run the RAG search (if the plan calls for it) using that query.
			let sources: { result: SearchResult; kind: StoreKind }[] = [];
			if (plan.shouldSearch && plan.searchQuery) {
				statusEl.setText('Searching your vault…');
				sources = await this.retrieveChatContext(plan.searchQuery);
			}

			// Step 3: final answer, grounded in the compounded retrieved context.
			statusEl.setText('Thinking…');
			const contextText = sources
				.map(
					({ result, kind }) =>
						`[${SEARCH_STORE_LABELS[kind]} — ${sourceLabel(result)}]\n${result.text}`,
				)
				.join('\n\n');
			const answer = await this.plugin.geminiGenerate.chatWithRag(
				history,
				contextText,
				question,
			);

			statusEl.remove();
			this.chatMessages.push({
				role: 'assistant',
				text: answer,
				sources,
			});
			this.renderChatMessages(messagesEl);
		} catch (e) {
			statusEl.setText(`Failed: ${String(e)}`);
		} finally {
			sendBtn.disabled = false;
		}
	}
}
