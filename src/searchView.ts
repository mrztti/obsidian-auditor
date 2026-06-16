import { ItemView, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from './main';
import type { SearchResult } from './indexer';

export const SEARCH_VIEW_TYPE = 'auditor-search-view';

export class SearchView extends ItemView {
	private plugin: AuditorPlugin;
	private queryInput!: HTMLInputElement;
	private resultsEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, plugin: AuditorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SEARCH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Vault semantic search';
	}

	getIcon(): string {
		return 'search';
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-search-container');

		const header = container.createDiv('auditor-search-header');
		header.createEl('h4', { text: 'Semantic search' });

		const inputRow = header.createDiv('auditor-search-input-row');
		this.queryInput = inputRow.createEl('input', {
			type: 'text',
			placeholder: 'Search your vault semantically…',
			cls: 'auditor-search-input',
		});

		const searchBtn = inputRow.createEl('button', { text: 'Search', cls: 'auditor-search-btn' });
		const indexBtn = header.createEl('button', { text: 'Re-index folder', cls: 'auditor-index-btn mod-muted' });

		this.resultsEl = container.createDiv('auditor-results');

		const doSearch = async () => {
			const query = this.queryInput.value.trim();
			if (!query) return;
			this.showStatus('Searching…');
			try {
				const results = await this.plugin.indexer.search(query, this.plugin.settings.maxResults);

				this.renderResults(results);
			} catch (e) {
				this.showStatus(`Error: ${String(e)}`);
			}
		};

		searchBtn.addEventListener('click', () => { void doSearch(); });
		this.queryInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') void doSearch();
		});

		indexBtn.addEventListener('click', () => { void this.plugin.runIndexing(); });
	}

	private renderResults(results: SearchResult[]): void {
		this.resultsEl.empty();

		if (results.length === 0) {
			this.showStatus('No results found.');
			return;
		}

		for (const result of results) {
			const card = this.resultsEl.createDiv('auditor-result-card');

			const meta = card.createDiv('auditor-result-meta');
			const fileLink = meta.createEl('a', {
				text: result.filePath.replace(/\.md$/, ''),
				cls: 'auditor-result-file',
			});
			fileLink.addEventListener('click', () => {
				const file = this.app.vault.getFileByPath(result.filePath);
				if (file) void this.app.workspace.getLeaf(false).openFile(file);
			});

			meta.createSpan({
				text: ` (${(result.score * 100).toFixed(0)}%)`,
				cls: 'auditor-result-score',
			});

			for (const section of result.sections) {
				card.createEl('p', {
					text: section.length > 300 ? section.slice(0, 300) + '…' : section,
					cls: 'auditor-result-preview',
				});
			}
		}
	}

	private showStatus(msg: string): void {
		this.resultsEl.empty();
		this.resultsEl.createEl('p', { text: msg, cls: 'auditor-status' });
	}

	async onClose(): Promise<void> {}
}
