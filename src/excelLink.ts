import XlsxPopulate, { type Cell, type Sheet } from 'xlsx-populate';
import { TFile } from 'obsidian';
import type AuditorPlugin from './main';
import { ControlStore } from './agent/controlStore';
import {
	CONTROL_FIELD_KEYS,
	buildControlNoteContent,
	emptyControlRecord,
	type ControlFieldKey,
	type ControlRating,
	type ControlRecord,
} from './controlNote';
import type { ExcelLinkConfig } from './settings';
import { readWorkbookPreview, readWorkbookRows } from './controlImport';

export function isExcelLinkConfigured(config: ExcelLinkConfig): boolean {
	return config.filePath.trim() !== '' && config.sheetName.trim() !== '' && config.headerRowNumber > 0 && config.keyColumn > 0;
}

/** Turns free-text rating cells (e.g. "Non-conformant", "Conform w/ observation") into the canonical rating code. */
export function normalizeRating(raw: string): ControlRating {
	const v = raw.trim();
	if (v === 'C' || v === 'C*' || v === 'NC' || v === '-') return v;
	const lower = v.toLowerCase();
	if (!lower) return '';
	if (lower === 'n/a' || lower === 'na' || lower === 'not applicable') return '-';
	if (lower.includes('non') && lower.includes('conform')) return 'NC';
	if (lower.includes('conform') && (lower.includes('*') || lower.includes('observ') || lower.includes('minor'))) return 'C*';
	if (lower.includes('conform')) return 'C';
	return '';
}

/** `Cell.value()` can return a `RichText` instance (any cell already holding rich text, or one this plugin wrote); `String(richText)` would stringify to the useless "[object Object]", so its own `.text()` is used instead. */
function cellValueToString(value: string | number | boolean | Date | InstanceType<typeof XlsxPopulate.RichText> | null | undefined): string {
	if (value === undefined || value === null) return '';
	if (value instanceof XlsxPopulate.RichText) return value.text();
	return String(value);
}

/**
 * XML 1.0 (what sharedStrings.xml and every worksheet XML is) forbids most ASCII control
 * characters outright (`Char ::= #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] |
 * [#x10000-#x10FFFF]`) and unpaired surrogates. Written text here ultimately comes from drafted
 * conclusions and whatever the source evidence/PDF extraction produced, which can silently carry a
 * stray NUL, form feed, or similar byte without it being visible anywhere in the UI — a single one
 * is enough for Excel to refuse the file outright ("we found a problem with some content") and
 * discard whole sheets while "recovering" it. Every string actually written to a cell is sanitized
 * through this first, rather than trusting the source was already clean.
 */
// eslint-disable-next-line no-control-regex -- stripping these control characters is the entire point
const ILLEGAL_XML_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g;

function sanitizeForExcel(text: string): string {
	return text.replace(ILLEGAL_XML_CHARS, '').replace(LONE_SURROGATE, (m) => m.slice(0, -1));
}

function excelFile(plugin: AuditorPlugin, config: ExcelLinkConfig): TFile {
	const file = plugin.app.vault.getAbstractFileByPath(config.filePath);
	if (!(file instanceof TFile)) throw new Error(`Linked spreadsheet "${config.filePath}" was not found in the vault.`);
	return file;
}

function lastUsedRow(sheet: Sheet): number {
	const used = sheet.usedRange();
	return used ? used.endCell().rowNumber() : 0;
}

/**
 * Conclusion text follows the structure the writing rules dictate — "Findings:", then
 * "Observations/Recommendations:" (or just "Observations:"/"Recommendations:"), then "Evidence:" —
 * but the model doesn't always keep the title on its own line (e.g. "Findings: No policies were
 * found…"), so this matches the title as a PREFIX of the line, case-insensitively, leaving whatever
 * follows it on that same line untouched.
 */
const SECTION_TITLE_PATTERN = /^(Findings?|Observations?\s*\/\s*Recommendations?|Observations?|Recommendations?|Evidence)\s*:/i;
const FINDINGS_TITLE_PATTERN = /^Findings?\s*:/i;

interface SectionTitleMatch {
	/** The matched title text (including leading whitespace and the colon) — the part made bold. */
	prefix: string;
	isFindings: boolean;
}

function matchSectionTitle(line: string): SectionTitleMatch | null {
	const leadingWs = /^\s*/.exec(line)?.[0] ?? '';
	const rest = line.slice(leadingWs.length);
	const m = SECTION_TITLE_PATTERN.exec(rest);
	if (!m) return null;
	return { prefix: leadingWs + m[0], isFindings: FINDINGS_TITLE_PATTERN.test(rest) };
}

/**
 * Rewrites conclusion text so every recognized section title (FR: "make each of the section titles
 * bold… and enforce that they have an empty line above all of them except for finding") gets
 * exactly one blank line directly above it — collapsing any existing run of blank lines down to
 * one, or inserting one if there isn't any — while "Findings"/"Finding" is left exactly where it
 * is, never gaining a forced blank line above it (it's the section that opens the conclusion).
 * Returns the rewritten text plus the character ranges (into that text) that should be bolded.
 */
function enforceSectionSpacing(text: string): { finalText: string; boldRanges: [number, number][] } {
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const outLines: string[] = [];
	const boldByLine = new Map<number, number>(); // output line index -> bold prefix length

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
	const boldRanges: [number, number][] = [];
	let offset = 0;
	for (let i = 0; i < outLines.length; i++) {
		const boldLength = boldByLine.get(i);
		if (boldLength !== undefined) boldRanges.push([offset, offset + boldLength]);
		offset += (outLines[i]?.length ?? 0) + 1;
	}
	return { finalText, boldRanges };
}

/** Style keys carried from the cell's existing (pre-rich-text) formatting into every rich-text run — without this, a run with no style of its own renders in Excel's default font/size rather than whatever font/size/color the template's cell actually had, since run-level formatting (not the cell's) governs how rich text displays. */
const CARRIED_FONT_STYLES = ['fontFamily', 'fontSize', 'fontColor', 'italic', 'underline', 'strikethrough', 'bold'] as const;

function readCellFontStyle(cell: Cell): Record<string, unknown> {
	const style = cell.style([...CARRIED_FONT_STYLES]);
	const present: Record<string, unknown> = {};
	for (const key of CARRIED_FONT_STYLES) {
		if (style[key] !== undefined && style[key] !== null) present[key] = style[key];
	}
	return present;
}

/**
 * Builds a rich-text cell value with each section title bolded, or a plain string when there are no
 * recognized titles to bold (so a field with no section structure isn't wrapped in rich text for no
 * reason). `baseFontStyle` (the cell's own current font/size/etc., read before this overwrites its
 * value) is applied to every run so nothing but the enforced bolding/spacing actually changes —
 * title runs get it plus `bold: true`; everything else gets it unchanged, original bold state
 * included.
 */
function buildConclusionCellValue(text: string, baseFontStyle: Record<string, unknown>): string | InstanceType<typeof XlsxPopulate.RichText> {
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

export interface SyncToExcelResult {
	/** Control numbers found in the sheet and written to. */
	updated: number;
	/** Control numbers that exist in the vault but have no matching row in the sheet — never appended, per the Excel link's "lookup only" contract. */
	notInSheet: number;
}

/**
 * Writes every mapped field of every vault control into the linked sheet, matched to a row purely
 * by control-number lookup against `keyColumn` — never inserting, reordering, or restyling rows.
 * Only the specific cells named in `config.mapping` ever have `.value()` called on them, so every
 * other cell's formatting, formulas, and content are left completely untouched. Columns are
 * addressed purely by their persisted column NUMBER (see `ExcelLinkConfig`) — never by re-reading
 * header text, which can't be trusted to match byte-for-byte (e.g. a wrapped header cell carries an
 * embedded line break that will never again match whatever was captured at configuration time).
 */
export async function syncToExcel(plugin: AuditorPlugin): Promise<SyncToExcelResult> {
	const config = plugin.settings.excelLink;
	if (!isExcelLinkConfigured(config)) throw new Error('No Excel link is configured yet.');

	const file = excelFile(plugin, config);
	const buffer = await plugin.app.vault.readBinary(file);
	const workbook = await XlsxPopulate.fromDataAsync(buffer);
	const sheet = workbook.sheet(config.sheetName);
	if (!sheet) throw new Error(`Sheet "${config.sheetName}" was not found in "${config.filePath}".`);

	const mappedCols: { field: ControlFieldKey; col: number }[] = [];
	for (const field of CONTROL_FIELD_KEYS) {
		const col = config.mapping[field];
		if (col) mappedCols.push({ field, col });
	}

	const endRow = lastUsedRow(sheet);
	const rowByNumber = new Map<string, number>();
	for (let r = config.headerRowNumber + 1; r <= endRow; r++) {
		const key = cellValueToString(sheet.cell(r, config.keyColumn).value()).trim();
		if (key) rowByNumber.set(key, r);
	}

	const entries = await new ControlStore(plugin).listAll();
	let updated = 0;
	let notInSheet = 0;
	for (const entry of entries) {
		const record = entry.record;
		const rowNumber = rowByNumber.get(record.number.trim());
		if (!rowNumber) { notInSheet++; continue; }
		for (const { field, col } of mappedCols) {
			const cell = sheet.cell(rowNumber, col);
			const value = field === 'todConclusion' || field === 'toeConclusion'
				? buildConclusionCellValue(record[field], readCellFontStyle(cell))
				: sanitizeForExcel(record[field]);
			cell.value(value);
		}
		updated++;
	}

	if (updated > 0) {
		const out = await workbook.outputAsync({ type: 'arraybuffer' }) as ArrayBuffer;
		await plugin.app.vault.modifyBinary(file, out);
	}
	return { updated, notInSheet };
}

export interface SyncFromExcelResult {
	updated: number;
	created: number;
	failed: { number: string; error: string }[];
}

export interface SyncFromExcelPreview {
	/** Control numbers that already have a note — syncing will OVERWRITE their mapped fields. */
	toOverwrite: string[];
	/** Control numbers with no existing note — syncing will create them fresh. */
	toCreate: number;
}

/**
 * Looks at what `syncFromExcel` would do, without writing anything — specifically how many existing
 * control notes would be overwritten — so the caller can confirm with the user before an
 * irreversible bulk overwrite happens.
 */
export async function previewSyncFromExcel(plugin: AuditorPlugin): Promise<SyncFromExcelPreview> {
	const config = plugin.settings.excelLink;
	if (!isExcelLinkConfigured(config)) throw new Error('No Excel link is configured yet.');

	const file = excelFile(plugin, config);
	const rows = await readWorkbookRows(plugin.app.vault, file, config.sheetName, config.headerRowNumber);
	const preview = await readWorkbookPreview(plugin.app.vault, file, config.sheetName, config.headerRowNumber);
	const keyIndex = config.keyColumn - preview.startColumn;
	const gateIndex = config.gateColumn ? config.gateColumn - preview.startColumn : undefined;

	const byNumber = new Map((await new ControlStore(plugin).listAll()).map((e) => [e.record.number.trim(), e]));

	const toOverwrite: string[] = [];
	let toCreate = 0;
	for (const row of rows) {
		const number = (row[keyIndex] ?? '').trim();
		if (!number) continue;
		if (gateIndex !== undefined && !(row[gateIndex] ?? '').trim()) continue;
		if (byNumber.has(number)) toOverwrite.push(number);
		else toCreate++;
	}
	return { toOverwrite, toCreate };
}

/**
 * Reads every mapped field from the linked sheet (via the same exceljs-based reader the one-shot
 * import wizard used to use) and merges it into the matching vault control note, looked up by
 * `keyColumn`'s value — a control note not already in the vault is created instead. Unlike a
 * one-shot import, fields NOT included in `config.mapping` are left exactly as they are on the
 * existing note (e.g. comments, audit guidance) rather than being blanked out. Columns are
 * addressed by their persisted column NUMBER — see `syncToExcel`'s doc comment for why.
 */
export async function syncFromExcel(plugin: AuditorPlugin): Promise<SyncFromExcelResult> {
	const config = plugin.settings.excelLink;
	if (!isExcelLinkConfigured(config)) throw new Error('No Excel link is configured yet.');

	const file = excelFile(plugin, config);
	// The header ROW is pinned to what was confirmed at configuration time (`config.headerRowNumber`)
	// rather than re-detected here — otherwise a sync could silently land on a different row than the
	// one the user actually mapped, if the auto-detection heuristic is ever ambiguous for this sheet
	// (e.g. a banner/title row above the real header).
	const rows = await readWorkbookRows(plugin.app.vault, file, config.sheetName, config.headerRowNumber);
	const preview = await readWorkbookPreview(plugin.app.vault, file, config.sheetName, config.headerRowNumber);
	// `rows[r][i]` corresponds to absolute column `preview.startColumn + i` — a defined Excel Table
	// can anchor anywhere on the sheet, so the row arrays are not always aligned to column 1.
	const colIndex = (columnNumber: number): number => columnNumber - preview.startColumn;

	const keyIndex = colIndex(config.keyColumn);
	const gateIndex = config.gateColumn ? colIndex(config.gateColumn) : undefined;

	const controlStore = new ControlStore(plugin);
	const byNumber = new Map((await controlStore.listAll()).map((e) => [e.record.number.trim(), e]));

	let updated = 0;
	let created = 0;
	const failed: SyncFromExcelResult['failed'] = [];
	const touched: TFile[] = [];

	for (const row of rows) {
		const number = (row[keyIndex] ?? '').trim();
		if (!number) continue;
		if (gateIndex !== undefined && !(row[gateIndex] ?? '').trim()) continue;
		try {
			const existing = byNumber.get(number);
			const base: ControlRecord = existing ? { ...existing.record, comments: [...existing.record.comments] } : emptyControlRecord(number);
			for (const field of CONTROL_FIELD_KEYS) {
				const col = config.mapping[field];
				if (!col) continue;
				const raw = row[colIndex(col)] ?? '';
				if (field === 'todRating' || field === 'toeRating') base[field] = normalizeRating(raw);
				else (base as unknown as Record<string, string>)[field] = raw;
			}
			if (existing) {
				await plugin.app.vault.modify(existing.file, buildControlNoteContent(base));
				touched.push(existing.file);
				updated++;
			} else {
				const path = plugin.controlNotePath(base);
				const created_ = await plugin.app.vault.create(path, buildControlNoteContent(base));
				touched.push(created_);
				created++;
			}
		} catch (e) {
			failed.push({ number, error: String(e) });
		}
	}

	if (touched.length > 0) {
		void plugin.spotIndexFiles('writtenControls', touched);
		plugin.refreshControlsViews();
	}
	return { updated, created, failed };
}
