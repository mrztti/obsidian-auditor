import { TFile } from 'obsidian';
import type AuditorPlugin from '../main';
import { buildControlNoteContent, parseControlNoteContent, type ControlRecord } from '../controlNote';

export interface ReviewerEntry {
	file: TFile;
	record: ControlRecord;
}

/** The fields the Reviewer may edit directly. */
export type ReviewerPatch = Partial<Pick<ControlRecord, 'reviewNotes' | 'todRating' | 'toeRating' | 'todConclusion' | 'toeConclusion'>>;

type Listener = () => void;

/** Shared state of the Reviewer view: every control note plus the persisted review set, with serialized saves back to the notes. */
export class ReviewerData {
	entries: ReviewerEntry[] = [];
	private byNumber = new Map<string, ReviewerEntry>();
	private listeners = new Set<Listener>();

	constructor(private plugin: AuditorPlugin) {}

	onChange(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => { this.listeners.delete(fn); };
	}

	private notify(): void {
		for (const fn of this.listeners) fn();
	}

	get(number: string): ReviewerEntry | undefined {
		return this.byNumber.get(number);
	}

	async reload(): Promise<void> {
		const { vault } = this.plugin.app;
		const folder = this.plugin.settings.writtenControlsFolder;
		const files = vault.getFiles().filter((f) => f.extension === 'md' && (!folder || f.path === folder || f.path.startsWith(`${folder}/`)));
		const entries: ReviewerEntry[] = [];
		for (const file of files) {
			entries.push({ file, record: parseControlNoteContent(await vault.cachedRead(file), file.basename) });
		}
		entries.sort((a, b) => a.record.number.localeCompare(b.record.number, undefined, { numeric: true }));
		this.entries = entries;
		this.byNumber = new Map(entries.map((e) => [e.record.number, e]));
		this.notify();
	}

	/** Control numbers in the review set, in control-number order, skipping any that no longer exist. */
	reviewSet(): string[] {
		const wanted = new Set(this.plugin.settings.reviewerControlNumbers);
		return this.entries.filter((e) => wanted.has(e.record.number)).map((e) => e.record.number);
	}

	async setReviewSet(numbers: string[]): Promise<void> {
		this.plugin.settings.reviewerControlNumbers = [...new Set(numbers)];
		await this.plugin.saveSettings();
		this.notify();
	}

	/**
	 * Writes `patch` onto the note. The file is re-read under the vault write lock and only the
	 * patched fields are changed, so an edit made elsewhere in the meantime (another view, an agent)
	 * to any other field is kept rather than overwritten.
	 */
	async save(number: string, patch: ReviewerPatch): Promise<void> {
		const entry = this.byNumber.get(number);
		if (!entry) return;
		await this.plugin.vaultWriteLock.run(async () => {
			const { vault } = this.plugin.app;
			const current = parseControlNoteContent(await vault.read(entry.file), entry.file.basename);
			const next: ControlRecord = { ...current, ...patch };
			await vault.modify(entry.file, buildControlNoteContent(next));
			entry.record = next;
		});
		void this.plugin.spotIndexFiles('writtenControls', [entry.file]);
		this.plugin.refreshControlsViews();
	}
}
