import { App, PluginSettingTab, Setting } from 'obsidian';
import AuditorPlugin from './main';
import { todayIsoDate, type ControlFieldKey } from './controlNote';
import { EXPORT_COLORS } from './exportColors';

/**
 * Versioning + prohibited-wording wrapper the batch QA tool checks against (FR-3.3) — retrieved at
 * QA runtime by `qa_review_conclusions_batch` (see src/agent/tools/qaBatch.ts). The structural
 * writing rules themselves are NOT duplicated here: QA uses the same `defaultWritingRules` /
 * `defaultStage2WritingRules` settings the drafting pipeline and `prepare_control_conclusion`
 * already use, so there is exactly one place those rules live, never two copies that can drift out
 * of sync. `version` is bumped automatically whenever the name or prohibited wording change, and
 * every QA result records the version it ran against, so an existing conclusion's QA stays
 * traceable even after the profile is later edited.
 */
export interface WritingStyleProfile {
	id: string;
	name: string;
	version: number;
	/** Words/phrases the QA pass must flag if found in a conclusion (case-insensitive substring match), e.g. hedging language or forbidden verbs. */
	prohibitedWording: string[];
	updatedAt: string;
}

export const EMPTY_WRITING_STYLE_PROFILE: WritingStyleProfile = {
	id: 'default',
	name: '',
	version: 0,
	prohibitedWording: [],
	updatedAt: '',
};

/**
 * Persisted bidirectional link between the vault's written controls and one sheet of one vault
 * .xlsx file, keyed by 1-based COLUMN NUMBER rather than header text — header-text matching turned
 * out to be fragile in practice (a header cell wrapped across two visual lines persists with an
 * embedded line break, which then never matches anything live; duplicate header text across
 * columns is also not uncommon in real templates). A column number is unambiguous and immune to
 * both. The tradeoff is explicit: if columns are reordered/inserted in Excel after this link is
 * configured, it must be reconfigured — re-running "Configure Excel link" re-reads the header row
 * so the user can re-pick columns by their (current) label.
 */
export interface ExcelLinkConfig {
	/** Vault path to the linked .xlsx/.xls file. Empty = link not configured. */
	filePath: string;
	sheetName: string;
	/** 1-based row number the column headers live on. */
	headerRowNumber: number;
	/** 1-based column number used to match a sheet row to a control note, both directions. 0 = unset. */
	keyColumn: number;
	/**
	 * Optional 1-based column number that gates sync-FROM-Excel: a sheet row is only synced
	 * (updating or creating its control note) when this column is non-empty on that row. 0 = none —
	 * every row with a key value is synced. Same idea as the one-shot import wizard's "Import gate
	 * column", carried over here so the Excel link doesn't lose that control.
	 */
	gateColumn: number;
	/** Field -> 1-based column number. A field absent here is never read from or written to the sheet. */
	mapping: Partial<Record<ControlFieldKey, number>>;
}

export const EMPTY_EXCEL_LINK: ExcelLinkConfig = {
	filePath: '',
	sheetName: '',
	headerRowNumber: 0,
	keyColumn: 0,
	gateColumn: 0,
	mapping: {},
};

/**
 * What kind of durable fact a `AgentMemoryItem` holds (FR-6.3). `acceptedConclusion` and
 * `acceptedDecision` are written only by the plugin itself, right after the user's own approval —
 * never by the agent — so they can be trusted as genuinely user-accepted. `stableDocumentFact`,
 * `thematicEvidenceMap`, `controlFrameworkMetadata` and `engagementConfig` can be written by the
 * agent via the `remember_fact` tool, always with a source citation; the agent is never allowed to
 * write the first two categories itself.
 */
export type MemoryCategory =
	| 'engagementConfig'
	| 'controlFrameworkMetadata'
	| 'writingStyleProfileRef'
	| 'stableDocumentFact'
	| 'acceptedDecision'
	| 'acceptedConclusion'
	| 'thematicEvidenceMap';

/**
 * One durable fact the agent can carry across chat sessions without re-deriving or re-researching
 * it each time (FR-6.3). Deliberately NOT a conversation transcript — `content` is a short,
 * structured statement with a citation, never raw draft text or an unverified model claim (that
 * restriction is enforced where items get written, not here).
 *
 * `scope` is always `'vault'`: this plugin is single-user and single-vault with no tenant,
 * multi-user or permission boundary to partition memory by — the "partition by tenant, engagement
 * and user authorization" requirement this type is modeled on has no real referent here, so this
 * field exists to make that explicit rather than to silently do nothing.
 */
export interface AgentMemoryItem {
	id: string;
	category: MemoryCategory;
	content: string;
	/** Where this came from — a control number, file path, or the tool/decision that produced it. Required so every item stays traceable to its source. */
	provenance: string;
	scope: 'vault';
	version: number;
	createdAt: string;
	/** Set once a newer item replaces this one. The superseded item is kept, never deleted, so the memory's history stays auditable. */
	supersededBy?: string;
	/** ISO date after which this item should no longer be surfaced — absent means it does not expire. */
	retentionUntil?: string;
}

export interface AuditorSettings {
	/** Gemini API key, stored in plain text in data.json (same as every other plugin holding an API key). */
	geminiApiKey: string;
	embeddingModel: string;
	generationModel: string;
	/** Optional, more capable/expensive Gemini model ID — used by the chat agent's own steps only when "Burn Mode" is enabled in the chat AND the agent has marked the current step quality-sensitive (QA, planning, drafting). Empty disables Burn Mode regardless of the chat toggle. Never used for session planning or RAG lookups, which always stay on the regular generation model. */
	boostedModel: string;
	/**
	 * USD price per 1,000,000 input tokens for the regular generation model — used only to
	 * calculate the estimated per-step/run/session cost shown in the chat agent's plan (Gemini's
	 * response reports token counts, never a confirmed dollar cost, so every figure derived from
	 * these prices is and must be labelled an estimate). 0 = cost shown as $0.00 until filled in.
	 */
	baseModelInputPricePerMtok: number;
	/** USD price per 1,000,000 cached input tokens for the regular generation model (Gemini context-cache hits) — see `baseModelInputPricePerMtok`. */
	baseModelCachedInputPricePerMtok: number;
	/** USD price per 1,000,000 output tokens for the regular generation model — see `baseModelInputPricePerMtok`. */
	baseModelOutputPricePerMtok: number;
	/** USD price per 1,000,000 input tokens for the boosted model (Burn Mode) — see `baseModelInputPricePerMtok`. */
	boostedModelInputPricePerMtok: number;
	/** USD price per 1,000,000 cached input tokens for the boosted model — see `baseModelInputPricePerMtok`. */
	boostedModelCachedInputPricePerMtok: number;
	/** USD price per 1,000,000 output tokens for the boosted model — see `baseModelInputPricePerMtok`. */
	boostedModelOutputPricePerMtok: number;
	/** The agent's single configured writing-style profile, enforced by `qa_review_conclusions_batch` — see `WritingStyleProfile`. */
	writingStyleProfile: WritingStyleProfile;
	/** Vault folder containing the standards used for auditing (e.g. ETSI 119431). */
	standardsFolder: string;
	/** Vault folder containing audit evidence. */
	evidenceFolder: string;
	/** Vault folder containing previously drafted/written controls, used as style references. */
	writtenControlsFolder: string;
	/** Vault folder containing interview evidence (Test of Effectiveness / Stage 2 evidence). */
	interviewEvidenceFolder: string;
	/** Vault folder containing finalized audit reports, kept purely as style/structure reference for how Stage 1/2 conclusions should read for a given control — never edited or cited as evidence itself. */
	referenceReportsFolder: string;
	/** Vault folder where interview session plans live: one reference note per session (an ordered list of Evidence Goal IDs), plus an `evidence-goals` subfolder holding one note per Evidence Goal. */
	interviewSessionPlansFolder: string;
	/** Vault folder exported PDF/Word documents (controls, evidence) are saved into. Empty = vault root. */
	exportsFolder: string;
	/** Hex color for PDF exports' cover-page band and section headings — was a fixed purple, now user-configurable. Applies to PDF exports only (Word exports use their own default styling). */
	pdfAccentColor: string;
	/** Vault path to an image (PNG/JPEG) drawn top-left of every PDF export's cover header. Empty = no logo. */
	pdfLogoPath: string;
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

	/** The regular (non-boosted) model's total context window, in tokens — used to calculate usable input budget and when context compaction must trigger (FR-6.1). Check the model's own documentation; this plugin cannot read it from the API. */
	baseModelMaxContextTokens: number;
	/** Compaction is triggered once context use crosses this percentage of the usable input budget (FR-6.1/FR-6.4). */
	compactionThresholdPercent: number;
	/** Tokens reserved for the model's own output, subtracted from the context window before calculating the usable input budget. */
	reservedOutputTokens: number;
	/** Tokens reserved for the system prompt and tool declarations, subtracted from the context window before calculating the usable input budget. */
	reservedSystemToolTokens: number;
	/** Cap on how many items `AgentMemoryItem[]` may hold before the oldest superseded entries are evicted (live entries are never evicted). */
	persistentMemoryMaxItems: number;
	/** Cap on how many entries the research/evidence cache (`src/agent/researchCache.ts`) may hold before the oldest are evicted. */
	evidenceCacheMaxEntries: number;
	/** Durable facts the agent carries across chat sessions — see `AgentMemoryItem`. Not meant to be hand-edited; use the "Clear agent memory" action in this settings tab, or the agent's own remember_fact/recall_memory tools. */
	agentMemory: AgentMemoryItem[];

	// ─── Rapid Fire batch cost controls (FR-8.8) ───────────────────────────
	/** A Rapid Fire batch pauses (never cancels/discards) once its running cost crosses this many USD — 0 disables the limit. */
	rapidFireMaxBatchCostUsd: number;
	/** A topic batch is split further during Phase 1 if its estimated context would exceed this many tokens. */
	rapidFireMaxTokensPerTopicBatch: number;
	/** Upper bound on how many controls are drafted/QA'd in a single model call (Phase 3/4). */
	rapidFireMaxControlsPerModelCall: number;
	/** A Rapid Fire batch pauses once boosted-model spend (escalated controls) crosses this many USD — 0 disables the limit. */
	rapidFireBoostedEscalationBudgetUsd: number;
	/** Ceiling on Gemini GENERATION requests per second from the Rapid Fire engine — unlike the chat agent (naturally paced by the user reading/typing between turns), Rapid Fire can fire many drafting/QA calls back to back with nothing pacing them, so this exists specifically to avoid bursting past the provider's rate limit. */
	rapidFireMaxRequestsPerSecond: number;

	/** The single configured bidirectional Excel link — see `ExcelLinkConfig`. */
	excelLink: ExcelLinkConfig;
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
	boostedModel: '',
	baseModelInputPricePerMtok: 0,
	baseModelCachedInputPricePerMtok: 0,
	baseModelOutputPricePerMtok: 0,
	boostedModelInputPricePerMtok: 0,
	boostedModelCachedInputPricePerMtok: 0,
	boostedModelOutputPricePerMtok: 0,
	writingStyleProfile: { ...EMPTY_WRITING_STYLE_PROFILE },
	standardsFolder: '',
	evidenceFolder: '',
	writtenControlsFolder: '',
	interviewEvidenceFolder: '',
	referenceReportsFolder: '',
	interviewSessionPlansFolder: '',
	exportsFolder: '',
	pdfAccentColor: EXPORT_COLORS.accent,
	pdfLogoPath: '',
	maxResults: 10,
	chunkWords: 300,
	defaultWritingRules: DEFAULT_WRITING_RULES,
	defaultStage2WritingRules: DEFAULT_STAGE2_WRITING_RULES,
	maxRequestsPerSecond: 5,
	gradualRampUp: true,
	maxConcurrentIndexing: 10,
	maxConcurrentStage2: 5,
	// Gemini 3.6 Flash's documented context window is ~1M tokens; conservative defaults leave headroom.
	baseModelMaxContextTokens: 1_000_000,
	compactionThresholdPercent: 80,
	reservedOutputTokens: 8_000,
	reservedSystemToolTokens: 4_000,
	persistentMemoryMaxItems: 200,
	evidenceCacheMaxEntries: 300,
	agentMemory: [],
	rapidFireMaxBatchCostUsd: 0,
	rapidFireMaxTokensPerTopicBatch: 60_000,
	rapidFireMaxControlsPerModelCall: 8,
	rapidFireBoostedEscalationBudgetUsd: 0,
	// Conservative default (1 generation call every 2s = 30/min) — comfortably under typical free-tier
	// Gemini RPM limits; raise it in settings if your quota allows faster throughput.
	rapidFireMaxRequestsPerSecond: 0.5,
	excelLink: { ...EMPTY_EXCEL_LINK },
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
			.setName('Boosted model')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "QA", "Burn Mode" and "Gemini" are literal terms
			.setDesc('Optional, more capable (and more expensive) Gemini model ID. Used by the chat agent only for the steps it marks quality-sensitive (QA, planning, drafting a conclusion) — and only while "Burn Mode" is switched on in the chat. Leave empty to disable Burn Mode entirely; everything else (session planning, searches/lookups) always uses the generation model above regardless.')
			.addText((text) =>
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case -- literal model ID
					.setPlaceholder('e.g. gemini-3.6-pro')
					.setValue(this.plugin.settings.boostedModel)
					.onChange(async (value) => {
						this.plugin.settings.boostedModel = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName('Cost tracking').setHeading();
		containerEl.createEl('p', {
			cls: 'auditor-field-description',
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "USD" and "Gemini" are literal terms
			text: 'Optional. Price per 1,000,000 tokens, in USD, used only to estimate the cost shown next to the chat agent\'s plan steps — Gemini reports token counts but never a confirmed dollar cost, so every figure is an estimate. Leave at 0 to hide cost (token counts still show).',
		});
		this.renderPriceField(containerEl, 'Base model — input price', 'baseModelInputPricePerMtok');
		this.renderPriceField(containerEl, 'Base model — cached-input price', 'baseModelCachedInputPricePerMtok');
		this.renderPriceField(containerEl, 'Base model — output price', 'baseModelOutputPricePerMtok');
		this.renderPriceField(containerEl, 'Boosted model — input price', 'boostedModelInputPricePerMtok');
		this.renderPriceField(containerEl, 'Boosted model — cached-input price', 'boostedModelCachedInputPricePerMtok');
		this.renderPriceField(containerEl, 'Boosted model — output price', 'boostedModelOutputPricePerMtok');

		new Setting(containerEl).setName('Writing style profile').setHeading();
		containerEl.createEl('p', {
			cls: 'auditor-field-description',
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "QA" is a literal acronym
			text: 'The single source of truth the agent\'s batch QA tool checks every Stage 1/Stage 2 conclusion against — not duplicated into any prompt. Required before the agent will present conclusions for your final review; leave it empty and it will stop with a configuration error instead of silently using a default. Editing any field here bumps the version automatically, and every QA result records which version it ran against.',
		});
		this.renderStyleProfileEditor(containerEl);

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
			.setName('Reference reports folder')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Stage 1/2" is a literal report term
			.setDesc('Vault folder containing finalized audit reports from past engagements, indexed separately and used only as a style/structure reference — how Stage 1/2 conclusions for a similar control were written — never as evidence.')
			.addText((text) =>
				text
					.setPlaceholder('Reference reports')
					.setValue(this.plugin.settings.referenceReportsFolder)
					.onChange(async (value) => {
						this.plugin.settings.referenceReportsFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Interview session plans folder')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Evidence Goals" names the plugin's own concept
			.setDesc('Vault folder where interview session plans are stored — one reference note per session, plus a subfolder with one note per Evidence Goal.')
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
			.setName('Exports folder')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "PDF" is a literal acronym
			.setDesc('Vault folder exported PDF/Word documents are saved into. Leave empty to save at the vault root.')
			.addText((text) =>
				text
					.setPlaceholder('Exports')
					.setValue(this.plugin.settings.exportsFolder)
					.onChange(async (value) => {
						this.plugin.settings.exportsFolder = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('PDF highlight color')
			.setDesc('Accent color used for the cover-page band and section headings in PDF exports (controls, evidence). Text color on the band adjusts automatically for contrast.')
			.addColorPicker((picker) =>
				picker
					.setValue(this.plugin.settings.pdfAccentColor)
					.onChange(async (value) => {
						this.plugin.settings.pdfAccentColor = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('PDF logo image')
			.setDesc('Vault path to an image (PNG or JPEG) shown at the top left of every PDF export\'s cover header. Leave empty for no logo.')
			.addText((text) =>
				text
					.setPlaceholder('Attachments/logo.png')
					.setValue(this.plugin.settings.pdfLogoPath)
					.onChange(async (value) => {
						this.plugin.settings.pdfLogoPath = value.trim();
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

		new Setting(containerEl).setName('Context & memory').setHeading();
		this.renderContextSettings(containerEl);

		// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Rapid Fire" is the feature's own name
		new Setting(containerEl).setName('Rapid Fire cost controls').setHeading();
		containerEl.createEl('p', {
			cls: 'auditor-field-description',
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Rapid Fire" is the feature's own name
			text: 'Limits a running Rapid Fire batch pauses at (never cancels or discards) rather than enforces up front. 0 disables a limit.',
		});
		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "USD" is a literal currency code
			.setName('Max batch cost (USD)')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.step = '0.5';
				text.setValue(String(this.plugin.settings.rapidFireMaxBatchCostUsd)).onChange(async (value) => {
					const parsed = Number.parseFloat(value);
					this.plugin.settings.rapidFireMaxBatchCostUsd = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "USD" is a literal currency code
			.setName('Max boosted-model escalation spend (USD)')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.step = '0.5';
				text.setValue(String(this.plugin.settings.rapidFireBoostedEscalationBudgetUsd)).onChange(async (value) => {
					const parsed = Number.parseFloat(value);
					this.plugin.settings.rapidFireBoostedEscalationBudgetUsd = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName('Max tokens per topic batch')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1000';
				text.inputEl.step = '1000';
				text.setValue(String(this.plugin.settings.rapidFireMaxTokensPerTopicBatch)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					this.plugin.settings.rapidFireMaxTokensPerTopicBatch = Number.isFinite(parsed) ? Math.max(1000, parsed) : this.plugin.settings.rapidFireMaxTokensPerTopicBatch;
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "QA" is a literal acronym
			.setName('Max controls per drafting/QA call')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '1';
				text.inputEl.step = '1';
				text.setValue(String(this.plugin.settings.rapidFireMaxControlsPerModelCall)).onChange(async (value) => {
					const parsed = Number.parseInt(value, 10);
					this.plugin.settings.rapidFireMaxControlsPerModelCall = Number.isFinite(parsed) ? Math.max(1, parsed) : this.plugin.settings.rapidFireMaxControlsPerModelCall;
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName('Max generation requests per second')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "Rapid Fire" is the feature's own name
			.setDesc('Paces the Rapid Fire engine\'s own drafting/QA/classification calls so a large batch never bursts past your Gemini rate limit — unlike the chat agent, which is naturally paced by you reading/typing between turns.')
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0.1';
				text.inputEl.step = '0.1';
				text.setValue(String(this.plugin.settings.rapidFireMaxRequestsPerSecond)).onChange(async (value) => {
					const parsed = Number.parseFloat(value);
					this.plugin.settings.rapidFireMaxRequestsPerSecond = Number.isFinite(parsed) && parsed > 0 ? parsed : this.plugin.settings.rapidFireMaxRequestsPerSecond;
					this.plugin.rapidFireRateLimiter.updateConfig(this.plugin.settings.rapidFireMaxRequestsPerSecond, false);
					await this.plugin.saveSettings();
				});
			});
	}

	/**
	 * Name and prohibited wording (one per line) for the single configured `WritingStyleProfile`.
	 * The structural writing rules are deliberately NOT edited here — see the note rendered below —
	 * they stay the pre-existing `defaultWritingRules`/`defaultStage2WritingRules` settings. Any edit
	 * here bumps `version` and stamps `updatedAt`, so a past QA result stays attributable to exactly
	 * what applied when it ran, even after the profile is later changed.
	 */
	private renderStyleProfileEditor(containerEl: HTMLElement): void {
		const profile = this.plugin.settings.writingStyleProfile;
		const bump = async () => {
			profile.version += 1;
			profile.updatedAt = todayIsoDate();
			await this.plugin.saveSettings();
			versionEl.setText(profile.version > 0 ? `Version ${profile.version}, last updated ${profile.updatedAt}` : 'Not yet configured');
		};

		new Setting(containerEl)
			.setName('Profile name')
			.addText((text) =>
				text
					// eslint-disable-next-line obsidianmd/ui/sentence-case -- placeholder, not sentence text
					.setPlaceholder('e.g. House style')
					.setValue(profile.name)
					.onChange(async (value) => { profile.name = value.trim(); await bump(); }),
			);

		containerEl.createEl('p', {
			cls: 'auditor-field-description',
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- quoted literal setting names
			text: 'The structural writing rules QA checks against are the same "Default writing rules" / "Default Stage 2 writing rules" set further down this page — not duplicated here, so there is only ever one place they live.',
		});

		new Setting(containerEl)
			.setName('Prohibited wording')
			// eslint-disable-next-line obsidianmd/ui/sentence-case -- "QA" is a literal acronym
			.setDesc('One word or phrase per line. QA flags a conclusion that contains any of these (case-insensitive).')
			.addTextArea((text) => {
				text.inputEl.rows = 3;
				text
					.setValue(profile.prohibitedWording.join('\n'))
					.onChange(async (value) => {
						profile.prohibitedWording = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
						await bump();
					});
			});

		const versionEl = containerEl.createEl('p', {
			cls: 'auditor-field-description',
			text: profile.version > 0 ? `Version ${profile.version}, last updated ${profile.updatedAt}` : 'Not yet configured',
		});
	}

	/** One "$ per 1,000,000 tokens" numeric field bound to a pricing key in settings — negative input is clamped to 0, and anything unparsable is left as the last good value. */
	private renderPriceField(
		containerEl: HTMLElement,
		name: string,
		key: 'baseModelInputPricePerMtok' | 'baseModelCachedInputPricePerMtok' | 'baseModelOutputPricePerMtok'
			| 'boostedModelInputPricePerMtok' | 'boostedModelCachedInputPricePerMtok' | 'boostedModelOutputPricePerMtok',
	): void {
		new Setting(containerEl)
			.setName(name)
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = '0';
				text.inputEl.step = '0.01';
				text
					.setPlaceholder('0.00')
					.setValue(String(this.plugin.settings[key]))
					.onChange(async (value) => {
						const parsed = Number.parseFloat(value);
						this.plugin.settings[key] = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
						await this.plugin.saveSettings();
					});
			});
	}

	/**
	 * Context-window budget settings (FR-6.1) plus a visible, auditable way to clear the agent's
	 * persistent memory (FR-6.3) — memory items are otherwise only written by the plugin/agent
	 * itself, never hand-edited, so "clear" rather than per-item editing is the right control here.
	 */
	private renderContextSettings(containerEl: HTMLElement): void {
		this.renderIntField(containerEl, 'Base model max context tokens', 'baseModelMaxContextTokens', 1000);
		this.renderIntField(containerEl, 'Compaction threshold (%)', 'compactionThresholdPercent', 1, 1, 100);
		this.renderIntField(containerEl, 'Reserved output tokens', 'reservedOutputTokens', 100);
		this.renderIntField(containerEl, 'Reserved system/tool tokens', 'reservedSystemToolTokens', 100);
		this.renderIntField(containerEl, 'Persistent memory max items', 'persistentMemoryMaxItems', 1);
		this.renderIntField(containerEl, 'Evidence cache max entries', 'evidenceCacheMaxEntries', 1);

		const memoryCount = this.plugin.settings.agentMemory.filter((m) => !m.supersededBy).length;
		new Setting(containerEl)
			.setName('Agent memory')
			.setDesc(`${memoryCount} active item${memoryCount === 1 ? '' : 's'} (${this.plugin.settings.agentMemory.length} total including superseded history).`)
			.addButton((btn) =>
				btn
					.setButtonText('Clear agent memory')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.agentMemory = [];
						await this.plugin.saveSettings();
						this.display();
					}),
			);
	}

	/** A plain integer field bound to a numeric key in settings, clamped to `[min, max]`. */
	private renderIntField(
		containerEl: HTMLElement,
		name: string,
		key: 'baseModelMaxContextTokens' | 'compactionThresholdPercent' | 'reservedOutputTokens' | 'reservedSystemToolTokens' | 'persistentMemoryMaxItems' | 'evidenceCacheMaxEntries',
		step: number,
		min = 0,
		max = Number.MAX_SAFE_INTEGER,
	): void {
		new Setting(containerEl)
			.setName(name)
			.addText((text) => {
				text.inputEl.type = 'number';
				text.inputEl.min = String(min);
				text.inputEl.max = String(max);
				text.inputEl.step = String(step);
				text
					.setValue(String(this.plugin.settings[key]))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						this.plugin.settings[key] = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : this.plugin.settings[key];
						await this.plugin.saveSettings();
					});
			});
	}
}
