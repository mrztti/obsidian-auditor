/**
 * Minimal, dependency-free markdown → HTML converter for chat messages. Covers what LLM replies
 * actually use in practice (headings, bold/italic, inline/fenced code, links, lists, paragraphs) —
 * not a full CommonMark implementation. The input is HTML-escaped up front, so every tag in the
 * output is one we inserted ourselves; no raw HTML from the model ever passes through.
 */

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Only these URL schemes (plus relative/fragment links) are safe to emit as an `href` — blocks `javascript:`/`data:`/`vbscript:` etc. */
const SAFE_LINK_PATTERN = /^(https?:|mailto:|\/|#)/i;

function renderInline(text: string): string {
	return text
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a: string, b: string) => `<strong>${a ?? b}</strong>`)
		.replace(/\*([^*]+)\*|_([^_]+)_/g, (_m, a: string, b: string) => `<em>${a ?? b}</em>`)
		.replace(/\[([^\]]+)]\(([^)]+)\)/g, (_m, linkText: string, url: string) => {
			const trimmed = url.trim();
			if (!SAFE_LINK_PATTERN.test(trimmed)) return linkText;
			return `<a href="${trimmed}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
		});
}

function renderListBlock(lines: string[], ordered: boolean): string {
	const items = lines.map((l) => `<li>${renderInline(l.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))}</li>`).join('');
	return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
}

export function renderChatMarkdown(raw: string): string {
	const escaped = escapeHtml(raw);

	// Pull out fenced code blocks first so nothing inside them gets touched by inline/list/heading rules.
	const codeBlocks: string[] = [];
	const withoutFences = escaped.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, code: string) => {
		codeBlocks.push(`<pre><code>${code}</code></pre>`);
		return ` CODEBLOCK${codeBlocks.length - 1} `;
	});

	const lines = withoutFences.split('\n');
	const htmlParts: string[] = [];
	let paragraph: string[] = [];
	let listBuffer: string[] = [];
	let listOrdered = false;

	const flushParagraph = () => {
		if (paragraph.length > 0) {
			htmlParts.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
			paragraph = [];
		}
	};
	const flushList = () => {
		if (listBuffer.length > 0) {
			htmlParts.push(renderListBlock(listBuffer, listOrdered));
			listBuffer = [];
		}
	};

	for (const line of lines) {
		const heading = /^(#{1,6})\s+(.*)$/.exec(line);
		const unordered = /^\s*[-*]\s+(.*)$/.exec(line);
		const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);

		if (heading) {
			flushParagraph();
			flushList();
			const level = heading[1]!.length;
			htmlParts.push(`<h${level}>${renderInline(heading[2]!)}</h${level}>`);
		} else if (unordered || ordered) {
			flushParagraph();
			const isOrdered = !!ordered;
			if (listBuffer.length > 0 && isOrdered !== listOrdered) flushList();
			listOrdered = isOrdered;
			listBuffer.push(line);
		} else if (line.trim() === '') {
			flushParagraph();
			flushList();
		} else if (/^ CODEBLOCK\d+ $/.test(line.trim())) {
			flushParagraph();
			flushList();
			htmlParts.push(line.trim());
		} else {
			flushList();
			paragraph.push(line.trim());
		}
	}
	flushParagraph();
	flushList();

	return htmlParts
		.join('\n')
		.replace(/ CODEBLOCK(\d+) /g, (_m, i: string) => codeBlocks[Number(i)] ?? '');
}

/**
 * Renders markdown into `el` without ever assigning `innerHTML` directly: the generated markup
 * (built entirely from HTML-escaped input plus tags we insert ourselves, per `renderChatMarkdown`)
 * is parsed via `DOMParser` and its nodes are moved into `el` one at a time.
 */
export function renderChatMarkdownInto(el: HTMLElement, raw: string): void {
	const html = renderChatMarkdown(raw);
	const parsed = new DOMParser().parseFromString(html, 'text/html');
	el.replaceChildren(...Array.from(parsed.body.childNodes));
}
