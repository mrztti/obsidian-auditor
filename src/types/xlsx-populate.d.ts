/**
 * Minimal ambient types for xlsx-populate — no official/@types package exists, and the library is
 * used here for exactly one job: load an existing .xlsx, write into a handful of already-populated
 * cells, and save it back without touching anything else's formatting. Only the surface this plugin
 * actually calls is declared; everything else in the real library is untyped (`any`) rather than
 * reproducing its full, much larger API here.
 */
declare module 'xlsx-populate' {
	export class RichText {
		constructor();
		add(text: string, styles?: Record<string, unknown>, index?: number): RichText;
		text(): string;
		readonly length: number;
	}

	export class Cell {
		value(): string | number | boolean | Date | RichText | null | undefined;
		value(value: string | number | boolean | Date | RichText | null): Cell;
		rowNumber(): number;
		columnNumber(): number;
		style(name: string): unknown;
		style(names: string[]): Record<string, unknown>;
		style(name: string, value: unknown): Cell;
		style(styles: Record<string, unknown>): Cell;
	}

	export class Row {
		cell(columnNumber: number): Cell;
	}

	export class Range {
		endCell(): Cell;
	}

	export class Sheet {
		name(): string;
		row(rowNumber: number): Row;
		cell(rowNumber: number, columnNumber: number): Cell;
		usedRange(): Range | undefined;
	}

	export class Workbook {
		sheet(nameOrIndex: string | number): Sheet | undefined;
		sheets(): Sheet[];
		outputAsync(opts?: { type?: string }): Promise<ArrayBuffer | Uint8Array | Blob | string>;
	}

	interface XlsxPopulateStatic {
		fromDataAsync(data: ArrayBuffer | Uint8Array | Blob, opts?: Record<string, unknown>): Promise<Workbook>;
		fromBlankAsync(): Promise<Workbook>;
		RichText: typeof RichText;
	}

	const XlsxPopulate: XlsxPopulateStatic;
	export default XlsxPopulate;
}
