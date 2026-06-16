import { App, PluginSettingTab, Setting } from 'obsidian';
import AuditorPlugin from './main';

export interface AuditorSettings {
	indexFolder: string;
	embeddingModel: string;
	maxResults: number;
	chunkWords: number;
	graphNotePath: string;
	/** Newline-separated path patterns ('*' wildcard) indexed by title only, content never embedded. */
	titleOnlyPaths: string;
}

export const DEFAULT_SETTINGS: AuditorSettings = {
	indexFolder: '',
	embeddingModel: 'Xenova/bge-small-en-v1.5',
	maxResults: 10,
	chunkWords: 300,
	graphNotePath: 'Auditor Graph.md',
	titleOnlyPaths: '',
};

export class AuditorSettingTab extends PluginSettingTab {
	plugin: AuditorPlugin;

	constructor(app: App, plugin: AuditorPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName('Vault auditor').setHeading();

		new Setting(containerEl)
			.setName('Folder to index')
			.setDesc(
				'Vault folder path to index (leave empty for entire vault). E.g. "notes" or "projects/2024"',
			)
			.addText((text) =>
				text
					.setPlaceholder('E.g. Notes')
					.setValue(this.plugin.settings.indexFolder)
					.onChange(async (value) => {
						this.plugin.settings.indexFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Embedding model')
			.setDesc(
				'HuggingFace model ID (must have ONNX files). Changing this requires re-indexing.',
			)
			.addText((text) =>
				text
					.setPlaceholder('Xenova/bge-small-en-v1.5')
					.setValue(this.plugin.settings.embeddingModel)
					.onChange(async (value) => {
						this.plugin.settings.embeddingModel =
							value.trim() || DEFAULT_SETTINGS.embeddingModel;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Max results')
			.setDesc('Maximum number of results to show in the search view.')
			.addSlider((slider) =>
				slider
					.setLimits(1, 30, 1)
					.setValue(this.plugin.settings.maxResults)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxResults = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Graph note path')
			.setDesc('Markdown note used to persist the phrase/top-k list for the phrase graph view.')
			.addText((text) =>
				text
					.setPlaceholder('Auditor Graph.md')
					.setValue(this.plugin.settings.graphNotePath)
					.onChange(async (value) => {
						this.plugin.settings.graphNotePath = value.trim() || DEFAULT_SETTINGS.graphNotePath;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Title-only paths')
			.setDesc(
				'One path pattern per line ("*" wildcard supported, e.g. "Logs/*" or "*.private.md"). ' +
				'Matching files are indexed by title only — same as the "_" prefix rule, but for files you can\'t rename.',
			)
			.addTextArea((text) => {
				text
					.setPlaceholder('Logs/*\nDrafts/*.md')
					.setValue(this.plugin.settings.titleOnlyPaths)
					.onChange(async (value) => {
						this.plugin.settings.titleOnlyPaths = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 5;
			});

		new Setting(containerEl)
			.setName('Chunk size (words)')
			.setDesc(
				'For long sections without sub-headings, approximate word count per chunk.',
			)
			.addSlider((slider) =>
				slider
					.setLimits(100, 800, 50)
					.setValue(this.plugin.settings.chunkWords)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.chunkWords = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
