import ExcelJS from 'exceljs';
import type { Vault, TFile } from 'obsidian';

const MAX_PREVIEW_ROWS = 5;
const MAX_HEADER_SCAN_ROWS = 20;

export interface WorkbookPreview {
	headers: string[];
	/** Number of data rows, excluding the header row. */
	rowCount: number;
	sampleRows: string[][];
	/** 1-based row number the header was found on — persisted by the Excel link so it can address the same row directly on later syncs without re-sniffing. */
	headerRowNumber: number;
	/** 1-based column number that `headers[0]`/`sampleRows[r][0]` corresponds to — a defined Excel Table can anchor anywhere on the sheet, so `headers`/row arrays are NOT always aligned to column 1. The Excel link's column-number-based mapping (immune to header text issues like embedded line breaks or duplicate names) depends on this to convert its stored column numbers into array indices: `index = columnNumber - startColumn`. */
	startColumn: number;
}

export function cellToString(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (typeof value === 'object') {
		if ('text' in value && typeof value.text === 'string') return value.text;
		if ('result' in value) return cellToString(value.result);
		if ('richText' in value && Array.isArray(value.richText)) {
			return (value.richText as { text: string }[]).map((r) => r.text).join('');
		}
	}
	return `[${Object.prototype.toString.call(value)}]`;
}

async function loadWorkbook(vault: Vault, file: TFile): Promise<ExcelJS.Workbook> {
	const buffer = await vault.readBinary(file);
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer);
	return workbook;
}

function getSheet(workbook: ExcelJS.Workbook, sheetName?: string): ExcelJS.Worksheet {
	const sheet = sheetName ? workbook.getWorksheet(sheetName) : workbook.worksheets[0];
	if (!sheet) throw new Error(sheetName ? `Sheet "${sheetName}" not found.` : 'Workbook has no worksheets.');
	return sheet;
}

/** Lists sheet names in workbook order, for the user to pick which one to import from. */
export async function readWorkbookSheetNames(vault: Vault, file: TFile): Promise<string[]> {
	const workbook = await loadWorkbook(vault, file);
	return workbook.worksheets.map((s) => s.name);
}

interface TabularData {
	headers: string[];
	rows: string[][];
	headerRowNumber: number;
	startColumn: number;
}

interface RawTableModel {
	name: string;
	ref: string;
	headerRow?: boolean;
	columns: { name?: string }[];
}

/**
 * Excel "Tables" (ListObjects, inserted via Insert > Table) carry their own header/column
 * definitions and data range independent of where they sit on the sheet — a plain
 * "first row = header" assumption misreads them whenever the table doesn't start at row 1, or
 * there's a title/merged banner row above it. When a table is defined, use its own header names
 * and its own start position instead of guessing from raw cells.
 *
 * Note: exceljs' `Table` wrapper (from `worksheet.getTables()`) does NOT expose `.columns`/`.rows`
 * as usable properties once loaded from an existing file (only `.name`/`.ref`/`.headerRow` are real
 * getters; the documented `.columns`/`.rows` only work for tables freshly created via
 * `addTable()`). The real, loaded column/range definitions live on the wrapper's `.model` — so that
 * is read directly here, and the actual data is then pulled from the worksheet at the table's own
 * anchor position rather than from the (empty) `.rows`.
 */
function extractFromDefinedTable(sheet: ExcelJS.Worksheet): TabularData | null {
	const tables = sheet.getTables() as unknown as { model: RawTableModel }[];
	const model = tables[0]?.model;
	if (!model?.ref || !model.columns?.length) return null;

	const [topLeftAddress, bottomRightAddress] = model.ref.split(':');
	if (!topLeftAddress) return null;
	const anchor = sheet.getCell(topLeftAddress);
	const startRow = Number(anchor.row);
	const startCol = Number(anchor.col);
	const hasHeaderRow = model.headerRow !== false;

	const headers = model.columns.map((c, i) => (c.name ? String(c.name) : `Column ${i + 1}`));
	const dataStartRow = startRow + (hasHeaderRow ? 1 : 0);
	// The table's own `ref` end row, when present, is the authoritative bound — falling back to the
	// whole sheet only if it's somehow missing. Either way, a blank row partway through (a common
	// section-separator in audit templates) is skipped, never treated as "end of table": a prior
	// version `break`-ed on the first blank row, silently dropping every real row after it.
	const endRow = bottomRightAddress ? Number(sheet.getCell(bottomRightAddress).row) : sheet.rowCount;

	const rows: string[][] = [];
	for (let r = dataStartRow; r <= endRow; r++) {
		const row = sheet.getRow(r);
		const values = headers.map((_, i) => cellToString(row.getCell(startCol + i).value));
		if (values.every((v) => v.trim() === '')) continue;
		rows.push(values);
	}
	return { headers, rows, headerRowNumber: startRow, startColumn: startCol };
}

/** True for a cell that isn't part of a merge, or is the top-left ("master") cell of one — used so a merged banner cell isn't counted once per column it spans. */
function isCountableCell(cell: ExcelJS.Cell): boolean {
	return !cell.isMerged || cell.master === cell;
}

/** For plain (non-Table) ranges: the header row isn't always row 1 — title/banner rows above it are common — so scan for the first row that actually looks like a header (at least two distinct non-empty cells, ignoring merged-cell mirroring). */
function findHeaderRowNumber(sheet: ExcelJS.Worksheet): number {
	const maxScan = Math.min(MAX_HEADER_SCAN_ROWS, sheet.rowCount);
	for (let r = 1; r <= maxScan; r++) {
		let nonEmpty = 0;
		sheet.getRow(r).eachCell({ includeEmpty: false }, (cell) => {
			if (isCountableCell(cell)) nonEmpty++;
		});
		if (nonEmpty >= 2) return r;
	}
	return 1;
}

function extractFromRange(sheet: ExcelJS.Worksheet, headerRowOverride?: number): TabularData {
	const headerRowNumber = headerRowOverride ?? findHeaderRowNumber(sheet);
	const headerRow = sheet.getRow(headerRowNumber);
	// `headerRow.eachCell` only walks that ROW's own cell count, which can be narrower than the
	// data rows below it (e.g. the header row was never explicitly touched out to a column that
	// data rows further right do use) — silently dropping every column past that point from both
	// `headers` and `rows`. `sheet.columnCount` is the max cell count across every row in the
	// sheet, so it catches those columns too.
	const colCount = Math.max(sheet.columnCount, headerRow.cellCount);
	const headers: string[] = [];
	for (let c = 1; c <= colCount; c++) {
		headers[c - 1] = cellToString(headerRow.getCell(c).value) || `Column ${c}`;
	}

	const rows: string[][] = [];
	for (let r = headerRowNumber + 1; r <= sheet.rowCount; r++) {
		const row = sheet.getRow(r);
		const values = headers.map((_, i) => cellToString(row.getCell(i + 1).value));
		if (values.some((v) => v.trim() !== '')) rows.push(values);
	}
	return { headers, rows, headerRowNumber, startColumn: 1 };
}

/**
 * `headerRowOverride`, when given, is used verbatim instead of re-running the header-row heuristic
 * (only affects the plain-range path — a defined Table's header row comes from its own anchor,
 * which an override has no business second-guessing). The Excel link always passes its persisted
 * `headerRowNumber` here on every sync, rather than letting each call independently re-detect it:
 * without this, a sync could silently drift to a different row than the one the user confirmed at
 * configuration time if the heuristic's guess is ever ambiguous for that sheet.
 */
function extractTabularData(sheet: ExcelJS.Worksheet, headerRowOverride?: number): TabularData {
	return extractFromDefinedTable(sheet) ?? extractFromRange(sheet, headerRowOverride);
}

/** Reads only the header row and up to MAX_PREVIEW_ROWS data rows of the given sheet — shown to the user while they manually map columns. */
export async function readWorkbookPreview(vault: Vault, file: TFile, sheetName?: string, headerRowOverride?: number): Promise<WorkbookPreview> {
	const workbook = await loadWorkbook(vault, file);
	const { headers, rows, headerRowNumber, startColumn } = extractTabularData(getSheet(workbook, sheetName), headerRowOverride);
	return { headers, rowCount: rows.length, sampleRows: rows.slice(0, MAX_PREVIEW_ROWS), headerRowNumber, startColumn };
}

/** Reads every data row (excluding the header) of the given sheet, as arrays aligned to the headers returned by `readWorkbookPreview` for the same file/sheet (same `startColumn` offset applies). */
export async function readWorkbookRows(vault: Vault, file: TFile, sheetName?: string, headerRowOverride?: number): Promise<string[][]> {
	const workbook = await loadWorkbook(vault, file);
	return extractTabularData(getSheet(workbook, sheetName), headerRowOverride).rows;
}
