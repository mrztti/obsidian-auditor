/**
 * An Evidence Result (ER) is the actual interview output captured against one Evidence Goal (EG):
 * freeform notes plus pasted screenshots. It is a completely separate note from the EG's own
 * definition note, keyed by the EG's ID rather than embedded in it — so creating, editing, or even
 * deleting an EG (e.g. during a "prepare session" re-run or a merge/compression pass) never touches
 * — let alone overwrites — the ER data already captured for it.
 */

export interface EvidenceResult {
	evidenceGoalId: string;
	notes: string;
	/** Vault paths (not bare filenames, to stay unambiguous) of pasted screenshot/file attachments, embedded as `![[path]]` on save. */
	screenshotPaths: string[];
}

export function emptyEvidenceResult(evidenceGoalId: string): EvidenceResult {
	return { evidenceGoalId, notes: '', screenshotPaths: [] };
}

export function buildEvidenceResultContent(result: EvidenceResult): string {
	return [
		'## Evidence Goal', '', result.evidenceGoalId, '',
		'## Notes', '', result.notes, '',
		'## Screenshots', '',
		...(result.screenshotPaths.length > 0 ? result.screenshotPaths.map((p) => `![[${p}]]`) : ['(none)']),
	].join('\n');
}

/** Parses an ER note back into structured data. `fallbackId` is used when the content has no explicit "Evidence Goal" section (shouldn't normally happen — the note is always created with one). */
export function parseEvidenceResultContent(content: string, fallbackId: string): EvidenceResult {
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

	const screenshotsBlock = sections.get('Screenshots') ?? '';
	const screenshotPaths = screenshotsBlock && screenshotsBlock !== '(none)'
		? screenshotsBlock
			.split(/\r?\n/)
			.map((line) => /!\[\[([^\]]+)\]\]/.exec(line)?.[1])
			.filter((p): p is string => Boolean(p))
		: [];

	return {
		evidenceGoalId: (sections.get('Evidence Goal') ?? '').trim() || fallbackId,
		notes: sections.get('Notes') ?? '',
		screenshotPaths,
	};
}
