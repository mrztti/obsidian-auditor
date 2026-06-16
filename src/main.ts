/* eslint-disable no-console */
import { FileSystemAdapter, MarkdownView, Notice, Plugin, TFile, normalizePath } from 'obsidian';
import { AuditorSettings, DEFAULT_SETTINGS, AuditorSettingTab } from './settings';
import { ModelLoadProgress, VaultIndexer } from './indexer';
import { SearchView, SEARCH_VIEW_TYPE } from './searchView';
import { SectionView, SECTION_VIEW_TYPE, FRONTMATTER_KEY, FRONTMATTER_VALUE } from './sectionView';
import { buildSkeleton } from './sections';
import { NewFindingModal } from './newFindingModal';

const log = (...args: unknown[]) => console.log('[Auditor]', ...args);

export default class AuditorPlugin extends Plugin {
	settings!: AuditorSettings;
	indexer!: VaultIndexer;
	private modelNotice: Notice | null = null;

	async onload() {
		log('onload: plugin loading');
		await this.loadSettings();
		log('onload: settings loaded', this.settings);

		const indexRootFolder = this.getIndexRootFolder();
		log('onload: index root folder', indexRootFolder);
		this.indexer = new VaultIndexer(
			this.settings.embeddingModel,
			indexRootFolder,
			undefined,
			(progress: ModelLoadProgress) => { this.onModelProgress(progress); },
		);

		this.registerView(SEARCH_VIEW_TYPE, (leaf) => new SearchView(leaf, this));
		this.registerView(SECTION_VIEW_TYPE, (leaf) => new SectionView(leaf, this));

		this.addRibbonIcon('search', 'Open vault search', () => {
			void this.activateSearchView();
		});

		this.addRibbonIcon('list-tree', 'Open as audit finding', () => {
			const file = this.app.workspace.getActiveFile();
			if (file && file.extension === 'md') void this.maybeReplaceWithSectionView(file, true);
		});

		this.registerEvent(this.app.workspace.on('file-open', (file) => {
			if (file) void this.maybeReplaceWithSectionView(file);
		}));

		this.addCommand({
			id: 'open-semantic-search',
			name: 'Open semantic search',
			callback: () => { void this.activateSearchView(); },
		});

		this.addCommand({
			id: 'reindex-folder',
			name: 'Re-index vault folder',
			callback: () => { void this.runIndexing(); },
		});

		this.addCommand({
			id: 'cancel-indexing',
			name: 'Cancel indexing',
			checkCallback: (checking) => {
				if (!this.indexer.isIndexing) return false;
				if (!checking) this.indexer.cancelIndexing();
				return true;
			},
		});

		this.addCommand({
			id: 'open-audit-sections',
			name: 'Open as audit sections',
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || file.extension !== 'md') return false;
				if (!checking) {
					void this.maybeReplaceWithSectionView(file, true);
				}
				return true;
			},
		});

		this.addCommand({
			id: 'new-finding-note',
			name: 'New finding note',
			callback: () => {
				new NewFindingModal(this.app, (name) => { void this.createFindingNote(name); }).open();
			},
		});

		this.addSettingTab(new AuditorSettingTab(this.app, this));
	}

	onunload() {
		log('onunload: plugin unloading');
	}

	/** Absolute path to this plugin's own data folder, used to persist the vector index as plain files. */
	private getIndexRootFolder(): string {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) {
			throw new Error('Auditor requires the desktop app (FileSystemAdapter) to persist its index.');
		}
		const relativePath = `${this.app.vault.configDir}/plugins/${this.manifest.id}/vector-index`;
		return adapter.getFullPath(relativePath);
	}

	/** Surfaces @huggingface/transformers model download progress as a Notice "progress bar". */
	private onModelProgress(progress: ModelLoadProgress): void {
		log('onModelProgress', progress);

		if (progress.status === 'done' || progress.status === 'ready') {
			if (this.modelNotice) {
				this.modelNotice.setMessage('Auditor: model ready!');
				window.setTimeout(() => {
					this.modelNotice?.hide();
					this.modelNotice = null;
				}, 2000);
			}
			return;
		}

		if (!this.modelNotice) {
			this.modelNotice = new Notice('Auditor: preparing model…', 0);
		}

		const file = progress.file ?? 'model';
		if (typeof progress.progress === 'number') {
			const pct = Math.round(progress.progress);
			const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
			this.modelNotice.setMessage(`Auditor: downloading ${file}\n[${bar}] ${pct}%`);
		} else {
			this.modelNotice.setMessage(`Auditor: ${progress.status} ${file}`);
		}
	}

	async runIndexing(): Promise<void> {
		if (this.indexer.isIndexing) {
			new Notice('Auditor: indexing already in progress.');
			return;
		}
		log('runIndexing: starting', { indexFolder: this.settings.indexFolder });
		const notice = new Notice('Auditor: indexing… 0% (click to cancel)', 0);
		// `messageEl` needs Obsidian 1.8.7+; this plugin's minAppVersion is 1.7.2, so we
		// stick with the older (deprecated but still functional) `noticeEl`.
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		notice.noticeEl.addClass('auditor-cancellable-notice');
		// eslint-disable-next-line @typescript-eslint/no-deprecated
		notice.noticeEl.addEventListener('click', () => { this.indexer.cancelIndexing(); });
		try {
			let cancelled = false;
			await this.indexer.indexVaultFolder(
				this.app.vault,
				this.settings.indexFolder,
				(done, total, label) => {
					if (label === 'Cancelled') cancelled = true;
					const pct = total > 0 ? Math.round((done / total) * 100) : 0;
					const suffix = cancelled ? '' : ' (click to cancel)';
					notice.setMessage(`Auditor: ${label} (${done}/${total} — ${pct}%)${suffix}`);
				},
			);
			notice.setMessage(cancelled ? 'Auditor: indexing cancelled.' : 'Auditor: indexing complete!');
			log('runIndexing: complete', { cancelled });
			window.setTimeout(() => notice.hide(), 3000);
		} catch (e) {
			notice.hide();
			console.error('[Auditor] runIndexing failed', e);
			new Notice(`Auditor: indexing failed — ${String(e)}`);
		}
	}

	private async activateSearchView(): Promise<void> {
		const leaves = this.app.workspace.getLeavesOfType(SEARCH_VIEW_TYPE);
		const existing = leaves[0];
		if (existing) {
			void this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: SEARCH_VIEW_TYPE, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Reads the frontmatter flag straight from disk rather than `metadataCache`,
	 * which can lag behind a just-opened or just-created file and cause the
	 * auto-swap below to silently no-op on the first open.
	 */
	private async isFindingNote(file: TFile): Promise<boolean> {
		if (file.extension !== 'md') return false;
		const content = await this.app.vault.cachedRead(file);
		const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
		if (!fmMatch) return false;
		const re = new RegExp(`^${FRONTMATTER_KEY}:\\s*["']?${FRONTMATTER_VALUE}["']?\\s*$`, 'm');
		return re.test(fmMatch[1]!);
	}

	/**
	 * Swaps every markdown leaf currently showing `file` over to our
	 * full-replacement SectionView, when the file is flagged as a finding note.
	 */
	private async maybeReplaceWithSectionView(file: TFile, skipFlagCheck = false): Promise<void> {
		log('maybeReplaceWithSectionView: checking', file.path);
		if (!skipFlagCheck && !(await this.isFindingNote(file))) {
			log('maybeReplaceWithSectionView: not a finding note, skipping', file.path);
			return;
		}
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		log('maybeReplaceWithSectionView: candidate markdown leaves', leaves.length);
		for (const leaf of leaves) {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === file.path) {
				log('maybeReplaceWithSectionView: swapping leaf for', file.path);
				await leaf.setViewState({ type: SECTION_VIEW_TYPE, state: leaf.getViewState().state });
			}
		}
	}

	/** Creates a new note flagged with our frontmatter type and the empty 4-section skeleton. */
	private async createFindingNote(title: string): Promise<void> {
		// Strip path separators and traversal segments so a typo'd title (e.g. containing
		// "../") can never write outside the vault via vault.create().
		const safeTitle = title.replace(/[/\\]/g, '-').replace(/\.\.+/g, '.');
		const path = normalizePath(`${safeTitle}.md`);
		const content = `---\n${FRONTMATTER_KEY}: ${FRONTMATTER_VALUE}\n---\n\n${buildSkeleton()}`;
		const file = await this.app.vault.create(path, content);
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<AuditorSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
