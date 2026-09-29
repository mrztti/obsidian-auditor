import { TFile } from 'obsidian';
import type AuditorPlugin from '../main';
import {
	CONTROL_RATINGS,
	CONTROL_STATUSES,
	buildControlNoteContent,
	parseControlNoteContent,
	todayIsoDate,
	type ControlRecord,
} from '../controlNote';
import {
	EDITABLE_CONTROL_FIELDS,
	type ApplyOutcome,
	type ControlChange,
	type EditableControlField,
	type ResolvedChange,
} from './types';

export interface ControlEntry {
	file: TFile;
	record: ControlRecord;
	content: string;
}

export interface ControlFilters {
	session?: string;
	status?: string;
	standard?: string;
	/** Matches when either the ToD or the ToE rating equals this value. */
	rating?: string;
}

export interface ControlMatch {
	entry: ControlEntry;
	score: number;
	reason: string;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'control', 'controls', 'with', 'that', 'this', 'all']);

const norm = (s: string): string => s.trim().toLowerCase();

/** Loads, searches, validates and writes control notes on behalf of the agent. */
export class ControlStore {
	/** Note content as last read by the agent in the current run, keyed by control number — a write is refused if the file no longer matches. */
	private snapshots = new Map<string, ControlEntry>();

	constructor(private plugin: AuditorPlugin) {}

	resetSnapshots(): void {
		this.snapshots.clear();
	}

	hasSnapshot(number: string): boolean {
		return this.snapshots.has(number);
	}

	async listAll(): Promise<ControlEntry[]> {
		const { vault } = this.plugin.app;
		const folder = this.plugin.settings.writtenControlsFolder;
		const files = vault.getMarkdownFiles().filter((f) => !folder || f.path.startsWith(`${folder}/`));
		const entries: ControlEntry[] = [];
		for (const file of files) {
			const content = await vault.read(file);
			entries.push({ file, content, record: parseControlNoteContent(content, file.basename) });
		}
		entries.sort((a, b) => a.record.number.localeCompare(b.record.number, undefined, { numeric: true }));
		return entries;
	}

	private matchesFilters(record: ControlRecord, f: ControlFilters): boolean {
		if (f.session && norm(record.session) !== norm(f.session)) return false;
		if (f.status && norm(record.status) !== norm(f.status)) return false;
		if (f.standard && !norm(record.standard).includes(norm(f.standard))) return false;
		if (f.rating && norm(record.todRating) !== norm(f.rating) && norm(record.toeRating) !== norm(f.rating)) return false;
		return true;
	}

	/**
	 * Resolves a free-text description ("the access review control", "4.2.1", "everything about
	 * backups") to candidate controls. Exact/partial control numbers rank highest, then keyword hits
	 * across the note's fields, then semantic hits from the written-controls vector index.
	 */
	async find(query: string, filters: ControlFilters, limit: number): Promise<{ matches: ControlMatch[]; total: number }> {
		const all = (await this.listAll()).filter((e) => this.matchesFilters(e.record, filters));
		const q = norm(query);
		if (!q) {
			return { total: all.length, matches: all.slice(0, limit).map((entry) => ({ entry, score: 0, reason: 'matches filters' })) };
		}

		const numberTokens = (query.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? []).map(norm).filter((t) => /\d/.test(t));
		const words = (query.match(/[\p{L}\p{N}]{3,}/gu) ?? []).map(norm).filter((w) => !STOPWORDS.has(w));

		const semantic = new Map<string, number>();
		try {
			const hits = await this.plugin.writtenControlsIndex.search(query, 15);
			for (const hit of hits) {
				const base = hit.sourcePath.split('/').pop()?.replace(/\.md$/i, '') ?? '';
				semantic.set(base, Math.max(semantic.get(base) ?? 0, hit.score));
			}
		} catch {
			// Index may not be built yet — keyword matching still works.
		}

		const scored: ControlMatch[] = [];
		for (const entry of all) {
			const r = entry.record;
			const number = norm(r.number);
			let score = 0;
			const reasons: string[] = [];
			for (const token of numberTokens) {
				if (number === token) { score += 100; reasons.push('exact number'); }
				else if (number.startsWith(`${token}.`) || number.startsWith(`${token}-`)) { score += 50; reasons.push('number prefix'); }
				else if (number.includes(token)) { score += 25; reasons.push('number contains'); }
			}
			const haystack = norm([r.topic, r.standard, r.control, r.session, r.assignedMember].join(' \n '));
			const hitWords = words.filter((w) => haystack.includes(w));
			if (hitWords.length > 0) {
				score += (hitWords.length / Math.max(words.length, 1)) * 30;
				reasons.push(`keywords: ${hitWords.slice(0, 4).join(', ')}`);
			}
			const sem = semantic.get(r.number) ?? semantic.get(entry.file.basename);
			if (sem !== undefined) { score += sem * 40; reasons.push(`semantic ${(sem * 100).toFixed(0)}%`); }
			if (score > 0) scored.push({ entry, score, reason: [...new Set(reasons)].join('; ') });
		}
		scored.sort((a, b) => b.score - a.score);
		return { total: scored.length, matches: scored.slice(0, limit) };
	}

	/** Reads controls by exact number and remembers what was read, so a later proposal can be checked against it. */
	async load(numbers: string[]): Promise<{ found: ControlEntry[]; missing: string[] }> {
		const all = await this.listAll();
		const byNumber = new Map(all.map((e) => [norm(e.record.number), e]));
		const found: ControlEntry[] = [];
		const missing: string[] = [];
		for (const n of numbers) {
			const entry = byNumber.get(norm(n));
			if (entry) {
				found.push(entry);
				this.snapshots.set(entry.record.number, entry);
			} else {
				missing.push(n);
			}
		}
		return { found, missing };
	}

	/** Validates the model's raw `changes` argument into typed `ControlChange`s, or returns a message the model can act on. */
	parseChanges(raw: unknown): { changes: ControlChange[] } | { error: string } {
		if (!Array.isArray(raw) || raw.length === 0) return { error: 'changes must be a non-empty array.' };
		const changes: ControlChange[] = [];
		for (const item of raw as Record<string, unknown>[]) {
			const number = typeof item.number === 'string' ? item.number : '';
			if (!number) return { error: 'Every change needs a control "number".' };
			if (!this.snapshots.has(number)) return { error: `Control "${number}" has not been read in this run — call get_controls for it first so your edit is based on its current content.` };
			const rawFields = (item.fields ?? {}) as Record<string, unknown>;
			const fields: ControlChange['fields'] = {};
			for (const [key, value] of Object.entries(rawFields)) {
				if (!(EDITABLE_CONTROL_FIELDS as readonly string[]).includes(key)) return { error: `Field "${key}" is not editable. Editable fields: ${EDITABLE_CONTROL_FIELDS.join(', ')}.` };
				const field = key as EditableControlField;
				if (field === 'todReady' || field === 'toeReady') {
					if (typeof value !== 'boolean') return { error: `${field} must be a boolean.` };
					fields[field] = value;
					continue;
				}
				if (typeof value !== 'string') return { error: `${field} must be a string.` };
				if ((field === 'todRating' || field === 'toeRating') && !CONTROL_RATINGS.includes(value as ControlRecord['todRating'])) {
					return { error: `${field} must be one of: ${CONTROL_RATINGS.map((r) => `"${r}"`).join(', ')}.` };
				}
				if (field === 'status' && !CONTROL_STATUSES.includes(value)) {
					return { error: `status must be one of: ${CONTROL_STATUSES.join(', ')}.` };
				}
				(fields as Record<string, unknown>)[field] = value;
			}
			const addComments = Array.isArray(item.addComments)
				? (item.addComments as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim() !== '')
				: [];
			changes.push({ number, fields, addComments });
		}
		return { changes };
	}

	/** Applies each change to a copy of the control as the agent read it, dropping fields that end up identical. */
	resolve(changes: ControlChange[]): ResolvedChange[] {
		const resolved: ResolvedChange[] = [];
		for (const change of changes) {
			const snap = this.snapshots.get(change.number);
			if (!snap) continue;
			const before = snap.record;
			const after: ControlRecord = { ...before, comments: [...before.comments] };
			const changedFields: ResolvedChange['changedFields'] = [];
			for (const key of EDITABLE_CONTROL_FIELDS) {
				const value = change.fields[key];
				if (value === undefined || value === before[key]) continue;
				(after as unknown as Record<string, unknown>)[key] = value;
				changedFields.push(key);
			}
			if (change.addComments.length > 0) {
				const date = todayIsoDate();
				for (const text of change.addComments) after.comments.push({ date, text: text.replace(/\r?\n/g, ' ').trim() });
				changedFields.push('comments');
			}
			if (changedFields.length > 0) {
				resolved.push({ number: change.number, file: snap.file, before, after, baseContent: snap.content, changedFields });
			}
		}
		return resolved;
	}

	/** Writes the approved changes, refusing any whose note was edited since the agent read it. Spot-indexes just the changed files (never the whole folder — the agent never renames, since `number` isn't an editable field). */
	async apply(changes: ResolvedChange[]): Promise<ApplyOutcome[]> {
		const { vault } = this.plugin.app;
		const outcomes: ApplyOutcome[] = [];
		const savedFiles: TFile[] = [];
		for (const change of changes) {
			try {
				const current = await vault.read(change.file);
				if (current !== change.baseContent) {
					outcomes.push({ key: change.number, ok: false, error: 'The note was edited after the agent read it — nothing was written. Ask the agent to try again.' });
					continue;
				}
				const content = buildControlNoteContent(change.after);
				await vault.modify(change.file, content);
				this.snapshots.set(change.number, { file: change.file, record: change.after, content });
				savedFiles.push(change.file);
				outcomes.push({ key: change.number, ok: true });
			} catch (e) {
				outcomes.push({ key: change.number, ok: false, error: String(e) });
			}
		}
		if (savedFiles.length > 0) {
			void this.plugin.spotIndexFiles('writtenControls', savedFiles);
			this.plugin.refreshControlsViews();
		}
		return outcomes;
	}
}

/** Compact description of a control for search results — enough to pick from, without the long conclusions. */
export function summarizeControl(entry: ControlEntry): Record<string, unknown> {
	const r = entry.record;
	return {
		number: r.number,
		standard: r.standard,
		topic: r.topic,
		session: r.session,
		status: r.status,
		todRating: r.todRating,
		toeRating: r.toeRating,
		hasStage1Conclusion: r.todConclusion.trim() !== '',
		hasStage2Conclusion: r.toeConclusion.trim() !== '',
		controlPreview: r.control.length > 200 ? `${r.control.slice(0, 200)}…` : r.control,
	};
}
