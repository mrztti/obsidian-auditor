import { jsPDF } from 'jspdf';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Header, PageBreak } from 'docx';
import type { ControlRecord } from './controlNote';
import { chipTextColorHex, ratingColorHex, readinessColorHex, statusColorHex, EXPORT_COLORS } from './exportColors';

export interface ExportControlEntry {
	record: ControlRecord;
}

/** Mirrors `readinessState` in controlsView.ts (kept local here to avoid a UI-module dependency from the export code). */
function readinessState(conclusion: string, ready: boolean): 'empty' | 'draft' | 'ready' {
	if (ready) return 'ready';
	return conclusion.trim() ? 'draft' : 'empty';
}

const READINESS_LABELS: Record<'empty' | 'draft' | 'ready', string> = { empty: 'Empty', draft: 'Draft', ready: 'Ready' };

/** jsPDF's own `.d.ts` types `splitTextToSize`'s return as `any` — this just pins it back down to `string[]`. */
function splitText(doc: jsPDF, text: string, maxWidth: number): string[] {
	return doc.splitTextToSize(text, maxWidth) as string[];
}

// ─── PDF ─────────────────────────────────────────────────────────────────

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28; // A4 pt
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;

function drawPdfChip(doc: jsPDF, x: number, y: number, text: string, bgHex: string): number {
	doc.setFontSize(8);
	doc.setFont('helvetica', 'bold');
	const textWidth = doc.getTextWidth(text);
	const chipWidth = textWidth + 12;
	const chipHeight = 14;
	doc.setFillColor(bgHex);
	doc.roundedRect(x, y, chipWidth, chipHeight, 6, 6, 'F');
	doc.setTextColor(chipTextColorHex(bgHex));
	doc.text(text, x + 6, y + chipHeight - 4.5);
	doc.setTextColor(EXPORT_COLORS.textDark);
	doc.setFont('helvetica', 'normal');
	return chipWidth;
}

function ensureSpace(doc: jsPDF, y: number, needed: number): number {
	if (y + needed > PAGE_HEIGHT - PAGE_MARGIN) {
		doc.addPage();
		return PAGE_MARGIN;
	}
	return y;
}

export function buildControlsPdf(title: string, entries: ExportControlEntry[]): jsPDF {
	const doc = new jsPDF({ unit: 'pt', format: 'a4' });

	// ─── Cover page ───────────────────────────────────────────────────────
	doc.setFillColor(EXPORT_COLORS.accent);
	doc.rect(0, 0, PAGE_WIDTH, 180, 'F');
	doc.setTextColor(EXPORT_COLORS.white);
	doc.setFont('helvetica', 'bold');
	doc.setFontSize(28);
	const titleLines = splitText(doc, title, CONTENT_WIDTH);
	doc.text(titleLines, PAGE_MARGIN, 100);
	doc.setFontSize(12);
	doc.setFont('helvetica', 'normal');
	doc.text(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }), PAGE_MARGIN, 150);
	doc.setTextColor(EXPORT_COLORS.textDark);
	doc.setFontSize(11);
	doc.text(`${entries.length} control(s)`, PAGE_MARGIN, 220);
	doc.addPage();

	// ─── Controls ────────────────────────────────────────────────────────
	let y = PAGE_MARGIN;
	for (const { record } of entries) {
		y = ensureSpace(doc, y, 60);

		doc.setFont('helvetica', 'bold');
		doc.setFontSize(13);
		doc.text(record.number || '(no number)', PAGE_MARGIN, y);
		y += 16;

		doc.setFont('helvetica', 'normal');
		doc.setFontSize(10);
		doc.setTextColor(EXPORT_COLORS.darkGray);
		doc.text(`${record.standard}${record.topic ? ` — ${record.topic}` : ''}`, PAGE_MARGIN, y);
		doc.setTextColor(EXPORT_COLORS.textDark);
		y += 14;

		// Chips row: status, ToD rating/readiness, ToE rating/readiness.
		let x = PAGE_MARGIN;
		x += drawPdfChip(doc, x, y, record.status || 'No status', statusColorHex(record.status)) + 6;
		x += drawPdfChip(doc, x, y, `ToD: ${record.todRating || '—'}`, ratingColorHex(record.todRating)) + 6;
		const todState = readinessState(record.todConclusion, record.todReady);
		x += drawPdfChip(doc, x, y, `ToD ${READINESS_LABELS[todState]}`, readinessColorHex(todState)) + 10;
		x += drawPdfChip(doc, x, y, `ToE: ${record.toeRating || '—'}`, ratingColorHex(record.toeRating)) + 6;
		const toeState = readinessState(record.toeConclusion, record.toeReady);
		drawPdfChip(doc, x, y, `ToE ${READINESS_LABELS[toeState]}`, readinessColorHex(toeState));
		y += 24;

		if (record.control.trim()) {
			doc.setFont('helvetica', 'bold');
			doc.setFontSize(9);
			y = ensureSpace(doc, y, 14);
			doc.text('Control', PAGE_MARGIN, y);
			y += 12;
			doc.setFont('helvetica', 'normal');
			doc.setFontSize(9.5);
			const lines = splitText(doc, record.control, CONTENT_WIDTH);
			for (const line of lines) {
				y = ensureSpace(doc, y, 12);
				doc.text(line, PAGE_MARGIN, y);
				y += 12;
			}
			y += 6;
		}

		if (record.todConclusion.trim()) {
			doc.setFont('helvetica', 'bold');
			doc.setFontSize(9);
			y = ensureSpace(doc, y, 14);
			doc.text('Stage 1 conclusion', PAGE_MARGIN, y);
			y += 12;
			doc.setFont('helvetica', 'normal');
			doc.setFontSize(9.5);
			const lines = splitText(doc, record.todConclusion, CONTENT_WIDTH);
			for (const line of lines) {
				y = ensureSpace(doc, y, 12);
				doc.text(line, PAGE_MARGIN, y);
				y += 12;
			}
			y += 6;
		}

		if (record.toeConclusion.trim()) {
			doc.setFont('helvetica', 'bold');
			doc.setFontSize(9);
			y = ensureSpace(doc, y, 14);
			doc.text('Stage 2 conclusion', PAGE_MARGIN, y);
			y += 12;
			doc.setFont('helvetica', 'normal');
			doc.setFontSize(9.5);
			const lines = splitText(doc, record.toeConclusion, CONTENT_WIDTH);
			for (const line of lines) {
				y = ensureSpace(doc, y, 12);
				doc.text(line, PAGE_MARGIN, y);
				y += 12;
			}
			y += 6;
		}

		y = ensureSpace(doc, y, 10);
		doc.setDrawColor(EXPORT_COLORS.lightGray);
		doc.line(PAGE_MARGIN, y, PAGE_WIDTH - PAGE_MARGIN, y);
		y += 20;
	}

	return doc;
}

// ─── DOCX ────────────────────────────────────────────────────────────────

function chipTextRun(text: string, bgHex: string): TextRun {
	return new TextRun({
		text: ` ${text} `,
		bold: true,
		color: chipTextColorHex(bgHex).replace('#', ''),
		shading: { fill: bgHex.replace('#', '') },
		size: 16,
	});
}

export async function buildControlsDocx(title: string, entries: ExportControlEntry[]): Promise<Blob> {
	const children: Paragraph[] = [
		new Paragraph({
			text: title,
			heading: HeadingLevel.TITLE,
			alignment: AlignmentType.CENTER,
			spacing: { after: 200 },
		}),
		new Paragraph({
			text: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
			alignment: AlignmentType.CENTER,
			spacing: { after: 100 },
		}),
		new Paragraph({
			text: `${entries.length} control(s)`,
			alignment: AlignmentType.CENTER,
			spacing: { after: 400 },
		}),
		new Paragraph({ children: [new PageBreak()] }),
	];

	for (const { record } of entries) {
		children.push(new Paragraph({
			text: record.number || '(no number)',
			heading: HeadingLevel.HEADING_2,
			spacing: { before: 300, after: 60 },
		}));
		children.push(new Paragraph({
			children: [new TextRun({ text: `${record.standard}${record.topic ? ` — ${record.topic}` : ''}`, italics: true, color: '555555' })],
			spacing: { after: 100 },
		}));

		const todState = readinessState(record.todConclusion, record.todReady);
		const toeState = readinessState(record.toeConclusion, record.toeReady);
		children.push(new Paragraph({
			children: [
				chipTextRun(record.status || 'No status', statusColorHex(record.status)),
				new TextRun({ text: '   ' }),
				chipTextRun(`ToD: ${record.todRating || '—'}`, ratingColorHex(record.todRating)),
				new TextRun({ text: ' ' }),
				chipTextRun(`ToD ${READINESS_LABELS[todState]}`, readinessColorHex(todState)),
				new TextRun({ text: '   ' }),
				chipTextRun(`ToE: ${record.toeRating || '—'}`, ratingColorHex(record.toeRating)),
				new TextRun({ text: ' ' }),
				chipTextRun(`ToE ${READINESS_LABELS[toeState]}`, readinessColorHex(toeState)),
			],
			spacing: { after: 150 },
		}));

		if (record.control.trim()) {
			children.push(new Paragraph({ text: 'Control', heading: HeadingLevel.HEADING_4, spacing: { before: 100, after: 40 } }));
			children.push(new Paragraph({ text: record.control, spacing: { after: 120 } }));
		}
		if (record.todConclusion.trim()) {
			children.push(new Paragraph({ text: 'Stage 1 conclusion', heading: HeadingLevel.HEADING_4, spacing: { before: 100, after: 40 } }));
			children.push(new Paragraph({ text: record.todConclusion, spacing: { after: 120 } }));
		}
		if (record.toeConclusion.trim()) {
			children.push(new Paragraph({ text: 'Stage 2 conclusion', heading: HeadingLevel.HEADING_4, spacing: { before: 100, after: 40 } }));
			children.push(new Paragraph({ text: record.toeConclusion, spacing: { after: 120 } }));
		}
	}

	const doc = new Document({
		sections: [{
			headers: {
				default: new Header({ children: [new Paragraph({ text: title, alignment: AlignmentType.RIGHT })] }),
			},
			children,
		}],
	});
	return Packer.toBlob(doc);
}
