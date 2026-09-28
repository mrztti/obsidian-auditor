export interface DiffPart {
	type: 'same' | 'add' | 'del';
	text: string;
}

/** Above this many token pairs the O(n·m) table gets too heavy for the UI thread; we fall back to "old replaced by new". */
const MAX_LCS_CELLS = 2_000_000;

function tokenize(text: string): string[] {
	return text.split(/(\s+)/).filter((t) => t !== '');
}

function pushPart(parts: DiffPart[], type: DiffPart['type'], text: string): void {
	const last = parts[parts.length - 1];
	if (last && last.type === type) last.text += text;
	else parts.push({ type, text });
}

/** Word-level diff (whitespace kept as tokens so the output re-joins to the exact text) via longest-common-subsequence. */
export function diffWords(before: string, after: string): DiffPart[] {
	if (before === after) return before ? [{ type: 'same', text: before }] : [];
	const a = tokenize(before);
	const b = tokenize(after);

	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

	const parts: DiffPart[] = [];
	if (start > 0) pushPart(parts, 'same', a.slice(0, start).join(''));

	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	const n = midA.length;
	const m = midB.length;

	if (n * m > MAX_LCS_CELLS) {
		if (n > 0) pushPart(parts, 'del', midA.join(''));
		if (m > 0) pushPart(parts, 'add', midB.join(''));
	} else {
		const width = m + 1;
		const table = new Uint32Array((n + 1) * width);
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				table[i * width + j] = midA[i] === midB[j]
					? table[(i + 1) * width + j + 1]! + 1
					: Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
			}
		}
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (midA[i] === midB[j]) { pushPart(parts, 'same', midA[i]!); i++; j++; }
			else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) { pushPart(parts, 'del', midA[i]!); i++; }
			else { pushPart(parts, 'add', midB[j]!); j++; }
		}
		while (i < n) pushPart(parts, 'del', midA[i++]!);
		while (j < m) pushPart(parts, 'add', midB[j++]!);
	}

	if (endA < a.length) pushPart(parts, 'same', a.slice(endA).join(''));
	return parts;
}
