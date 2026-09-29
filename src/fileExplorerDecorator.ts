import type AuditorPlugin from './main';
import type { StoreKind } from './main';

const FILE_EXPLORER_VIEW_TYPE = 'file-explorer';
const DOT_CLASS = 'auditor-indexed-dot';
const ERROR_CLASS = 'is-error';

type DotState = { kind: 'indexed' } | { kind: 'error'; message: string };

/**
 * Prepends a small dot to file-explorer entries for every file tracked by any of the three
 * vector-store manifests: green if its last indexing attempt succeeded, red (with the error
 * message as a tooltip) if it failed. Obsidian's file explorer has no public API for this, so we
 * work directly against its DOM (`.nav-file-title[data-path]`), the same approach most community
 * "file decoration" plugins use.
 */
export class FileExplorerDecorator {
	private plugin: AuditorPlugin;
	private refreshTimer: number | null = null;

	constructor(plugin: AuditorPlugin) {
		this.plugin = plugin;
	}

	/** Debounced refresh — safe to call frequently (e.g. from vault events) without hammering the DOM. */
	scheduleRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, 150);
	}

	private static readonly ALL_KINDS: StoreKind[] = ['standards', 'evidence', 'writtenControls', 'interviewEvidence', 'referenceReports'];

	async refresh(): Promise<void> {
		const plugin = this.plugin;
		const perStore = await Promise.all(
			FileExplorerDecorator.ALL_KINDS.map(async (kind) => {
				const store = plugin.storeFor(kind);
				return { ok: await store.getIndexedPaths(), err: await store.getErroredPaths() };
			}),
		);

		const states = new Map<string, DotState>();
		for (const { ok } of perStore) {
			for (const path of ok) states.set(path, { kind: 'indexed' });
		}
		// Errors take priority over a stale "indexed" state from a previous successful run.
		for (const { err } of perStore) {
			for (const [path, message] of Object.entries(err)) states.set(path, { kind: 'error', message });
		}

		for (const leaf of plugin.app.workspace.getLeavesOfType(FILE_EXPLORER_VIEW_TYPE)) {
			const root = leaf.view.containerEl;
			const titleEls = root.querySelectorAll<HTMLElement>('.nav-file-title[data-path]');
			titleEls.forEach((titleEl) => { this.applyDot(titleEl, states); });
		}
	}

	private applyDot(titleEl: HTMLElement, states: Map<string, DotState>): void {
		const path = titleEl.getAttribute('data-path');
		const state = path !== null ? states.get(path) : undefined;
		const existing = titleEl.querySelector<HTMLElement>(`.${DOT_CLASS}`);

		if (!state) {
			existing?.remove();
			return;
		}

		const dot = existing ?? titleEl.doc.createElement('span');
		dot.className = state.kind === 'error' ? `${DOT_CLASS} ${ERROR_CLASS}` : DOT_CLASS;
		dot.title = state.kind === 'error' ? `Auditor: indexing failed — ${state.message}` : 'Auditor: indexed';
		if (!existing) titleEl.prepend(dot);
	}
}
