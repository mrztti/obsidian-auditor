/** The canonical shape every written-control note is read from and saved as, everywhere in the plugin. */

export type ControlRating = '' | 'C' | 'C*' | 'NC' | '-';

/** C = conform, C* = conform but with observation, NC = non-conform with recommendation, - = not applicable. */
export const CONTROL_RATINGS: ControlRating[] = ['', 'C', 'C*', 'NC', '-'];

export const CONTROL_STATUSES = ['To-Do', 'Needs Clarification', 'Problem', 'Draft', 'Done'];

/** kebab-case CSS-safe slug for a status, used to look up its soft background colour. */
export function statusSlug(status: string): string {
	return status.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'unknown';
}

/** A single dated comment. `date` is an ISO date (YYYY-MM-DD), stamped at the moment the comment is submitted. */
export interface ControlComment {
	date: string;
	text: string;
}

export interface ControlRecord {
	/** Audit template number; also the note's filename. */
	number: string;
	standard: string;
	topic: string;
	control: string;
	session: string;
	assignedMember: string;
	status: string;
	/** Free-text Stage 1 conclusion block — the user (or the draft step) writes the whole thing, including whatever Findings/Observations-Recommendations/Evidence sub-parts belong in it. */
	todConclusion: string;
	todRating: ControlRating;
	/** Set explicitly by the user once the Stage 1 conclusion is finalized — a non-empty conclusion is only a "draft" until this is set. */
	todReady: boolean;
	/** Free-text Stage 2 conclusion block, same idea as `todConclusion`. */
	toeConclusion: string;
	toeRating: ControlRating;
	/** Same idea as `todReady`, for Stage 2. */
	toeReady: boolean;
	/** Append-only log of dated comments, oldest first — never edited or removed in place, only added to. */
	comments: ControlComment[];
}

export const CONTROL_FIELD_KEYS = [
	'number', 'standard', 'topic', 'control', 'session', 'assignedMember', 'status',
	'todConclusion', 'todRating',
	'toeConclusion', 'toeRating',
] as const;

export type ControlFieldKey = typeof CONTROL_FIELD_KEYS[number];

export function emptyControlRecord(number = ''): ControlRecord {
	return {
		number,
		standard: '',
		topic: '',
		control: '',
		session: '',
		assignedMember: '',
		status: 'To-Do',
		todConclusion: '',
		todRating: '',
		todReady: false,
		toeConclusion: '',
		toeRating: '',
		toeReady: false,
		comments: [],
	};
}

/** Today's date as an ISO `YYYY-MM-DD` string, in the local timezone — used to stamp new comments. */
export function todayIsoDate(): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** One comment per line, as `YYYY-MM-DD: text` — the reason comments are single-line is exactly so each round-trips through the note file as one line, keeping the parser trivial. Any newlines the user types into the "add comment" box are collapsed to spaces before storing. */
function formatCommentLine(comment: ControlComment): string {
	return `${comment.date}: ${comment.text.replace(/\r?\n/g, ' ').trim()}`;
}

const COMMENT_LINE_PATTERN = /^(\d{4}-\d{2}-\d{2}):\s*(.*)$/;

function parseCommentLine(line: string): ControlComment | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	const match = COMMENT_LINE_PATTERN.exec(trimmed);
	if (match) return { date: match[1] ?? '', text: match[2] ?? '' };
	// Legacy/free-text line with no date prefix (e.g. an older single free-text comment, or an imported cell) — keep it, undated.
	return { date: '', text: trimmed };
}

/**
 * Every character Obsidian forbids in filenames is stripped, trailing dots/spaces (which Windows
 * also rejects) are removed, and the result is length-capped — used for the control number, which
 * doubles as the note's filename.
 */
export function sanitizeFileTitle(title: string, maxLength = 80): string {
	const firstLine = title.split(/\r?\n/)[0] ?? '';
	const cleaned = firstLine
		.replace(/[\\/:*?"<>|]/g, '-')
		.replace(/\.\.+/g, '.')
		.trim()
		.slice(0, maxLength)
		.replace(/[\s.]+$/, '')
		.trim();
	return cleaned || 'Untitled control';
}

export function buildControlNoteContent(record: ControlRecord): string {
	return [
		'## Standard', '', record.standard, '',
		'## Topic', '', record.topic, '',
		'## Control', '', record.control, '',
		'## Session', '', record.session, '',
		'## Assigned Member', '', record.assignedMember, '',
		'## Status', '', record.status, '',
		'## ', '',
		'## Test of Design (Stage 1)', '',
		record.todConclusion, '',
		'## ToD Rating', '', record.todRating, '',
		'## ToD Ready', '', String(record.todReady), '',
		'## Test of Effectiveness (Stage 2)', '',
		record.toeConclusion, '',
		'## ToE Rating', '', record.toeRating, '',
		'## ToE Ready', '', String(record.toeReady), '',
		'## Comments', '', ...record.comments.map(formatCommentLine),
	].join('\n');
}

/** Parses the canonical control-note markdown back into a record. `fallbackNumber` is used when the content has no explicit number heading (the filename itself is the number). */
export function parseControlNoteContent(content: string, fallbackNumber = ''): ControlRecord {
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

	return {
		number: fallbackNumber,
		standard: sections.get('Standard') ?? '',
		topic: sections.get('Topic') ?? '',
		control: sections.get('Control') ?? '',
		session: sections.get('Session') ?? '',
		assignedMember: sections.get('Assigned Member') ?? '',
		status: sections.get('Status') ?? '',
		todConclusion: sections.get('Test of Design (Stage 1)') ?? '',
		todRating: (sections.get('ToD Rating') ?? '').trim() as ControlRating,
		todReady: (sections.get('ToD Ready') ?? '').trim() === 'true',
		toeConclusion: sections.get('Test of Effectiveness (Stage 2)') ?? '',
		toeRating: (sections.get('ToE Rating') ?? '').trim() as ControlRating,
		toeReady: (sections.get('ToE Ready') ?? '').trim() === 'true',
		comments: (sections.get('Comments') ?? '')
			.split(/\r?\n/)
			.map(parseCommentLine)
			.filter((c): c is ControlComment => c !== null),
	};
}
