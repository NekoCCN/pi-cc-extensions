import type {
	ExtensionAPI,
	MarkdownMessageType,
	MarkdownTransformContext,
} from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import { diagramKind, render as renderMermaid, sourceBox } from "grok-mermaid";

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
// Mermaid 方言渲染
// ============================================================================

// 标准 ```mermaid 交给 Pi 内置渲染器（1.5.1 起支持饼图、自定义样式、可点击标签，
// 也会画在展开的 summary 里）；这里只补 grok-mermaid 才认的方言 fence。
const DIAGRAM_FENCE =
	/^(`{3,})\s*(statediagram|statediagram-v2|classdiagram|classdiagram-v2|erdiagram|sequencediagram)\s*$/i;
const FENCE_OPEN = /^(`{3,})/;
const FENCE_CLOSE = /^`{3,}\s*$/;

/** 把一行图内容包成行内代码（保持空格与框线字符对齐）。 */
function codeSpan(line: string): string {
	const content = line || "\u00a0";
	const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
	const fence = "`".repeat(longestRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

/** 渲染失败或图宽超出终端宽度时，把源码包进带标题的框里显示。 */
function framedSource(src: string, width: number): string {
	const box = sourceBox(src, Math.max(8, width - 2));
	return `\`\`\`\n${box.plain.join("\n")}\n\`\`\``;
}

/** 解析 ```diagram 代码块，返回 { 源码, 块内行数 }；未闭合返回 null。 */
function collectFence(lines: string[], i: number): { diagram: string; next: number } | null {
	const open = lines[i].match(FENCE_OPEN)?.[0] ?? "```";
	const src: string[] = [];
	let j = i + 1;
	while (j < lines.length) {
		if (lines[j].match(FENCE_CLOSE) && lines[j].startsWith(open)) {
			return { diagram: src.join("\n"), next: j + 1 };
		}
		src.push(lines[j]);
		j++;
	}
	return null; // 未闭合：放弃转换，保持原文
}

// ============================================================================
// 圈数字 → 半角括号
// ============================================================================

// Nerd Font 补丁字形（U+2460-U+2473）ink 超界，DirectWrite 下渲染会压住相邻字符；
// 转成 ASCII "(n)" 后任何字体下宽度一致。U+2460-U+2473 连续，差值即序号。
const CIRCLED_RE = /[①-⑳]/g;

const BLOCKQUOTE_PREFIX = /^ {0,3}>[ \t]?/;
const CODE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const CODE_FENCE_CLOSE = /^ {0,3}(`+|~+)[ \t]*$/;

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

function deCircled(markdown: string): string {
	let fence: MarkdownFence | undefined;
	return markdown
		.split("\n")
		.map((line) => {
			const scanned = scanMarkdownFence(line, fence);
			fence = scanned.fence;
			if (scanned.protected) return line;
			return line.replace(CIRCLED_RE, (ch) => `(${ch.codePointAt(0)! - 0x2460 + 1})`);
		})
		.join("\n");
}

// ============================================================================
// 跨行链接规整
// ============================================================================

// \x1b 排除：Pi 的带颜色 Mermaid 输出把每行包成含 ANSI SGR（\x1b[...m）的 code span，
// 转义序列里的 `[` 不能当成链接起点，否则匹配会从第一个转义跨行直到后面真正的 `](`，
// 把图和之后的段落全压成一行（#84）。
const MULTILINE_LINK_RE = /(?<!\x1b)\[([^\]\n\x1b]*(?:\n[^\]\n\x1b]*)+)\](?=\()/g;

/** 防止 Markdown 跨行链接把行尾填充空格纳入 OSC 8 点击区。 */
function normalizeMultilineLinks(markdown: string): string {
	const out: string[] = [];
	let prose: string[] = [];
	let fence: MarkdownFence | undefined;
	const flush = () => {
		if (prose.length === 0) return;
		out.push(
			prose.join("\n").replace(MULTILINE_LINK_RE, (_match, label: string) => {
				const normalized = label.replace(/[ \t]*\n[ \t]*/g, " ").trim();
				return `[${normalized}]`;
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
		else prose.push(line);
	}
	flush();
	return out.join("\n");
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
): string {
	const { messageType, isStreaming = false } = context ?? {};
	// thinking 保持原文；普通回复即使流式中也先关闭跨行链接的空白点击区。
	if (messageType === "assistant-thinking") return markdown;
	markdown = normalizeMultilineLinks(markdown);
	if (isStreaming) return markdown;
	markdown = deCircled(markdown);
	return renderDiagrams(markdown, context);
}

export default function (pi: ExtensionAPI): void {
	pi.registerMarkdownTransformer(transformMarkdown, {
		messageTypes: MARKDOWN_ENHANCE_MESSAGE_TYPES,
	});
}

// grok-mermaid 渲染结果缓存：resize/restored 重绘会重复转换，按源码缓存 art。
// ponytail: 固定上限 50 条，防长期会话膨胀；超出后清空重来。
const ART_CACHE = new Map<string, ReturnType<typeof renderMermaid>>();
const ART_CACHE_MAX = 50;

/** 获取/计算 mermaid art（带缓存）。 */
function getArt(src: string): ReturnType<typeof renderMermaid> | null {
	const cached = ART_CACHE.get(src);
	if (cached) return cached;
	let art = null;
	try {
		art = renderMermaid(src);
	} catch {
		art = null;
	}
	if (ART_CACHE.size >= ART_CACHE_MAX) ART_CACHE.clear();
	if (art) ART_CACHE.set(src, art);
	return art;
}

/** Mermaid 方言代码块 → ASCII 图（流式跳过）。 */
function renderDiagrams(
	markdown: string,
	context?: { isStreaming?: boolean; availableWidth?: number },
): string {
	const { isStreaming = false, availableWidth } = context ?? {};
	if (isStreaming) return markdown;
	const lines = markdown.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const fence = line.match(DIAGRAM_FENCE);
		if (fence) {
			const collected = collectFence(lines, i);
			if (collected) {
				const { diagram, next } = collected;
				// grok-mermaid 需要源码自带类型头：fence 名当类型头补上；正文已带头就别再补，
				// 重复头会解析失败退成源码框，或者把类型头画成一个节点
				const src = diagramKind(diagram) ? diagram : `${fence[2]}\n${diagram}`;
				const art = getArt(src);
				const width = availableWidth ?? 80;
				if (art && art.width <= width) {
					// 图行用硬换行（行尾两空格）连接，防止 Markdown 软换行合并行
					out.push(art.plain.map(codeSpan).join("  \n"));
				} else {
					out.push(framedSource(src, width));
				}
				i = next;
				continue;
			}
			// 未闭合：保持原文
		}
		out.push(line);
		i++;
	}
	return out.join("\n");
}
