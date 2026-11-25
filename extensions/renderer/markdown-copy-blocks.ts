import {
	type Markdown,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	fencedCodeSource,
	type MarkdownCopySource,
	paragraphSource,
} from "./markdown-copy-source.ts";

export const BLOCK_COPY_LABEL = "[Copy]";
const FRAME_EDGE = 1;
const FRAME_INSET = " ";
const OPEN_RULE = "╭─";
const CLOSE_RULE = "─╮";
const ACTION_WIDTH = visibleWidth(BLOCK_COPY_LABEL);
const MIN_FRAME_WIDTH = visibleWidth(`${OPEN_RULE} ${BLOCK_COPY_LABEL} ${CLOSE_RULE}`);
const DIAGRAM =
	/^(?:mermaid|statediagram(?:-v2)?|classdiagram(?:-v2)?|erdiagram|sequencediagram)$/i;

export interface CopyBlockToken {
	readonly type?: string;
	readonly raw?: string;
	readonly lang?: string;
}

export interface BlockCopyStyle {
	readonly border: (text: string) => string;
	readonly muted?: (text: string) => string;
}

export interface CopyBlock {
	readonly kind: "code" | "paragraph";
	readonly payload: string;
}

export type BlockMarkers = (
	label: "block-copy" | "end" | "skip" | "body-start" | "body-end",
) => string;
type RenderToken = (
	this: Markdown,
	token: CopyBlockToken,
	width: number,
	nextTokenType?: string,
	styleContext?: unknown,
) => string[];

export type RenderBlock = (
	this: Markdown,
	...args: [
		block: unknown,
		token: CopyBlockToken,
		nextTokenType: string | undefined,
		width: number,
		contentWidth: number,
	]
) => void;

export interface BlockProvenance {
	readonly source: MarkdownCopySource;
	readonly streaming: boolean;
	readonly width: number;
}

export function copyableBlocks(
	cache: { readonly tokens: readonly CopyBlockToken[]; readonly source: string },
	context: BlockProvenance,
) {
	const blocks = new Map<CopyBlockToken, CopyBlock>();
	const locate = context.source.locate(cache.source);
	if (!locate) return blocks;
	for (const token of cache.tokens) {
		if (!token.raw) continue;
		const block = copyableBlock(token, locate(token.raw), context);
		if (block) blocks.set(token, block);
	}
	return blocks;
}

export function copyableBlock(
	token: CopyBlockToken,
	raw: string | undefined,
	context: BlockProvenance,
): CopyBlock | undefined {
	if (raw === undefined) return undefined;
	if (token.type === "paragraph" && context.width >= ACTION_WIDTH) {
		return { kind: "paragraph", payload: paragraphSource(raw) };
	}
	if (token.type === "code" && context.width >= MIN_FRAME_WIDTH && !DIAGRAM.test(language(token))) {
		const payload = fencedCodeSource(raw, context.streaming);
		if (payload !== undefined) return { kind: "code", payload };
	}
	return undefined;
}

function language(token: CopyBlockToken): string {
	return token.lang?.trim().split(/\s+/, 1)[0] ?? "";
}

interface BlockChrome extends BlockCopyStyle {
	readonly width: number;
	readonly lang: string;
	readonly indent: string;
	readonly marks: BlockMarkers;
}

function frameCode(lines: string[], chrome: BlockChrome): string[] {
	const { width, lang, indent, marks, border, muted = border } = chrome;
	const gap = FRAME_INSET;
	const action = `${marks("block-copy")}${BLOCK_COPY_LABEL}${marks("end")}`;
	const spare = width - MIN_FRAME_WIDTH;
	const clipped = spare > 2 ? truncateToWidth(lang, spare - 2) : "";
	const title = clipped ? `${gap}${muted(clipped)}${gap}` : "";
	const rules = "─".repeat(spare - visibleWidth(title));
	const rail = border("│");
	const inner = width - 2 * (FRAME_EDGE + visibleWidth(gap));
	const end = lines.at(-1) === "" ? lines.length - 2 : lines.length - 1;
	const result = [
		`${marks("skip")}${border(OPEN_RULE)}${title}${border(rules)}${gap}${action}${gap}${border(CLOSE_RULE)}`,
	];
	for (const native of lines.slice(1, end)) {
		const text = native.startsWith(indent) ? native.slice(indent.length) : native;
		for (const part of wrapTextWithAnsi(text, inner)) {
			const fill = gap.repeat(Math.max(0, inner - visibleWidth(part)));
			result.push(
				`${rail}${gap}${marks("body-start")}${part}${marks("body-end")}${fill}${gap}${rail}`,
			);
		}
	}
	result.push(`${marks("skip")}${border(`╰${"─".repeat(width - 2 * FRAME_EDGE)}╯`)}`);
	if (end < lines.length - 1) result.push("");
	return result;
}

export function decorateCopyBlock(
	lines: string[],
	token: { readonly lang?: string; readonly kind: CopyBlock["kind"] },
	chrome: Omit<BlockChrome, "lang">,
): string[] {
	if (token.kind === "code") {
		return frameCode(lines, { ...chrome, lang: language(token) });
	}
	const { marks } = chrome;
	const action = `${marks("skip")}${marks("block-copy")}${BLOCK_COPY_LABEL}${marks("end")}`;
	lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, action);
	return lines;
}

/** Keep native token rendering (especially highlighted code) and its block cache. */
export function renderCopyBlock(
	component: Markdown,
	native: { readonly render: RenderBlock; readonly args: Parameters<RenderBlock> },
	options: BlockCopyStyle & { readonly kind: CopyBlock["kind"]; readonly marks: BlockMarkers },
): void {
	const original: unknown = Reflect.get(component, "renderToken");
	if (typeof original !== "function") {
		native.render.apply(component, native.args);
		return;
	}
	const descriptor = Object.getOwnPropertyDescriptor(component, "renderToken");
	const render: RenderToken = function (token, width, nextTokenType, styleContext) {
		const lines: string[] = original.call(this, token, width, nextTokenType, styleContext);
		if (token !== native.args[1]) return lines;
		const theme: { readonly codeBlockIndent?: string } = Reflect.get(this, "theme");
		return decorateCopyBlock(
			lines,
			{ ...token, kind: options.kind },
			{
				...options,
				width,
				indent: theme.codeBlockIndent ?? "  ",
			},
		);
	};
	Object.defineProperty(component, "renderToken", { value: render, configurable: true });
	try {
		native.render.apply(component, native.args);
	} finally {
		if (descriptor) Object.defineProperty(component, "renderToken", descriptor);
		else Reflect.deleteProperty(component, "renderToken");
	}
}
