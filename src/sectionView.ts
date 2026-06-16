import { FileView, TFile, WorkspaceLeaf } from 'obsidian';
import type AuditorPlugin from './main';
import { leafSections, getSection, setSection, type SectionDef } from './sections';

export const SECTION_VIEW_TYPE = 'auditor-section-view';

/** Frontmatter property + value that flags a note as one of our structured documents. */
export const FRONTMATTER_KEY = 'auditor-type';
export const FRONTMATTER_VALUE = 'finding';

/** Full-editor replacement view for "finding" notes: renders the 4 fixed sections instead of raw markdown source. */
export class SectionView extends FileView {
	private plugin: AuditorPlugin;
	private saveTimer: number | null = null;
	private textareas: Map<string, HTMLTextAreaElement> = new Map();

	constructor(leaf: WorkspaceLeaf, plugin: AuditorPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return SECTION_VIEW_TYPE;
	}

	getDisplayText(): string {
		return this.file?.basename ?? 'Audit finding';
	}

	getIcon(): string {
		return 'list-tree';
	}

	async onLoadFile(file: TFile): Promise<void> {
		await this.render(file);
	}

	async onUnloadFile(): Promise<void> {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
	}

	private async render(file: TFile): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('auditor-section-container');

		const header = container.createDiv('auditor-section-header');
		header.createEl('h3', { text: file.basename });
		const revertBtn = header.createEl('button', { text: 'Open as markdown', cls: 'mod-muted' });
		revertBtn.addEventListener('click', () => {
			void this.leaf.setViewState({ type: 'markdown', state: this.leaf.getViewState().state });
		});

		this.textareas.clear();
		const content = await this.app.vault.read(file);
		for (const section of leafSections()) {
			this.renderSectionEditor(container, file, section, content);
		}
	}

	private renderSectionEditor(container: HTMLElement, file: TFile, section: SectionDef, content: string): void {
		const wrapper = container.createDiv('auditor-section-block');
		wrapper.createEl('h5', { text: section.heading, cls: 'auditor-section-title' });

		if (section.kind === 'images') {
			this.renderImageGallery(wrapper, file, section, content);
			return;
		}

		const textarea = wrapper.createEl('textarea', { cls: 'auditor-section-textarea' });
		textarea.value = getSection(content, section.heading, section.level);
		textarea.rows = 6;
		this.textareas.set(section.id, textarea);

		textarea.addEventListener('input', () => {
			this.scheduleSave(file, section, textarea.value);
		});

		if (section.id === 'findings.evidence') {
			this.renderEvidenceFinder(wrapper, file, section, textarea);
		}
	}

	/** Renders a paste-image gallery for the section instead of a plain textarea. */
	private renderImageGallery(wrapper: HTMLElement, file: TFile, section: SectionDef, content: string): void {
		const galleryEl = wrapper.createDiv('auditor-image-gallery');
		this.renderImageThumbnails(galleryEl, file, section, getSection(content, section.heading, section.level));

		const dropzone = wrapper.createDiv('auditor-image-dropzone');
		dropzone.setAttribute('tabindex', '0');
		dropzone.setText('Click here, then paste an image (Ctrl/Cmd+V)');
		dropzone.addEventListener('paste', (e) => {
			void this.handleImagePaste(e, file, section, galleryEl);
		});
	}

	private renderImageThumbnails(galleryEl: HTMLElement, file: TFile, section: SectionDef, text: string): void {
		galleryEl.empty();
		const names = this.extractImageEmbedNames(text);

		for (const name of names) {
			const thumb = galleryEl.createDiv('auditor-image-thumb');
			const target = this.app.metadataCache.getFirstLinkpathDest(name, file.path);
			if (target) {
				thumb.createEl('img', { attr: { src: this.app.vault.getResourcePath(target) } });
			} else {
				thumb.createEl('p', { text: `Missing: ${name}`, cls: 'auditor-status' });
			}
			const removeBtn = thumb.createEl('button', { text: '✕', cls: 'auditor-image-remove' });
			removeBtn.addEventListener('click', () => {
				void this.removeImageEmbed(file, section, name, galleryEl);
			});
		}
	}

	/**
	 * Picks the next attachment path for a pasted image. Scans the whole vault (not just
	 * the section's live embeds) for existing `${basename}-Image<N>.*` files, since a
	 * removed embed never deletes its file — reusing a number would collide with it.
	 */
	private async nextImagePath(file: TFile, ext: string): Promise<string> {
		const re = new RegExp(`^${file.basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-Image(\\d+)\\.[^.]+$`);
		let maxN = 0;
		for (const f of this.app.vault.getFiles()) {
			const match = re.exec(f.name);
			if (match) maxN = Math.max(maxN, Number(match[1]));
		}
		const filename = `${file.basename}-Image${maxN + 1}.${ext}`;
		return this.app.fileManager.getAvailablePathForAttachment(filename, file.path);
	}

	private extractImageEmbedNames(text: string): string[] {
		const embedRe = /!\[\[([^\]]+)\]\]/g;
		const names: string[] = [];
		let match = embedRe.exec(text);
		while (match !== null) {
			names.push(match[1]!);
			match = embedRe.exec(text);
		}
		return names;
	}

	private async handleImagePaste(
		event: ClipboardEvent,
		file: TFile,
		section: SectionDef,
		galleryEl: HTMLElement,
	): Promise<void> {
		const items = event.clipboardData?.items;
		if (!items) return;

		for (const item of Array.from(items)) {
			if (!item.type.startsWith('image/')) continue;
			event.preventDefault();
			const blob = item.getAsFile();
			if (!blob) continue;

			const ext = item.type.split('/')[1] ?? 'png';
			const arrayBuffer = await blob.arrayBuffer();
			const attachmentPath = await this.nextImagePath(file, ext);
			const newFile = await this.app.vault.createBinary(attachmentPath, arrayBuffer);

			await this.app.vault.process(file, (current) => {
				const existing = getSection(current, section.heading, section.level);
				const embed = `![[${newFile.path}]]`;
				const updated = existing.length > 0 ? `${existing}\n${embed}` : embed;
				return setSection(current, section.heading, section.level, updated);
			});

			const newText = getSection(await this.app.vault.read(file), section.heading, section.level);
			this.renderImageThumbnails(galleryEl, file, section, newText);
		}
	}

	private async removeImageEmbed(file: TFile, section: SectionDef, name: string, galleryEl: HTMLElement): Promise<void> {
		await this.app.vault.process(file, (current) => {
			const existing = getSection(current, section.heading, section.level);
			const updated = existing
				.split('\n')
				.filter((line) => line.trim() !== `![[${name}]]`)
				.join('\n');
			return setSection(current, section.heading, section.level, updated);
		});
		const newText = getSection(await this.app.vault.read(file), section.heading, section.level);
		this.renderImageThumbnails(galleryEl, file, section, newText);
	}

	/** Suggests likely-related files for Evidence, found via semantic search over Control + Indications. */
	private renderEvidenceFinder(
		wrapper: HTMLElement,
		file: TFile,
		section: SectionDef,
		textarea: HTMLTextAreaElement,
	): void {
		const findBtn = wrapper.createEl('button', {
			text: 'Find linked files',
			cls: 'auditor-evidence-find-btn mod-muted',
		});
		const suggestionsEl = wrapper.createDiv('auditor-evidence-suggestions');

		findBtn.addEventListener('click', () => {
			void this.findEvidenceSuggestions(file, section, textarea, findBtn, suggestionsEl);
		});
	}

	private async findEvidenceSuggestions(
		file: TFile,
		section: SectionDef,
		textarea: HTMLTextAreaElement,
		findBtn: HTMLButtonElement,
		suggestionsEl: HTMLElement,
	): Promise<void> {
		const control = this.textareas.get('control')?.value ?? '';
		const indications = this.textareas.get('indications')?.value ?? '';
		const query = `${control}\n${indications}`.trim();

		suggestionsEl.empty();
		if (!query) {
			suggestionsEl.createEl('p', { text: 'Fill in Control and Indications first.', cls: 'auditor-status' });
			return;
		}

		findBtn.disabled = true;
		findBtn.setText('Searching…');
		try {
			const results = await this.plugin.indexer.search(query, this.plugin.settings.maxResults);
			suggestionsEl.empty();
			const candidates = results.filter((r) => r.filePath !== file.path);
			if (candidates.length === 0) {
				suggestionsEl.createEl('p', { text: 'No likely related files found.', cls: 'auditor-status' });
				return;
			}
			for (const result of candidates) {
				const chip = suggestionsEl.createDiv('auditor-evidence-chip');
				const main = chip.createDiv('auditor-evidence-chip-main');
				main.createSpan({
					text: `${result.filePath} (${(result.score * 100).toFixed(0)}%)`,
					cls: 'auditor-evidence-chip-label',
				});
				for (const passage of result.sections) {
					main.createEl('p', {
						text: passage.length > 600 ? `${passage.slice(0, 600)}…` : passage,
						cls: 'auditor-evidence-chip-passage',
					});
				}
				const actions = chip.createDiv('auditor-evidence-chip-actions');
				const viewBtn = actions.createEl('button', { text: 'View' });
				viewBtn.addEventListener('click', () => {
					const target = this.app.vault.getFileByPath(result.filePath);
					if (target) void this.app.workspace.getLeaf('window').openFile(target);
				});
				const addBtn = actions.createEl('button', { text: 'Add', cls: 'mod-cta' });
				addBtn.addEventListener('click', () => {
					const link = `- [[${result.filePath.replace(/\.md$/, '')}]]`;
					textarea.value = textarea.value.trim().length > 0
						? `${textarea.value.trim()}\n${link}`
						: link;
					this.scheduleSave(file, section, textarea.value);
					chip.remove();
				});
			}
		} catch (e) {
			suggestionsEl.empty();
			suggestionsEl.createEl('p', { text: `Search failed: ${String(e)}`, cls: 'auditor-status' });
		} finally {
			findBtn.disabled = false;
			findBtn.setText('Find linked files');
		}
	}

	/** Debounces writes so we don't hit disk on every keystroke. */
	private scheduleSave(file: TFile, section: SectionDef, value: string): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			void this.app.vault.process(file, (current) =>
				setSection(current, section.heading, section.level, value),
			);
		}, 500);
	}
}
