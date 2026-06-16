/** A single editable section in the structured document, identified by its heading. */
export interface SectionDef {
	id: string;
	heading: string;
	level: 2 | 3;
	/** 'text' (default) renders a plain textarea; 'images' renders a paste-image gallery. */
	kind?: 'text' | 'images';
	children?: SectionDef[];
}

/**
 * The fixed 4-section skeleton: Control, Indications, Findings (with
 * Findings/Observations-recommendations/Evidence/Images nested underneath it).
 */
export const SECTION_TREE: SectionDef[] = [
	{ id: 'control', heading: 'Control', level: 2 },
	{ id: 'indications', heading: 'Indications', level: 2 },
	{
		id: 'findings',
		heading: 'Findings',
		level: 2,
		children: [
			{ id: 'findings.findings', heading: 'Findings', level: 3 },
			{
				id: 'findings.observations',
				heading: 'Observations / Recommendations',
				level: 3,
			},
			{ id: 'findings.evidence', heading: 'Evidence', level: 3 },
			{ id: 'findings.images', heading: 'Images', level: 3, kind: 'images' },
		],
	},
];

/** Flattens the tree into the document-order list of leaf sections that actually hold text. */
export function leafSections(tree: SectionDef[] = SECTION_TREE): SectionDef[] {
	const out: SectionDef[] = [];
	for (const node of tree) {
		if (node.children?.length) {
			out.push(...leafSections(node.children));
		} else {
			out.push(node);
		}
	}
	return out;
}

interface HeadingLine {
	level: number;
	text: string;
	lineIdx: number;
}

function findHeadings(lines: string[]): HeadingLine[] {
	const headings: HeadingLine[] = [];
	const re = /^(#{1,6})\s+(.*)\s*$/;
	for (let i = 0; i < lines.length; i++) {
		const match = re.exec(lines[i]!);
		if (match) {
			headings.push({
				level: match[1]!.length,
				text: match[2]!.trim(),
				lineIdx: i,
			});
		}
	}
	return headings;
}

function matchesHeading(
	h: HeadingLine,
	heading: string,
	level: number,
): boolean {
	return h.level === level && h.text.toLowerCase() === heading.toLowerCase();
}

/** Returns the trimmed body text under the given heading, or '' if the heading isn't present. */
export function getSection(
	content: string,
	heading: string,
	level: 2 | 3,
): string {
	const lines = content.split('\n');
	const headings = findHeadings(lines);
	const idx = headings.findIndex((h) => matchesHeading(h, heading, level));
	if (idx === -1) return '';
	const start = headings[idx]!.lineIdx + 1;
	const end =
		idx + 1 < headings.length ? headings[idx + 1]!.lineIdx : lines.length;
	return lines.slice(start, end).join('\n').trim();
}

/**
 * Returns the document with the body under `heading` replaced by `newText`. If the
 * heading doesn't exist yet, it (and its body) is appended at the end of the file.
 */
export function setSection(
	content: string,
	heading: string,
	level: 2 | 3,
	newText: string,
): string {
	const lines = content.split('\n');
	const headings = findHeadings(lines);
	const idx = headings.findIndex((h) => matchesHeading(h, heading, level));
	const body = newText.trim();

	if (idx === -1) {
		const prefix = '#'.repeat(level);
		const sep =
			content.length > 0 && !content.endsWith('\n\n') ? '\n\n' : '';
		return `${content}${sep}${prefix} ${heading}\n\n${body}\n`;
	}

	const start = headings[idx]!.lineIdx + 1;
	const end =
		idx + 1 < headings.length ? headings[idx + 1]!.lineIdx : lines.length;
	const before = lines.slice(0, start);
	const after = lines.slice(end);
	const newBody = body.length > 0 ? ['', body, ''] : [''];
	return [...before, ...newBody, ...after].join('\n');
}

/** Generates a fresh note body with every section heading present (empty) in document order. */
export function buildSkeleton(): string {
	let body = '';
	for (const node of SECTION_TREE) {
		body += `${'#'.repeat(node.level)} ${node.heading}\n\n`;
		if (node.children) {
			for (const child of node.children) {
				body += `${'#'.repeat(child.level)} ${child.heading}\n\n`;
			}
		}
	}
	return body.trimEnd() + '\n';
}
