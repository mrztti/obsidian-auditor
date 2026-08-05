import { FileSystemAdapter, Notice, Plugin, TFile, normalizePath } from 'obsidian';
import {
	AuditorSettings,
	DEFAULT_SETTINGS,
	AuditorSettingTab,
} from './settings';
import { AuditVectorStore, type IndexSummary } from './vectorStore';
import { EvidenceGoalIndex } from './evidenceGoalIndex';
import { GeminiEmbeddings } from './geminiEmbeddings';
import { GeminiGenerate } from './geminiGenerate';
import { AuditorView, AUDITOR_VIEW_TYPE } from './auditorView';
import { ControlsView, CONTROLS_VIEW_TYPE } from './controlsView';
import { ControlDetailView, CONTROL_DETAIL_VIEW_TYPE } from './controlDetailView';
import { FileExplorerDecorator } from './fileExplorerDecorator';
import { AddControlModal } from './addControlModal';
import { RateLimiter } from './rateLimiter';
import { buildControlNoteContent, sanitizeFileTitle, type ControlRecord } from './controlNote';
import {
	buildSessionPlanContent,
	emptySessionPlan,
	parseSessionPlanContent,
	sanitizeSessionFileName,
	type InterviewSessionPlan,
} from './evidenceGoal';

const log = (...args: unknown[]) => console.debug('[Auditor]', ...args);

export type StoreKind = 'standards' | 'evidence' | 'writtenControls' | 'interviewEvidence';

export default class AuditorPlugin extends Plugin {
	settings!: AuditorSettings;
	standardsIndex!: AuditVectorStore;
	evidenceIndex!: AuditVectorStore;
	writtenControlsIndex!: AuditVectorStore;
	interviewEvidenceIndex!: AuditVectorStore;
	evidenceGoalIndex!: EvidenceGoalIndex;
	geminiGenerate!: GeminiGenerate;
	fileExplorerDecorator!: FileExplorerDecorator;
	rateLimiter!: RateLimiter;

	async onload() {
		log('onload: plugin loading');
		await this.loadSettings();

		this.rateLimiter = new RateLimiter(
			this.settings.maxRequestsPerSecond,
			this.settings.gradualRampUp,
		);
		const embeddings = new GeminiEmbeddings(
			this.settings.geminiApiKey,
			this.settings.embeddingModel,
			this.rateLimiter,
		);
		this.geminiGenerate = new GeminiGenerate(
			this.settings.geminiApiKey,
			this.settings.generationModel,
		);

		const dataRoot = this.getPluginDataFolder();
		this.standardsIndex = new AuditVectorStore(
			embeddings,
			`${dataRoot}/vector-index/standards`,
			this.settings.chunkWords,
			this.settings.maxConcurrentIndexing,
		);
		this.evidenceIndex = new AuditVectorStore(
			embeddings,
			`${dataRoot}/vector-index/evidence`,
			this.settings.chunkWords,
			this.settings.maxConcurrentIndexing,
		);
		this.writtenControlsIndex = new AuditVectorStore(
			embeddings,
			`${dataRoot}/vector-index/written-controls`,
			this.settings.chunkWords,
			this.settings.maxConcurrentIndexing,
		);
		this.interviewEvidenceIndex = new AuditVectorStore(
			embeddings,
			`${dataRoot}/vector-index/interview-evidence`,
			this.settings.chunkWords,
			this.settings.maxConcurrentIndexing,
		);
		this.evidenceGoalIndex = new EvidenceGoalIndex(
			embeddings,
			`${dataRoot}/vector-index/evidence-goals`,
		);

		this.fileExplorerDecorator = new FileExplorerDecorator(this);
		this.app.workspace.onLayoutReady(() => {
			this.fileExplorerDecorator.scheduleRefresh();
		});
		this.registerEvent(
			this.app.workspace.on('layout-change', () => {
				this.fileExplorerDecorator.scheduleRefresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on('create', () => {
				this.fileExplorerDecorator.scheduleRefresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', () => {
				this.fileExplorerDecorator.scheduleRefresh();
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', () => {
				this.fileExplorerDecorator.scheduleRefresh();
			}),
		);

		this.registerView(
			AUDITOR_VIEW_TYPE,
			(leaf) => new AuditorView(leaf, this),
		);
		this.registerView(
			CONTROLS_VIEW_TYPE,
			(leaf) => new ControlsView(leaf, this),
		);
		this.registerView(
			CONTROL_DETAIL_VIEW_TYPE,
			(leaf) => new ControlDetailView(leaf, this),
		);

		this.addRibbonIcon('bot', 'Open auditor', () => {
			void this.activateAuditorView();
		});

		this.addRibbonIcon('list-checks', 'Open controls', () => {
			void this.activateControlsView();
		});

		this.addRibbonIcon('file-plus', 'Add control', () => {
			new AddControlModal(this.app, (record) => {
				void this.saveControlNote(record);
			}).open();
		});

		this.addCommand({
			id: 'open-auditor',
			name: 'Open main view',
			callback: () => {
				void this.activateAuditorView();
			},
		});

		this.addCommand({
			id: 'open-controls',
			name: 'Open controls',
			callback: () => {
				void this.activateControlsView();
			},
		});

		this.addCommand({
			id: 'add-control',
			name: 'Add control',
			callback: () => {
				new AddControlModal(this.app, (record) => {
					void this.saveControlNote(record);
				}).open();
			},
		});

		this.addCommand({
			id: 'reindex-standards',
			name: 'Re-index standards',
			callback: () => {
				void this.runIndexing('standards');
			},
		});

		this.addCommand({
			id: 'reindex-evidence',
			name: 'Re-index evidence',
			callback: () => {
				void this.runIndexing('evidence');
			},
		});

		this.addCommand({
			id: 'reindex-written-controls',
			name: 'Re-index written controls',
			callback: () => {
				void this.runIndexing('writtenControls');
			},
		});

		this.addCommand({
			id: 'reindex-interview-evidence',
			name: 'Re-index interview evidence',
			callback: () => {
				void this.runIndexing('interviewEvidence');
			},
		});

		this.addCommand({
			id: 'reindex-evidence-goals',
			name: 'Re-index evidence goals',
			callback: () => {
				void this.reindexEvidenceGoals();
			},
		});

		this.addSettingTab(new AuditorSettingTab(this.app, this));
	}

	onunload() {
		log('onunload: plugin unloading');
	}

	/** Absolute path to this plugin's own data folder, used to persist the vector indexes as plain files. */
	private getPluginDataFolder(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error(
				'Auditor requires the desktop app (FileSystemAdapter) to persist its index.',
			);
		}
		const relativePath = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		return adapter.getFullPath(relativePath);
	}

	storeFor(kind: StoreKind): AuditVectorStore {
		if (kind === 'standards') return this.standardsIndex;
		if (kind === 'evidence') return this.evidenceIndex;
		if (kind === 'interviewEvidence') return this.interviewEvidenceIndex;
		return this.writtenControlsIndex;
	}

	/** Applies the current `maxConcurrentIndexing` setting to all stores; called whenever the setting changes. */
	updateIndexingConcurrency(): void {
		for (const kind of ['standards', 'evidence', 'writtenControls', 'interviewEvidence'] as StoreKind[]) {
			this.storeFor(kind).setMaxConcurrentFiles(this.settings.maxConcurrentIndexing);
		}
	}

	private folderFor(kind: StoreKind): string {
		if (kind === 'standards') return this.settings.standardsFolder;
		if (kind === 'evidence') return this.settings.evidenceFolder;
		if (kind === 'interviewEvidence') return this.settings.interviewEvidenceFolder;
		return this.settings.writtenControlsFolder;
	}

	private labelFor(kind: StoreKind): string {
		if (kind === 'standards') return 'Standards';
		if (kind === 'evidence') return 'Evidence';
		if (kind === 'interviewEvidence') return 'Interview evidence';
		return 'Written controls';
	}

	/**
	 * Runs indexing for the given store. `onProgress`, if given, is called in addition to the
	 * usual cancellable Notice — used by AuditorView to render live progress inline in the view.
	 */
	async runIndexing(
		kind: StoreKind,
		onProgress?: (done: number, total: number, label: string) => void,
		onActiveFilesChange?: (activePaths: string[]) => void,
	): Promise<IndexSummary | null> {
		const store = this.storeFor(kind);
		const label = this.labelFor(kind);
		if (store.isIndexing) {
			new Notice(`Auditor: ${label} indexing already in progress.`);
			return null;
		}
		log('runIndexing: starting', { kind, folder: this.folderFor(kind) });
		this.rateLimiter.reset();
		const notice = new Notice(
			`Auditor: indexing ${label}… 0% (click to cancel)`,
			0,
		);
		// `messageEl` needs Obsidian 1.8.7+; this plugin's minAppVersion is 1.7.2, so we
		// stick with the older (deprecated but still functional) `noticeEl`.
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		notice.noticeEl.addClass('auditor-cancellable-notice');
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		notice.noticeEl.addEventListener('click', () => {
			store.cancelIndexing();
		});
		try {
			const summary = await store.indexFolder(
				this.app.vault,
				this.folderFor(kind),
				(done, total, indexLabel) => {
					const pct =
						total > 0 ? Math.round((done / total) * 100) : 0;
					const suffix =
						indexLabel === 'Cancelled' ? '' : ' (click to cancel)';
					notice.setMessage(
						`Auditor: ${label} — (${done}/${total} — ${pct}%)${suffix}`,
					);
					onProgress?.(done, total, indexLabel);
				},
				(activePaths) => { onActiveFilesChange?.(activePaths); },
			);
			notice.setMessage(
				summary.cancelled
					? `Auditor: ${label} indexing cancelled.`
					: `Auditor: ${label} indexing complete!`,
			);
			window.setTimeout(() => notice.hide(), 3000);
			this.fileExplorerDecorator.scheduleRefresh();
			return summary;
		} catch (e) {
			notice.hide();
			console.error('[Auditor] runIndexing failed', e);
			new Notice(`Auditor: ${label} indexing failed — ${String(e)}`);
			return null;
		}
	}

	async activateAuditorView(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(AUDITOR_VIEW_TYPE);
		const existing = leaves[0];
		if (existing) {
			void this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: AUDITOR_VIEW_TYPE, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	async activateControlsView(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(CONTROLS_VIEW_TYPE);
		const existing = leaves[0];
		if (existing) {
			void this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({ type: CONTROLS_VIEW_TYPE, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	/** Opens (or reuses) the control-detail view in the right sidebar and points it at the given control. */
	async openControlDetail(file: TFile, record: ControlRecord): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(CONTROL_DETAIL_VIEW_TYPE);
		let leaf = leaves[0];
		if (!leaf) {
			const rightLeaf = this.app.workspace.getRightLeaf(false);
			if (!rightLeaf) return;
			leaf = rightLeaf;
			await leaf.setViewState({ type: CONTROL_DETAIL_VIEW_TYPE, active: true });
		}
		void this.app.workspace.revealLeaf(leaf);
		if (leaf.view instanceof ControlDetailView) await leaf.view.setControl(file, record);
	}

	/** Reloads every open Controls view (there's normally at most one) — called after a save from the control-detail view, since that save doesn't go through the Controls view's own UI. */
	refreshControlsViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(CONTROLS_VIEW_TYPE)) {
			if (leaf.view instanceof ControlsView) void leaf.view.refresh();
		}
	}

	/**
	 * Creates a new note in the written-controls folder, in the canonical control-record format,
	 * then re-indexes that folder so the new control is immediately searchable. The note's filename
	 * is the audit template number (`record.number`).
	 */
	async saveControlNote(record: ControlRecord): Promise<void> {
		const folder = this.settings.writtenControlsFolder;
		const safeNumber = sanitizeFileTitle(record.number || 'Untitled control');
		const path = normalizePath(
			folder ? `${folder}/${safeNumber}.md` : `${safeNumber}.md`,
		);
		const content = buildControlNoteContent(record);
		const file = await this.app.vault.create(path, content);
		await this.app.workspace.getLeaf(false).openFile(file);
		void this.runIndexing('writtenControls');
	}

	/**
	 * The path a control record's note would be written to, based on its number — same naming
	 * scheme `saveControlNote`/`importControlRecords` use. Exposed so the import flow can compute
	 * collisions with existing notes before writing anything.
	 */
	controlNotePath(record: ControlRecord): string {
		const folder = this.settings.writtenControlsFolder;
		const safeNumber = sanitizeFileTitle(record.number || 'Untitled control');
		return normalizePath(folder ? `${folder}/${safeNumber}.md` : `${safeNumber}.md`);
	}

	/**
	 * Writes many control records in one go (used by the Excel import feature): unlike
	 * `saveControlNote`, this does not open each note and only re-indexes the written-controls
	 * folder once at the end. When `overwrite` is false, filenames that collide with an existing
	 * note get a numeric suffix instead of being touched; when true, the existing note's content is
	 * replaced. Callers should confirm with the user (via `controlNotePath`) before passing `overwrite`.
	 */
	async importControlRecords(records: ControlRecord[], overwrite = false): Promise<{ written: number; failed: { record: ControlRecord; error: string }[] }> {
		const folder = this.settings.writtenControlsFolder;
		const failed: { record: ControlRecord; error: string }[] = [];
		let written = 0;
		for (const record of records) {
			try {
				const content = buildControlNoteContent(record);
				const directPath = this.controlNotePath(record);
				const existing = this.app.vault.getAbstractFileByPath(directPath);
				if (existing instanceof TFile) {
					if (!overwrite) {
						const base = sanitizeFileTitle(record.number || 'Untitled control');
						let safeNumber = base;
						let suffix = 1;
						let path = directPath;
						while (this.app.vault.getAbstractFileByPath(path)) {
							safeNumber = `${base}-${++suffix}`;
							path = normalizePath(folder ? `${folder}/${safeNumber}.md` : `${safeNumber}.md`);
						}
						await this.app.vault.create(path, content);
					} else {
						await this.app.vault.modify(existing, content);
					}
				} else {
					await this.app.vault.create(directPath, content);
				}
				written++;
			} catch (e) {
				failed.push({ record, error: String(e) });
			}
		}
		if (written > 0) void this.runIndexing('writtenControls');
		return { written, failed };
	}

	/** The path a session's interview session plan note lives at — one note per session, named after it. */
	sessionPlanPath(session: string): string {
		const folder = this.settings.interviewSessionPlansFolder;
		const safeName = sanitizeSessionFileName(session);
		return normalizePath(folder ? `${folder}/${safeName}.md` : `${safeName}.md`);
	}

	/** Loads the session plan (its Evidence Goals) for a given session, or an empty one if no plan note exists yet. */
	async loadSessionPlan(session: string): Promise<InterviewSessionPlan> {
		const path = this.sessionPlanPath(session);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return emptySessionPlan(session);
		const content = await this.app.vault.read(file);
		return parseSessionPlanContent(content, session);
	}

	/** Writes a session plan back to its note, creating the note (and its folder) if it doesn't exist yet. */
	async saveSessionPlan(plan: InterviewSessionPlan): Promise<void> {
		const path = this.sessionPlanPath(plan.session);
		const content = buildSessionPlanContent(plan);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
			return;
		}
		const folder = this.settings.interviewSessionPlansFolder;
		if (folder && !this.app.vault.getAbstractFileByPath(normalizePath(folder))) {
			await this.app.vault.createFolder(normalizePath(folder));
		}
		await this.app.vault.create(path, content);
	}

	/** Full re-sync of the evidence-goal index against every session plan note currently in the vault. */
	async reindexEvidenceGoals(): Promise<void> {
		const notice = new Notice('Auditor: indexing evidence goals…', 0);
		try {
			await this.evidenceGoalIndex.rebuildAll(this.app.vault, this.settings.interviewSessionPlansFolder);
			notice.setMessage('Auditor: evidence goals indexed.');
			window.setTimeout(() => notice.hide(), 3000);
		} catch (e) {
			notice.hide();
			console.error('[Auditor] reindexEvidenceGoals failed', e);
			new Notice(`Auditor: evidence-goal indexing failed — ${String(e)}`);
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<AuditorSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
