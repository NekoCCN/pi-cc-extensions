import type {
	ExtensionAPI,
	MarkdownMessageType,
	MarkdownTransformContext,
} from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import type { MarkdownCopySource, MarkdownEdit } from "./markdown-copy-source.ts";
import { renderDiagrams } from "./markdown-diagrams.ts";

const HEADING_STYLE = Symbol.for("pi.ccstyle.markdown-heading-style");

type RenderToken = (
	this: tui.Markdown,
	token: { readonly type: string; readonly depth?: number },
	width: number,
	nextTokenType?: string,
	styleContext?: unknown,
) => string[];

/** Style parsed headings, render hyphen bullets as typographic bullets, and add the gap native Markdown omits after lists. */
export function setMarkdownHeadingStyle(enabled: boolean): void {
	const prototype = tui.Markdown.prototype;
	const restore: unknown = Reflect.get(prototype, HEADING_STYLE);
	if (typeof restore === "function") {
		if (!enabled) restore();
		return;
	}
	if (!enabled) return;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "renderToken");
	if (typeof descriptor?.value !== "function") return;
	const original: RenderToken = descriptor.value;
	const clearCache: unknown = Reflect.get(tui, "clearRenderCache");
	const renderToken: RenderToken = function (token, width, nextTokenType, styleContext) {
		// Hyphen list markers render as typographic bullets. Only the marker glyph
		// passed to theme.listBullet is swapped, while this one list renders, so
		// nesting, task checkboxes, ordered markers, fenced code and tables are
		// untouched. Other unordered markers (+, *) keep their source glyph (Pi
		// normalizes them to "- " unless preserveOrderedListMarkers is set).
		const theme = (this as unknown as { theme?: { listBullet?: (marker: string) => string } })
			.theme;
		const listBullet = token.type === "list" ? theme?.listBullet : undefined;
		const bulletize = typeof listBullet === "function";
		if (bulletize) {
			try {
				theme!.listBullet = (marker) =>
					listBullet(marker.startsWith("- ") ? `• ${marker.slice(2)}` : marker);
			} catch {
				// Frozen theme: fall back to the native marker.
			}
		}
		let lines: string[];
		try {
			lines = original.call(this, token, width, nextTokenType, styleContext);
		} finally {
			if (bulletize) {
				try {
					theme!.listBullet = listBullet;
				} catch {
					// Frozen theme: nothing was swapped.
				}
			}
		}
		if (token.type === "heading" && token.depth && width >= 8 && lines[0]) {
			const level = token.depth;
			if (level < 3) {
				lines[0] = (level === 1 ? "▌ " : "─ ") + lines[0];
			} else if (
				level <= 6 &&
				tui.stripTerminalSequences(lines[0]).startsWith(`${"#".repeat(level)} `)
			) {
				lines[0] = lines[0].replace(`${"#".repeat(level)} `, "· ");
			}
		}
		if (token.type === "list" && nextTokenType === "heading" && lines.length && lines.at(-1)) {
			// OmO attaches source ranges to this array. Keep it and only append a visual row.
			lines.push("");
		}
		return lines;
	};
	Object.defineProperty(prototype, "renderToken", { ...descriptor, value: renderToken });
	Object.defineProperty(prototype, HEADING_STYLE, {
		configurable: true,
		value: () => {
			if (Object.getOwnPropertyDescriptor(prototype, "renderToken")?.value !== renderToken) {
				return;
			}
			Object.defineProperty(prototype, "renderToken", descriptor);
			Reflect.deleteProperty(prototype, HEADING_STYLE);
			if (typeof clearCache === "function") clearCache();
		},
	});
	if (typeof clearCache === "function") clearCache();
}

// ============================================================================
// 圈数字 → 半角括号
// ============================================================================

// Nerd Font 补丁字形（U+2460-U+2473）ink 超界，DirectWrite 下渲染会压住相邻字符；
// 转成 ASCII "(n)" 后任何字体下宽度一致。U+2460-U+2473 连续，差值即序号。
const CIRCLED_RE = /[①-⑳]/g;

const BLOCKQUOTE_PREFIX = /^ {0,3}>[ \t]?/;
const CODE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const CODE_FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*\r?$/;

type MarkdownFence = { marker: string; blockquoteDepth: number };

function parseFenceLine(line: string): { blockquoteDepth: number; content: string } {
	let content = line;
	let blockquoteDepth = 0;
	while (BLOCKQUOTE_PREFIX.test(content)) {
		content = content.replace(BLOCKQUOTE_PREFIX, "");
		blockquoteDepth++;
	}
	return { blockquoteDepth, content };
}

function scanMarkdownFence(
	line: string,
	fence: MarkdownFence | undefined,
): { protected: boolean; fence: MarkdownFence | undefined } {
	const parsed = parseFenceLine(line);
	if (fence && parsed.blockquoteDepth >= fence.blockquoteDepth) {
		const close = parsed.content.match(CODE_FENCE_CLOSE)?.[1];
		const closed =
			parsed.blockquoteDepth === fence.blockquoteDepth &&
			close?.[0] === fence.marker[0] &&
			close.length >= fence.marker.length;
		return { protected: true, fence: closed ? undefined : fence };
	}
	const marker = parsed.content.match(CODE_FENCE_OPEN)?.[1];
	return {
		protected: Boolean(marker),
		fence: marker ? { marker, blockquoteDepth: parsed.blockquoteDepth } : undefined,
	};
}

function deCircled(markdown: string, source?: MarkdownCopySource): string {
	let fence: MarkdownFence | undefined;
	let offset = 0;
	const edits: MarkdownEdit[] = [];
	const result = markdown
		.split("\n")
		.map((line) => {
			const start = offset;
			offset += line.length + 1;
			const scanned = scanMarkdownFence(line, fence);
			fence = scanned.fence;
			if (scanned.protected) return line;
			return line.replace(CIRCLED_RE, (ch: string, index: number) => {
				const replacement = `(${ch.charCodeAt(0) - 0x2460 + 1})`;
				if (source)
					edits.push({ start: start + index, length: 1, replacementLength: replacement.length });
				return replacement;
			});
		})
		.join("\n");
	source?.record(result, edits);
	return result;
}

// ============================================================================
// 跨行链接规整
// ============================================================================

// \x1b 排除：Pi 的带颜色 Mermaid 输出把每行包成含 ANSI SGR（\x1b[...m）的 code span，
// 转义序列里的 `[` 不能当成链接起点，否则匹配会从第一个转义跨行直到后面真正的 `](`，
// 把图和之后的段落全压成一行（#84）。
const MULTILINE_LINK_RE = /(?<!\x1b)\[([^\]\n\x1b]*(?:\n[^\]\n\x1b]*)+)\](?=\()/g;

/** 防止 Markdown 跨行链接把行尾填充空格纳入 OSC 8 点击区。 */
function normalizeMultilineLinks(markdown: string, source?: MarkdownCopySource): string {
	const out: string[] = [];
	let prose: string[] = [];
	let proseOffset = 0;
	let offset = 0;
	const edits: MarkdownEdit[] = [];
	let fence: MarkdownFence | undefined;
	const flush = () => {
		if (prose.length === 0) return;
		out.push(
			prose.join("\n").replace(MULTILINE_LINK_RE, (match, label: string, index: number) => {
				const normalized = label.replace(/[ \t]*\r?\n[ \t]*/g, " ").trim();
				const replacement = `[${normalized}]`;
				if (source)
					edits.push({
						start: proseOffset + index,
						length: match.length,
						replacementLength: replacement.length,
					});
				return replacement;
			}),
		);
		prose = [];
	};
	for (const line of markdown.split("\n")) {
		const scanned = scanMarkdownFence(line, fence);
		const opening = !fence && scanned.fence;
		const closing = fence && !scanned.fence;
		fence = scanned.fence;
		if (opening || closing) flush();
		if (scanned.protected) out.push(line);
		else {
			if (prose.length === 0) proseOffset = offset;
			prose.push(line);
		}
		offset += line.length + 1;
	}
	flush();
	const result = out.join("\n");
	source?.record(result, edits);
	return result;
}

// ============================================================================
// 注册
// ============================================================================

export const MARKDOWN_ENHANCE_MESSAGE_TYPES: readonly MarkdownMessageType[] = [
	"user",
	"assistant",
	"assistant-thinking",
	"custom",
	"summary",
];

/** Pure conversion so the package entry point can share Pi's single transformer slot. */
export function transformMarkdown(
	markdown: string,
	context?: Partial<MarkdownTransformContext>,
	source?: MarkdownCopySource,
): string {
	const { messageType, isStreaming = false } = context ?? {};
	// thinking 保持原文；普通回复即使流式中也先关闭跨行链接的空白点击区。
	if (messageType === "assistant-thinking") return markdown;
	markdown = normalizeMultilineLinks(markdown, source);
	if (isStreaming) return markdown;
	markdown = deCircled(markdown, source);
	return renderDiagrams(markdown, context, source);
}

export default function (pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer(transformMarkdown, {
		messageTypes: MARKDOWN_ENHANCE_MESSAGE_TYPES,
	});
}
