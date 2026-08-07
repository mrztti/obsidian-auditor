import { jsPDF } from 'jspdf';
import { Document, Packer, Paragraph, TextRun, ImageRun, HeadingLevel, AlignmentType, Header, PageBreak } from 'docx';
import type { TFile, Vault } from 'obsidian';
import type { EvidenceGoal, InterviewSessionPlan } from './evidenceGoal';
import type { EvidenceResult } from './evidenceResult';
import { EXPORT_COLORS } from './exportColors';

export interface EvidenceExportItem {
	evidenceGoal: EvidenceGoal;
	result: EvidenceResult;
	/** Resolved screenshot files, in the same order as `result.screenshotPaths` (missing ones are dropped). */
	screenshots: TFile[];
}

/** Groups the session's EGs (with their loaded ERs) in the same order the session-plan view / session mode shows them: each group in order, then any ungrouped EGs. */
export function organizeEvidenceForExport(plan: InterviewSessionPlan, results: Map<string, EvidenceResult>, vault: Vault): { title: string; items: EvidenceExportItem[] }[] {
	const toItem = (eg: EvidenceGoal): EvidenceExportItem => {
		const result = results.get(eg.id) ?? { evidenceGoalId: eg.id, notes: '', screenshotPaths: [] };
		const screenshots = result.screenshotPaths
			.map((p) => vault.getAbstractFileByPath(p))
			.filter((f): f is TFile => f !== null && 'extension' in f);
		return { evidenceGoal: eg, result, screenshots };
	};

	const sections: { title: string; items: EvidenceExportItem[] }[] = [];
	for (const group of plan.groups) {
		const members = plan.evidenceGoals.filter((eg) => eg.groupId === group.id);
		if (members.length === 0) continue;
		sections.push({ title: group.title, items: members.map(toItem) });
	}
	const groupIds = new Set(plan.groups.map((g) => g.id));
	const ungrouped = plan.evidenceGoals.filter((eg) => !eg.groupId || !groupIds.has(eg.groupId));
	if (ungrouped.length > 0) sections.push({ title: 'Ungrouped', items: ungrouped.map(toItem) });
	return sections;
}

async function imageBitmapSize(data: ArrayBuffer): Promise<{ width: number; height: number } | null> {
	try {
		const bitmap = await createImageBitmap(new Blob([data]));
		const size = { width: bitmap.width, height: bitmap.height };
		bitmap.close();
		return size;
	} catch {
		return null;
	}
}

function arrayBufferToBase64(data: ArrayBuffer): string {
	let binary = '';
	const bytes = new Uint8Array(data);
	for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
	return btoa(binary);
}

/** jsPDF's own `.d.ts` types `splitTextToSize`'s return as `any` — this just pins it back down to `string[]`. */
function splitText(doc: jsPDF, text: string, maxWidth: number): string[] {
	return doc.splitTextToSize(text, maxWidth) as string[];
}

// ─── PDF ─────────────────────────────────────────────────────────────────

const PAGE_MARGIN = 40;
const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const MAX_IMAGE_WIDTH = 360;
const MAX_IMAGE_HEIGHT = 320;

function ensureSpace(doc: jsPDF, y: number, needed: number): number {
	if (y + needed > PAGE_HEIGHT - PAGE_MARGIN) {
		doc.addPage();
		return PAGE_MARGIN;
	}
	return y;
}

export async function buildEvidencePdf(title: string, session: string, sections: { title: string; items: EvidenceExportItem[] }[], vault: Vault): Promise<jsPDF> {
	const doc = new jsPDF({ unit: 'pt', format: 'a4' });

	doc.setFillColor(EXPORT_COLORS.accent);
	doc.rect(0, 0, PAGE_WIDTH, 180, 'F');
	doc.setTextColor(EXPORT_COLORS.white);
	doc.setFont('helvetica', 'bold');
	doc.setFontSize(28);
	doc.text(splitText(doc, title, CONTENT_WIDTH), PAGE_MARGIN, 100);
	doc.setFontSize(12);
	doc.setFont('helvetica', 'normal');
	doc.text(`Session: ${session}`, PAGE_MARGIN, 140);
	doc.text(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }), PAGE_MARGIN, 160);
	doc.setTextColor(EXPORT_COLORS.textDark);
	doc.addPage();

	let y = PAGE_MARGIN;
	for (const section of sections) {
		y = ensureSpace(doc, y, 30);
		doc.setFont('helvetica', 'bold');
		doc.setFontSize(16);
		doc.setTextColor(EXPORT_COLORS.accent);
		doc.text(section.title, PAGE_MARGIN, y);
		doc.setTextColor(EXPORT_COLORS.textDark);
		y += 24;

		for (const item of section.items) {
			const { evidenceGoal: eg, result, screenshots } = item;
			y = ensureSpace(doc, y, 40);
			doc.setFont('helvetica', 'bold');
			doc.setFontSize(12);
			doc.text(eg.name || '(untitled)', PAGE_MARGIN, y);
			y += 14;

			doc.setFont('helvetica', 'normal');
			doc.setFontSize(9);
			doc.setTextColor(EXPORT_COLORS.darkGray);
			doc.text(`Controls: ${eg.controlNumbers.join(', ') || '—'}`, PAGE_MARGIN, y);
			doc.setTextColor(EXPORT_COLORS.textDark);
			y += 14;

			if (eg.description.trim()) {
				doc.setFontSize(9.5);
				for (const line of splitText(doc, eg.description, CONTENT_WIDTH)) {
					y = ensureSpace(doc, y, 12);
					doc.text(line, PAGE_MARGIN, y);
					y += 12;
				}
				y += 4;
			}

			y = ensureSpace(doc, y, 14);
			doc.setFont('helvetica', 'bold');
			doc.setFontSize(9);
			doc.text('Notes', PAGE_MARGIN, y);
			y += 12;
			doc.setFont('helvetica', 'normal');
			doc.setFontSize(9.5);
			if (result.notes.trim()) {
				for (const line of splitText(doc, result.notes, CONTENT_WIDTH)) {
					y = ensureSpace(doc, y, 12);
					doc.text(line, PAGE_MARGIN, y);
					y += 12;
				}
			} else {
				doc.setTextColor(EXPORT_COLORS.gray);
				doc.text('No comments', PAGE_MARGIN, y);
				doc.setTextColor(EXPORT_COLORS.textDark);
				y += 12;
			}
			y += 4;

			y = ensureSpace(doc, y, 14);
			doc.setFont('helvetica', 'bold');
			doc.setFontSize(9);
			doc.text('Screenshots', PAGE_MARGIN, y);
			y += 12;
			doc.setFont('helvetica', 'normal');
			doc.setFontSize(9.5);
			if (screenshots.length === 0) {
				doc.setTextColor(EXPORT_COLORS.gray);
				doc.text('No screenshot', PAGE_MARGIN, y);
				doc.setTextColor(EXPORT_COLORS.textDark);
				y += 12;
			}
			for (const file of screenshots) {
				try {
					const data = await vault.readBinary(file);
					const size = await imageBitmapSize(data);
					if (!size) continue;
					const scale = Math.min(MAX_IMAGE_WIDTH / size.width, MAX_IMAGE_HEIGHT / size.height, 1);
					const w = size.width * scale;
					const h = size.height * scale;
					y = ensureSpace(doc, y, h + 10);
					const format = file.extension.toLowerCase() === 'jpg' ? 'JPEG' : file.extension.toUpperCase();
					doc.addImage(`data:image/${file.extension};base64,${arrayBufferToBase64(data)}`, format, PAGE_MARGIN, y, w, h);
					y += h + 10;
				} catch (e) {
					console.error('[Auditor] failed to embed screenshot in PDF export', file.path, e);
				}
			}

			y = ensureSpace(doc, y, 10);
			doc.setDrawColor(EXPORT_COLORS.lightGray);
			doc.line(PAGE_MARGIN, y, PAGE_WIDTH - PAGE_MARGIN, y);
			y += 18;
		}
	}

	return doc;
}

// ─── DOCX ────────────────────────────────────────────────────────────────

export async function buildEvidenceDocx(title: string, session: string, sections: { title: string; items: EvidenceExportItem[] }[], vault: Vault): Promise<Blob> {
	const children: (Paragraph)[] = [
		new Paragraph({ text: title, heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { after: 200 } }),
		new Paragraph({ text: `Session: ${session}`, alignment: AlignmentType.CENTER, spacing: { after: 100 } }),
		new Paragraph({
			text: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
			alignment: AlignmentType.CENTER,
			spacing: { after: 400 },
		}),
		new Paragraph({ children: [new PageBreak()] }),
	];

	for (const section of sections) {
		children.push(new Paragraph({ text: section.title, heading: HeadingLevel.HEADING_1, spacing: { before: 300, after: 120 } }));

		for (const item of section.items) {
			const { evidenceGoal: eg, result, screenshots } = item;
			children.push(new Paragraph({ text: eg.name || '(untitled)', heading: HeadingLevel.HEADING_3, spacing: { before: 200, after: 40 } }));
			children.push(new Paragraph({
				children: [new TextRun({ text: `Controls: ${eg.controlNumbers.join(', ') || '—'}`, italics: true, color: '555555' })],
				spacing: { after: 100 },
			}));
			if (eg.description.trim()) {
				children.push(new Paragraph({ text: eg.description, spacing: { after: 100 } }));
			}
			children.push(new Paragraph({ text: 'Notes', heading: HeadingLevel.HEADING_4, spacing: { after: 40 } }));
			children.push(result.notes.trim()
				? new Paragraph({ text: result.notes, spacing: { after: 100 } })
				: new Paragraph({ children: [new TextRun({ text: 'No comments', italics: true, color: '888888' })], spacing: { after: 100 } }));

			children.push(new Paragraph({ text: 'Screenshots', heading: HeadingLevel.HEADING_4, spacing: { after: 40 } }));
			if (screenshots.length === 0) {
				children.push(new Paragraph({ children: [new TextRun({ text: 'No screenshot', italics: true, color: '888888' })], spacing: { after: 100 } }));
			}

			for (const file of screenshots) {
				try {
					const data = await vault.readBinary(file);
					const size = await imageBitmapSize(data);
					if (!size) continue;
					const scale = Math.min(MAX_IMAGE_WIDTH / size.width, MAX_IMAGE_HEIGHT / size.height, 1);
					children.push(new Paragraph({
						children: [new ImageRun({
							data,
							transformation: { width: Math.round(size.width * scale), height: Math.round(size.height * scale) },
							type: file.extension.toLowerCase() === 'jpg' || file.extension.toLowerCase() === 'jpeg' ? 'jpg' : 'png',
						})],
						spacing: { after: 100 },
					}));
				} catch (e) {
					console.error('[Auditor] failed to embed screenshot in Word export', file.path, e);
				}
			}
		}
	}

	const doc = new Document({
		sections: [{
			headers: { default: new Header({ children: [new Paragraph({ text: title, alignment: AlignmentType.RIGHT })] }) },
			children,
		}],
	});
	return Packer.toBlob(doc);
}
