import XlsxPopulate from 'xlsx-populate';

// eslint-disable-next-line no-control-regex
const ILLEGAL_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g;
function sanitizeForExcel(text) {
	return text.replace(ILLEGAL_XML_CHARS, '').replace(LONE_SURROGATE, (m) => m.slice(0, -1));
}

const SECTION_TITLE_PATTERN = /^(Findings?|Observations?\s*\/\s*Recommendations?|Observations?|Recommendations?|Evidence)\s*:/i;
const FINDINGS_TITLE_PATTERN = /^Findings?\s*:/i;
function matchSectionTitle(line) {
	const leadingWs = /^\s*/.exec(line)?.[0] ?? '';
	const rest = line.slice(leadingWs.length);
	const m = SECTION_TITLE_PATTERN.exec(rest);
	if (!m) return null;
	return { prefix: leadingWs + m[0], isFindings: FINDINGS_TITLE_PATTERN.test(rest) };
}
function enforceSectionSpacing(text) {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const outLines = [];
	const boldByLine = new Map();
	for (const line of lines) {
		const title = matchSectionTitle(line);
		if (title && !title.isFindings) {
			while (outLines.length > 0 && outLines[outLines.length - 1]?.trim() === '') outLines.pop();
			if (outLines.length > 0) outLines.push('');
		}
		if (title) boldByLine.set(outLines.length, title.prefix.length);
		outLines.push(line);
	}
	const finalText = outLines.join('\n');
	const boldRanges = [];
	let offset = 0;
	for (let i = 0; i < outLines.length; i++) {
		const boldLength = boldByLine.get(i);
		if (boldLength !== undefined) boldRanges.push([offset, offset + boldLength]);
		offset += (outLines[i]?.length ?? 0) + 1;
	}
	return { finalText, boldRanges };
}
function buildConclusionCellValue(text, baseFontStyle) {
	const { finalText, boldRanges } = enforceSectionSpacing(sanitizeForExcel(text));
	if (boldRanges.length === 0) return finalText;
	const richText = new XlsxPopulate.RichText();
	let pos = 0;
	for (const [start, end] of boldRanges) {
		if (start > pos) richText.add(finalText.slice(pos, start), baseFontStyle);
		richText.add(finalText.slice(start, end), { ...baseFontStyle, bold: true });
		pos = end;
	}
	if (pos < finalText.length) richText.add(finalText.slice(pos), baseFontStyle);
	return richText;
}

const realText = `Findings: No policies, configurations, or technical evidence were provided to verify compliance with clause SRG_KM.1.1 of EN 419241-1 regarding the signing keys environment and cryptographic key generation and management.
Observations/Recommendations:
It is recommended that policies, configurations, and technical evidence addressing the signing keys environment under EN 419241-1 SRG_KM.1.1 be documented and provided.
Evidence:
(none)`;

const wb = await XlsxPopulate.fromBlankAsync();
const sheet = wb.sheet(0);
const cell = sheet.cell('A1');
cell.value('placeholder');
cell.style({ fontFamily: 'Calibri', fontSize: 11 });

const base = { fontFamily: 'Calibri', fontSize: 11 };
const value = buildConclusionCellValue(realText, base);
console.log('value type:', value.constructor.name, 'length' in value ? value.length : '(string)');
cell.value(value);

const buf = await wb.outputAsync({ type: 'arraybuffer' });
const wb2 = await XlsxPopulate.fromDataAsync(buf);
const cell2 = wb2.sheet(0).cell('A1');
const reloaded = cell2.value();
console.log('--- reloaded text ---');
console.log(reloaded.text ? reloaded.text() : reloaded);
if (reloaded.length !== undefined) {
	console.log('--- runs ---');
	for (let i = 0; i < reloaded.length; i++) {
		const frag = reloaded.get(i);
		console.log(i, JSON.stringify(frag.value()), frag.style(['bold', 'fontFamily', 'fontSize']));
	}
}
