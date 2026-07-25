import { FileSystemAdapter, Notice, Plugin, normalizePath } from 'obsidian';
import {
	AuditorSettings,
	DEFAULT_SETTINGS,
	AuditorSettingTab,
} from './settings';
import { AuditVectorStore, type IndexSummary } from './vectorStore';
import { GeminiEmbeddings } from './geminiEmbeddings';
import { GeminiGenerate } from './geminiGenerate';
import { AuditorView, AUDITOR_VIEW_TYPE } from './auditorView';
import { FileExplorerDecorator } from './fileExplorerDecorator';
import { AddControlModal } from './addControlModal';

const log = (...args: unknown[]) => console.debug('[Auditor]', ...args);

export type StoreKind = 'standards' | 'evidence' | 'writtenControls';

/**
 * Turns a free-text control description (often long and multi-line) into a safe, short note
 * title: only the first line is used (avoiding embedded newlines entirely), every character
 * Obsidian forbids in filenames is stripped, and trailing dots/spaces (which Windows also
 * rejects) and path-traversal sequences are removed, then the result is length-capped.
 */
function sanitizeFileTitle(title: string, maxLength = 80): string {
	const firstLine = title.split(/\r?\n/)[0] ?? '';
	const cleaned = firstLine
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/\.\.+/g, '.')
		.trim()
		.slice(0, maxLength)
		.replace(/[\s.]+$/, '')
		.trim();
	return cleaned || 'Untitled control';
}

/** The one canonical markdown shape every control note is saved in, everywhere in the plugin. */
function buildControlNoteContent(requirement: string, conclusion: string): string {
	return [
		'## Control',
		'',
		requirement,
		'',
		'## Control report',
		'',
		conclusion,
	].join('\n');
}

export default class AuditorPlugin extends Plugin {
	settings!: AuditorSettings;
	standardsIndex!: AuditVectorStore;
	evidenceIndex!: AuditVectorStore;
	writtenControlsIndex!: AuditVectorStore;
	geminiGenerate!: GeminiGenerate;
	fileExplorerDecorator!: FileExplorerDecorator;

	async onload() {
		log('onload: plugin loading');
		await this.loadSettings();

		const embeddings = new GeminiEmbeddings(
			this.settings.geminiApiKey,
			this.settings.embeddingModel,
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
		);
		this.evidenceIndex = new AuditVectorStore(
			embeddings,
			`${dataRoot}/vector-index/evidence`,
			this.settings.chunkWords,
		);
		this.writtenControlsIndex = new AuditVectorStore(
			embeddings,
			`${dataRoot}/vector-index/written-controls`,
			this.settings.chunkWords,
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

		this.addRibbonIcon('bot', 'Open auditor', () => {
			void this.activateAuditorView();
		});

		this.addRibbonIcon('file-plus', 'Add control', () => {
			new AddControlModal(this.app, (title, requirement, conclusion) => {
				void this.saveControlNote(title, requirement, conclusion);
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
			id: 'add-control',
			name: 'Add control',
			callback: () => {
				new AddControlModal(this.app, (title, requirement, conclusion) => {
					void this.saveControlNote(title, requirement, conclusion);
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
		return this.writtenControlsIndex;
	}

	private folderFor(kind: StoreKind): string {
		if (kind === 'standards') return this.settings.standardsFolder;
		if (kind === 'evidence') return this.settings.evidenceFolder;
		return this.settings.writtenControlsFolder;
	}

	private labelFor(kind: StoreKind): string {
		if (kind === 'standards') return 'Standards';
		if (kind === 'evidence') return 'Evidence';
		return 'Written controls';
	}

	/**
	 * Runs indexing for the given store. `onProgress`, if given, is called in addition to the
	 * usual cancellable Notice — used by AuditorView to render live progress inline in the view.
	 */
	async runIndexing(
		kind: StoreKind,
		onProgress?: (done: number, total: number, label: string) => void,
	): Promise<IndexSummary | null> {
		const store = this.storeFor(kind);
		const label = this.labelFor(kind);
		if (store.isIndexing) {
			new Notice(`Auditor: ${label} indexing already in progress.`);
			return null;
		}
		log('runIndexing: starting', { kind, folder: this.folderFor(kind) });
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
						`Auditor: ${label} — ${indexLabel} (${done}/${total} — ${pct}%)${suffix}`,
					);
					onProgress?.(done, total, indexLabel);
				},
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

	/**
	 * Creates a new note in the written-controls folder, in the canonical Control/Control report
	 * format, then re-indexes that folder so the new control is immediately searchable. `title` is
	 * the requirement's own nomenclature (e.g. "ETSI TS 119 431-1 SIG-6.3.1-03"), used as the
	 * filename; falls back to deriving one from `requirement` when not given.
	 */
	async saveControlNote(title: string, requirement: string, conclusion: string): Promise<void> {
		const folder = this.settings.writtenControlsFolder;
		const safeTitle = sanitizeFileTitle(title || requirement);
		const path = normalizePath(
			folder ? `${folder}/${safeTitle}.md` : `${safeTitle}.md`,
		);
		const content = buildControlNoteContent(requirement, conclusion);
		const file = await this.app.vault.create(path, content);
		await this.app.workspace.getLeaf(false).openFile(file);
		void this.runIndexing('writtenControls');
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
