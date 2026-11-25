/** An edit uses offsets from before its stage; edits in a stage are ordered and disjoint. */
export interface MarkdownEdit {
	readonly start: number;
	readonly length: number;
	readonly replacementLength: number;
	readonly generated?: boolean;
}

interface Range {
	readonly start: number;
	readonly end: number;
}

function originalOffset(offset: number, edits: readonly MarkdownEdit[], rightEdge: boolean) {
	let delta = 0;
	for (const edit of edits) {
		const start = edit.start + delta;
		const end = start + edit.replacementLength;
		if (offset <= start) break;
		if (offset < end) return edit.start + (rightEdge ? edit.length : 0);
		delta += edit.replacementLength - edit.length;
	}
	return offset - delta;
}

function originatesInDiagram(range: Range, edits: readonly MarkdownEdit[]): boolean {
	let delta = 0;
	for (const edit of edits) {
		const start = edit.start + delta;
		const end = start + edit.replacementLength;
		if (edit.generated && range.start < end && range.end > start) return true;
		delta += edit.replacementLength - edit.length;
	}
	return false;
}

/**
 * Recover the source of real parsed tokens after presentation-only edits. The
 * renderer stays the authority on block boundaries; generated diagram art is
 * not prose/code, even when the native lexer represents it with those tokens.
 */
export class MarkdownCopySource {
	readonly #original: string;
	readonly #stages: Array<readonly MarkdownEdit[]> = [];
	#display: string;

	constructor(original: string) {
		this.#original = original;
		this.#display = original;
	}

	record(display: string, edits: readonly MarkdownEdit[]): void {
		this.#display = display;
		if (edits.length) this.#stages.push(edits);
	}

	/** A cursor distinguishes identical rendered paragraphs without storing text in ANSI markers. */
	locate(cachedSource: string) {
		if (this.#display.replaceAll("\t", "   ") !== cachedSource) return undefined;
		const nativeEdits: MarkdownEdit[] = [];
		const normalized = this.#display.replace(/\t|\r\n?/g, (match: string, start: number) => {
			const replacement = match === "\t" ? "   " : "\n";
			nativeEdits.push({ start, length: match.length, replacementLength: replacement.length });
			return replacement;
		});
		const stages = [nativeEdits, ...this.#stages.toReversed()];
		let cursor = 0;
		return (raw: string): string | undefined => {
			let start = normalized.indexOf(raw, cursor);
			while (start > cursor) {
				// The host can omit comment and reference-definition blocks from
				// its token list. Their interior text is not a visible block start.
				const comment = /^\s*<!--[\s\S]*?(?:-->|$)/.exec(normalized.slice(cursor));
				const opening = comment ? cursor + comment[0].indexOf("<!--") : undefined;
				if (comment && opening !== undefined && start > opening) {
					cursor += comment[0].length;
					start = normalized.indexOf(raw, cursor);
					continue;
				}
				const lineStart = normalized.lastIndexOf("\n", start - 1) + 1;
				if (!raw.trim() || !/\S/.test(normalized.slice(lineStart, start))) break;
				start = normalized.indexOf(raw, start + raw.length);
			}
			if (start < 0) return undefined;
			cursor = start + raw.length;
			let range: Range = { start, end: cursor };
			for (const edits of stages) {
				if (originatesInDiagram(range, edits)) return undefined;
				range = {
					start: originalOffset(range.start, edits, false),
					end: originalOffset(range.end, edits, true),
				};
			}
			return this.#original.slice(range.start, range.end);
		};
	}
}

const OPEN_FENCE = /^( {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r\n|\n|\r|$)/;
const EOL = /(?:\r\n|\r|\n)$/;

/** Remove only the fence delimiters and the opening fence's structural indentation. */
export function fencedCodeSource(raw: string, streaming: boolean): string | undefined {
	const open = OPEN_FENCE.exec(raw);
	if (!open) return undefined;
	const indent = open[1].length;
	const fence = open[2];
	const body = raw.slice(open[0].length);
	const closing = new RegExp(
		`(?:^|\\r\\n|\\r|\\n) {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r\\n|\\r|\\n)*$`,
	).exec(body);
	const pending = streaming
		? new RegExp(`(?:^|\\r\\n|\\r|\\n)${fence[0]}{1,${fence.length - 1}}$`).exec(body)
		: null;
	const text = body.slice(0, closing?.index ?? pending?.index ?? body.length);
	return indent ? text.replace(new RegExp(`(^|\\r\\n|\\r|\\n) {1,${indent}}`, "g"), "$1") : text;
}

export function paragraphSource(raw: string): string {
	return raw.replace(EOL, "");
}
