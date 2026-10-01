import { Type } from '@google/genai';
import { AGENT_WRITABLE_CATEGORIES } from '../memory';
import type { MemoryCategory } from '../../settings';
import { str, type AgentTool } from './types';

/**
 * Writes one durable fact to persistent agent memory (FR-6.3) — survives across chat sessions,
 * unlike the conversation itself. Only for things CONFIRMED from evidence this run, with a
 * citation; never a draft, an assumption, or something still unresolved. `acceptedConclusion` and
 * `acceptedDecision` are deliberately not writable here — those are stamped automatically, only
 * once the user has actually approved something, so they stay trustworthy as genuinely accepted.
 */
export const rememberFactTool: AgentTool = {
	declaration: {
		name: 'remember_fact',
		description:
			`Store one durable, structured fact in persistent memory so future chat sessions don't need to re-research it — e.g. stable engagement/control-framework metadata, or a document fact confirmed from current evidence (with its source). Only for things you have actually CONFIRMED this run, never a draft, assumption, or anything still unresolved — see the "assumptions"/"unresolvedIssues" fields on prepare_control_conclusion for those instead. Writable categories: ${AGENT_WRITABLE_CATEGORIES.join(', ')}. A later call with "supersedes" replaces an outdated fact without losing the record that it once said something else.`,
		parameters: {
			type: Type.OBJECT,
			properties: {
				category: { type: Type.STRING, enum: AGENT_WRITABLE_CATEGORIES, description: '"engagementConfig" = stable facts about this engagement/vault setup; "controlFrameworkMetadata" = facts about the standard/framework itself; "stableDocumentFact" = a specific confirmed fact from a document; "thematicEvidenceMap" = which evidence covers which recurring theme/topic across controls.' },
				content: { type: Type.STRING, description: 'Short, structured statement of the fact — one or two sentences, not a transcript or draft text.' },
				provenance: { type: Type.STRING, description: 'Exact source: a file path, control number, or tool result this came from. Required — never write a fact without one.' },
				supersedes: { type: Type.STRING, description: 'The memory item id (from a recall_memory result) this replaces, if updating an outdated fact. Omit when writing a new one.' },
			},
			required: ['category', 'content', 'provenance'],
		},
	},
	label: (a) => `Remembering: ${str(a.content).slice(0, 60)}`,
	run: async (args, ctx) => {
		const category = str(args.category) as MemoryCategory;
		if (!AGENT_WRITABLE_CATEGORIES.includes(category)) {
			return { ok: false, output: { error: `category must be one of: ${AGENT_WRITABLE_CATEGORIES.join(', ')}.` }, summary: 'Invalid memory category' };
		}
		const content = str(args.content).trim();
		const provenance = str(args.provenance).trim();
		if (!content) return { ok: false, output: { error: 'content is required.' }, summary: 'Empty fact' };
		if (!provenance) return { ok: false, output: { error: 'provenance is required — cite the file/control/tool this fact came from.' }, summary: 'Missing provenance' };

		const item = await ctx.plugin.agentMemory.remember(category, content, provenance, { supersedes: str(args.supersedes) || undefined });
		return {
			output: { id: item.id, category: item.category, version: item.version },
			summary: `Remembered (${category}): ${content.slice(0, 80)}`,
		};
	},
};

export const recallMemoryTool: AgentTool = {
	declaration: {
		name: 'recall_memory',
		description:
			'Search persistent agent memory — durable facts carried over from earlier chat sessions (engagement/control-framework metadata, accepted conclusions/decisions, confirmed document facts, thematic evidence maps). Check this BEFORE researching something that may already be known, to avoid repeating work; it is never a substitute for verifying CURRENT compliance status from current evidence.',
		parameters: {
			type: Type.OBJECT,
			properties: {
				category: { type: Type.STRING, description: 'Optional: limit to one category.' },
				text: { type: Type.STRING, description: 'Optional: substring to match against the fact/provenance.' },
			},
		},
	},
	label: (a) => `Recalling memory${str(a.text) ? `: ${str(a.text)}` : ''}`,
	run: (args, ctx) => {
		const category = str(args.category) as MemoryCategory | '';
		const items = ctx.plugin.agentMemory.query({ category: category || undefined, text: str(args.text) || undefined });
		return Promise.resolve({
			output: {
				count: items.length,
				items: items.map((m) => ({ id: m.id, category: m.category, content: m.content, provenance: m.provenance, version: m.version, createdAt: m.createdAt })),
				...(items.length === 0 ? { hint: 'Nothing remembered yet for this — research it normally.' } : {}),
			},
			summary: `${items.length} memory item(s) recalled`,
		});
	},
};
