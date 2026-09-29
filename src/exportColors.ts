/**
 * Hex equivalents of the CSS custom-property colors used for chips/badges in the app's own UI
 * (controlsView.ts / styles.css) — exports can't reference CSS variables, so these mirror the same
 * fallback values by hand. Keep in sync if the in-app palette changes.
 */

export const EXPORT_COLORS = {
	red: '#e53935',
	blue: '#2196f3',
	green: '#4caf50',
	yellow: '#b58900',
	gray: '#9e9e9e',
	darkGray: '#555555',
	lightGray: '#e0e0e0',
	accent: '#7c5cff',
	white: '#ffffff',
	textDark: '#222222',
};

/** Mirrors `ratingClass`/the `.auditor-rating-*` rules in styles.css. */
export function ratingColorHex(rating: string): string {
	if (rating === 'NC') return EXPORT_COLORS.red;
	if (rating === 'C*') return EXPORT_COLORS.blue;
	if (rating === 'C') return EXPORT_COLORS.green;
	if (rating === '-') return EXPORT_COLORS.darkGray;
	return EXPORT_COLORS.lightGray;
}

/** Mirrors the `.auditor-status-*` background rules in styles.css. */
export function statusColorHex(status: string): string {
	const s = status.toLowerCase();
	if (s === 'under review') return EXPORT_COLORS.yellow;
	if (s === 'problem') return EXPORT_COLORS.red;
	if (s === 'draft') return EXPORT_COLORS.blue;
	if (s === 'done') return EXPORT_COLORS.green;
	return EXPORT_COLORS.gray;
}

/** Mirrors the `.auditor-readiness-*` rules in styles.css. */
export function readinessColorHex(state: 'empty' | 'draft' | 'ready'): string {
	if (state === 'ready') return EXPORT_COLORS.green;
	if (state === 'draft') return EXPORT_COLORS.yellow;
	return EXPORT_COLORS.lightGray;
}

/** White text reads better on the darker/saturated chip colors; dark text on the light gray ones. */
export function chipTextColorHex(bgHex: string): string {
	return bgHex === EXPORT_COLORS.lightGray ? EXPORT_COLORS.textDark : EXPORT_COLORS.white;
}

/**
 * Picks readable text (dark or white) for arbitrary background colors — used for the PDF cover
 * band, whose color is now a user setting rather than the one fixed purple every other color
 * helper here was written to match. Falls back to white (the old, fixed assumption) for a
 * malformed hex value rather than throwing.
 */
export function readableTextOnHex(bgHex: string): string {
	const match = /^#?([0-9a-f]{6})$/i.exec(bgHex.trim());
	if (!match) return EXPORT_COLORS.white;
	const hex = match[1]!;
	const r = parseInt(hex.slice(0, 2), 16);
	const g = parseInt(hex.slice(2, 4), 16);
	const b = parseInt(hex.slice(4, 6), 16);
	// Perceived luminance (ITU-R BT.601) — same rule of thumb used for chip text above, generalized.
	const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return luminance > 0.6 ? EXPORT_COLORS.textDark : EXPORT_COLORS.white;
}
