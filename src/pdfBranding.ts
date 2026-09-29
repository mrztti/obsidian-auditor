import type { jsPDF } from 'jspdf';
import { TFile, type Vault } from 'obsidian';

export interface PdfLogo {
	dataUrl: string;
	/** jsPDF's `addImage` format string, e.g. "PNG", "JPEG". */
	format: string;
	width: number;
	height: number;
}

/** The two user-configurable PDF export settings, resolved and ready to hand to `buildControlsPdf`/`buildEvidencePdf`. */
export interface PdfBranding {
	/** Hex color for the cover-page band and section headings — replaces what used to be a single hardcoded purple. */
	accentHex: string;
	/** Loaded via `loadPdfLogo`; null if unset, missing, or unsupported. */
	logo: PdfLogo | null;
}

// jsPDF's `addImage` only reliably handles these raster formats — not SVG, which is why the logo
// setting is scoped to them (a mismatch is silently treated as "no logo" rather than a hard error,
// so a stale/renamed setting never breaks an export).
const SUPPORTED_LOGO_EXTENSIONS = new Set(['png', 'jpg', 'jpeg']);

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

/**
 * Reads the vault image configured as the PDF header logo and prepares it for jsPDF's `addImage`.
 * Never throws and never blocks an export: an empty path, a missing file, an unsupported format,
 * or an unreadable image all just mean "no logo" for this run.
 */
export async function loadPdfLogo(vault: Vault, path: string): Promise<PdfLogo | null> {
	const trimmed = path.trim();
	if (!trimmed) return null;
	const file = vault.getAbstractFileByPath(trimmed);
	if (!(file instanceof TFile)) return null;
	const ext = file.extension.toLowerCase();
	if (!SUPPORTED_LOGO_EXTENSIONS.has(ext)) return null;
	try {
		const data = await vault.readBinary(file);
		const size = await imageBitmapSize(data);
		if (!size) return null;
		const mime = ext === 'jpg' ? 'jpeg' : ext;
		return {
			dataUrl: `data:image/${mime};base64,${arrayBufferToBase64(data)}`,
			format: ext === 'jpg' ? 'JPEG' : ext.toUpperCase(),
			width: size.width,
			height: size.height,
		};
	} catch (e) {
		console.error('[Auditor] failed to load PDF logo', path, e);
		return null;
	}
}

/** Draws the logo (if any) at `x, y`, scaled down to fit within `maxWidth`×`maxHeight` (never scaled up) — call once per PDF, in the cover header. No-op when `logo` is null, so callers never need their own conditional. */
export function drawPdfLogo(doc: jsPDF, logo: PdfLogo | null, x: number, y: number, maxWidth: number, maxHeight: number): void {
	if (!logo) return;
	const scale = Math.min(maxWidth / logo.width, maxHeight / logo.height, 1);
	doc.addImage(logo.dataUrl, logo.format, x, y, logo.width * scale, logo.height * scale);
}
