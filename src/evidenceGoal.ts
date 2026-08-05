/**
 * An Evidence Goal (EG) is a single screenshot (or, rarely, file) an auditor needs to capture during
 * an interview session to verify one or more controls are conform in practice. The same EG can back
 * multiple controls — the aim of the interview-planning workflow is to keep merging/reusing EGs across
 * controls so a session needs as few of them as possible, rather than one EG per control.
 */

export type EvidenceGoalType = 'screenshot' | 'file';

export interface EvidenceGoal {
	/** Stable identifier, independent of `name` (which the user may rename later) — this is what ties an EG back to itself across edits/merges. */
	id: string;
	name: string;
	description: string;
	questions: string[];
	type: EvidenceGoalType;
	/** Control numbers (ControlRecord.number) this EG is evidence for. An EG can — and ideally does — back more than one control. */
	controlNumbers: string[];
}

export interface InterviewSessionPlan {
	session: string;
	evidenceGoals: EvidenceGoal[];
}

export function generateEvidenceGoalId(): string {
	return `eg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyEvidenceGoal(controlNumber: string): EvidenceGoal {
	return {
		id: generateEvidenceGoalId(),
		name: '',
		description: '',
		questions: [],
		type: 'screenshot',
		controlNumbers: controlNumber ? [controlNumber] : [],
	};
}

export function emptySessionPlan(session: string): InterviewSessionPlan {
	return { session, evidenceGoals: [] };
}

/**
 * Every character Obsidian forbids in filenames is stripped — used for the session, which doubles as
 * the session plan note's filename. Mirrors `sanitizeFileTitle` in controlNote.ts.
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

function buildEvidenceGoalSection(eg: EvidenceGoal): string {
	return [
		`## EG: ${eg.name || '(untitled)'}`,
		'',
		`ID: ${eg.id}`,
		`Type: ${typeLabel(eg.type)}`,
		`Controls: ${eg.controlNumbers.join(', ')}`,
		'',
		'### Description',
		'',
		eg.description,
		'',
		'### Questions',
		'',
		...(eg.questions.length > 0 ? eg.questions.map((q) => `- ${q}`) : ['(none)']),
	].join('\n');
}

export function buildSessionPlanContent(plan: InterviewSessionPlan): string {
	const header = `# Interview session plan: ${plan.session}`;
	if (plan.evidenceGoals.length === 0) return `${header}\n`;
	return [header, '', ...plan.evidenceGoals.map(buildEvidenceGoalSection)].join('\n\n');
}

/** Parses a session plan note back into structured EGs. `fallbackSession` is used when the content has no title line (the filename itself is the session). */
export function parseSessionPlanContent(content: string, fallbackSession = ''): InterviewSessionPlan {
	const titleMatch = /^#\s*Interview session plan:\s*(.*)$/m.exec(content);
	const session = (titleMatch?.[1] ?? '').trim() || fallbackSession;

	const evidenceGoals: EvidenceGoal[] = [];
	const sections = content.split(/^##\s*EG:\s*/m).slice(1);
	for (const section of sections) {
		const nameMatch = /^(.*)$/.exec(section);
		const name = (nameMatch?.[1] ?? '').trim();

		const idMatch = /^ID:\s*(.*)$/m.exec(section);
		const typeMatch = /^Type:\s*(.*)$/m.exec(section);
		const controlsMatch = /^Controls:\s*(.*)$/m.exec(section);

		const descMatch = /^###\s*Description\s*\n([\s\S]*?)(?=\n###\s*Questions|$)/m.exec(section);
		const questionsMatch = /^###\s*Questions\s*\n([\s\S]*)$/m.exec(section);

		const description = (descMatch?.[1] ?? '').trim();
		const questionsBlock = (questionsMatch?.[1] ?? '').trim();
		const questions = questionsBlock && questionsBlock !== '(none)'
			? questionsBlock
				.split(/\r?\n/)
				.map((line) => line.replace(/^\s*-\s*/, '').trim())
				.filter(Boolean)
			: [];

		evidenceGoals.push({
			id: (idMatch?.[1] ?? '').trim() || generateEvidenceGoalId(),
			name,
			description,
			questions,
			type: parseType(typeMatch?.[1] ?? ''),
			controlNumbers: (controlsMatch?.[1] ?? '')
				.split(',')
				.map((c) => c.trim())
				.filter(Boolean),
		});
	}

	return { session, evidenceGoals };
}
