/**
 * An Evidence Goal (EG) is a single screenshot (or, rarely, file) an auditor needs to capture during
 * an interview session to verify one or more controls are conform in practice. The same EG can back
 * multiple controls — the aim of the interview-planning workflow is to keep merging/reusing EGs across
 * controls so a session needs as few of them as possible, rather than one EG per control.
 *
 * Storage: each EG is its own note (named after its ID), so it can be edited/found independently and
 * isn't tied to a single session file's text layout. A session's plan note just references an ORDERED
 * list of EG IDs — that order is what the session-plan view's drag-and-drop reordering changes — plus
 * `session` is still stored redundantly on each EG note itself so the EG index can filter by session
 * without having to cross-reference every plan note.
 */

export type EvidenceGoalType = 'screenshot' | 'file';

export interface EvidenceGoal {
	/** Stable identifier, independent of `name` (which the user may rename later) — also the EG's note filename. */
	id: string;
	session: string;
	name: string;
	description: string;
	questions: string[];
	type: EvidenceGoalType;
	/** Control numbers (ControlRecord.number) this EG is evidence for. An EG can — and ideally does — back more than one control. */
	controlNumbers: string[];
	/** ID of the domain group (see `EvidenceGoalGroup`) this EG belongs to, or '' if ungrouped. */
	groupId: string;
}

/** A domain-topic group (e.g. "Access Control", "Change Management") EGs can be sorted into — the LLM proposes these, but the title and membership are freely editable in the session-plan view. */
export interface EvidenceGoalGroup {
	id: string;
	title: string;
}

/** A session's plan: which EGs it has and in what order (the order the session-plan view lets you drag/drop), plus its domain groups. */
export interface InterviewSessionPlan {
	session: string;
	evidenceGoals: EvidenceGoal[];
	groups: EvidenceGoalGroup[];
}

export function generateEvidenceGoalId(): string {
	return `eg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function generateEvidenceGoalGroupId(): string {
	return `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyEvidenceGoal(session: string, controlNumber: string): EvidenceGoal {
	return {
		id: generateEvidenceGoalId(),
		session,
		name: '',
		description: '',
		questions: [],
		type: 'screenshot',
		controlNumbers: controlNumber ? [controlNumber] : [],
		groupId: '',
	};
}

export function emptySessionPlan(session: string): InterviewSessionPlan {
	return { session, evidenceGoals: [], groups: [] };
}

/**
 * Every character Obsidian forbids in filenames is stripped — used for the session, which doubles as
 * the session plan note's filename, and for EG IDs, which double as EG note filenames. Mirrors
 * `sanitizeFileTitle` in controlNote.ts.
 */
export function sanitizeSessionFileName(session: string, maxLength = 80): string {
	const firstLine = session.split(/\r?\n/)[0] ?? '';
	const cleaned = firstLine
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/\.\.+/g, '.')
		.trim()
		.slice(0, maxLength)
		.replace(/[\s.]+$/, '')
		.trim();
	return cleaned || 'Untitled session';
}

function typeLabel(type: EvidenceGoalType): string {
	return type === 'file' ? 'File' : 'Screenshot';
}

function parseType(raw: string): EvidenceGoalType {
	return raw.trim().toLowerCase() === 'file' ? 'file' : 'screenshot';
}

// ─── Individual EG note ─────────────────────────────────────────────────────

export function buildEvidenceGoalFileContent(eg: EvidenceGoal): string {
	return [
		'## Name', '', eg.name, '',
		'## Session', '', eg.session, '',
		'## Group', '', eg.groupId, '',
		'## Type', '', typeLabel(eg.type), '',
		'## Controls', '', eg.controlNumbers.join(', '), '',
		'## Description', '', eg.description, '',
		'## Questions', '',
		...(eg.questions.length > 0 ? eg.questions.map((q) => `- ${q}`) : ['(none)']),
	].join('\n');
}

/** Parses an EG note back into structured data. `fallbackId` is the note's filename, used when the content has no explicit ID (there isn't one stored inline — the filename IS the ID). */
export function parseEvidenceGoalFileContent(content: string, fallbackId: string): EvidenceGoal {
	const sections = new Map<string, string>();
	let current: string | null = null;
	let buffer: string[] = [];
	const flush = () => {
		if (current !== null) sections.set(current, buffer.join('\n').trim());
		buffer = [];
	};
	for (const line of content.split(/\r?\n/)) {
		const heading = /^##\s*(.*)$/.exec(line);
		if (heading) {
			flush();
			current = (heading[1] ?? '').trim();
		} else {
			buffer.push(line);
		}
	}
	flush();

	const questionsBlock = sections.get('Questions') ?? '';
	const questions = questionsBlock && questionsBlock !== '(none)'
		? questionsBlock.split(/\r?\n/).map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
		: [];

	return {
		id: fallbackId,
		session: sections.get('Session') ?? '',
		name: sections.get('Name') ?? '',
		description: sections.get('Description') ?? '',
		questions,
		type: parseType(sections.get('Type') ?? ''),
		controlNumbers: (sections.get('Controls') ?? '').split(',').map((c) => c.trim()).filter(Boolean),
		groupId: (sections.get('Group') ?? '').trim(),
	};
}

// ─── Session plan reference note (just an ordered list of EG IDs) ──────────

export function buildSessionPlanRefContent(session: string, evidenceGoalIds: string[], groups: EvidenceGoalGroup[]): string {
	return [
		`# Interview session plan: ${session}`,
		'',
		'## Groups', '',
		...(groups.length > 0 ? groups.map((g) => `- ${g.id}: ${g.title}`) : ['(none yet)']),
		'',
		'## Evidence goals',
		'',
		...(evidenceGoalIds.length > 0 ? evidenceGoalIds.map((id) => `- ${id}`) : ['(none yet)']),
	].join('\n');
}

export function parseSessionPlanRefContent(content: string, fallbackSession = ''): { session: string; evidenceGoalIds: string[]; groups: EvidenceGoalGroup[] } {
	const titleMatch = /^#\s*Interview session plan:\s*(.*)$/m.exec(content);
	const session = (titleMatch?.[1] ?? '').trim() || fallbackSession;

	// Same heading-flush approach as parseEvidenceGoalFileContent/parseControlNoteContent — a lazy
	// regex lookahead spanning multiple lines is fragile here because `$` under the `m` flag matches
	// at the end of *every* line, not just the end of the block, silently truncating multi-line
	// sections (e.g. "Groups") to just their first line.
	const sections = new Map<string, string>();
	let current: string | null = null;
	let buffer: string[] = [];
	const flush = () => {
		if (current !== null) sections.set(current, buffer.join('\n').trim());
		buffer = [];
	};
	for (const line of content.split(/\r?\n/)) {
		const heading = /^##\s*(.*)$/.exec(line);
		if (heading) {
			flush();
			current = (heading[1] ?? '').trim();
		} else if (current !== null) {
			buffer.push(line);
		}
	}
	flush();

	const groupsBlock = sections.get('Groups') ?? '';
	const groups: EvidenceGoalGroup[] = groupsBlock && groupsBlock !== '(none yet)'
		? groupsBlock.split(/\r?\n/).map((line) => {
			const match = /^\s*-\s*([^:]+):\s*(.*)$/.exec(line);
			return match ? { id: (match[1] ?? '').trim(), title: (match[2] ?? '').trim() } : null;
		}).filter((g): g is EvidenceGoalGroup => g !== null)
		: [];

	const block = sections.get('Evidence goals') ?? '';
	const evidenceGoalIds = block && block !== '(none yet)'
		? block.split(/\r?\n/).map((line) => line.replace(/^\s*-\s*/, '').trim()).filter(Boolean)
		: [];

	return { session, evidenceGoalIds, groups };
}
