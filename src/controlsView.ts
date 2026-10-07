import { ItemView, Notice, TFile, WorkspaceLeaf, prepareFuzzySearch, setIcon } from 'obsidian';
import type AuditorPlugin from './main';
import {
	buildControlNoteContent,
	CONTROL_STATUSES,
	parseControlNoteContent,
	sanitizeFileTitle,
	statusSlug,
	type ControlRecord,
} from './controlNote';
import { ExcelLinkModal, confirmExcelOverwrite } from './excelLinkModal';
import { isExcelLinkConfigured, previewSyncFromExcel, syncFromExcel, syncToExcel } from './excelLink';
import { EvidenceGoalsModal } from './evidenceGoalsModal';
import { ExportControlsModal } from './exportControlsModal';
import { RapidFireExportModal } from './rapidFire/exportModal';
import type { DraftStage } from './agent/draftQueue';

export const CONTROLS_VIEW_TYPE = 'auditor-controls-view';

const QUEUE_BUTTON_LABEL: Record<DraftStage, { add: string; queued: string }> = {
	stage1: { add: 'Add stage 1 to queue', queued: 'Queued for stage 1 (click to remove)' },
	stage2: { add: 'Add stage 2 to queue', queued: 'Queued for stage 2 (click to remove)' },
};

function ratingClass(rating: string): string {
	if (rating === 'NC') return 'auditor-rating-nc';
	if (rating === 'C*') return 'auditor-rating-cstar';
	if (rating === 'C') return 'auditor-rating-c';
	if (rating === '-') return 'auditor-rating-na';
	return 'auditor-rating-none';
}

/** Conclusion state for the "ready" chips: empty (nothing written), draft (written but not marked ready), or ready (explicitly marked). */
function readinessState(conclusion: string, ready: boolean): 'empty' | 'draft' | 'ready' {
	if (ready) return 'ready';
	return conclusion.trim() ? 'draft' : 'empty';
}

const READINESS_LABELS: Record<ReturnType<typeof readinessState>, string> = {
	empty: 'Empty',
	draft: 'Draft',
	ready: 'Ready',
};

/**
 * The card background reflects the most critical rating achieved across the two stages: NC (red)
 * outranks C* (blue), which outranks C (green). If both stages are explicitly "not applicable" the
 * card gets a faint neutral tint instead. Otherwise (nothing rated yet, or a mix with no rating
 * present) falls back to the status-based background.
 */
function cardBackgroundClass(todRating: string, toeRating: string, status: string): string {
	if (todRating === 'NC' || toeRating === 'NC') return 'auditor-card-bg-nc';
	if (todRating === 'C*' || toeRating === 'C*') return 'auditor-card-bg-cstar';
	if (todRating === 'C' || toeRating === 'C') return 'auditor-card-bg-c';
	if (todRating === '-' && toeRating === '-') return 'auditor-card-bg-na';
	return `auditor-status-${statusSlug(status)}`;
}

/** Severity order for the "minimum rating" filter — higher is more critical. Unrated and "not applicable" both sit at the bottom. */
const RATING_SEVERITY: Record<string, number> = { NC: 3, 'C*': 2, C: 1, '-': 0, '': 0 };

function maxSeverity(record: ControlRecord): number {
	return Math.max(RATING_SEVERITY[record.todRating] ?? 0, RATING_SEVERITY[record.toeRating] ?? 0);
}

interface ControlFilters {
	/** Empty set = no restriction (matches everything) — for session/standard/topic/status, multiple values may be selected at once (e.g. sessions 1, 2, 3). */
	sessions: Set<string>;
	standards: Set<string>;
	topics: Set<string>;
	statuses: Set<string>;
	minRating: '' | 'C' | 'C*' | 'NC';
	commentsOnly: boolean;
	/** Fuzzy-matched against each control's `control` text (see `prepareFuzzySearch`) — applied and sorted by match score separately from the discrete filters below. */
	searchQuery: string;
}

function emptyFilters(): ControlFilters {
	return { sessions: new Set(), standards: new Set(), topics: new Set(), statuses: new Set(), minRating: '', commentsOnly: false, searchQuery: '' };
}

/** Human-readable summary of the active filters — shown in the Rapid Fire export confirmation (FR-8.1) and stored on the resulting batch as a frozen label, never re-evaluated against live filter state. */
function describeFilters(filters: ControlFilters): string {
	const parts: string[] = [];
	if (filters.sessions.size > 0) parts.push(`session: ${[...filters.sessions].join(', ')}`);
	if (filters.standards.size > 0) parts.push(`standard: ${[...filters.standards].join(', ')}`);
	if (filters.topics.size > 0) parts.push(`topic: ${[...filters.topics].join(', ')}`);
	if (filters.statuses.size > 0) parts.push(`status: ${[...filters.statuses].join(', ')}`);
	if (filters.minRating) parts.push(`rating ≥ ${filters.minRating}`);
	if (filters.commentsOnly) parts.push('has comments');
	if (filters.searchQuery.trim()) parts.push(`search: "${filters.searchQuery.trim()}"`);
	return parts.join('; ');
}

function matchesFilters(record: ControlRecord, filters: ControlFilters): boolean {
	if (filters.sessions.size > 0 && !filters.sessions.has(record.session)) return false;
	if (filters.standards.size > 0 && !filters.standards.has(record.standard)) return false;
	if (filters.topics.size > 0 && !filters.topics.has(record.topic)) return false;
	if (filters.statuses.size > 0 && !filters.statuses.has(record.status)) return false;
	if (filters.minRating && maxSeverity(record) < (RATING_SEVERITY[filters.minRating] ?? 0)) return false;
	if (filters.commentsOnly && record.comments.length === 0) return false;
	return true;
}

/** Distinct, sorted non-empty values of `key` across all entries — used to populate the session/standard/topic/status filter dropdowns from whatever's actually in the vault. */
function distinctValues(entries: { record: ControlRecord }[], key: 'session' | 'standard' | 'topic' | 'status'): string[] {
	return [...new Set(entries.map((e) => e.record[key]).filter((v) => v.trim()))].sort((a, b) => a.localeCompare(b));
}

type SetFilterKey = 'sessions' | 'standards' | 'topics' | 'statuses';
const RECORD_KEY_FOR: Record<SetFilterKey, 'session' | 'standard' | 'topic' | 'status'> = {
	sessions: 'session',
	standards: 'standard',
	topics: 'topic',
	statuses: 'status',
};

/**
 * Options for one multi-select filter, narrowed to whatever's actually reachable given every
 * OTHER currently-active filter (sets, min rating, comments-only — not the free-text search,
 * which stays a separate reordering step) — so picking a session, say, immediately shrinks the
 * Standard/Topic/Status dropdowns to only the values that still occur within it, cascading as more
 * filters are added. A value already selected in `except` itself is never excluded by this, since
 * `except`'s own criterion is dropped before matching.
 */
function optionsExcluding(entries: { record: ControlRecord }[], filters: ControlFilters, except: SetFilterKey): string[] {
	const partial: ControlFilters = { ...filters, [except]: new Set<string>() };
	const matching = entries.filter((e) => matchesFilters(e.record, partial));
	return distinctValues(matching, RECORD_KEY_FOR[except]);
}

/**
 * Sidebar/main-area view listing every written control as a filterable, one-per-row stack
 * (info+chips / control text / comments — the comments column is omitted when there are none),
 * opened via the "Controls" ribbon icon. Editing the full record, including adding comments,
 * happens in the separate `ControlDetailView` (right panel) via the "Edit control" button — this
 * view itself only supports a quick status change, which saves straight to disk.
 */
export class ControlsView extends ItemView {
	private plugin: AuditorPlugin;
	private reload: () => Promise<void> = async () => {};
	/** One `sync()` closure per currently-rendered queue button, re-run whenever the queue changes elsewhere (e.g. cleared/launched from the chat) so these cards stay truthful without a full grid reload. Reset on every grid rebuild. */
	private queueButtonSyncs: (() => void)[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: AuditorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CONTROLS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Controls';
	}

	getIcon(): string {
		return 'list-checks';
	}

	async onOpen(): Promise<void> {
		this.register(this.plugin.draftQueue.onChange(() => {
			for (const sync of this.queueButtonSyncs) sync();
		}));
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		// Unlike the other views, this container itself does not scroll — position:sticky inside a
		// padded scroll container kept leaving a gap above the filter bar no matter how the padding
		// was juggled. Instead the heading + filter bar are plain (non-scrolling) flex items, and only
		// the grid below them lives in its own scrollable child — so the filter bar is simply always
		// on screen, with no sticky-positioning math involved at all.
		container.addClass('auditor-view-container', 'auditor-controls-page');
		this.renderControlsTab(container);
	}

	async onClose(): Promise<void> {}

	/** Reloads the list from disk — called after saves made elsewhere (the control-detail view). */
	async refresh(): Promise<void> {
		await this.reload();
	}

	private showStatus(parent: HTMLElement, msg: string): HTMLElement {
		return parent.createEl('p', { text: msg, cls: 'auditor-status' });
	}

	/**
	 * A compact "Label (n)" button that opens a checkbox panel on click — lets several values be
	 * selected at once (e.g. sessions 1, 2, 3) without eating a full row the way a native
	 * `<select multiple>` listbox would. Closes on an outside click or when another one of these
	 * panels opens.
	 */
	private createMultiSelectFilter(
		container: HTMLElement,
		label: string,
		selected: Set<string>,
		getOptions: () => string[],
		onChange: () => void,
	): { refreshOptions: () => void; refreshLabel: () => void } {
		const wrap = container.createDiv('auditor-multiselect');
		const btn = wrap.createEl('button', { cls: 'auditor-multiselect-btn' });
		const panel = wrap.createDiv('auditor-multiselect-panel auditor-tab-hidden');

		const refreshLabel = () => {
			btn.setText(selected.size === 0 ? label : `${label} (${selected.size})`);
		};
		const refreshOptions = () => {
			panel.empty();
			const options = getOptions();
			if (options.length === 0) {
				panel.createEl('p', { text: 'No values yet.', cls: 'auditor-field-description' });
				return;
			}
			for (const opt of options) {
				const optLabel = panel.createEl('label', { cls: 'auditor-checkbox-label' });
				const checkbox = optLabel.createEl('input', { type: 'checkbox' });
				checkbox.checked = selected.has(opt);
				optLabel.createSpan({ text: opt });
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) selected.add(opt);
					else selected.delete(opt);
					refreshLabel();
					onChange();
				});
			}
		};

		btn.addEventListener('click', (evt) => {
			evt.stopPropagation();
			const willOpen = panel.hasClass('auditor-tab-hidden');
			this.containerEl.querySelectorAll('.auditor-multiselect-panel').forEach((el) => el.addClass('auditor-tab-hidden'));
			panel.toggleClass('auditor-tab-hidden', !willOpen);
		});
		this.registerDomEvent(activeDocument, 'click', (evt) => {
			if (!wrap.contains(evt.target as Node)) panel.addClass('auditor-tab-hidden');
		});

		refreshLabel();
		refreshOptions();
		return { refreshOptions, refreshLabel };
	}

	private renderControlsTab(container: HTMLElement): void {
		const filterBar = container.createDiv('auditor-controls-filter-bar');
		const filtersRow = filterBar.createDiv('auditor-controls-filters-row');

		const searchInput = filtersRow.createEl('input', { type: 'text', cls: 'auditor-controls-search-input' });
		searchInput.placeholder = 'Fuzzy search control text…';

		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Excel" is a literal product name
		const excelLinkBtn = filtersRow.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Configure Excel link' } });
		setIcon(excelLinkBtn, 'link');
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Excel" is a literal product name
		const syncFromExcelBtn = filtersRow.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Sync from Excel' } });
		setIcon(syncFromExcelBtn, 'arrow-down-to-line');
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Excel" is a literal product name
		const syncToExcelBtn = filtersRow.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Sync to Excel' } });
		setIcon(syncToExcelBtn, 'arrow-up-from-line');
		const refreshBtn = filtersRow.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Refresh' } });
		setIcon(refreshBtn, 'refresh-cw');

		let allEntries: { file: TFile; record: ControlRecord }[] = [];
		const filters = emptyFilters();

		// Reassigned once all four filters exist (see below) — referenced here only by closure, so the
		// temporary no-op is never actually called before the real one is in place.
		let refreshAllFilterOptions = () => {};
		const onFilterChange = () => { refreshAllFilterOptions(); applyFilter(); };

		const sessionFilter = this.createMultiSelectFilter(filtersRow, 'Session', filters.sessions, () => optionsExcluding(allEntries, filters, 'sessions'), onFilterChange);
		const standardFilter = this.createMultiSelectFilter(filtersRow, 'Standard', filters.standards, () => optionsExcluding(allEntries, filters, 'standards'), onFilterChange);
		const topicFilter = this.createMultiSelectFilter(filtersRow, 'Topic', filters.topics, () => optionsExcluding(allEntries, filters, 'topics'), onFilterChange);
		const statusFilter = this.createMultiSelectFilter(filtersRow, 'Status', filters.statuses, () => optionsExcluding(allEntries, filters, 'statuses'), onFilterChange);
		refreshAllFilterOptions = () => {
			sessionFilter.refreshOptions();
			standardFilter.refreshOptions();
			topicFilter.refreshOptions();
			statusFilter.refreshOptions();
		};

		const minRatingSelect = filtersRow.createEl('select');
		for (const [value, label] of [['', 'Any rating'], ['C', 'At least C'], ['C*', 'At least C*'], ['NC', 'At least NC']] as const) {
			minRatingSelect.createEl('option', { text: label, value });
		}
		const commentsOnlyLabel = filtersRow.createEl('label', { cls: 'auditor-checkbox-label' });
		const commentsOnlyCheckbox = commentsOnlyLabel.createEl('input', { type: 'checkbox' });
		commentsOnlyLabel.createSpan({ text: 'Has comments' });
		const clearBtn = filtersRow.createEl('button', { text: 'Clear filters' });
		const exportBtn = filtersRow.createEl('button', { text: 'Export…' });
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Rapid Fire" is the feature's own name
		const rapidFireBtn = filtersRow.createEl('button', { text: 'Export to Rapid Fire…' });
		const status = filtersRow.createDiv('auditor-controls-count');

		const scrollArea = container.createDiv('auditor-controls-scroll-area');
		const grid = scrollArea.createDiv('auditor-controls-grid');

		// Below this width the comments column can no longer fit its 220-300px track comfortably —
		// drop it entirely and let the control text (middle column) take the freed space instead,
		// since that's the more important thing to read at a glance. Done via ResizeObserver rather
		// than a CSS container query so it doesn't depend on container-query support.
		const NARROW_BREAKPOINT = 700;
		const resizeObserver = new ResizeObserver((observedEntries) => {
			const width = observedEntries[0]?.contentRect.width ?? grid.clientWidth;
			grid.toggleClass('auditor-controls-grid-narrow', width < NARROW_BREAKPOINT);
		});
		resizeObserver.observe(grid);
		this.register(() => resizeObserver.disconnect());

		const currentlyFiltered = () => {
			const base = allEntries.filter((e) => matchesFilters(e.record, filters));
			const query = filters.searchQuery.trim();
			if (!query) {
				return base.sort((a, b) => a.record.number.localeCompare(b.record.number, undefined, { numeric: true }));
			}
			// Fuzzy-match against control text specifically, sorted by match score (best first) —
			// unlike every other filter here, this one reorders the list instead of just narrowing it.
			const fuzzyMatch = prepareFuzzySearch(query);
			return base
				.map((e) => ({ entry: e, match: fuzzyMatch(e.record.control) }))
				.filter((r): r is { entry: typeof base[number]; match: NonNullable<ReturnType<typeof fuzzyMatch>> } => r.match !== null)
				.sort((a, b) => b.match.score - a.match.score)
				.map((r) => r.entry);
		};

		const applyFilter = () => {
			grid.empty();
			this.queueButtonSyncs = [];
			const filtered = currentlyFiltered();
			status.setText(
				filtered.length === allEntries.length
					? `${allEntries.length} control(s).`
					: `${filtered.length} of ${allEntries.length} control(s).`,
			);
			if (filtered.length === 0) {
				this.showStatus(grid, 'No controls found.');
				return;
			}
			for (const entry of filtered) this.renderControlCard(grid, entry, load);
		};

		const load = async () => {
			// Reloading rebuilds the whole grid, which would otherwise reset scroll to the top on
			// every quick status/comment change — restore it so those in-place edits don't feel like
			// the list jumped around.
			const savedScrollTop = scrollArea.scrollTop;
			status.setText('Loading controls…');
			grid.empty();
			const folder = this.plugin.settings.writtenControlsFolder;
			const files = this.app.vault
				.getFiles()
				.filter(
					(f) =>
						f.extension === 'md' &&
						(!folder || f.path === folder || f.path.startsWith(`${folder}/`)),
				);
			const entries: { file: TFile; record: ControlRecord }[] = [];
			for (const file of files) {
				const content = await this.app.vault.cachedRead(file);
				entries.push({ file, record: parseControlNoteContent(content, file.basename) });
			}
			entries.sort((a, b) => a.record.number.localeCompare(b.record.number, undefined, { numeric: true }));
			allEntries = entries;
			refreshAllFilterOptions();
			applyFilter();
			scrollArea.scrollTop = savedScrollTop;
		};
		this.reload = load;

		minRatingSelect.addEventListener('change', () => { filters.minRating = minRatingSelect.value as ControlFilters['minRating']; refreshAllFilterOptions(); applyFilter(); });
		commentsOnlyCheckbox.addEventListener('change', () => { filters.commentsOnly = commentsOnlyCheckbox.checked; refreshAllFilterOptions(); applyFilter(); });
		clearBtn.addEventListener('click', () => {
			filters.sessions.clear();
			filters.standards.clear();
			filters.topics.clear();
			filters.statuses.clear();
			filters.minRating = '';
			filters.commentsOnly = false;
			sessionFilter.refreshLabel();
			standardFilter.refreshLabel();
			topicFilter.refreshLabel();
			statusFilter.refreshLabel();
			refreshAllFilterOptions();
			minRatingSelect.value = '';
			commentsOnlyCheckbox.checked = false;
			filters.searchQuery = '';
			searchInput.value = '';
			applyFilter();
		});
		searchInput.addEventListener('input', () => {
			filters.searchQuery = searchInput.value;
			applyFilter();
		});

		refreshBtn.addEventListener('click', () => {
			void load();
		});
		excelLinkBtn.addEventListener('click', () => {
			new ExcelLinkModal(this.app, this.plugin, () => {
				void load();
			}).open();
		});
		syncFromExcelBtn.addEventListener('click', () => {
			void (async () => {
				if (!isExcelLinkConfigured(this.plugin.settings.excelLink)) {
					// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Excel" is a literal product name
					new Notice('Auditor: configure the Excel link first.');
					return;
				}
				syncFromExcelBtn.disabled = true;
				try {
					const { toOverwrite, toCreate } = await previewSyncFromExcel(this.plugin);
					const proceed = await confirmExcelOverwrite(this.app, toOverwrite, toCreate);
					if (!proceed) return;
					const result = await syncFromExcel(this.plugin);
					new Notice(`Auditor: synced from Excel — ${result.updated} updated, ${result.created} created${result.failed.length > 0 ? `, ${result.failed.length} failed` : ''}.`);
					await load();
				} catch (e) {
					new Notice(`Auditor: sync from Excel failed — ${String(e)}`);
				} finally {
					syncFromExcelBtn.disabled = false;
				}
			})();
		});
		syncToExcelBtn.addEventListener('click', () => {
			void (async () => {
				if (!isExcelLinkConfigured(this.plugin.settings.excelLink)) {
					// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Excel" is a literal product name
					new Notice('Auditor: configure the Excel link first.');
					return;
				}
				syncToExcelBtn.disabled = true;
				try {
					const result = await syncToExcel(this.plugin);
					new Notice(`Auditor: synced to Excel — ${result.updated} row(s) updated${result.notInSheet > 0 ? `, ${result.notInSheet} control(s) not found in the sheet (skipped)` : ''}.`);
				} catch (e) {
					new Notice(`Auditor: sync to Excel failed — ${String(e)}`);
				} finally {
					syncToExcelBtn.disabled = false;
				}
			})();
		});
		exportBtn.addEventListener('click', () => {
			new ExportControlsModal(this.app, this.plugin, currentlyFiltered()).open();
		});
		rapidFireBtn.addEventListener('click', () => {
			new RapidFireExportModal(this.app, this.plugin, currentlyFiltered(), describeFilters(filters)).open();
		});
		void load();
	}

	/** Writes `updated` to `entry.file` (renaming if the number changed), spot-indexes just that file, then reloads the whole list — used by the quick status change. */
	private async persist(entry: { file: TFile; record: ControlRecord }, updated: ControlRecord, refresh: () => Promise<void>): Promise<void> {
		const folder = this.plugin.settings.writtenControlsFolder;
		const safeNumber = sanitizeFileTitle(updated.number || entry.file.basename);
		const newPath = folder ? `${folder}/${safeNumber}.md` : `${safeNumber}.md`;
		const oldPath = entry.file.path;
		if (newPath !== oldPath) {
			await this.app.fileManager.renameFile(entry.file, newPath);
			void this.plugin.spotRemoveFile('writtenControls', oldPath);
		}
		await this.app.vault.modify(entry.file, buildControlNoteContent(updated));
		void this.plugin.spotIndexFiles('writtenControls', [entry.file]);
		await refresh();
	}

	private renderControlCard(grid: HTMLElement, entry: { file: TFile; record: ControlRecord }, refresh: () => Promise<void>): void {
		const card = grid.createDiv(`auditor-control-card ${cardBackgroundClass(entry.record.todRating, entry.record.toeRating, entry.record.status)}`);

		// ─── Left column: info, chips, quick status, edit button ───────────
		const left = card.createDiv('auditor-control-card-left');
		const numberGroup = left.createDiv('auditor-control-card-number-group');
		if (entry.record.comments.length > 0) {
			const commentIcon = numberGroup.createSpan('auditor-control-card-comment-icon');
			setIcon(commentIcon, 'message-square');
			commentIcon.setAttr(
				'aria-label',
				entry.record.comments.map((c) => (c.date ? `${c.date}: ${c.text}` : c.text)).join('\n'),
			);
		}
		numberGroup.createSpan({ text: entry.record.number || '(no number)', cls: 'auditor-control-card-number' });

		left.createDiv({ cls: 'auditor-control-card-standard', text: entry.record.standard });
		left.createDiv({ cls: 'auditor-control-card-topic', text: entry.record.topic });
		const metaRow = left.createDiv('auditor-control-card-meta');
		metaRow.createSpan({ text: `Session: ${entry.record.session || '—'}` });
		metaRow.createSpan({ text: `Assigned: ${entry.record.assignedMember || '—'}` });
		const todState = readinessState(entry.record.todConclusion, entry.record.todReady);
		const toeState = readinessState(entry.record.toeConclusion, entry.record.toeReady);
		const stageRow = (title: string, rating: string, state: ReturnType<typeof readinessState>) => {
			const row = left.createDiv('auditor-control-card-stage-row');
			row.createSpan({ text: title, cls: 'auditor-control-card-stage-title' });
			row.createSpan({ text: rating || '—', cls: `auditor-rating-badge ${ratingClass(rating)}` });
			row.createSpan({ text: READINESS_LABELS[state], cls: `auditor-rating-badge auditor-readiness-${state}` });
		};
		stageRow('ToD', entry.record.todRating, todState);
		stageRow('ToE', entry.record.toeRating, toeState);

		const statusWrap = left.createDiv('auditor-field');
		statusWrap.createEl('label', { text: 'Status', cls: 'auditor-field-label' });
		const statusSelect = statusWrap.createEl('select', { cls: `auditor-status-select auditor-status-${statusSlug(entry.record.status)}` });
		const statusOptions = CONTROL_STATUSES.includes(entry.record.status) ? CONTROL_STATUSES : [entry.record.status, ...CONTROL_STATUSES];
		for (const opt of statusOptions) {
			const optionEl = statusSelect.createEl('option', { text: opt || '(none)', value: opt });
			if (opt === entry.record.status) optionEl.selected = true;
		}
		statusSelect.addEventListener('change', () => {
			for (const opt of statusOptions) statusSelect.removeClass(`auditor-status-${statusSlug(opt)}`);
			statusSelect.addClass(`auditor-status-${statusSlug(statusSelect.value)}`);
			void this.persist(entry, { ...entry.record, status: statusSelect.value }, refresh);
		});

		const cardActions = left.createDiv('auditor-control-card-actions');
		const editBtn = cardActions.createEl('button', { text: 'Edit control', cls: 'auditor-control-card-edit-btn mod-cta' });
		editBtn.addEventListener('click', () => {
			void this.plugin.openControlDetail(entry.file, entry.record);
		});
		const egBtn = cardActions.createEl('button', { text: 'Evidence goals' });
		egBtn.addEventListener('click', () => {
			new EvidenceGoalsModal(this.app, this.plugin, entry.record).open();
		});
		const queueBtn = (stage: DraftStage): HTMLButtonElement => {
			const btn = cardActions.createEl('button');
			const sync = () => {
				const queued = this.plugin.draftQueue.has(entry.record.number, stage);
				btn.setText(QUEUE_BUTTON_LABEL[stage][queued ? 'queued' : 'add']);
				btn.toggleClass('is-queued', queued);
			};
			btn.addEventListener('click', () => {
				if (this.plugin.draftQueue.has(entry.record.number, stage)) {
					this.plugin.draftQueue.removeByControl(entry.record.number, stage);
				} else {
					this.plugin.draftQueue.add(entry.record.number, entry.record.topic || entry.record.control, stage);
					new Notice(`Added ${entry.record.number || 'control'} (${stage === 'stage1' ? 'Stage 1' : 'Stage 2'}) to the chat's drafting queue.`);
				}
				sync();
			});
			sync();
			this.queueButtonSyncs.push(sync);
			return btn;
		};
		queueBtn('stage1');
		queueBtn('stage2');

		// ─── Middle column: full control text, never clamped ───────────────
		const middle = card.createDiv('auditor-control-card-middle');
		middle.createDiv({ cls: 'auditor-control-card-text', text: entry.record.control || '(no control text)' });

		// ─── Right column: comment history — omitted entirely when there are none. Adding
		// comments happens in the control-detail view (via "Edit control"), not here. ───────
		const hasComments = entry.record.comments.length > 0;
		if (hasComments) {
			const right = card.createDiv('auditor-control-card-right');
			const commentsWrap = right.createDiv('auditor-control-card-comments');
			for (const comment of entry.record.comments) {
				const commentRow = commentsWrap.createDiv('auditor-control-card-comment');
				if (comment.date) commentRow.createSpan({ text: comment.date, cls: 'auditor-control-card-comment-date' });
				commentRow.createSpan({ text: comment.text, cls: 'auditor-control-card-comment-text' });
			}
		} else {
			card.addClass('auditor-control-card-no-comments');
		}
	}
}
