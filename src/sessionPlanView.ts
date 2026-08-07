import { ItemView, TFile, WorkspaceLeaf, setIcon } from 'obsidian';
import type AuditorPlugin from './main';
import {
	generateEvidenceGoalGroupId,
	type EvidenceGoal,
	type EvidenceGoalType,
	type InterviewSessionPlan,
} from './evidenceGoal';
import type { EvidenceResult } from './evidenceResult';
import { ExportEvidenceModal } from './exportEvidenceModal';

export const SESSION_PLAN_VIEW_TYPE = 'auditor-session-plan-view';

const UNGROUPED_SECTION_ID = '';

/**
 * Overview of one interview session's Evidence Goals, organized into domain/topic groups (e.g.
 * "Access Control", "Change Management") — the LLM proposes these via "Regenerate groups", but titles
 * and membership are freely editable here, including dragging a card between groups. Within a group,
 * dragging up/down changes the order the interview will walk through them in. Opened via
 * `plugin.openSessionPlan(session)`. Every field is directly editable here (this is the one place an
 * EG's full set of linked controls can be reviewed/trimmed at a glance, not just added to from a
 * single control like `EvidenceGoalsModal` does); changes are staged in memory and written out
 * together via the Save button, same as `ControlDetailView`.
 */
export class SessionPlanView extends ItemView {
	private plugin: AuditorPlugin;
	private session: string | null = null;
	private plan: InterviewSessionPlan | null = null;
	private dirty = false;
	private statusEl!: HTMLElement;
	private saveBtn!: HTMLButtonElement;
	private draggedId: string | null = null;
	/** EG IDs currently expanded for editing — everything else shows as a collapsed title+description summary. */
	private expandedIds = new Set<string>();
	/** "Start session" mode: one EG full-screen at a time, read-only definition, editable notes + pasted screenshots (an Evidence Result, saved completely separately from the EG itself). */
	private sessionModeActive = false;
	private sessionModeIndex = 0;
	private currentResult: EvidenceResult | null = null;
	private notesSaveTimeout: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: AuditorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SESSION_PLAN_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.session ? `Session plan: ${this.session}` : 'Session plan';
	}

	getIcon(): string {
		return 'layout-list';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	async onClose(): Promise<void> {}

	async setSession(session: string): Promise<void> {
		this.session = session;
		this.dirty = false;
		this.expandedIds.clear();
		this.plan = await this.plugin.loadSessionPlan(session);
		this.render();
	}

	private markDirty(): void {
		this.dirty = true;
		this.saveBtn.disabled = false;
		this.statusEl.setText('Unsaved changes.');
	}

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-view-container');
		container.toggleClass('auditor-session-mode-active', this.sessionModeActive);

		if (!this.session || !this.plan) {
			container.createEl('p', { text: 'No session selected.', cls: 'auditor-status' });
			return;
		}
		const plan = this.plan;

		if (this.sessionModeActive) {
			this.renderSessionMode(container);
			return;
		}

		const header = container.createDiv();
		header.createEl('h3', { text: `Session plan: ${this.session}` });
		const controlCount = new Set(plan.evidenceGoals.flatMap((eg) => eg.controlNumbers)).size;
		header.createEl('p', {
			text: `${plan.evidenceGoals.length} evidence goal(s) covering ${controlCount} control(s). Drag a card to reorder or to move it into a different group.`,
			cls: 'auditor-field-description',
		});

		const toolbar = header.createDiv('auditor-controls-toolbar');
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- leading "+" defeats the rule's sentence-start detection; text is already sentence case
		const addGroupBtn = toolbar.createEl('button', { text: '+ New group' });
		addGroupBtn.addEventListener('click', () => {
			plan.groups.push({ id: generateEvidenceGoalGroupId(), title: 'New group' });
			this.markDirty();
			this.render();
		});
		const regroupBtn = toolbar.createEl('button', { text: 'Regenerate groups (AI)' });
		regroupBtn.addEventListener('click', () => {
			void this.regenerateGroups(regroupBtn);
		});
		const startSessionBtn = toolbar.createEl('button', { text: 'Start session', cls: 'mod-cta' });
		startSessionBtn.disabled = plan.evidenceGoals.length === 0;
		startSessionBtn.addEventListener('click', () => {
			void this.startSession();
		});
		const exportBtn = toolbar.createEl('button', { text: 'Export evidence…' });
		exportBtn.disabled = plan.evidenceGoals.length === 0;
		exportBtn.addEventListener('click', () => {
			new ExportEvidenceModal(this.app, this.plugin, plan).open();
		});

		const list = container.createDiv('auditor-eg-list');
		if (plan.evidenceGoals.length === 0) {
			list.createEl('p', { text: 'No evidence goals in this session yet.', cls: 'auditor-status' });
		}

		for (const group of plan.groups) {
			this.renderSection(list, group.id, group.title, plan.evidenceGoals.filter((eg) => eg.groupId === group.id));
		}
		const groupIds = new Set(plan.groups.map((g) => g.id));
		const ungrouped = plan.evidenceGoals.filter((eg) => !eg.groupId || !groupIds.has(eg.groupId));
		if (ungrouped.length > 0 || plan.groups.length === 0) {
			this.renderSection(list, UNGROUPED_SECTION_ID, 'Ungrouped', ungrouped);
		}

		const footer = container.createDiv('auditor-edit-modal-footer');
		this.saveBtn = footer.createEl('button', { text: 'Save', cls: 'mod-cta' });
		this.saveBtn.disabled = !this.dirty;
		const refreshBtn = footer.createEl('button', { text: 'Refresh' });
		this.statusEl = footer.createDiv('auditor-autosave-status');
		this.statusEl.setText(this.dirty ? 'Unsaved changes.' : 'No changes.');

		this.saveBtn.addEventListener('click', () => {
			void this.save();
		});
		refreshBtn.addEventListener('click', () => {
			void this.setSession(this.session!);
		});
	}

	private renderSection(list: HTMLElement, groupId: string, title: string, members: EvidenceGoal[]): void {
		const section = list.createDiv('auditor-eg-section');
		const sectionHeader = section.createDiv('auditor-eg-section-header');

		if (groupId === UNGROUPED_SECTION_ID) {
			sectionHeader.createEl('strong', { text: title });
		} else {
			const titleInput = sectionHeader.createEl('input', { type: 'text', cls: 'auditor-eg-section-title-input' });
			titleInput.value = title;
			titleInput.addEventListener('input', () => {
				const group = this.plan?.groups.find((g) => g.id === groupId);
				if (group) { group.title = titleInput.value; this.markDirty(); }
			});
			const deleteGroupBtn = sectionHeader.createEl('button', { text: 'Ungroup', cls: 'auditor-eg-section-delete-btn' });
			deleteGroupBtn.addEventListener('click', () => {
				if (!this.plan) return;
				this.plan.groups = this.plan.groups.filter((g) => g.id !== groupId);
				for (const eg of this.plan.evidenceGoals) if (eg.groupId === groupId) eg.groupId = '';
				this.markDirty();
				this.render();
			});
		}

		const body = section.createDiv('auditor-eg-section-body');
		if (members.length === 0) {
			const dropZone = body.createDiv('auditor-eg-section-empty');
			dropZone.setText('Drop an evidence goal here.');
			dropZone.addEventListener('dragover', (evt) => {
				if (!this.draggedId) return;
				evt.preventDefault();
				dropZone.addClass('auditor-eg-drop-target');
			});
			dropZone.addEventListener('dragleave', () => dropZone.removeClass('auditor-eg-drop-target'));
			dropZone.addEventListener('drop', (evt) => {
				evt.preventDefault();
				dropZone.removeClass('auditor-eg-drop-target');
				if (!this.plan || !this.draggedId) return;
				const dragged = this.plan.evidenceGoals.find((eg) => eg.id === this.draggedId);
				if (!dragged) return;
				dragged.groupId = groupId;
				this.markDirty();
				this.render();
			});
			return;
		}
		members.forEach((eg, index) => this.renderEvidenceGoalRow(body, eg, index, groupId));
	}

	private renderEvidenceGoalRow(list: HTMLElement, eg: EvidenceGoal, index: number, sectionGroupId: string): void {
		const row = list.createDiv('auditor-eg-card auditor-eg-draggable');
		row.setAttr('draggable', 'true');

		row.addEventListener('dragstart', (evt) => {
			this.draggedId = eg.id;
			row.addClass('auditor-eg-dragging');
			evt.dataTransfer?.setData('text/plain', eg.id);
		});
		row.addEventListener('dragend', () => {
			this.draggedId = null;
			row.removeClass('auditor-eg-dragging');
			this.containerEl.querySelectorAll('.auditor-eg-drop-before, .auditor-eg-drop-after, .auditor-eg-drop-target').forEach((el) => {
				el.removeClass('auditor-eg-drop-before');
				el.removeClass('auditor-eg-drop-after');
				el.removeClass('auditor-eg-drop-target');
			});
		});
		row.addEventListener('dragover', (evt) => {
			if (!this.draggedId || this.draggedId === eg.id) return;
			evt.preventDefault();
			const before = evt.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
			row.toggleClass('auditor-eg-drop-before', before);
			row.toggleClass('auditor-eg-drop-after', !before);
		});
		row.addEventListener('dragleave', () => {
			row.removeClass('auditor-eg-drop-before');
			row.removeClass('auditor-eg-drop-after');
		});
		row.addEventListener('drop', (evt) => {
			evt.preventDefault();
			row.removeClass('auditor-eg-drop-before');
			row.removeClass('auditor-eg-drop-after');
			if (!this.plan || !this.draggedId || this.draggedId === eg.id) return;
			const fromIndex = this.plan.evidenceGoals.findIndex((g) => g.id === this.draggedId);
			if (fromIndex === -1) return;
			const [moved] = this.plan.evidenceGoals.splice(fromIndex, 1);
			moved!.groupId = sectionGroupId;
			const before = evt.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
			const toIndex = this.plan.evidenceGoals.findIndex((g) => g.id === eg.id);
			this.plan.evidenceGoals.splice(before ? toIndex : toIndex + 1, 0, moved!);
			this.markDirty();
			this.render();
		});

		const expanded = this.expandedIds.has(eg.id);

		const summary = row.createDiv('auditor-eg-summary');
		const handle = summary.createDiv('auditor-eg-drag-handle');
		setIcon(handle, 'grip-vertical');
		handle.createSpan({ text: `#${index + 1}`, cls: 'auditor-eg-order' });

		const summaryText = summary.createDiv('auditor-eg-summary-text');
		summaryText.createEl('strong', { text: eg.name || '(untitled)' });
		if (!expanded) {
			summaryText.createDiv({ text: eg.description || '(no description)', cls: 'auditor-eg-summary-description' });
		}

		const toggleBtn = summary.createEl('button', { text: expanded ? 'Collapse' : 'Edit', cls: 'auditor-eg-toggle-btn' });
		toggleBtn.addEventListener('click', () => {
			if (expanded) this.expandedIds.delete(eg.id);
			else this.expandedIds.add(eg.id);
			this.render();
		});

		if (!expanded) return;

		const grid = row.createDiv('auditor-compact-grid');
		const nameWrap = grid.createDiv('auditor-field auditor-field-full');
		nameWrap.createEl('label', { text: 'Name', cls: 'auditor-field-label' });
		const nameInput = nameWrap.createEl('input', { type: 'text' });
		nameInput.value = eg.name;
		nameInput.addEventListener('input', () => { eg.name = nameInput.value; this.markDirty(); });

		const typeWrap = grid.createDiv('auditor-field auditor-field-compact');
		typeWrap.createEl('label', { text: 'Type', cls: 'auditor-field-label' });
		const typeSelect = typeWrap.createEl('select');
		for (const opt of ['screenshot', 'file'] as EvidenceGoalType[]) {
			const optionEl = typeSelect.createEl('option', { text: opt === 'file' ? 'File' : 'Screenshot', value: opt });
			if (opt === eg.type) optionEl.selected = true;
		}
		typeSelect.addEventListener('change', () => { eg.type = typeSelect.value as EvidenceGoalType; this.markDirty(); });

		const controlsWrap = row.createDiv('auditor-field');
		controlsWrap.createEl('label', { text: 'Controls', cls: 'auditor-field-label' });
		const controlsRow = controlsWrap.createDiv('auditor-eg-controls-row');
		for (const controlNumber of eg.controlNumbers) {
			const chip = controlsRow.createDiv('auditor-chip auditor-eg-control-chip');
			chip.createSpan({ text: controlNumber });
			const removeBtn = chip.createSpan({ text: '×', cls: 'auditor-eg-control-chip-remove' });
			removeBtn.addEventListener('click', () => {
				eg.controlNumbers = eg.controlNumbers.filter((c) => c !== controlNumber);
				this.markDirty();
				this.render();
			});
		}
		if (eg.controlNumbers.length === 0) {
			controlsRow.createSpan({ text: '(no controls linked — will be dropped on save)', cls: 'auditor-field-description' });
		}

		const descWrap = row.createDiv('auditor-field');
		descWrap.createEl('label', { text: 'Description', cls: 'auditor-field-label' });
		const descArea = descWrap.createEl('textarea', { cls: 'auditor-pipeline-textarea' });
		descArea.rows = 3;
		descArea.value = eg.description;
		descArea.addEventListener('input', () => { eg.description = descArea.value; this.markDirty(); });

		const questionsWrap = row.createDiv('auditor-field');
		questionsWrap.createEl('label', { text: 'Related questions (one per line)', cls: 'auditor-field-label' });
		const questionsArea = questionsWrap.createEl('textarea', { cls: 'auditor-pipeline-textarea' });
		questionsArea.rows = 3;
		questionsArea.value = eg.questions.join('\n');
		questionsArea.addEventListener('input', () => {
			eg.questions = questionsArea.value.split(/\r?\n/).map((q) => q.trim()).filter(Boolean);
			this.markDirty();
		});

		const removeBtn = row.createEl('button', { text: 'Delete evidence goal', cls: 'auditor-eg-delete-btn' });
		removeBtn.addEventListener('click', () => {
			if (!this.plan) return;
			this.plan.evidenceGoals = this.plan.evidenceGoals.filter((e) => e.id !== eg.id);
			this.markDirty();
			this.render();
		});
	}

	// ─── Session mode ────────────────────────────────────────────────────────

	/** Flattened display order: groups in order, then their members in order, then any ungrouped EGs — same order `render()` shows them in. */
	private orderedEvidenceGoals(): EvidenceGoal[] {
		if (!this.plan) return [];
		const ordered: EvidenceGoal[] = [];
		for (const group of this.plan.groups) {
			for (const eg of this.plan.evidenceGoals) if (eg.groupId === group.id) ordered.push(eg);
		}
		const groupIds = new Set(this.plan.groups.map((g) => g.id));
		for (const eg of this.plan.evidenceGoals) if (!eg.groupId || !groupIds.has(eg.groupId)) ordered.push(eg);
		return ordered;
	}

	private async startSession(): Promise<void> {
		this.sessionModeActive = true;
		this.sessionModeIndex = 0;
		await this.loadResultForCurrentEg();
		this.render();
	}

	private async loadResultForCurrentEg(): Promise<void> {
		const eg = this.orderedEvidenceGoals()[this.sessionModeIndex];
		this.currentResult = eg ? await this.plugin.loadEvidenceResult(eg.id) : null;
	}

	/** Flushes any pending debounced notes save immediately — called before navigating away from an EG or exiting, so nothing typed is lost. */
	private async flushNotesSave(): Promise<void> {
		if (this.notesSaveTimeout !== null) {
			window.clearTimeout(this.notesSaveTimeout);
			this.notesSaveTimeout = null;
		}
		if (this.currentResult) await this.plugin.saveEvidenceResult(this.currentResult);
	}

	private async goToIndex(index: number): Promise<void> {
		const egs = this.orderedEvidenceGoals();
		if (index < 0 || index >= egs.length) return;
		await this.flushNotesSave();
		this.sessionModeIndex = index;
		await this.loadResultForCurrentEg();
		this.render();
	}

	private async exitSession(): Promise<void> {
		await this.flushNotesSave();
		this.sessionModeActive = false;
		this.currentResult = null;
		this.render();
	}

	private renderSessionMode(container: HTMLElement): void {
		const egs = this.orderedEvidenceGoals();
		const eg = egs[this.sessionModeIndex];
		const result = this.currentResult;

		const topBar = container.createDiv('auditor-session-mode-topbar');
		const exitBtn = topBar.createEl('button', { text: 'Exit session' });
		exitBtn.addEventListener('click', () => { void this.exitSession(); });
		topBar.createSpan({ text: `${this.sessionModeIndex + 1} / ${egs.length}`, cls: 'auditor-session-mode-progress' });
		// eslint-disable-next-line obsidianmd/ui/sentence-case -- leading arrow glyph defeats the rule's sentence-start detection; text is already sentence case
		const prevBtn = topBar.createEl('button', { text: '← Previous' });
		prevBtn.disabled = this.sessionModeIndex === 0;
		prevBtn.addEventListener('click', () => { void this.goToIndex(this.sessionModeIndex - 1); });
		const nextBtn = topBar.createEl('button', { text: 'Next →', cls: 'mod-cta' });
		nextBtn.disabled = this.sessionModeIndex >= egs.length - 1;
		nextBtn.addEventListener('click', () => { void this.goToIndex(this.sessionModeIndex + 1); });

		const contentRow = container.createDiv('auditor-session-mode-content-row');
		const mainCol = contentRow.createDiv('auditor-session-mode-main');
		this.renderSessionModeNav(contentRow, egs);

		if (!eg || !result) {
			mainCol.createEl('p', { text: 'No evidence goal to show.', cls: 'auditor-status' });
			return;
		}

		const body = mainCol.createDiv('auditor-session-mode-body');
		body.createEl('h1', { text: eg.name || '(untitled)' });
		const metaRow = body.createDiv('auditor-session-mode-meta');
		metaRow.createSpan({ text: eg.type === 'file' ? 'File' : 'Screenshot', cls: 'auditor-session-mode-chip' });
		for (const controlNumber of eg.controlNumbers) metaRow.createSpan({ text: controlNumber, cls: 'auditor-session-mode-chip' });

		body.createEl('p', { text: eg.description || '(no description)', cls: 'auditor-session-mode-description' });

		if (eg.questions.length > 0) {
			body.createEl('h4', { text: 'Questions to ask' });
			const list = body.createEl('ul');
			for (const q of eg.questions) list.createEl('li', { text: q });
		}

		const notesWrap = body.createDiv('auditor-field');
		notesWrap.createEl('label', { text: 'Notes', cls: 'auditor-field-label' });
		const notesArea = notesWrap.createEl('textarea', { cls: 'auditor-pipeline-textarea auditor-session-mode-notes' });
		notesArea.rows = 6;
		notesArea.value = result.notes;
		notesArea.placeholder = 'Notes captured during the interview for this evidence goal…';
		notesArea.addEventListener('input', () => {
			result.notes = notesArea.value;
			if (this.notesSaveTimeout !== null) window.clearTimeout(this.notesSaveTimeout);
			this.notesSaveTimeout = window.setTimeout(() => {
				this.notesSaveTimeout = null;
				void this.plugin.saveEvidenceResult(result);
			}, 800);
		});

		const screenshotsWrap = body.createDiv('auditor-field');
		screenshotsWrap.createEl('label', { text: 'Screenshots', cls: 'auditor-field-label' });
		const thumbsEl = screenshotsWrap.createDiv('auditor-session-mode-thumbs');
		const pasteZone = screenshotsWrap.createDiv('auditor-session-mode-paste-zone');
		pasteZone.setAttr('tabindex', '0');
		pasteZone.setText('Click here, then paste a screenshot (Cmd/Ctrl+V).');

		const renderThumbs = () => {
			thumbsEl.empty();
			for (const path of result.screenshotPaths) {
				const file = this.app.vault.getAbstractFileByPath(path);
				const thumb = thumbsEl.createDiv('auditor-session-mode-thumb');
				if (file instanceof TFile) {
					const img = thumb.createEl('img');
					img.src = this.app.vault.getResourcePath(file);
				} else {
					thumb.createSpan({ text: `(missing: ${path})` });
				}
				const removeBtn = thumb.createEl('button', { text: '×', cls: 'auditor-session-mode-thumb-remove' });
				removeBtn.addEventListener('click', () => {
					void (async () => {
						result.screenshotPaths = result.screenshotPaths.filter((p) => p !== path);
						if (file instanceof TFile) await this.app.fileManager.trashFile(file);
						await this.plugin.saveEvidenceResult(result);
						renderThumbs();
					})();
				});
			}
		};
		renderThumbs();

		pasteZone.addEventListener('paste', (evt: ClipboardEvent) => {
			void (async () => {
				const items = evt.clipboardData?.items;
				if (!items) return;
				for (const item of Array.from(items)) {
					if (!item.type.startsWith('image/')) continue;
					evt.preventDefault();
					const blob = item.getAsFile();
					if (!blob) continue;
					const arrayBuffer = await blob.arrayBuffer();
					const extension = item.type.split('/')[1] || 'png';
					const file = await this.plugin.saveEvidenceScreenshot(eg.id, arrayBuffer, extension);
					result.screenshotPaths.push(file.path);
					await this.plugin.saveEvidenceResult(result);
					renderThumbs();
				}
			})();
		});
	}

	/** Right-side navigation panel for session mode: every group with its EGs' titles, current one highlighted, click to jump straight to it. */
	private renderSessionModeNav(contentRow: HTMLElement, egs: EvidenceGoal[]): void {
		if (!this.plan) return;
		const nav = contentRow.createDiv('auditor-session-mode-nav');
		const currentId = egs[this.sessionModeIndex]?.id;

		const renderEntry = (eg: EvidenceGoal) => {
			const index = egs.findIndex((e) => e.id === eg.id);
			const entry = nav.createDiv(`auditor-session-mode-nav-entry${eg.id === currentId ? ' auditor-session-mode-nav-entry-active' : ''}`);
			entry.setText(eg.name || '(untitled)');
			entry.addEventListener('click', () => { void this.goToIndex(index); });
		};

		for (const group of this.plan.groups) {
			const members = this.plan.evidenceGoals.filter((eg) => eg.groupId === group.id);
			if (members.length === 0) continue;
			nav.createDiv('auditor-session-mode-nav-group-title').setText(group.title);
			for (const eg of members) renderEntry(eg);
		}
		const groupIds = new Set(this.plan.groups.map((g) => g.id));
		const ungrouped = this.plan.evidenceGoals.filter((eg) => !eg.groupId || !groupIds.has(eg.groupId));
		if (ungrouped.length > 0) {
			nav.createDiv('auditor-session-mode-nav-group-title').setText('Ungrouped');
			for (const eg of ungrouped) renderEntry(eg);
		}
	}

	/** Re-runs the LLM domain-grouping over the current EG set and replaces the existing groups/assignments. */
	private async regenerateGroups(triggerBtn: HTMLButtonElement): Promise<void> {
		if (!this.plan) return;
		triggerBtn.disabled = true;
		this.statusEl?.setText('Grouping…');
		try {
			const grouping = await this.plugin.geminiGenerate.groupEvidenceGoalsByDomain(
				this.plan.evidenceGoals.map((eg) => ({ id: eg.id, name: eg.name, description: eg.description, controlNumbers: eg.controlNumbers })),
			);
			const groups: { id: string; title: string }[] = [];
			const assignedGroupId = new Map<string, string>();
			for (const group of grouping.groups) {
				if (group.evidenceGoalIds.length === 0) continue;
				const groupId = generateEvidenceGoalGroupId();
				groups.push({ id: groupId, title: group.title });
				for (const egId of group.evidenceGoalIds) assignedGroupId.set(egId, groupId);
			}
			for (const eg of this.plan.evidenceGoals) eg.groupId = assignedGroupId.get(eg.id) ?? '';
			this.plan.groups = groups;
			this.markDirty();
			this.render();
		} catch (e) {
			triggerBtn.disabled = false;
			this.statusEl?.setText(`Grouping failed: ${String(e)}`);
		}
	}

	private async save(): Promise<void> {
		if (!this.plan) return;
		this.saveBtn.disabled = true;
		this.statusEl.setText('Saving…');
		try {
			// An EG that's been unlinked from every control is meaningless — drop it rather than
			// persisting an orphaned evidence goal.
			this.plan.evidenceGoals = this.plan.evidenceGoals.filter((eg) => eg.controlNumbers.length > 0);
			await this.plugin.saveSessionPlan(this.plan);
			for (const eg of this.plan.evidenceGoals) void this.plugin.evidenceGoalIndex.upsert(eg);
			this.dirty = false;
			this.statusEl.setText('Saved.');
			this.render();
		} catch (e) {
			this.saveBtn.disabled = false;
			this.statusEl.setText(`Save failed: ${String(e)}`);
		}
	}
}
