import { App, PluginSettingTab, Setting } from 'obsidian';
import AuditorPlugin from './main';

export interface AuditorSettings {
	/** Gemini API key, stored in plain text in data.json (same as every other plugin holding an API key). */
	geminiApiKey: string;
	embeddingModel: string;
	generationModel: string;
	/** Vault folder containing the standards used for auditing (e.g. ETSI 119431). */
	standardsFolder: string;
	/** Vault folder containing audit evidence. */
	evidenceFolder: string;
	/** Vault folder containing previously drafted/written controls, used as style references. */
	writtenControlsFolder: string;
	/** Vault folder containing interview evidence (Test of Effectiveness / Stage 2 evidence). */
	interviewEvidenceFolder: string;
	/** Vault folder where interview session plans (one note per session, listing its Evidence Goals) are stored. */
	interviewSessionPlansFolder: string;
	maxResults: number;
	/** Target paragraph-chunk size in words. */
	chunkWords: number;
	/** Default writing rules pre-filled in the control-drafting pipeline's "Writing rules" step. */
	defaultWritingRules: string;
	/** Default writing rules pre-filled in the Stage 2 evidence tab's "Writing rules" step. */
	defaultStage2WritingRules: string;
	/** Ceiling on Gemini embedding requests per second during indexing, shared across all three stores. */
	maxRequestsPerSecond: number;
	/** When enabled, indexing starts at a slow request rate and ramps up to the ceiling over ~30s instead of starting at full speed. */
	gradualRampUp: boolean;
	/** Maximum number of files indexed concurrently within a single store (standards/evidence/written-controls each apply this independently). */
	maxConcurrentIndexing: number;
	/** Maximum number of controls processed concurrently by the batch Stage 2 evidence pipeline. */
	maxConcurrentStage2: number;
}

const DEFAULT_WRITING_RULES = `RULE 1
Output your results in the following structure:
Findings:
....
Observations/Recommendations:
...
Evidence:
...
Do not output anything else

RULE 2
If a minor non-conformity is found, give a recommendation in Observations, but do not show Recommendations.
If a major non-conformity is found, give a recommendation in Recommendations, but do not show Observations.
If no non-conformitiy is found, do not show Observations/Recommendations.

RULE 3
Make all observations in the Findings sections. Stat by stating the name of the file, give the evidence number then state the observations relative to the control, eg: "The Cryptography Policy [E003] is observed to define policies for maintaining an inventory of cryptographic materials". Always start the findings by listing relevant files in such a way.

RULE 4
If a non-conformity is observed, observe it first in the Findings, using the phrasing eg: "However, it is observed that no process exists for updating the Cryptography Policy".

RULE 5
Always start the Observations and Recommendations section with the wording "It is recommended that ...". Do not use strong verbs like shall or shold. Do not consult.

RULE 6
Reference filenames in findings using their titles with capitalization eg: "Change Management Policy" in a readable way, followed by the evidence number (E followed by three digits) surrounded in square brackets.

RULE 7
All files referenced in the Findings section must be documented in the Evidence section by giving the full filename including the file suffix eg: "E003_Cryptography_Policy.pdf". Write only that.
`;

const DEFAULT_STAGE2_WRITING_RULES = `RULE 1
Output your results in the following structure:
Finding:
....
Observation/Recommendation:
...
Evidence:
...
Do not output anything else

RULE 2
If a minor non-conformity is found, give a recommendation in Observations but do not show Recommendation.
If a major non-conformity is found, give a recommendation in Recommendation, but do not show Observation.
If no non-conformitiy is found, do not show Observation/Recommendation.

RULE 3
Make all observations in the Finding sections. Start by stating the date of the walkthrough, give the date of the walkthrough then state the observations relative to the control, eg: "During the walkthrough on 22.07.26, it was that a tool is used to maitain an inventory of cryptographic materials [E129, p.3]". Always start the findings using this wording.

RULE 4
If a non-conformity is observed, observe it first in the Findings, using the phrasing eg: "However, no process was observed to be in place to document changes".

RULE 5
Always start the Observations and Recommendations section with the wording "It is recommended that ...". Do not use strong verbs like shall or shold. Do not consult.

RULE 6
Reference filenames in findings using their titles with capitalization eg: "Change Management Policy" in a readable way, followed by the evidence number (E followed by three digits) surrounded in square brackets.

RULE 7
All files referenced in the Findings section must be documented in the Evidence section by giving the full filename including the file suffix eg: "E003_Cryptography_Policy.pdf". Write only that.

RULE 8
Files with filenames starting with [TRANSCRIPT] must never be referenced as evidence. Only use these files for providing context on what was said in the interviews.

RULE 9
For stage 2 writing, always describe what the auditors saw during walkthroughs. Use this specific wording: "During the walkthrough on 22.07.26, the auditors observed that...". Restate this for each individual walkthrough as supported by evidence and transcripts.

RULE 10
Always cite the page ranges where in the evidence where the supporting screenshots can be found like so "[E129, p.4-6]".

RULE 11
Always use non biased language like "it was observed" or "the interviewed SME stated that ...".

RULE 12
Make all observations in the finding section.

RULE 13
Never invent or assume a walkthrough, interview, or observation that is not explicitly supported by the provided interview evidence or transcripts. Do not apply the RULE 3/RULE 9 walkthrough wording as a fixed template regardless of content — only use it for walkthroughs that actually happened and are evidenced. If no walkthrough evidence was provided for the control, say plainly that no walkthrough evidence was available instead of fabricating one. Never write a "However" sentence (RULE 4) that contradicts or restates the sentence before it without a real logical link — each sentence must follow coherently from the actual evidence, not from mechanically stitching rule templates together.
`;

export const DEFAULT_SETTINGS: AuditorSettings = {
	geminiApiKey: '',
	embeddingModel: 'gemini-embedding-2',
	generationModel: 'gemini-3.6-flash',
	standardsFolder: '',
	evidenceFolder: '',
	writtenControlsFolder: '',
	interviewEvidenceFolder: '',
	interviewSessionPlansFolder: '',
	maxResults: 10,
	chunkWords: 300,
	defaultWritingRules: DEFAULT_WRITING_RULES,
	defaultStage2WritingRules: DEFAULT_STAGE2_WRITING_RULES,
	maxRequestsPerSecond: 5,
	gradualRampUp: true,
	maxConcurrentIndexing: 10,
	maxConcurrentStage2: 5,
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

		new Setting(containerEl)
			.setName('Gemini API key')
			.setDesc(
				'Used for both embedding and generation calls. Stored in plain text in this plugin\'s data.json, ' +
				'same as any other plugin that holds an API key.',
			)
			.addText((text) => {
				text.inputEl.type = 'password';
				text
					.setPlaceholder('AI...')
					.setValue(this.plugin.settings.geminiApiKey)
					.onChange(async (value) => {
						this.plugin.settings.geminiApiKey = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName('Embedding model')
			.setDesc('Gemini embedding model ID used to index standards, evidence, and written controls.')
			.addText((text) =>
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case -- literal model ID
					.setPlaceholder('gemini-embedding-2')
					.setValue(this.plugin.settings.embeddingModel)
					.onChange(async (value) => {
						this.plugin.settings.embeddingModel = value.trim() || DEFAULT_SETTINGS.embeddingModel;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Generation model')
			.setDesc('Gemini model ID used to synthesize evidence-search queries and draft controls.')
			.addText((text) =>
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case -- literal model ID
					.setPlaceholder('gemini-3.6-flash')
					.setValue(this.plugin.settings.generationModel)
					.onChange(async (value) => {
						this.plugin.settings.generationModel = value.trim() || DEFAULT_SETTINGS.generationModel;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Standards folder')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- ETSI is an acronym
			.setDesc('Vault folder containing the standards used for auditing (e.g. ETSI 119431).')
			.addText((text) =>
				text
					.setPlaceholder('Standards')
					.setValue(this.plugin.settings.standardsFolder)
					.onChange(async (value) => {
						this.plugin.settings.standardsFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Evidence folder')
			.setDesc('Vault folder containing audit evidence.')
			.addText((text) =>
				text
					.setPlaceholder('Evidence')
					.setValue(this.plugin.settings.evidenceFolder)
					.onChange(async (value) => {
						this.plugin.settings.evidenceFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Written controls folder')
			.setDesc('Vault folder containing previously drafted controls, used as style references and as the save destination for new drafts.')
			.addText((text) =>
				text
					.setPlaceholder('Written controls')
					.setValue(this.plugin.settings.writtenControlsFolder)
					.onChange(async (value) => {
						this.plugin.settings.writtenControlsFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Interview evidence folder')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Test of Effectiveness" / "Stage 2" are literal report terms
			.setDesc('Vault folder containing interview evidence, used for the Test of Effectiveness / Stage 2 evidence-writing flow.')
			.addText((text) =>
				text
					.setPlaceholder('Interview evidence')
					.setValue(this.plugin.settings.interviewEvidenceFolder)
					.onChange(async (value) => {
						this.plugin.settings.interviewEvidenceFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Interview session plans folder')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Evidence Goals" names the plugin's own concept
			.setDesc('Vault folder where interview session plans are stored — one note per session, listing its Evidence Goals.')
			.addText((text) =>
				text
					.setPlaceholder('Interview session plans')
					.setValue(this.plugin.settings.interviewSessionPlansFolder)
					.onChange(async (value) => {
						this.plugin.settings.interviewSessionPlansFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Max results')
			.setDesc('Maximum number of results to retrieve per search step.')
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
			.setName('Chunk size (words)')
			.setDesc('Target paragraph-chunk size, in words, used when indexing.')
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

		new Setting(containerEl)
			.setName('Default writing rules')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Writing rules" names the pipeline step's own heading
			.setDesc('Pre-filled in the control-drafting pipeline\'s "Writing rules" step; editable per-draft there.')
			.addTextArea((text) => {
				text
					.setValue(this.plugin.settings.defaultWritingRules)
					.onChange(async (value) => {
						this.plugin.settings.defaultWritingRules = value || DEFAULT_SETTINGS.defaultWritingRules;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 16;
				text.inputEl.addClass('auditor-rules-textarea');
			});

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Stage 2" is a literal report term
			.setName('Default Stage 2 writing rules')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Writing rules" names the Stage 2 tab's own heading, "Stage 2" is a literal report term
			.setDesc('Pre-filled in the Stage 2 evidence tab\'s "Writing rules" step; editable per-draft there.')
			.addTextArea((text) => {
				text
					.setValue(this.plugin.settings.defaultStage2WritingRules)
					.onChange(async (value) => {
						this.plugin.settings.defaultStage2WritingRules = value || DEFAULT_SETTINGS.defaultStage2WritingRules;
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 16;
				text.inputEl.addClass('auditor-rules-textarea');
			});

		new Setting(containerEl)
			.setName('Max requests per second')
			.setDesc('Ceiling on Gemini embedding requests per second during indexing, shared across all three stores.')
			.addSlider((slider) =>
				slider
					.setLimits(1, 20, 1)
					.setValue(this.plugin.settings.maxRequestsPerSecond)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxRequestsPerSecond = value;
						this.plugin.rateLimiter.updateConfig(value, this.plugin.settings.gradualRampUp);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Gradual increase')
			.setDesc('Ramp indexing up from a slow request rate to the ceiling above over ~30s, instead of starting at full speed.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.gradualRampUp)
					.onChange(async (value) => {
						this.plugin.settings.gradualRampUp = value;
						this.plugin.rateLimiter.updateConfig(this.plugin.settings.maxRequestsPerSecond, value);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Max concurrent files')
			.setDesc('How many files can be indexed at the same time, within a single store (standards/evidence/written-controls each apply this independently).')
			.addSlider((slider) =>
				slider
					.setLimits(1, 30, 1)
					.setValue(this.plugin.settings.maxConcurrentIndexing)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxConcurrentIndexing = value;
						this.plugin.updateIndexingConcurrency();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Stage 2" is a literal report term
			.setName('Max concurrent Stage 2 drafts')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Stage 2" is a literal report term
			.setDesc('How many controls the batch Stage 2 evidence pipeline processes at the same time.')
			.addSlider((slider) =>
				slider
					.setLimits(1, 20, 1)
					.setValue(this.plugin.settings.maxConcurrentStage2)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxConcurrentStage2 = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
