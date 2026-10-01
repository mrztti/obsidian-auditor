import {
	GoogleGenAI,
	Type,
	type Content,
	type FunctionDeclaration,
	type GenerateContentResponse,
	type Schema,
} from '@google/genai';
import type { DraftStage } from './agent/types';
import type { WritingStyleProfile } from './settings';

export interface RerankedSnippet {
	index: number;
	/** The exact verbatim text from the snippet that is most relevant to the query. */
	excerpt: string;
	reason: string;
}

export interface RerankResult {
	/** The model's thought-summary text, surfaced so the user can see its reasoning. */
	thinking: string;
	/** A formal, direct answer to the user's query, synthesized from the relevant snippets. */
	response: string;
	relevant: RerankedSnippet[];
}

export interface StandardChunkSelection {
	index: number;
	/** Exact clause/control nomenclature as it appears in the standard (e.g. "6.2.1", "REQ-14"). */
	controlNumber: string;
	excerpt: string;
	reason: string;
}

export interface StandardReference {
	/** Name of the other standard referenced, as it appears in the text (e.g. "ETSI EN 319 401"). */
	standardName: string;
	/** Clause/control number within that standard, if given. */
	controlNumber: string;
	excerpt: string;
}

export interface TargetDocument {
	/** Descriptive name/topic of the document to look for (e.g. "Cryptographic Policy"). */
	file: string;
	/** Keywords/synonyms suited for embedding-based semantic search. */
	keywords: string[];
}

export interface ControlAnalysis {
	thinking: string;
	selected: StandardChunkSelection[];
	references: StandardReference[];
	targetDocuments: TargetDocument[];
	/** Concise summary of the exact document requirements to verify the control, carried forward as memory. */
	memorySummary: string;
}

const CONTROL_ANALYSIS_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		selected: {
			type: Type.ARRAY,
			description:
				'The snippets (by index) most relevant to understanding this control, most relevant first.',
			items: {
				type: Type.OBJECT,
				properties: {
					index: {
						type: Type.INTEGER,
						description: 'The [index] of the relevant snippet.',
					},
					controlNumber: {
						type: Type.STRING,
						description:
							'The exact clause/control nomenclature as it appears in the standard (e.g. "6.2.1", "REQ-14"). Empty string if none.',
					},
					excerpt: {
						type: Type.STRING,
						description:
							'The exact verbatim excerpt from the snippet defining the control.',
					},
					reason: {
						type: Type.STRING,
						description:
							'One sentence on why this snippet matters for understanding the control.',
					},
				},
				required: ['index', 'controlNumber', 'excerpt', 'reason'],
			},
		},
		references: {
			type: Type.ARRAY,
			description:
				'Any mentions, within the provided snippets, of OTHER standards being referenced/cited (e.g. "see ISO 27001 clause 5.3").',
			items: {
				type: Type.OBJECT,
				properties: {
					standardName: {
						type: Type.STRING,
						description:
							'Name of the other standard referenced, as it appears in the text.',
					},
					controlNumber: {
						type: Type.STRING,
						description:
							'Clause/control number within that standard, if given. Empty string if none.',
					},
					excerpt: {
						type: Type.STRING,
						description:
							'The exact verbatim excerpt containing the reference.',
					},
				},
				required: ['standardName', 'controlNumber', 'excerpt'],
			},
		},
		targetDocuments: {
			type: Type.ARRAY,
			description:
				'A comprehensive list of the kinds of evidence documents that will need to be inspected to verify this control.',
			items: {
				type: Type.OBJECT,
				properties: {
					file: {
						type: Type.STRING,
						description:
							'Descriptive name/topic of the document to look for, e.g. "Cryptographic Policy".',
					},
					keywords: {
						type: Type.ARRAY,
						description:
							'Keywords and synonyms for this document, suited for embedding-based semantic search.',
						items: { type: Type.STRING },
					},
				},
				required: ['file', 'keywords'],
			},
		},
		memorySummary: {
			type: Type.STRING,
			description:
				'A concise summary of the exact document requirements that must be verified with evidence in later steps.',
		},
	},
	required: ['selected', 'references', 'targetDocuments', 'memorySummary'],
};

export interface ResearchAssessment {
	thinking: string;
	progress: string;
	gaps: string[];
	/** Updated memory summary reflecting what has now been verified and what remains outstanding. */
	updatedMemory: string;
}

const RESEARCH_ASSESSMENT_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		progress: {
			type: Type.STRING,
			description:
				'A narrative summary of what has been verified so far against the requirements.',
		},
		gaps: {
			type: Type.ARRAY,
			description:
				'The requirements that are still missing evidence, listed concretely.',
			items: { type: Type.STRING },
		},
		updatedMemory: {
			type: Type.STRING,
			description:
				'An updated version of the requirements memory, reflecting what is now verified and what remains outstanding.',
		},
	},
	required: ['progress', 'gaps', 'updatedMemory'],
};

export interface FinalizationItem {
	index: number;
	/** What finding/content will be drawn from this document or existing control when drafting the report. */
	plannedFinding: string;
}

export interface FinalizationPlan {
	thinking: string;
	items: FinalizationItem[];
}

const FINALIZATION_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		items: {
			type: Type.ARRAY,
			description:
				'ONLY the documents/controls (by index) that are actually relevant enough to cite in the report. Omit every index that is not genuinely relevant — do not include an entry for every input.',
			items: {
				type: Type.OBJECT,
				properties: {
					index: {
						type: Type.INTEGER,
						description: 'The [index] of the document/control.',
					},
					plannedFinding: {
						type: Type.STRING,
						description:
							'A concise statement of what finding or content will be drawn from this document/control when drafting the report.',
					},
				},
				required: ['index', 'plannedFinding'],
			},
		},
	},
	required: ['items'],
};

export interface DraftedControl {
	thinking: string;
	standard: string;
	topic: string;
	/** The full Stage 1 conclusion block, following the writing rules exactly — Findings, Observations/Recommendations, and Evidence sub-parts all belong inside this one block. */
	todConclusion: string;
	/** C = conform, C* = conform but with observation, NC = non-conform with recommendation. */
	todRating: 'C' | 'C*' | 'NC';
}

const DRAFT_CONTROL_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		standard: {
			type: Type.STRING,
			description:
				'Name of the standard this control/requirement comes from, e.g. "ETSI TS 119 431-1".',
		},
		topic: {
			type: Type.STRING,
			description:
				'A short topic label for this control, e.g. "Device Management".',
		},
		todConclusion: {
			type: Type.STRING,
			description:
				'The full Test of Design conclusion block, following the writing rules exactly (Findings, then Observations/Recommendations, then Evidence, as sub-parts of this one block). Nothing except what the rules produce.',
		},
		todRating: {
			type: Type.STRING,
			enum: ['C', 'C*', 'NC'],
			description:
				'C = conform, no issues. C* = conform but with an observation/minor note. NC = non-conform, a recommendation is required.',
		},
	},
	required: [
		'standard',
		'topic',
		'todConclusion',
		'todRating',
	],
};

export interface DraftedStage2 {
	thinking: string;
	/** The full Stage 2 (Test of Effectiveness) conclusion block — same idea as `DraftedControl.todConclusion`: one piece of text containing whatever Findings/Observations-Recommendations/Evidence sub-parts the writing rules require. */
	toeConclusion: string;
	/** C = conform, C* = conform but with observation, NC = non-conform with recommendation. */
	toeRating: 'C' | 'C*' | 'NC';
}

const DRAFT_STAGE2_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		toeConclusion: {
			type: Type.STRING,
			description:
				'The full Test of Effectiveness conclusion block, following the writing rules exactly (Findings, then Observations/Recommendations, then Evidence, as sub-parts of this one block). Nothing except what the rules produce.',
		},
		toeRating: {
			type: Type.STRING,
			enum: ['C', 'C*', 'NC'],
			description:
				'C = conform, no issues. C* = conform but with an observation/minor note. NC = non-conform, a recommendation is required.',
		},
	},
	required: ['toeConclusion', 'toeRating'],
};

/** One stage's output from `prepareControlConclusion` — the dedicated conclusion-drafting tool (FR-2.1). Unlike `DraftedControl`/`DraftedStage2`, gaps are surfaced explicitly rather than silently folded into the conclusion text. */
export interface PreparedConclusionStage {
	stage: DraftStage;
	conclusionText: string;
	rating: 'C' | 'C*' | 'NC';
	/** What was taken as given because it was not explicit in the evidence provided. */
	assumptions: string[];
	/** Evidence gaps or open questions NOT resolved by what was given — never folded silently into "satisfied". */
	unresolvedIssues: string[];
}

const PREPARED_CONCLUSION_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		stages: {
			type: Type.ARRAY,
			description: 'Exactly one entry per stage requested.',
			items: {
				type: Type.OBJECT,
				properties: {
					stage: { type: Type.STRING, enum: ['stage1', 'stage2'] },
					conclusionText: { type: Type.STRING, description: 'The full conclusion block for this stage, following the writing rules exactly.' },
					rating: { type: Type.STRING, enum: ['C', 'C*', 'NC'], description: 'C = conform, no issues. C* = conform but with an observation/minor note. NC = non-conform, a recommendation is required.' },
					assumptions: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'What was taken as given because it was not explicit in the evidence provided. Empty array if genuinely none.' },
					unresolvedIssues: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Evidence gaps or open questions NOT resolved by what was given — never silently treated as satisfied. Empty array only if genuinely none.' },
				},
				required: ['stage', 'conclusionText', 'rating', 'assumptions', 'unresolvedIssues'],
			},
		},
	},
	required: ['stages'],
};

/** One item submitted to `qaReviewConclusionsBatch` — see `qa_review_conclusions_batch` (FR-3.2). */
export interface QaBatchItemInput {
	controlId: string;
	stage: DraftStage;
	conclusionText: string;
	rating: string;
	evidenceReferences: string[];
}

/** One item's result from `qaReviewConclusionsBatch`. */
export interface QaBatchItemResult {
	controlId: string;
	stage: DraftStage;
	pass: boolean;
	correctedConclusionText: string;
	correctedRating: string;
	/** Specific issues found (evidence alignment, unsupported claims, structure, style, prohibited wording, reference correctness) — empty only if genuinely none. */
	findings: string[];
}

const QA_BATCH_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		results: {
			type: Type.ARRAY,
			description: 'Exactly one entry per item reviewed, in the same order.',
			items: {
				type: Type.OBJECT,
				properties: {
					controlId: { type: Type.STRING, description: 'Copied exactly from the item reviewed.' },
					stage: { type: Type.STRING, enum: ['stage1', 'stage2'] },
					pass: { type: Type.BOOLEAN },
					correctedConclusionText: { type: Type.STRING, description: 'The conclusion text, corrected if anything needed to change — identical to the input text if nothing did. Never blank.' },
					correctedRating: { type: Type.STRING, description: 'The rating, corrected if needed — identical to the input rating if nothing needed to change. Never blank.' },
					findings: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Specific issues found. Empty array only if genuinely none.' },
				},
				required: ['controlId', 'stage', 'pass', 'correctedConclusionText', 'correctedRating', 'findings'],
			},
		},
	},
	required: ['results'],
};

// ─── Rapid Fire (Epic 8) ────────────────────────────────────────────────────

export interface SimilarityBatchAssignment {
	controlNumber: string;
	batchLabel: string;
	/** One sentence: why this control landed in this batch — kept for the "explanation" guardrail (FR-8.3), not just a label. */
	reason: string;
}

export interface SimilarityBatchPlan {
	thinking: string;
	batchLabels: string[];
	/** Terms genuinely shared by a batch's controls — explicitly NOT generic words like "documented"/"reviewed"/"approved" (guarded against in the prompt). */
	sharedTermsByBatch: Record<string, string[]>;
	assignments: SimilarityBatchAssignment[];
}

const SIMILARITY_BATCH_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		batchLabels: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Final, deduplicated set of topic-batch labels in use.' },
		sharedTermsByBatch: {
			type: Type.ARRAY,
			description: 'One entry per batch label, listing the specific shared terms (framework section, technology, process, evidence type — never generic words like "documented"/"reviewed"/"approved") that justify grouping its controls.',
			items: {
				type: Type.OBJECT,
				properties: {
					batchLabel: { type: Type.STRING },
					terms: { type: Type.ARRAY, items: { type: Type.STRING } },
				},
				required: ['batchLabel', 'terms'],
			},
		},
		assignments: {
			type: Type.ARRAY,
			description: 'Exactly one entry per control given.',
			items: {
				type: Type.OBJECT,
				properties: {
					controlNumber: { type: Type.STRING },
					batchLabel: { type: Type.STRING, description: 'One of batchLabels.' },
					reason: { type: Type.STRING, description: 'One sentence: specifically why this control fits this batch (shared section/technology/process/evidence type) — never just "similar topic".' },
				},
				required: ['controlNumber', 'batchLabel', 'reason'],
			},
		},
	},
	required: ['batchLabels', 'sharedTermsByBatch', 'assignments'],
};

export interface ExtractedEvidenceFact {
	text: string;
	sourcePath: string;
	location: string;
	/** Every control number (from this batch) this fact actually supports — never assigned by topic similarity alone (FR-8.4's critical rule). */
	controlNumbers: string[];
	stages: DraftStage[];
}

export interface ThemeEvidenceExtraction {
	thinking: string;
	facts: ExtractedEvidenceFact[];
	/** Per control number, anything the batch's retrieved evidence does NOT cover — carried into drafting as an honest gap, never silently dropped. */
	unresolvedQuestions: string[];
}

const THEME_EVIDENCE_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		facts: {
			type: Type.ARRAY,
			description: 'Discrete evidence facts extracted from the retrieved snippets, each explicitly mapped to the control(s)/stage(s) it actually supports.',
			items: {
				type: Type.OBJECT,
				properties: {
					text: { type: Type.STRING, description: 'The fact itself, concisely, in your own words — not a copy of the whole snippet.' },
					sourcePath: { type: Type.STRING, description: 'Exact file path of the snippet this came from.' },
					location: { type: Type.STRING, description: 'Page/line/section within that file, if given in the snippet label.' },
					controlNumbers: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'ONLY controls (from this batch) this specific fact actually supports — never every control in the batch just because they share a topic.' },
					stages: { type: Type.ARRAY, items: { type: Type.STRING, enum: ['stage1', 'stage2'] }, description: 'Which stage(s) this fact is relevant to.' },
				},
				required: ['text', 'sourcePath', 'location', 'controlNumbers', 'stages'],
			},
		},
		unresolvedQuestions: {
			type: Type.ARRAY,
			items: { type: Type.STRING },
			description: 'What this batch\'s controls need that the retrieved evidence does not cover — be specific, e.g. "C-4.2.1: no evidence found of the change-approval workflow". Empty array only if genuinely none.',
		},
	},
	required: ['facts', 'unresolvedQuestions'],
};

export interface BatchDraftItemInput {
	controlNumber: string;
	stage: DraftStage;
	controlText: string;
	priorConclusion: string;
}

export interface BatchDraftItemResult {
	controlNumber: string;
	stage: DraftStage;
	conclusionText: string;
	rating: string;
	assumptions: string[];
	unresolvedIssues: string[];
}

const BATCH_DRAFT_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		results: {
			type: Type.ARRAY,
			description: 'Exactly one entry per requested (controlNumber, stage) item — never merged, never omitted.',
			items: {
				type: Type.OBJECT,
				properties: {
					controlNumber: { type: Type.STRING, description: 'Copied exactly from the request.' },
					stage: { type: Type.STRING, enum: ['stage1', 'stage2'] },
					conclusionText: { type: Type.STRING, description: 'The full conclusion block for this control/stage, following the writing rules exactly. Built only from the evidence facts given for THIS control — never a fact mapped to a different control, even in the same batch.' },
					rating: { type: Type.STRING, enum: ['C', 'C*', 'NC'] },
					assumptions: { type: Type.ARRAY, items: { type: Type.STRING } },
					unresolvedIssues: { type: Type.ARRAY, items: { type: Type.STRING } },
				},
				required: ['controlNumber', 'stage', 'conclusionText', 'rating', 'assumptions', 'unresolvedIssues'],
			},
		},
	},
	required: ['results'],
};

export interface ControlGroupAssignment {
	controlNumber: string;
	/** Exact title of a group in `groups` below (either an existing one reused, or one newly proposed). */
	groupTitle: string;
}

export interface ControlGroupingPlan {
	thinking: string;
	/** The deduplicated, final set of group titles in use — existing ones reused plus any newly proposed. */
	groups: string[];
	assignments: ControlGroupAssignment[];
}

const CONTROL_GROUPING_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		groups: {
			type: Type.ARRAY,
			items: { type: Type.STRING },
			description: 'The final, deduplicated set of domain/topic group titles in use (existing titles reused verbatim, plus any new ones proposed). Every title an assignment below uses must appear here.',
		},
		assignments: {
			type: Type.ARRAY,
			description: 'Exactly one entry per control given, assigning it to one of the group titles above.',
			items: {
				type: Type.OBJECT,
				properties: {
					controlNumber: { type: Type.STRING, description: 'Exact control number, copied from the input.' },
					groupTitle: { type: Type.STRING, description: 'The exact title (from `groups` above) this control belongs to.' },
				},
				required: ['controlNumber', 'groupTitle'],
			},
		},
	},
	required: ['groups', 'assignments'],
};

export interface GroupEvidenceGoalDecision {
	action: 'create' | 'link' | 'modify_and_link';
	/** Existing EG's ID, for "link"/"modify_and_link". Empty for "create". */
	targetId: string;
	/** Every control number (from this batch) this one decision covers — a decision covers more than one control only when they genuinely need the exact same screenshot/file. */
	controlNumbers: string[];
	/** New/replacement fields, for "create"/"modify_and_link". Empty/unused for "link". */
	name: string;
	description: string;
	questions: string[];
	type: 'screenshot' | 'file';
}

export interface GroupEvidenceGoalPlan {
	thinking: string;
	/** Every control given must be covered by at least one decision's `controlNumbers`; a control needing several distinct pieces of evidence gets covered by several decisions. */
	decisions: GroupEvidenceGoalDecision[];
}

const GROUP_EVIDENCE_GOAL_DECISION_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		action: {
			type: Type.STRING,
			enum: ['create', 'link', 'modify_and_link'],
			description: '"link" if an existing EG already covers this piece of evidence as-is; "modify_and_link" if one is a close-enough fit once broadened; "create" if none are a reasonable fit.',
		},
		targetId: {
			type: Type.STRING,
			description: 'The existing EG\'s ID, for "link"/"modify_and_link". Empty string for "create".',
		},
		controlNumbers: {
			type: Type.ARRAY,
			items: { type: Type.STRING },
			description: 'Every control (from this batch) this decision covers. Almost always one; more than one only when they genuinely need the exact same evidence.',
		},
		name: {
			type: Type.STRING,
			description: 'The (new, or replacement) EG name. Empty string for "link".',
		},
		description: {
			type: Type.STRING,
			description: 'What exactly should be captured and why it matters, covering every control this EG applies to. Empty string for "link".',
		},
		questions: {
			type: Type.ARRAY,
			items: { type: Type.STRING },
			description: 'Questions the auditor should ask the interviewee to prompt them into showing/navigating to the evidence. Empty array for "link".',
		},
		type: {
			type: Type.STRING,
			enum: ['screenshot', 'file'],
			description: 'Almost always "screenshot"; "file" only when a screenshot genuinely cannot capture the evidence. Empty/ignored for "link".',
		},
	},
	required: ['action', 'targetId', 'controlNumbers', 'name', 'description', 'questions', 'type'],
};

const GROUP_EVIDENCE_GOAL_PLAN_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		decisions: {
			type: Type.ARRAY,
			description: 'Every decision needed to cover every control in this batch. Most controls need exactly one decision; only add more per control when it genuinely requires separate, distinct screenshots/files.',
			items: GROUP_EVIDENCE_GOAL_DECISION_SCHEMA,
		},
	},
	required: ['decisions'],
};

export interface EvidenceGoalFinalizationEntry {
	/** One id: refine that EG's questions/description in place. Two or more: merge them into one, with the fields below. */
	sourceIds: string[];
	name: string;
	description: string;
	questions: string[];
	type: 'screenshot' | 'file';
}

export interface EvidenceGoalFinalizationPlan {
	thinking: string;
	/** Only EGs actually being changed (merged and/or refined); anything not listed is left exactly as planned. */
	entries: EvidenceGoalFinalizationEntry[];
}

const EVIDENCE_GOAL_FINALIZATION_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		entries: {
			type: Type.ARRAY,
			description: 'Only the evidence goals being changed — merged (2+ sourceIds) and/or refined in place (1 sourceId). Omit any EG that needs neither.',
			items: {
				type: Type.OBJECT,
				properties: {
					sourceIds: {
						type: Type.ARRAY,
						items: { type: Type.STRING },
						description: 'IDs of the evidence goals being merged (2 or more).',
					},
					name: { type: Type.STRING, description: 'The merged EG\'s name.' },
					description: { type: Type.STRING, description: 'The merged EG\'s description, correctly covering every control all merged EGs covered.' },
					questions: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'The merged EG\'s questions.' },
					type: { type: Type.STRING, enum: ['screenshot', 'file'], description: 'The merged EG\'s type.' },
				},
				required: ['sourceIds', 'name', 'description', 'questions', 'type'],
			},
		},
	},
	required: ['entries'],
};

export interface EvidenceGoalDomainGroup {
	title: string;
	evidenceGoalIds: string[];
}

export interface EvidenceGoalGroupingPlan {
	thinking: string;
	groups: EvidenceGoalDomainGroup[];
}

const EVIDENCE_GOAL_GROUPING_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		groups: {
			type: Type.ARRAY,
			description: 'Domain/topic groups (e.g. "Access Control", "Change Management", "Cryptography") that organize the session\'s evidence goals for the interview. Every evidence goal must appear in exactly one group.',
			items: {
				type: Type.OBJECT,
				properties: {
					title: { type: Type.STRING, description: 'Short, specific domain/topic name for this group.' },
					evidenceGoalIds: {
						type: Type.ARRAY,
						items: { type: Type.STRING },
						description: 'IDs of the evidence goals that belong to this group.',
					},
				},
				required: ['title', 'evidenceGoalIds'],
			},
		},
	},
	required: ['groups'],
};

const RERANK_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		response: {
			type: Type.STRING,
			description:
				"A formal, direct answer to the user's query, synthesized from the relevant snippets. Presented to the user before the snippets themselves.",
		},
		relevant: {
			type: Type.ARRAY,
			description:
				'The snippets (by index) that are actually relevant to the query, most relevant first.',
			items: {
				type: Type.OBJECT,
				properties: {
					index: {
						type: Type.INTEGER,
						description: 'The [index] of the relevant snippet.',
					},
					excerpt: {
						type: Type.STRING,
						description:
							'The exact verbatim text copied from within the snippet that is most relevant to the query — not a summary or paraphrase, an exact substring of the snippet.',
					},
					reason: {
						type: Type.STRING,
						description:
							'One sentence on why this excerpt is relevant.',
					},
				},
				required: ['index', 'excerpt', 'reason'],
			},
		},
	},
	required: ['response', 'relevant'],
};

/** Thin wrapper around Gemini's generateContent, used for every LLM step across the plugin. */
export class GeminiGenerate {
	private ai: GoogleGenAI;
	private model: string;

	constructor(apiKey: string, model: string) {
		this.ai = new GoogleGenAI({ apiKey });
		this.model = model;
	}

	private async generate(
		prompt: string,
		model: string = this.model,
	): Promise<string> {
		const response = await this.ai.models.generateContent({
			model,
			contents: prompt,
		});
		const text = response.text;
		if (!text) throw new Error('Gemini returned an empty response.');
		return text.trim();
	}

	/**
	 * Runs a structured-output call, returning the parsed JSON plus the thought summary (empty when
	 * `includeThinking` is false) and the raw token-usage metadata Gemini reports for this call —
	 * callers that want it tracked (e.g. a tool calling `ctx.recordUsage`) read it off `usage`;
	 * callers that don't just destructure `{ thinking, parsed }` as before, unaffected by this field.
	 */
	private async generateStructured<T>(
		prompt: string,
		schema: Schema,
		model: string = this.model,
		includeThinking = true,
	): Promise<{ thinking: string; parsed: T; usage: GenerateContentResponse['usageMetadata'] }> {
		const response = await this.ai.models.generateContent({
			model,
			contents: prompt,
			config: {
				responseMimeType: 'application/json',
				responseSchema: schema,
				...(includeThinking
					? { thinkingConfig: { includeThoughts: true } }
					: {}),
			},
		});

		const thinking = (response.candidates?.[0]?.content?.parts ?? [])
			.filter((p) => p.thought && p.text)
			.map((p) => p.text)
			.join('\n');

		const text = response.text;
		if (!text) throw new Error('Gemini returned no structured output.');
		return { thinking, parsed: JSON.parse(text) as T, usage: response.usageMetadata };
	}

	/** Turns a free-text prompt into a keyword-dense description suited for vector-store retrieval. */
	async generateSearchKeywords(prompt: string): Promise<string> {
		const fullPrompt = [
			'You are helping search a vector database of documents.',
			"Given the user's prompt below, write a short, keyword-dense description of what to",
			'look for — the concepts, terms, and phrases most likely to appear in relevant passages.',
			'Reply with only the description text, no preamble.',
			'',
			'User prompt:',
			prompt,
		].join('\n');
		return this.generate(fullPrompt);
	}

	/**
	 * Has Gemini decide which retrieved snippets actually answer the query, using thinking and a
	 * structured (JSON-schema) response so the result is reliably parseable.
	 */
	async rerankSnippets(
		query: string,
		snippets: { index: number; label: string; text: string }[],
	): Promise<RerankResult> {
		const snippetsBlock = snippets
			.map((s) => `[${s.index}] Source: ${s.label}\n${s.text}`)
			.join('\n\n');
		const prompt = [
			'You are helping an auditor find the most relevant passages in a document vector database.',
			'Given the query and the retrieved snippets below, decide which snippets are actually',
			'relevant to the query. Exclude snippets that are only superficially/keyword-similar but',
			'do not actually answer the query.',
			'',
			'For each relevant snippet, copy out the exact verbatim excerpt — a direct substring of',
			"that snippet's text, not a summary or paraphrase — that most directly answers the query,",
			'and briefly explain why it is relevant.',
			'',
			'Also write a formal, direct answer to the query itself, synthesized from the relevant',
			'snippets, as if answering the auditor directly. This is shown to the user before the',
			'snippets, so it should stand on its own.',
			'',
			`Query: ${query}`,
			'',
			'Snippets:',
			snippetsBlock,
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<{
			response: string;
			relevant: RerankedSnippet[];
		}>(prompt, RERANK_SCHEMA);
		return {
			thinking,
			response: parsed.response,
			relevant: parsed.relevant,
		};
	}

	/**
	 * Step 1 of the control-drafting pipeline: given the retrieved standards snippets, has Gemini
	 * select the ones that matter, extract their exact clause/control nomenclature, pull out any
	 * inline references to other standards, and plan the evidence documents to look for next.
	 */
	async analyzeControl(
		controlInput: string,
		snippets: { index: number; label: string; text: string }[],
	): Promise<ControlAnalysis> {
		const snippetsBlock = snippets
			.map((s) => `[${s.index}] Source: ${s.label}\n${s.text}`)
			.join('\n\n');
		const prompt = [
			'You are an auditor building an understanding of an audit control before drafting it.',
			'Given the control/requirement below and the retrieved standards snippets, select the',
			'snippets that matter for understanding this control. For each, extract the exact clause',
			'or control nomenclature as it appears in the standard (e.g. "6.2.1", "REQ-14") and the',
			'verbatim excerpt defining it.',
			'',
			'Separately, scan all snippets for any inline references to OTHER standards being cited',
			'(e.g. "see ISO 27001 clause 5.3", "as defined in ETSI EN 319 401") and extract those as',
			'references, with a verbatim excerpt of the citation.',
			'',
			'Then, build a comprehensive list of the kinds of evidence documents that will need to be',
			'inspected to verify this control (e.g. policies, configurations, logs), each with a list',
			'of keywords and synonyms. This list will be used to run embedding-based semantic search',
			'against a vector database of evidence documents, so be comprehensive: include synonyms,',
			'related terminology, and adjacent concepts an auditor might phrase differently.',
			'',
			'Finally, write a concise memory summary listing the exact document requirements that',
			'must be verified with evidence in later steps — this will be carried forward as your own',
			'memory into the next request.',
			'',
			`Control / requirement: ${controlInput}`,
			'',
			'Snippets:',
			snippetsBlock,
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<
			Omit<ControlAnalysis, 'thinking'>
		>(prompt, CONTROL_ANALYSIS_SCHEMA);
		return { thinking, ...parsed };
	}

	/**
	 * Assesses research progress against the memory summary from `analyzeControl`, given evidence
	 * findings gathered so far, and identifies what's still missing. When `refinement` is given
	 * (a "retry with feedback"), the model is also shown its own previous assessment plus the
	 * auditor's feedback, and asked to refine rather than start over.
	 */
	async assessResearchProgress(
		memorySummary: string,
		findingsText: string,
		refinement?: {
			previousProgress: string;
			previousGaps: string[];
			userFeedback: string;
		},
	): Promise<ResearchAssessment> {
		const prompt = [
			'You are an auditor tracking research progress while gathering evidence for a control.',
			'Below is your own memory summary of the document requirements that must be verified,',
			'followed by the evidence findings gathered so far from a vector database search.',
			'',
			'Assess current progress: what has been verified by the findings, and what is still',
			'missing. List the missing items concretely as gaps. Then write an updated memory summary',
			'reflecting the current state (what remains outstanding), to carry forward.',
			'',
			...(refinement
				? [
						"This is a refinement of your own previous assessment. Take the auditor's feedback",
						'into account and adjust your progress/gaps/memory accordingly rather than starting over.',
						'',
						'Your previous progress assessment:',
						refinement.previousProgress,
						'',
						'Your previous gaps:',
						refinement.previousGaps.join('\n') || '(none)',
						'',
						"Auditor's feedback:",
						refinement.userFeedback,
						'',
					]
				: []),
			'Memory summary:',
			memorySummary,
			'',
			'Evidence findings:',
			findingsText || '(no findings)',
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<
			Omit<ResearchAssessment, 'thinking'>
		>(prompt, RESEARCH_ASSESSMENT_SCHEMA);
		return { thinking, ...parsed };
	}

	/** Drafts a search query to run against the evidence vector store, given the understood control. */
	async synthesizeEvidenceQuery(
		controlUnderstanding: string,
	): Promise<string> {
		const prompt = [
			'You are helping an auditor find evidence for a control requirement.',
			'Given the control understanding below, write a single, concise search query',
			'(a few sentences at most) that would retrieve relevant evidence documents',
			'from a vector database of audit evidence. Reply with only the query text.',
			'',
			'Control understanding:',
			controlUnderstanding,
		].join('\n');
		return this.generate(prompt);
	}

	/**
	 * Finalizing step: given everything gathered so far (evidence + selected existing controls),
	 * has Gemini plan, per document/control, what finding will actually be drawn from it when
	 * drafting the report — shown to the auditor as a checklist before the draft is generated.
	 */
	async planFinalization(
		controlUnderstanding: string,
		items: {
			index: number;
			label: string;
			kind: 'evidence' | 'control';
			text: string;
		}[],
	): Promise<FinalizationPlan> {
		const itemsBlock = items
			.map((it) => `[${it.index}] (${it.kind}) ${it.label}\n${it.text}`)
			.join('\n\n');
		const prompt = [
			'You are an auditor preparing to draft a control report.',
			'Given the control understanding and the documents/controls gathered below (evidence',
			'documents, and existing written controls used as style reference), identify ONLY the',
			'ones that are genuinely relevant enough to cite as a finding in the report.',
			'',
			'Be strict and as selective as possible: most retrieved documents are noise. Exclude',
			'anything redundant, tangential, or only superficially related. If two documents would',
			'support the same finding, keep only the stronger one. Do not include an entry for every',
			'input — omit the index entirely for anything not relevant. Aim for the smallest possible',
			'set of documents that still fully supports the report.',
			'',
			'For each document/control you DO keep, by index, state concretely what finding or content',
			'will actually be drawn from it when the report is drafted. This is a planning step shown',
			'to the auditor before drafting, so they can decide what to include.',
			'',
			'Control understanding:',
			controlUnderstanding,
			'',
			'Documents/controls:',
			itemsBlock,
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<
			Omit<FinalizationPlan, 'thinking'>
		>(prompt, FINALIZATION_SCHEMA);
		return { thinking, ...parsed };
	}

	/**
	 * Drafts the Test of Design conclusion block + rating from the accumulated, user-curated
	 * retrieval context, strictly following the given writing rules for phrasing, and separately
	 * identifies the standard + topic for the control record's own fields.
	 */
	async draftControl(
		controlUnderstanding: string,
		evidenceContext: string,
		similarControlsContext: string,
		writingRules: string,
		guidance: string,
	): Promise<DraftedControl> {
		const prompt = [
			'You are an auditor drafting the Test of Design conclusion for a control.',
			'Use the control understanding, the evidence found in the vault, and the style of',
			'previously written controls to draft it.',
			'',
			'You MUST follow the writing rules below exactly for phrasing and structure. The',
			'"todConclusion" field is the ENTIRE conclusion block as one piece of text — it must',
			'contain all of the sub-parts the writing rules define (e.g. Findings, then',
			'Observations/Recommendations, then Evidence), each properly labeled within that single',
			'block exactly as the rules specify. Do not split these into separate fields or omit any',
			'sub-part the rules require.',
			'',
			'Decide the todRating: "C" if fully conform with no issues, "C*" if conform but with a',
			'minor observation, "NC" if a non-conformity requiring a recommendation was found.',
			'',
			'Also identify the name of the standard this control/requirement comes from, and a short',
			'topic label for it (e.g. "Device Management"), from the control understanding below.',
			'',
			'Writing rules:',
			writingRules,
			'',
			...(guidance
				? [
						'Additional guidance for finalizing this report:',
						guidance,
						'',
					]
				: []),
			'Control understanding:',
			controlUnderstanding,
			'',
			'Evidence:',
			evidenceContext || '(none selected)',
			'',
			'Similar previously written controls (style reference):',
			similarControlsContext || '(none selected)',
			'',
			'Draft the Test of Design assessment now, following the writing rules exactly.',
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<
			Omit<DraftedControl, 'thinking'>
		>(prompt, DRAFT_CONTROL_SCHEMA);
		return { thinking, ...parsed };
	}

	/**
	 * Drafts the Test of Effectiveness (Stage 2) conclusion block + rating for a control that
	 * already has its Stage 1 conclusion written. Unlike `draftControl`, the citable evidence here
	 * comes from interview evidence (not general audit evidence) plus other related written
	 * controls; supporting standards are also fetched via RAG, but purely so the model understands
	 * the requirement — never the standards/evidence stores as *evidence* for the conclusion.
	 */
	async draftStage2Control(
		controlText: string,
		stage1Context: string,
		standardsContext: string,
		interviewEvidenceContext: string,
		relatedControlsContext: string,
		writingRules: string,
		guidance: string,
	): Promise<DraftedStage2> {
		const prompt = [
			'You are an auditor drafting the Test of Effectiveness (Stage 2) conclusion for a control',
			'that has already passed Test of Design. Test of Effectiveness verifies, via interview',
			'evidence, that the control actually operates as designed in practice.',
			'',
			'You MUST follow the writing rules below exactly for phrasing and structure. The',
			'"toeConclusion" field is the ENTIRE conclusion block as one piece of text — it must',
			'contain all of the sub-parts the writing rules define (e.g. Findings, then',
			'Observations/Recommendations, then Evidence), each properly labeled within that single',
			'block exactly as the rules specify. Do not split these into separate fields or omit any',
			'sub-part the rules require.',
			'',
			'Decide the toeRating: "C" if fully conform with no issues, "C*" if conform but with a',
			'minor observation, "NC" if a non-conformity requiring a recommendation was found.',
			'',
			'The supporting standards below are given ONLY so you correctly understand what the control',
			'requires — never cite them as evidence in the Evidence section; only interview evidence and',
			'related controls may be cited there.',
			'',
			'Writing rules:',
			writingRules,
			'',
			...(guidance
				? [
						'Additional guidance for finalizing this report:',
						guidance,
						'',
					]
				: []),
			'Control:',
			controlText,
			'',
			'Stage 1 (Test of Design) conclusion, for context:',
			stage1Context || '(none)',
			'',
			'Supporting standards (context only, not citable evidence):',
			standardsContext || '(none selected)',
			'',
			'Interview evidence:',
			interviewEvidenceContext || '(none selected)',
			'',
			'Related previously written controls (style reference):',
			relatedControlsContext || '(none selected)',
			'',
			'Draft the Test of Effectiveness conclusion now, following the writing rules exactly.',
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<
			Omit<DraftedStage2, 'thinking'>
		>(prompt, DRAFT_STAGE2_SCHEMA);
		return { thinking, ...parsed };
	}

	/** One stage's drafted conclusion, as produced by `prepareControlConclusion` — see `prepare_control_conclusion` (src/agent/tools/conclusion.ts), the chat agent's dedicated drafting tool. */
	async prepareControlConclusion(
		controlText: string,
		stages: DraftStage[],
		cachedEvidenceContext: string,
		priorConclusion: string,
		requestedChanges: string[],
		writingRules: string,
		guidance: string,
		model?: string,
	): Promise<{ thinking: string; stages: PreparedConclusionStage[]; usage: GenerateContentResponse['usageMetadata'] }> {
		const stageInstructions: Record<DraftStage, string> = {
			stage1: 'Stage 1 (Test of Design) verifies the control is correctly DESIGNED — that policy/configuration establishes it, from general audit evidence.',
			stage2: 'Stage 2 (Test of Effectiveness) verifies the control actually OPERATES as designed in practice, from interview evidence/walkthroughs.',
		};
		const prompt = [
			'You are an auditor drafting one or more conclusions for a single control, via a dedicated',
			'conclusion-generation tool rather than free-form prompting. Produce exactly one entry in',
			'"stages" for each stage requested below — independent of each other, each with its own',
			'conclusionText and rating.',
			'',
			...stages.map((s) => stageInstructions[s]),
			'',
			'You MUST follow the writing rules below exactly for phrasing and structure. Each',
			'conclusionText is the ENTIRE conclusion block as one piece of text — it must contain all of',
			'the sub-parts the writing rules define (e.g. Findings, then Observations/Recommendations,',
			'then Evidence), each properly labeled within that single block exactly as the rules specify.',
			'',
			'Decide each rating: "C" if fully conform with no issues, "C*" if conform but with a minor',
			'observation, "NC" if a non-conformity requiring a recommendation was found.',
			'',
			'CRITICAL: never treat missing or absent evidence as satisfactory. If the evidence below does',
			'not actually cover something the control requires, that is a gap — list it in',
			'unresolvedIssues for that stage, and let it inform (do not silently ignore it for) the',
			'rating. List in assumptions anything you had to take as given because it was not explicit in',
			'what was provided (e.g. "assumed the named policy document is still current"). Both arrays',
			'must be empty only when genuinely nothing applies — never omit a known gap to look complete.',
			'',
			'Writing rules:',
			writingRules,
			'',
			...(guidance ? ['Additional guidance for this control:', guidance, ''] : []),
			'Control:',
			controlText,
			'',
			...(priorConclusion ? ['Prior conclusion (for context, e.g. when revising):', priorConclusion, ''] : []),
			...(requestedChanges.length > 0
				? ['Specific changes requested for this revision — address every one of these:', requestedChanges.map((c) => `- ${c}`).join('\n'), '']
				: []),
			'Evidence gathered for this control (already retrieved — do not invent anything beyond this):',
			cachedEvidenceContext || '(none provided)',
			'',
			'Draft the requested stage(s) now, following the writing rules exactly.',
		].join('\n');

		const { thinking, parsed, usage } = await this.generateStructured<{ stages: PreparedConclusionStage[] }>(prompt, PREPARED_CONCLUSION_SCHEMA, model ?? this.model);
		return { thinking, stages: parsed.stages, usage };
	}

	/**
	 * One control+stage's batched QA result, as produced by `qaReviewConclusionsBatch` — see
	 * `qa_review_conclusions_batch` (src/agent/tools/qaBatch.ts). `writingRules` is the SAME
	 * `defaultWritingRules`/`defaultStage2WritingRules` settings the drafting pipeline and
	 * `prepareControlConclusion` already use — QA never gets its own separate copy of the rules, so
	 * there is exactly one place they're maintained.
	 */
	async qaReviewConclusionsBatch(
		items: QaBatchItemInput[],
		writingRules: { stage1: string; stage2: string },
		profile: WritingStyleProfile,
		model?: string,
	): Promise<{ thinking: string; results: QaBatchItemResult[]; usage: GenerateContentResponse['usageMetadata'] }> {
		const stagesPresent = new Set(items.map((it) => it.stage));
		const rulesBlock = [
			stagesPresent.has('stage1') ? `Stage 1 (Test of Design) writing rules:\n${writingRules.stage1}` : '',
			stagesPresent.has('stage2') ? `Stage 2 (Test of Effectiveness) writing rules:\n${writingRules.stage2}` : '',
		].filter(Boolean).join('\n\n') || '(no rules configured)';
		const prohibitedBlock = profile.prohibitedWording.length > 0
			? profile.prohibitedWording.join(', ')
			: '(none configured)';
		const itemsBlock = items
			.map((it, i) => [
				`[${i}] Control ${it.controlId} — ${it.stage}`,
				`Rating: ${it.rating}`,
				`Evidence references: ${it.evidenceReferences.join(', ') || '(none listed)'}`,
				'Conclusion text:',
				it.conclusionText,
			].join('\n'))
			.join('\n\n');

		const prompt = [
			`You are independently QA-reviewing a batch of ${items.length} drafted audit conclusion(s)`,
			`against the configured writing-style profile "${profile.name}" (version ${profile.version}).`,
			'This is a genuine, separate check — not a restatement of the draft. For EACH item, by its',
			'[index], verify:',
			'- Evidence alignment: every claim is actually supported by the listed evidence references.',
			'- No unsupported claims: nothing stated as fact beyond what the evidence references show.',
			'- Internal consistency: the rating matches what the conclusion text itself describes.',
			'- Required structure: the conclusion follows the writing rules\' required structure exactly.',
			'- Style: tone/phrasing matches the configured rules below.',
			'- Prohibited wording: flag (and remove/rephrase in the corrected text) any use of the',
			'  prohibited words/phrases below, case-insensitive.',
			'- Control/evidence-reference correctness: the control id is right and every evidence',
			'  reference cited in the text is one of the ones listed for that item (never invented).',
			'',
			'Do not do new research — only use what is given per item. If evidence is genuinely',
			'insufficient to judge an item, say so in its findings and fail it; do not guess.',
			'',
			'For each item, return pass/fail, a corrected version of the conclusion text and rating (the',
			'SAME text/rating as the input when nothing needed to change — never leave these blank), and',
			'the specific findings that justify the verdict (empty array only if genuinely none).',
			'',
			'Writing-style rules:',
			rulesBlock,
			'',
			'Prohibited wording:',
			prohibitedBlock,
			'',
			'Items to review:',
			itemsBlock,
		].join('\n');

		const { thinking, parsed, usage } = await this.generateStructured<{ results: QaBatchItemResult[] }>(prompt, QA_BATCH_SCHEMA, model ?? this.model);
		return { thinking, results: parsed.results, usage };
	}

	/**
	 * Rapid Fire Phase 1 (FR-8.3): groups a potentially large set of controls into bounded topic
	 * batches using semantic + deterministic signal (framework section, family, technology, process,
	 * evidence type, requested stage) — guarded against grouping purely on generic words like
	 * "documented"/"reviewed"/"approved". Token-budget splitting (FR-8.3's "split a batch when its
	 * combined context exceeds the available token budget") is done by the caller from
	 * `estimatedContextTokens`, not here — the model only proposes topic coherence.
	 */
	async buildSimilarityBatches(
		controls: { number: string; standard: string; topic: string; control: string; stages: DraftStage[] }[],
		model?: string,
	): Promise<{ thinking: string; plan: SimilarityBatchPlan; usage: GenerateContentResponse['usageMetadata'] }> {
		const controlsBlock = controls
			.map((c) => `[${c.number}] ${c.standard}${c.topic ? ` — ${c.topic}` : ''} (${c.stages.join('+')})\n${c.control}`)
			.join('\n\n');
		const prompt = [
			'You are building bounded topic batches of audit controls so they can later share research',
			'and QA context efficiently. Group controls that genuinely share a framework section, control',
			'family, technology, process, or evidence type — NOT merely because their text contains the',
			'same generic words (e.g. "documented", "reviewed", "approved" prove nothing on their own).',
			'',
			'Every assignment needs its own one-sentence reason naming the SPECIFIC shared signal (e.g.',
			'"both require evidence of quarterly access reviews"), not a vague "similar topic".',
			'',
			'Controls to batch (number, standard/topic, requested stage(s), text):',
			controlsBlock,
		].join('\n');

		const { thinking, parsed, usage } = await this.generateStructured<Omit<SimilarityBatchPlan, 'thinking' | 'sharedTermsByBatch'> & { sharedTermsByBatch: { batchLabel: string; terms: string[] }[] }>(prompt, SIMILARITY_BATCH_SCHEMA, model ?? this.model);
		const sharedTermsByBatch: Record<string, string[]> = {};
		for (const entry of parsed.sharedTermsByBatch) sharedTermsByBatch[entry.batchLabel] = entry.terms;
		return { thinking, plan: { thinking, batchLabels: parsed.batchLabels, sharedTermsByBatch, assignments: parsed.assignments }, usage };
	}

	/**
	 * Rapid Fire Phase 2 (FR-8.4): extracts discrete, control-mapped evidence facts from the
	 * snippets retrieved for one topic batch. The "critical rule" (shared evidence usable only when
	 * EXPLICITLY mapped to a control) is enforced by the schema requiring `controlNumbers` per fact,
	 * not inferred from the batch as a whole — a fact the model can't attribute to a specific control
	 * simply doesn't get one in its `controlNumbers` array, and drafting (Phase 3) only ever sees
	 * facts actually mapped to the control it's drafting.
	 */
	async extractThematicEvidence(
		topicLabel: string,
		controlNumbers: string[],
		snippets: { sourcePath: string; location: string; text: string }[],
		model?: string,
	): Promise<{ thinking: string; extraction: ThemeEvidenceExtraction; usage: GenerateContentResponse['usageMetadata'] }> {
		const snippetsBlock = snippets.map((s) => `Source: ${s.sourcePath} (${s.location})\n${s.text}`).join('\n\n');
		const prompt = [
			`You are extracting evidence facts for the "${topicLabel}" topic batch, covering controls:`,
			controlNumbers.join(', '),
			'',
			'From the retrieved snippets below, extract discrete facts. For EACH fact, map it ONLY to the',
			'specific control(s) it actually supports — never every control in the batch just because they',
			'share a topic. A fact relevant to none of these controls should simply be omitted.',
			'',
			'Also list, per control, anything these controls need that the snippets do NOT cover — be',
			'specific (cite the control number). This is carried forward as an honest gap, never silently',
			'dropped.',
			'',
			'Retrieved snippets:',
			snippetsBlock || '(none retrieved)',
		].join('\n');

		const { thinking, parsed, usage } = await this.generateStructured<Omit<ThemeEvidenceExtraction, 'thinking'>>(prompt, THEME_EVIDENCE_SCHEMA, model ?? this.model);
		return { thinking, extraction: { thinking, ...parsed }, usage };
	}

	/**
	 * Rapid Fire Phase 3 (FR-8.5): drafts several (control, stage) conclusions in one call, each
	 * built only from the evidence facts mapped to that specific item — never another item's facts,
	 * even within the same batch, even though they're in the same prompt. The caller (the Rapid Fire
	 * engine) validates the result has exactly one entry per requested item and retries only
	 * missing/malformed ones, per FR-8.5's process.
	 */
	async draftConclusionsBatch(
		items: BatchDraftItemInput[],
		evidenceContextByItem: Record<string, string>,
		writingRules: string,
		model?: string,
	): Promise<{ thinking: string; results: BatchDraftItemResult[]; usage: GenerateContentResponse['usageMetadata'] }> {
		const itemsBlock = items
			.map((it, i) => {
				const key = `${it.controlNumber}:${it.stage}`;
				return [
					`[${i}] Control ${it.controlNumber} — ${it.stage}`,
					it.controlText,
					...(it.priorConclusion ? ['Prior conclusion (context, e.g. revising):', it.priorConclusion] : []),
					'Evidence facts mapped to THIS item only:',
					evidenceContextByItem[key] || '(none mapped — treat as an evidence gap, do not borrow another item\'s facts)',
				].join('\n');
			})
			.join('\n\n');

		const prompt = [
			`Draft ${items.length} control/stage conclusion(s) in one pass. Each entry below is INDEPENDENT:`,
			'build its conclusion only from the evidence facts listed under that same entry — never from',
			'another entry\'s facts, even though they appear in the same batch below. If an item\'s facts',
			'are thin or absent, its rating and unresolvedIssues must reflect that honestly rather than',
			'borrowing confidence from a different item.',
			'',
			'You MUST follow the writing rules below exactly for phrasing and structure.',
			'',
			'Writing rules:',
			writingRules,
			'',
			'Items:',
			itemsBlock,
		].join('\n');

		const { thinking, parsed, usage } = await this.generateStructured<{ results: BatchDraftItemResult[] }>(prompt, BATCH_DRAFT_SCHEMA, model ?? this.model);
		return { thinking, results: parsed.results, usage };
	}

	/**
	 * One turn of the chat agent: sends the running conversation (including earlier tool calls and
	 * their results) plus the tool declarations, and returns the raw response so the caller can
	 * execute any requested function calls. The model's returned `content` must be appended to the
	 * history unchanged — it carries thought signatures Gemini needs to see on the next turn.
	 */
	async agentStep(
		contents: Content[],
		systemInstruction: string,
		functionDeclarations: FunctionDeclaration[],
		/** "Burn Mode" override — a more capable/expensive model id for a quality-sensitive step (QA, planning, drafting). Falls back to the regular generation model when unset. */
		model: string = this.model,
	): Promise<GenerateContentResponse> {
		return this.ai.models.generateContent({
			model,
			contents,
			config: {
				systemInstruction,
				tools: [{ functionDeclarations }],
			},
		});
	}

	/**
	 * "Prepare session" step 0: given every control targeted by the session, organizes them into
	 * domain/topic groups (e.g. "Access Control", "Change Management") BEFORE any Evidence Goal is
	 * created — every EG created afterwards is scoped to one control's assigned group, so a later
	 * "reuse an existing EG" decision only ever considers EGs about the same topic, never an unrelated
	 * control that happens to rank nearby in a similarity search. Reuses an existing group whenever a
	 * control genuinely fits it (so re-running this on a session that already has groups doesn't
	 * fragment them); only proposes a new group when nothing existing fits.
	 */
	async assignControlGroups(
		existingGroupTitles: string[],
		controls: { number: string; standard: string; topic: string; control: string }[],
	): Promise<ControlGroupingPlan> {
		const controlsBlock = controls
			.map((c) => `[${c.number}] ${c.standard}${c.topic ? ` — ${c.topic}` : ''}\n${c.control}`)
			.join('\n\n');

		const prompt = [
			'You are planning an audit interview session by first organizing its controls into',
			'domain/topic groups (e.g. "Access Control", "Change Management", "Cryptography", "Physical',
			'Security") — every piece of evidence needed for a control will later be planned inside its',
			'assigned group, so put controls that will realistically need the SAME or overlapping',
			'evidence (e.g. the same login/config screen) in the same group, and controls about genuinely',
			'different topics in different groups.',
			'',
			'Reuse an existing group (exact title, verbatim) whenever a control genuinely fits it. Only',
			'propose a new group when nothing existing is a reasonable fit. Use as many groups as the',
			'actual variety of topics warrants — do not force unrelated controls into the same group just',
			'to reduce the group count, and do not split closely related controls into separate groups',
			'either.',
			'',
			existingGroupTitles.length > 0
				? `Existing groups already in this session: ${existingGroupTitles.join(', ')}`
				: '(no groups exist in this session yet)',
			'',
			'Controls to assign (number, standard, topic, control text):',
			controlsBlock,
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<Omit<ControlGroupingPlan, 'thinking'>>(prompt, CONTROL_GROUPING_SCHEMA);
		return { thinking, ...parsed };
	}

	/**
	 * "Prepare session" step 2: given EVERY control in one batch of a domain/topic group (from
	 * `assignControlGroups` — never controls from other groups) at once, plus the EGs already in that
	 * group, decides for each control whether it needs a brand new EG, an existing one as-is, or an
	 * existing one broadened to also cover it. Batched rather than one call per control, both for cost
	 * (large sessions can have 100+ controls) and for quality: seeing every control in the batch
	 * together lets the model make consistent, coherent grouping decisions instead of an incremental
	 * one-at-a-time guess that can't see what's coming next. Reuse an existing EG only when it
	 * genuinely covers the same evidence — this is quality-first, not count-minimizing: forcing
	 * unrelated controls to share one screenshot just to produce fewer EGs makes that EG's own
	 * description/questions incoherent and overloaded, which is worse for the interview than two clean,
	 * focused EGs.
	 */
	async planEvidenceGoalsForGroup(
		groupTitle: string,
		setupContext: string,
		controls: { number: string; context: string; standardsContext: string; evidenceContext: string }[],
		candidateEvidenceGoals: { id: string; name: string; description: string; questions: string[]; type: string; controlNumbers: string[] }[],
	): Promise<GroupEvidenceGoalPlan> {
		const candidatesBlock = candidateEvidenceGoals.length > 0
			? candidateEvidenceGoals
				.map((eg) => [
					`[${eg.id}] ${eg.name} (${eg.type})`,
					`Currently used by: ${eg.controlNumbers.join(', ') || '(none)'}`,
					`Description: ${eg.description}`,
					eg.questions.length > 0 ? `Questions: ${eg.questions.join(' | ')}` : '',
				].filter(Boolean).join('\n'))
				.join('\n\n')
			: '(no existing evidence goals found in this group yet)';

		const controlsBlock = controls
			.map((c) => [
				`### Control ${c.number}`,
				c.context,
				'',
				'Relevant supporting standards (context only):',
				c.standardsContext || '(none)',
				'',
				'Relevant evidence already collected for this control (use to ground the EG in what has',
				'actually been observed so far, not to replace the evidence goal itself):',
				c.evidenceContext || '(none found)',
			].join('\n'))
			.join('\n\n');

		const prompt = [
			`You are planning the "${groupTitle}" part of an audit interview session, for the batch of`,
			`${controls.length} control(s) below all at once. An "Evidence Goal" (EG) is a single`,
			'screenshot (or, rarely, file) an auditor needs to capture during the interview to verify a',
			'control is conform in practice. The SAME EG can cover multiple controls when — and only',
			'when — they genuinely need the exact same screenshot/file (e.g. one config screen that',
			'itself satisfies two related controls) — when several controls in this batch need the exact',
			'same evidence, cover ALL of them with ONE decision by listing every one of them in that',
			'decision\'s controlNumbers, rather than creating a separate new EG per control. Otherwise, for',
			'each control, check whether an existing EG below already covers it as-is, or is a close',
			'enough fit that broadening its name/description/questions slightly would cover it too WITHOUT',
			'becoming vague, unfocused, or a grab-bag of unrelated requirements. When in doubt, prefer a',
			'new, focused EG over stretching an existing one to fit — a session with a few more clean EGs',
			'is better than one with fewer EGs that are each overloaded and hard to interview against.',
			'',
			'Most controls need exactly one evidence goal. Only produce more than one decision for a',
			'control when it genuinely requires multiple distinct, separately-captured pieces of evidence',
			'(e.g. two different configuration screens) — do not split a single piece of evidence into',
			'several decisions just because the control text has several sentences. EVERY control below',
			'must be covered by at least one decision.',
			'',
			'For each decision, choose exactly one action:',
			'- "link": an existing EG below already fully covers this piece of evidence as-is. Just',
			'  attach the control(s) to it — do not change its name/description/questions.',
			'- "modify_and_link": an existing EG below is a close but not perfect fit. Broaden its',
			'  name/description/questions just enough to also cover the control(s), then attach them. The',
			'  new fields REPLACE the EG\'s current ones — write them so they still make complete sense for',
			'  every control the EG covers, not just the new one(s).',
			'- "create": no existing EG below is a reasonable fit. Define a new one, listing every control',
			'  in this batch that it covers.',
			'',
			'For "link"/"modify_and_link", set targetId to the existing EG\'s ID (from the list below —',
			'never an EG you are creating in this same response; if several controls need the same new',
			'evidence, that is one single "create" decision listing all of them, not several decisions',
			'linked to each other). For "create", leave targetId empty and fill in the new EG\'s',
			'name/description/questions/type. controlNumbers always lists every control this exact',
			'decision covers.',
			'',
			'PLAIN LANGUAGE, NOT TECHNICAL PRECISION. These EGs are read aloud by an auditor in a live',
			'interview with someone who is often not technical, and the whole point is that they are quick',
			'and easy to follow — not a restatement of the control or standard\'s own clause language.',
			'Write every name, description and question the way you would casually explain it to a',
			'colleague, never the way the requirement itself is phrased:',
			'- name: a short, plain caption of the SCREENSHOT/FILE itself, not the control — e.g. "Network',
			'  diagram screenshot", "MFA settings screen", "Completed onboarding flow". Never restate a',
			'  clause number, policy name or technical setting as the EG\'s name.',
			'- description: one GLOBAL, plain-language sentence describing what the screenshot/file should',
			'  show — e.g. "A screenshot of the network diagram" or "A screenshot showing a completed',
			'  onboarding flow" — not a technical breakdown of every sub-requirement it happens to satisfy.',
			'  One simple, general description covering several related requirements at once is the goal,',
			'  not a precise enumeration of each one.',
			'- questions: simple, everyday things to ask to get there — e.g. "Can you show me the network',
			'  diagram?" or "Can you walk me through completing an onboarding?" — never multi-clause,',
			'  jargon-heavy asks that read like the standard itself. Usually one short question is enough.',
			'Use each control\'s existing evidence and the client\'s actual setup (below) only to make sure',
			'the plain description points at something that genuinely exists — never to add technical',
			'detail back into the wording. If a control or standard is highly technical, that technicality',
			'is for your own understanding of what to look for, not for what gets written into the EG.',
			'',
			'The client\'s actual setup, to the best of our knowledge (ground truth for what evidence',
			'realistically exists and where):',
			setupContext || '(no setup description provided)',
			'',
			`Existing evidence goals already in the "${groupTitle}" group (the only ones eligible to link/modify — an EG from a different topic group is never a fit, even if it looks similar):`,
			candidatesBlock,
			'',
			'Controls to plan for, this batch:',
			controlsBlock,
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<Omit<GroupEvidenceGoalPlan, 'thinking'>>(prompt, GROUP_EVIDENCE_GOAL_PLAN_SCHEMA);
		return { thinking, ...parsed };
	}

	/**
	 * "Prepare session" final pass, once per group: does THREE things in one call, to keep large
	 * sessions (which can have many groups) cheap. (1) LIMITED further compression the batched
	 * planning above may have missed — only pairs/groups of EGs that verify the literal same
	 * screenshot/file, where merging loses nothing; deliberately conservative, since over-merging here
	 * recreates the exact "one overloaded EG" problem grouping was meant to avoid. (2) Simplifies any
	 * EG whose name/description/questions still read as technical or precise rather than plain,
	 * global, easy-to-ask language — a backstop for whatever the batched planning call above missed,
	 * since the whole point of this pipeline is a session plan a non-technical interviewer can
	 * actually follow. (3) Refines each EG's questions against `referenceContext` — excerpts from
	 * finalized reports of a PAST, closed engagement for a similar topic — to point the interview at
	 * what specifically might have changed since then, while keeping the question just as plain, e.g.
	 * "Can you show me the current network diagram? Last time it looked different." The past report is
	 * a prompt for what to re-verify, never a source of the current answer — never phrase a question
	 * as if the old finding already still holds.
	 */
	async finalizeEvidenceGoals(
		groupTitle: string,
		evidenceGoals: { id: string; name: string; description: string; questions: string[]; type: string; controlNumbers: string[] }[],
		referenceContext: string,
	): Promise<EvidenceGoalFinalizationPlan> {
		const block = evidenceGoals
			.map((eg) => [
				`[${eg.id}] ${eg.name} (${eg.type})`,
				`Controls: ${eg.controlNumbers.join(', ')}`,
				`Description: ${eg.description}`,
				eg.questions.length > 0 ? `Questions: ${eg.questions.join(' | ')}` : '',
			].filter(Boolean).join('\n'))
			.join('\n\n');

		const prompt = [
			`You are doing a final pass over the Evidence Goals (EGs) planned for the "${groupTitle}"`,
			'topic group of an audit interview session, with three jobs:',
			'',
			'1) LIMITED further compression: only pairs/groups of EGs that verify the literal same',
			'screenshot/file, where merging loses nothing. Only propose a merge when it genuinely',
			'eliminates a redundant screenshot the auditor would otherwise capture twice for no reason —',
			'do not merge EGs that cover meaningfully different evidence just because they sound similar',
			'or share a control, and do not merge anything just to reduce the count. When unsure, leave',
			'EGs separate; a slightly longer list of focused EGs is the correct, better outcome here, not',
			'a failure to compress.',
			'',
			'2) SIMPLIFY. These EGs get read aloud by an auditor in a live interview, often with someone',
			'non-technical — they must be quick and easy to follow, not a restatement of a control or',
			'standard\'s own clause language. For any EG whose name, description or questions still sound',
			'technical, precise or jargon-heavy, rewrite them plainly:',
			'- name: a short, plain caption of the screenshot/file itself — e.g. "Network diagram',
			'  screenshot", "Completed onboarding flow" — never a clause number, policy name or setting.',
			'- description: one GLOBAL, plain sentence of what the screenshot should show — e.g. "A',
			'  screenshot of the network diagram" or "A screenshot showing a completed onboarding flow" —',
			'  not a technical enumeration of every sub-requirement it happens to satisfy.',
			'- questions: simple, everyday asks — e.g. "Can you show me the network diagram?" — never',
			'  multi-clause or jargon-heavy. Usually one short question is enough.',
			'If an EG already reads this way, leave it alone.',
			'',
			'3) Sharpen questions using the excerpts below from a finalized report of a PAST, CLOSED',
			'engagement on a similar topic — but keep them just as plain as job 2 requires. That old',
			'report is CLOSED and may be outdated — use it only to spot SPECIFIC things worth re-checking',
			'because they were noted before and commonly drift over time (a policy value, a named',
			'tool/vendor, a configuration setting, a named owner/role). Turn that into a plain question',
			'that asks the interviewee to confirm the CURRENT state — e.g. "Can you show me the current',
			'network diagram? It looked different last time." — never state the old finding as still',
			'true, and never invent a specific detail that isn\'t actually in the excerpts below. If',
			'nothing specific is worth flagging for an EG, leave its questions as they are.',
			'',
			'Only include an entry for an EG you are actually changing (merged, simplified and/or',
			'refined); leave out anything unchanged. For a merge, list all its source IDs and write the',
			'single replacement EG (name/description/questions/type) covering every control the merged',
			'EGs covered — already simplified and incorporating any history-driven refinement. For a',
			'non-merge change, list just that one EG\'s ID with its complete updated fields.',
			'',
			'Evidence goals in this group:',
			block,
			'',
			'Excerpts from a past, closed engagement\'s finalized report, on a similar topic (style/history reference only — see job 3 above):',
			referenceContext || '(none found)',
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<Omit<EvidenceGoalFinalizationPlan, 'thinking'>>(prompt, EVIDENCE_GOAL_FINALIZATION_SCHEMA);
		return { thinking, ...parsed };
	}

	/**
	 * "Prepare session" step 5 (and the session-plan view's "Regenerate groups" action): organizes a
	 * session's finished Evidence Goals into domain/topic groups (e.g. "Access Control", "Change
	 * Management") for the interview to walk through. Every EG must end up in exactly one group —
	 * titles and membership are freely editable afterwards in the session-plan view, this just gives a
	 * reasonable starting structure instead of one long flat list.
	 */
	async groupEvidenceGoalsByDomain(
		evidenceGoals: { id: string; name: string; description: string; controlNumbers: string[] }[],
	): Promise<EvidenceGoalGroupingPlan> {
		const block = evidenceGoals
			.map((eg) => [
				`[${eg.id}] ${eg.name}`,
				`Controls: ${eg.controlNumbers.join(', ')}`,
				`Description: ${eg.description}`,
			].join('\n'))
			.join('\n\n');

		const prompt = [
			'You are organizing the finished list of Evidence Goals (EGs) for one audit interview session',
			'into domain/topic groups, so the interview can walk through them one coherent topic at a',
			'time instead of as one long flat list (e.g. "Access Control", "Change Management",',
			'"Cryptography", "Physical Security"). Base the grouping on what the EG actually verifies, not',
			'on which control(s) happen to cite it.',
			'',
			'Every evidence goal below must appear in exactly one group. Use as many groups as the actual',
			'variety of topics warrants — don\'t force unrelated EGs into the same group just to reduce',
			'the group count, and don\'t split closely related EGs into separate groups either.',
			'',
			'Evidence goals in this session:',
			block,
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<Omit<EvidenceGoalGroupingPlan, 'thinking'>>(prompt, EVIDENCE_GOAL_GROUPING_SCHEMA);
		return { thinking, ...parsed };
	}
}
