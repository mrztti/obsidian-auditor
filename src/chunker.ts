/** A paragraph-sized chunk of markdown text, with the 1-based line it starts on. */
export interface MarkdownChunk {
	text: string;
	line: number;
}

/** A paragraph-sized chunk of PDF text, with the 1-based page it was extracted from. */
export interface PdfChunk {
	text: string;
	page: number;
}

interface RawParagraph {
	text: string;
	/** Line within the source unit (file, for markdown; page, for PDF). */
	line: number;
}

/** Splits text into blank-line-delimited paragraphs, tracking each paragraph's 1-based starting line. */
function splitIntoParagraphs(text: string): RawParagraph[] {
	const lines = text.split('\n');
	const paragraphs: RawParagraph[] = [];
	let current: string[] = [];
	let startLine = 1;

	const flush = () => {
		const joined = current.join('\n').trim();
		if (joined.length > 0) paragraphs.push({ text: joined, line: startLine });
		current = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim().length === 0) {
			flush();
		} else {
			if (current.length === 0) startLine = i + 1;
			current.push(line);
		}
	}
	flush();

	return paragraphs;
}

/** Splits a single overlong paragraph into word-bounded pieces of roughly `targetWords` each. */
function splitLongParagraph(text: string, targetWords: number): string[] {
	const words = text.split(/\s+/).filter((w) => w.length > 0);
	if (words.length <= targetWords * 2) return [text];

	const pieces: string[] = [];
	for (let i = 0; i < words.length; i += targetWords) {
		pieces.push(words.slice(i, i + targetWords).join(' '));
	}
	return pieces;
}

/** Merges consecutive short paragraphs up to `targetWords`, and hard-splits any paragraph over 2x `targetWords`. */
function chunkParagraphs(paragraphs: RawParagraph[], targetWords: number): RawParagraph[] {
	const out: RawParagraph[] = [];
	let bufferText = '';
	let bufferLine = 0;
	let bufferWords = 0;

	const flushBuffer = () => {
		if (bufferText.length > 0) out.push({ text: bufferText, line: bufferLine });
		bufferText = '';
		bufferWords = 0;
	};

	for (const para of paragraphs) {
		const pieces = splitLongParagraph(para.text, targetWords);
		for (const piece of pieces) {
			const wordCount = piece.split(/\s+/).filter((w) => w.length > 0).length;
			if (bufferWords > 0 && bufferWords + wordCount > targetWords) flushBuffer();
			if (bufferWords === 0) bufferLine = para.line;
			bufferText = bufferText.length > 0 ? `${bufferText}\n\n${piece}` : piece;
			bufferWords += wordCount;
		}
	}
	flushBuffer();

	return out;
}

/** Chunks a markdown file's content into paragraph-sized pieces, each with its starting line number. */
export function chunkMarkdown(content: string, targetWords: number): MarkdownChunk[] {
	const paragraphs = splitIntoParagraphs(content);
	return chunkParagraphs(paragraphs, targetWords).map((p) => ({ text: p.text, line: p.line }));
}

/** Chunks a PDF's per-page text into paragraph-sized pieces, each with its 1-based page number. */
export function chunkPdfPages(pages: string[], targetWords: number): PdfChunk[] {
	const out: PdfChunk[] = [];
	pages.forEach((pageText, i) => {
		const paragraphs = splitIntoParagraphs(pageText);
		for (const chunk of chunkParagraphs(paragraphs, targetWords)) {
			out.push({ text: chunk.text, page: i + 1 });
		}
	});
	return out;
}
