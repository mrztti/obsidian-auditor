import { GoogleGenAI, Type, type Schema } from '@google/genai';

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

export interface EvidenceGoalDecision {
	action: 'create' | 'link' | 'modify_and_link';
	/** Existing EG's ID, for "link"/"modify_and_link". Empty for "create". */
	targetId: string;
	/** New/replacement fields, for "create"/"modify_and_link". Empty/unused for "link". */
	name: string;
	description: string;
	questions: string[];
	type: 'screenshot' | 'file';
}

export interface EvidenceGoalPlan {
	thinking: string;
	/** One control can need more than one screenshot/file — most controls need exactly one decision, but a control covering several distinct pieces of evidence (e.g. two different config screens) gets one decision per piece. */
	decisions: EvidenceGoalDecision[];
}

const EVIDENCE_GOAL_DECISION_SCHEMA: Schema = {
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
	required: ['action', 'targetId', 'name', 'description', 'questions', 'type'],
};

const EVIDENCE_GOAL_PLAN_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		decisions: {
			type: Type.ARRAY,
			description: 'One decision per distinct piece of evidence this control needs. Most controls need exactly one; only add more when the control genuinely requires separate, distinct screenshots/files to be verified.',
			items: EVIDENCE_GOAL_DECISION_SCHEMA,
		},
	},
	required: ['decisions'],
};

export interface EvidenceGoalCompressionMerge {
	sourceIds: string[];
	name: string;
	description: string;
	questions: string[];
	type: 'screenshot' | 'file';
}

export interface EvidenceGoalCompressionPlan {
	thinking: string;
	merges: EvidenceGoalCompressionMerge[];
}

const EVIDENCE_GOAL_COMPRESSION_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		merges: {
			type: Type.ARRAY,
			description: 'Groups of 2+ evidence-goal IDs that should be merged into one. Omit EGs that should stay as-is.',
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
	required: ['merges'],
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

	/** Runs a structured-output call, returning the parsed JSON plus the thought summary (empty when `includeThinking` is false). */
	private async generateStructured<T>(
		prompt: string,
		schema: Schema,
		model: string = this.model,
		includeThinking = true,
	): Promise<{ thinking: string; parsed: T }> {
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
		return { thinking, parsed: JSON.parse(text) as T };
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

	/**
	 * Step 1 of the chat flow: given the conversation so far and the auditor's latest message,
	 * decides whether searching the vault would help at all, and if so, what kind of documents to
	 * look for — expressed as a keyword-dense query suited to embedding retrieval, not just the raw
	 * message. Runs *before* any RAG search — its output query is what actually gets searched.
	 */
	async planChatSearch(
		history: { role: 'user' | 'assistant'; text: string }[],
		question: string,
	): Promise<{ thinking: string; shouldSearch: boolean; searchQuery: string }> {
		const historyText = history
			.map((m) => `${m.role === 'user' ? 'Auditor' : 'Assistant'}: ${m.text}`)
			.join('\n\n');
		const prompt = [
			'You are planning the retrieval step for an auditor\'s chat message, before a vector-database',
			'search of their vault (standards, evidence, written controls, interview evidence) runs.',
			'',
			'Decide whether searching the vault would actually help answer this message — false for',
			'greetings, meta questions about the conversation itself, or anything answerable without',
			'vault content. If true, write a keyword-dense search query describing what kind of',
			'documents/content to look for: the concepts, terms, and phrases most likely to appear in',
			'relevant passages — not simply the auditor\'s raw message restated.',
			'',
			...(historyText ? ['Conversation so far:', historyText, ''] : []),
			`Auditor's latest message: ${question}`,
		].join('\n');

		const schema: Schema = {
			type: Type.OBJECT,
			properties: {
				shouldSearch: {
					type: Type.BOOLEAN,
					description: 'Whether searching the vault would help answer this message.',
				},
				searchQuery: {
					type: Type.STRING,
					description: 'Keyword-dense search query describing what kind of documents to look for. Empty string if shouldSearch is false.',
				},
			},
			required: ['shouldSearch', 'searchQuery'],
		};

		const { thinking, parsed } = await this.generateStructured<{ shouldSearch: boolean; searchQuery: string }>(prompt, schema);
		return { thinking, ...parsed };
	}

	/**
	 * Step 2 of the chat flow: free-form reply, grounded in RAG context retrieved (per the plan from
	 * `planChatSearch`) across all indexes. Plain text in, plain text out — no structured output,
	 * since chat replies aren't consumed programmatically.
	 */
	async chatWithRag(
		history: { role: 'user' | 'assistant'; text: string }[],
		retrievedContext: string,
		question: string,
	): Promise<string> {
		const historyText = history
			.map((m) => `${m.role === 'user' ? 'Auditor' : 'Assistant'}: ${m.text}`)
			.join('\n\n');
		const prompt = [
			'You are an AI assistant helping an auditor explore their vault of standards, evidence,',
			'written controls, and interview evidence.',
			'',
			'Answer the auditor\'s latest message using the retrieved context below when it\'s relevant.',
			'If the context doesn\'t contain the answer, say so honestly rather than making things up.',
			'Keep the conversation natural — you don\'t need to force in context that isn\'t relevant to',
			'what was just asked.',
			'',
			...(historyText ? ['Conversation so far:', historyText, ''] : []),
			'Retrieved context (top matches across all indexes):',
			retrievedContext || '(no relevant context found)',
			'',
			`Auditor: ${question}`,
			'',
			'Assistant:',
		].join('\n');
		return this.generate(prompt);
	}

	/**
	 * "Prepare session" step 1: given a control's full context and the Evidence Goals (EGs) already
	 * in its session that looked plausibly relevant (via RAG), decides whether to create a brand new
	 * EG, link this control to an existing one as-is, or modify an existing one (broadening its name/
	 * description/questions to also fit this control) and link it. The goal is to minimize the total
	 * number of EGs a session needs — reuse/modify an existing EG whenever it's a reasonable fit
	 * rather than creating a near-duplicate.
	 */
	async planEvidenceGoal(
		controlContext: string,
		standardsContext: string,
		setupContext: string,
		evidenceContext: string,
		candidateEvidenceGoals: { id: string; name: string; description: string; questions: string[]; type: string; controlNumbers: string[] }[],
	): Promise<EvidenceGoalPlan> {
		const candidatesBlock = candidateEvidenceGoals.length > 0
			? candidateEvidenceGoals
				.map((eg) => [
					`[${eg.id}] ${eg.name} (${eg.type})`,
					`Currently used by: ${eg.controlNumbers.join(', ') || '(none)'}`,
					`Description: ${eg.description}`,
					eg.questions.length > 0 ? `Questions: ${eg.questions.join(' | ')}` : '',
				].filter(Boolean).join('\n'))
				.join('\n\n')
			: '(no existing evidence goals found in this session yet)';

		const prompt = [
			'You are planning an audit interview session. An "Evidence Goal" (EG) is a single screenshot',
			'(or, rarely, file) an auditor needs to capture during the interview to verify a control is',
			'conform in practice. The SAME EG can — and should, whenever reasonable — serve MULTIPLE',
			'controls at once. The objective is to plan the session with as FEW evidence goals as',
			'possible, so before creating a new one, always check whether an existing one already covers',
			'this control, or could reasonably be broadened (a slightly more general name/description/',
			'question set) to cover it too, without becoming vague or losing what it actually verifies.',
			'',
			'Most controls need exactly one evidence goal. Only produce more than one decision when the',
			'control genuinely requires multiple distinct, separately-captured pieces of evidence (e.g. two',
			'different configuration screens) — do not split a single piece of evidence into several',
			'decisions just because the control text has several sentences.',
			'',
			'For each decision, choose exactly one action:',
			'- "link": an existing EG below already fully covers this piece of evidence as-is. Just',
			'  attach this control to it — do not change its name/description/questions.',
			'- "modify_and_link": an existing EG below is a close but not perfect fit. Broaden its name/',
			'  description/questions just enough to also cover this control, then attach this control to',
			'  it. The new fields REPLACE the EG\'s current ones — write them so they still make complete',
			'  sense for every control the EG already covers, not just this one.',
			'- "create": no existing EG is a reasonable fit. Define a new one.',
			'',
			'For "link", set targetId to the existing EG\'s ID and leave name/description/questions empty.',
			'For "modify_and_link", set targetId to the existing EG\'s ID and fill in the replacement',
			'name/description/questions/type. For "create", leave targetId empty and fill in the new',
			'EG\'s name/description/questions/type.',
			'',
			'An EG\'s description should say exactly what should be captured and why it matters. Questions',
			'are what the auditor should ask the interviewee to prompt them into showing/navigating to it.',
			'Use the client\'s actual setup (below) and any existing evidence to ground the description and',
			'questions in what is realistically there to find, rather than generic wording.',
			'',
			'Control (full context — standard, topic, control text, and any existing Stage 1/Stage 2',
			'conclusions):',
			controlContext,
			'',
			'Relevant supporting standards (context only):',
			standardsContext || '(none)',
			'',
			'The client\'s actual setup, to the best of our knowledge (ground truth for what evidence',
			'realistically exists and where — use this to make descriptions/questions concrete):',
			setupContext || '(no setup description provided)',
			'',
			'Relevant evidence already collected for this control (use to ground the EG in what has',
			'actually been observed so far, not to replace the evidence goal itself):',
			evidenceContext || '(none found)',
			'',
			'Existing evidence goals already in this session:',
			candidatesBlock,
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<Omit<EvidenceGoalPlan, 'thinking'>>(prompt, EVIDENCE_GOAL_PLAN_SCHEMA);
		return { thinking, ...parsed };
	}

	/**
	 * "Prepare session" step 4: given every EG a session ended up with, looks for further compression
	 * opportunities the incremental per-control planning above may have missed (e.g. two EGs created
	 * early on, before either had seen the other, that turn out to overlap). Returns groups of 2+ EG
	 * IDs to merge into one, with the merged EG's fields — never invents merges among EGs that don't
	 * actually overlap.
	 */
	async compressEvidenceGoals(
		evidenceGoals: { id: string; name: string; description: string; questions: string[]; type: string; controlNumbers: string[] }[],
	): Promise<EvidenceGoalCompressionPlan> {
		const block = evidenceGoals
			.map((eg) => [
				`[${eg.id}] ${eg.name} (${eg.type})`,
				`Controls: ${eg.controlNumbers.join(', ')}`,
				`Description: ${eg.description}`,
				eg.questions.length > 0 ? `Questions: ${eg.questions.join(' | ')}` : '',
			].filter(Boolean).join('\n'))
			.join('\n\n');

		const prompt = [
			'You are reviewing a finished list of Evidence Goals (EGs) planned for one audit interview',
			'session, looking for further compression: pairs or groups of EGs that actually verify the',
			'same screenshot/file, or are close enough that broadening one slightly would let it absorb',
			'the other(s) without losing precision. Only propose a merge when it genuinely reduces',
			'redundant screenshots the auditor would otherwise capture twice — do not merge EGs that',
			'cover meaningfully different evidence just because they sound similar.',
			'',
			'For each merge, list the EG IDs being merged (2 or more) and write the single replacement',
			'EG (name/description/questions/type) that correctly covers every control all of the merged',
			'EGs covered. EGs not mentioned in any merge are left as-is.',
			'',
			'Evidence goals in this session:',
			block,
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<Omit<EvidenceGoalCompressionPlan, 'thinking'>>(prompt, EVIDENCE_GOAL_COMPRESSION_SCHEMA);
		return { thinking, ...parsed };
	}
}
