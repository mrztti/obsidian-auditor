/* eslint-disable no-console */
import { Notice, Plugin } from 'obsidian';
import { AuditorSettings, DEFAULT_SETTINGS, AuditorSettingTab } from './settings';
import { ModelLoadProgress, VaultIndexer } from './indexer';
import { SearchView, SEARCH_VIEW_TYPE } from './searchView';

const log = (...args: unknown[]) => console.log('[Auditor]', ...args);

export default class AuditorPlugin extends Plugin {
	settings!: AuditorSettings;
	indexer!: VaultIndexer;
	private modelNotice: Notice | null = null;

	async onload() {
		log('onload: plugin loading');
		await this.loadSettings();
		log('onload: settings loaded', this.settings);

		this.indexer = new VaultIndexer(
			this.settings.embeddingModel,
			undefined,
			(progress) => { this.onModelProgress(progress); },
		);

		this.registerView(SEARCH_VIEW_TYPE, (leaf) => new SearchView(leaf, this));

		this.addRibbonIcon('search', 'Open vault search', () => {
			void this.activateSearchView();
		});

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

		this.addSettingTab(new AuditorSettingTab(this.app, this));
	}

	onunload() {
		log('onunload: plugin unloading');
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
		log('runIndexing: starting', { indexFolder: this.settings.indexFolder });
		const notice = new Notice('Auditor: indexing… 0%', 0);
		try {
			await this.indexer.indexVaultFolder(
				this.app.vault,
				this.settings.indexFolder,
				(done, total, label) => {
					const pct = total > 0 ? Math.round((done / total) * 100) : 0;
					notice.setMessage(`Auditor: ${label} (${done}/${total} — ${pct}%)`);
				},
			);
			notice.setMessage('Auditor: indexing complete!');
			log('runIndexing: complete');
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

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<AuditorSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
