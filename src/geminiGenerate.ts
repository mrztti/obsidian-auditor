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
			description: 'The snippets (by index) most relevant to understanding this control, most relevant first.',
			items: {
				type: Type.OBJECT,
				properties: {
					index: { type: Type.INTEGER, description: 'The [index] of the relevant snippet.' },
					controlNumber: {
						type: Type.STRING,
						description: 'The exact clause/control nomenclature as it appears in the standard (e.g. "6.2.1", "REQ-14"). Empty string if none.',
					},
					excerpt: { type: Type.STRING, description: 'The exact verbatim excerpt from the snippet defining the control.' },
					reason: { type: Type.STRING, description: 'One sentence on why this snippet matters for understanding the control.' },
				},
				required: ['index', 'controlNumber', 'excerpt', 'reason'],
			},
		},
		references: {
			type: Type.ARRAY,
			description: 'Any mentions, within the provided snippets, of OTHER standards being referenced/cited (e.g. "see ISO 27001 clause 5.3").',
			items: {
				type: Type.OBJECT,
				properties: {
					standardName: { type: Type.STRING, description: 'Name of the other standard referenced, as it appears in the text.' },
					controlNumber: { type: Type.STRING, description: 'Clause/control number within that standard, if given. Empty string if none.' },
					excerpt: { type: Type.STRING, description: 'The exact verbatim excerpt containing the reference.' },
				},
				required: ['standardName', 'controlNumber', 'excerpt'],
			},
		},
		targetDocuments: {
			type: Type.ARRAY,
			description: 'A comprehensive list of the kinds of evidence documents that will need to be inspected to verify this control.',
			items: {
				type: Type.OBJECT,
				properties: {
					file: { type: Type.STRING, description: 'Descriptive name/topic of the document to look for, e.g. "Cryptographic Policy".' },
					keywords: {
						type: Type.ARRAY,
						description: 'Keywords and synonyms for this document, suited for embedding-based semantic search.',
						items: { type: Type.STRING },
					},
				},
				required: ['file', 'keywords'],
			},
		},
		memorySummary: {
			type: Type.STRING,
			description: 'A concise summary of the exact document requirements that must be verified with evidence in later steps.',
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
		progress: { type: Type.STRING, description: 'A narrative summary of what has been verified so far against the requirements.' },
		gaps: {
			type: Type.ARRAY,
			description: 'The requirements that are still missing evidence, listed concretely.',
			items: { type: Type.STRING },
		},
		updatedMemory: {
			type: Type.STRING,
			description: 'An updated version of the requirements memory, reflecting what is now verified and what remains outstanding.',
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
			description: 'ONLY the documents/controls (by index) that are actually relevant enough to cite in the report. Omit every index that is not genuinely relevant — do not include an entry for every input.',
			items: {
				type: Type.OBJECT,
				properties: {
					index: { type: Type.INTEGER, description: 'The [index] of the document/control.' },
					plannedFinding: {
						type: Type.STRING,
						description: 'A concise statement of what finding or content will be drawn from this document/control when drafting the report.',
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
	/** Standard name + requirement identifier code, e.g. "ETSI TS 119 431-1 SIG-6.3.1-03". */
	title: string;
	/** The control report body, following the writing rules exactly (Findings/Observations-Recommendations/Evidence). */
	conclusion: string;
}

const DRAFT_CONTROL_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		title: {
			type: Type.STRING,
			description: 'The standard name followed by the requirement\'s short identifier code, e.g. "ETSI TS 119 431-1 SIG-6.3.1-03". Just the nomenclature, nothing else.',
		},
		conclusion: {
			type: Type.STRING,
			description: 'The control report body, following the writing rules exactly. Nothing except what the rules produce.',
		},
	},
	required: ['title', 'conclusion'],
};

const RERANK_SCHEMA: Schema = {
	type: Type.OBJECT,
	properties: {
		response: {
			type: Type.STRING,
			description: 'A formal, direct answer to the user\'s query, synthesized from the relevant snippets. Presented to the user before the snippets themselves.',
		},
		relevant: {
			type: Type.ARRAY,
			description: 'The snippets (by index) that are actually relevant to the query, most relevant first.',
			items: {
				type: Type.OBJECT,
				properties: {
					index: { type: Type.INTEGER, description: 'The [index] of the relevant snippet.' },
					excerpt: {
						type: Type.STRING,
						description: 'The exact verbatim text copied from within the snippet that is most relevant to the query — not a summary or paraphrase, an exact substring of the snippet.',
					},
					reason: { type: Type.STRING, description: 'One sentence on why this excerpt is relevant.' },
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

	private async generate(prompt: string): Promise<string> {
		const response = await this.ai.models.generateContent({
			model: this.model,
			contents: prompt,
		});
		const text = response.text;
		if (!text) throw new Error('Gemini returned an empty response.');
		return text.trim();
	}

	/** Runs a structured-output call with thinking enabled, returning the parsed JSON plus the thought summary. */
	private async generateStructured<T>(prompt: string, schema: Schema): Promise<{ thinking: string; parsed: T }> {
		const response = await this.ai.models.generateContent({
			model: this.model,
			contents: prompt,
			config: {
				responseMimeType: 'application/json',
				responseSchema: schema,
				thinkingConfig: { includeThoughts: true },
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
			'Given the user\'s prompt below, write a short, keyword-dense description of what to',
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
			'that snippet\'s text, not a summary or paraphrase — that most directly answers the query,',
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

		const { thinking, parsed } = await this.generateStructured<{ response: string; relevant: RerankedSnippet[] }>(
			prompt,
			RERANK_SCHEMA,
		);
		return { thinking, response: parsed.response, relevant: parsed.relevant };
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

		const { thinking, parsed } = await this.generateStructured<Omit<ControlAnalysis, 'thinking'>>(
			prompt,
			CONTROL_ANALYSIS_SCHEMA,
		);
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
		refinement?: { previousProgress: string; previousGaps: string[]; userFeedback: string },
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
			...(refinement ? [
				'This is a refinement of your own previous assessment. Take the auditor\'s feedback',
				'into account and adjust your progress/gaps/memory accordingly rather than starting over.',
				'',
				'Your previous progress assessment:',
				refinement.previousProgress,
				'',
				'Your previous gaps:',
				refinement.previousGaps.join('\n') || '(none)',
				'',
				'Auditor\'s feedback:',
				refinement.userFeedback,
				'',
			] : []),
			'Memory summary:',
			memorySummary,
			'',
			'Evidence findings:',
			findingsText || '(no findings)',
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<Omit<ResearchAssessment, 'thinking'>>(
			prompt,
			RESEARCH_ASSESSMENT_SCHEMA,
		);
		return { thinking, ...parsed };
	}

	/** Drafts a search query to run against the evidence vector store, given the understood control. */
	async synthesizeEvidenceQuery(controlUnderstanding: string): Promise<string> {
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
		items: { index: number; label: string; kind: 'evidence' | 'control'; text: string }[],
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

		const { thinking, parsed } = await this.generateStructured<Omit<FinalizationPlan, 'thinking'>>(
			prompt,
			FINALIZATION_SCHEMA,
		);
		return { thinking, ...parsed };
	}

	/**
	 * Drafts the final control text from the accumulated, user-curated retrieval context, strictly
	 * following the given writing rules, and separately extracts the requirement's own nomenclature
	 * (e.g. "SIG-6.3.1-03") to use as the note title — kept apart from the conclusion body.
	 */
	async draftControl(
		controlUnderstanding: string,
		evidenceContext: string,
		similarControlsContext: string,
		writingRules: string,
		guidance: string,
	): Promise<DraftedControl> {
		const prompt = [
			'You are an auditor drafting a control write-up.',
			'Use the control understanding, the evidence found in the vault, and the style of',
			'previously written controls to draft the new control.',
			'',
			'You MUST follow the writing rules below exactly — they define the required structure,',
			'wording, and formatting of the "conclusion" field. It must contain nothing except what',
			'the rules produce: no preamble, no explanation, no markdown code fences, no extra',
			'commentary before or after.',
			'',
			'Separately, build the note title from the requirement\'s own nomenclature: the name of the',
			'standard it comes from, followed by its short identifier code. E.g. given a requirement',
			'"SIG-6.3.1-03: Clause SRC_SA.1.4 of EN 419241-1 [3], specifying access control, shall',
			'apply." found in standard "ETSI TS 119 431-1", the title is exactly',
			'"ETSI TS 119 431-1 SIG-6.3.1-03" — the standard name plus the leading identifier code,',
			'not the description that follows it. Take the standard name from the source file',
			'references in the control understanding below. If no identifier code is present, write a',
			'short (few-word) descriptive title instead, still prefixed with the standard name if known.',
			'',
			'Writing rules:',
			writingRules,
			'',
			...(guidance ? ['Additional guidance for finalizing this report:', guidance, ''] : []),
			'Control understanding:',
			controlUnderstanding,
			'',
			'Evidence:',
			evidenceContext || '(none selected)',
			'',
			'Similar previously written controls (style reference):',
			similarControlsContext || '(none selected)',
			'',
			'Write the drafted control now, following the writing rules exactly.',
		].join('\n');

		const { thinking, parsed } = await this.generateStructured<Omit<DraftedControl, 'thinking'>>(
			prompt,
			DRAFT_CONTROL_SCHEMA,
		);
		return { thinking, ...parsed };
	}
}
