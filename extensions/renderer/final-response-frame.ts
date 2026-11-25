/**
 * Final-response frame：在 styled transcript 模式（on/compact）下，给唯一一条
 * “已完成、成功、纯文本”的助手最终回答罩一个透明中性圆角框。
 *
 * 成框条件（缺一即原生渲染）：
 * - CCStyle 处在激活样式（默认 `config.mode !== "off"`，可注入覆盖）；
 * - 组件不是浏览层副本（transcript-scope 标记的预览/对话框副本不罩框）；
 * - `lastMessage` 是最终态：`stopReason === "stop"`、有非空 text 块、
 *   无 toolCall 块、无 errorMessage；
 * - 终答身份：回放/重开凭 `stopReason === "stop"` + 非流式；live 组件原生
 *   永标 streaming，凭 agent_end 结算标记（只读集合，不调 updateContent，
 *   不重建 thinking 子树，与扩展/原生订阅顺序无关）；
 * - 框内只有答案：按原生 Markdown 子组件识别正文，先画框外的思考与间距；
 * - 渲染宽度足够（左右边框各占 2 列，太窄回退原生，避免挤坏正文）；
 * - 行来源（selection-source）可用：缺失时宁可不成框，也不破坏
 *   fullscreen 选中/复制的坐标映射（兼容性门）。
 *
 * 几何：顶 `╭─╮` 底 `╰─╯`，左右 `│ `/` │`，偏移经
 * `copyLineSources` 回填（`"│ "` 可见宽 2），边框行标
 * `null`（选中跳过，与 Box 一致）；OSC133 留内层；边框点击吞掉，内容点击
 * 平移后交 Container（thinking/handoff 命中不变）。
 *
 * 不碰 reasoning/工具卡/cancelled/error/流式正文；无 Copy 入口；不改 AGENTS/modal；
 * 边框行标 null 依赖宿主 setLineSource，缺失时纯文本回退（不深导入）。
 */

import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import * as tui from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";

import { config } from "../config/config.ts";
import { patchRegistry } from "../utils/patch-keys.ts";
import {
	createFinalResponseFinality,
	isFinalResponseContent,
	type AssistantMessageShape,
	type FinalityStore,
} from "./final-response-frame-finality.ts";
import { isTranscriptComponent } from "./transcript-scope.ts";
import { walkComponentTree } from "../utils/component-tree.ts";

const FINAL_RESPONSE_FRAME_PATCH_KEY = Symbol.for("pi.ccstyle.final-response-frame");

/** 边框单侧占用的列数（`"│ "` / `" │"` 的可见宽度）。 */
const FRAME_SIDE_COLUMNS = 2;
/** 成框最小渲染宽度：边框 4 列 + 至少 4 列正文，窄于此回退原生。 */
export const FINAL_RESPONSE_FRAME_MIN_WIDTH = 8;
/** 中性边框颜色：与工具卡强调色区分，只用 muted。 */
const FRAME_COLOR_NAME = "muted";

export type FinalResponseFrameTheme = {
	fg(name: string, text: string): string;
};

export type CopyLineSourcesFn = (
	from: readonly string[],
	to: string[],
	rowOffset?: number,
	columnOffset?: number,
) => string[];

export type SetLineSourceFn = (lines: string[], row: number, source: null) => void;

export type FinalResponseFrameSources = {
	copyLineSources: CopyLineSourcesFn;
	setLineSource?: SetLineSourceFn;
};

export type FinalResponseFrameOptions = {
	/** 样式是否激活；默认跟随全局 config（off 即原生）。 */
	isStyleActive?: () => boolean;
	/** 边框取色；默认用模块级 setFinalResponseFrameTheme 存下的主题。 */
	getTheme?: () => FinalResponseFrameTheme | undefined;
	/** 行来源函数；默认从宿主 pi-tui 解析，测试注入假实现。 */
	sources?: FinalResponseFrameSources;
};

type ComponentInternals = {
	lastMessage?: AssistantMessageShape;
	isStreaming?: boolean;
	hasToolCalls?: boolean;
	providerErrorOwned?: boolean;
	contentContainer?: { children: readonly tui.Component[] };
	invalidate(): void;
	updateContent(message: AssistantMessageShape, isStreaming?: boolean): void;
	render(width: number): string[];
	handleMouse?: (event: MouseEventLike) => unknown;
};

export type MouseEventLike = {
	x: number;
	y: number;
	width: number;
	height: number;
	[key: string]: unknown;
};

export type FinalResponseFrameHandle = {
	/** 原型是否可补丁（类结构兼容）。行来源缺失时仍为 true，只是暂不成框。 */
	supported: boolean;
	dispose(): void;
	/** 重绘挂载树里的助手组件（模式/主题切换后调用）。返回处理数。 */
	refresh(root: unknown): number;
	/** message_end 暂存候选签名，不翻转（原生仍标 streaming，迟到增量未定）。 */
	stageFinalCandidate(message: unknown): boolean;
	/** agent_end 结算确认并翻转命中的流式组件。返回翻转数。 */
	confirmFinalResponses(root: unknown, agentMessages: unknown): number;
};

let activeTheme: FinalResponseFrameTheme | undefined;

/** 与 message-display / compact-mode 的 setXTheme 同模式：后设置的主题获胜。 */
export function setFinalResponseFrameTheme(theme: FinalResponseFrameTheme | undefined): void {
	activeTheme = theme;
}

/** 老宿主没有 copyLineSources 时不改变原生布局。 */
function resolveHostSources(): FinalResponseFrameSources | undefined {
	const mod = tui as unknown as Record<string, unknown>;
	if (typeof mod.copyLineSources !== "function") return undefined;
	const sources: FinalResponseFrameSources = {
		copyLineSources: mod.copyLineSources as CopyLineSourcesFn,
	};
	// setLineSource 只在新版命名空间里有：有则边框行标 null（选中跳过），
	// 缺失就保持无来源（纯文本回退），不影响成框，不做深导入。
	if (typeof mod.setLineSource === "function") {
		sources.setLineSource = mod.setLineSource as SetLineSourceFn;
	}
	return sources;
}

function asComponent(value: unknown): ComponentInternals | undefined {
	if (value instanceof AssistantMessageComponent) return value as unknown as ComponentInternals;
	return undefined;
}

/** Compact thinking may rebuild children without updating the native render descriptors. */
function answerPrefix(component: ComponentInternals, width: number): number | undefined {
	const blocks = component.lastMessage?.content ?? [];
	if (!blocks.some((block) => block.type === "thinking")) return 0;
	const children = component.contentContainer?.children;
	if (!children?.length) return undefined;
	const answers = new Set(
		blocks.flatMap((block) =>
			block.type === "text" && typeof block.text === "string" ? [block.text.trim()] : [],
		),
	);
	let first: number | undefined;
	for (let i = children.length - 1; i >= 0; i--) {
		const child = children[i];
		if (child instanceof tui.Spacer) continue;
		if (!(child instanceof tui.Markdown) || Reflect.get(child, "defaultTextStyle") !== undefined)
			break;
		const text: unknown = Reflect.get(child, "text");
		if (typeof text !== "string" || !answers.has(text.trim())) break;
		first = i;
	}
	if (first === undefined) return undefined;
	return children.slice(0, first).reduce((rows, child) => rows + child.render(width).length, 0);
}

function shouldFrame(component: ComponentInternals, isStyleActive: () => boolean): boolean {
	if (!isStyleActive()) return false;
	if (isTranscriptComponent(component)) return false;
	if (component.hasToolCalls === true) return false;
	if (component.providerErrorOwned === true) return false;
	return isFinalResponseContent(component.lastMessage);
}

function padLine(line: string, width: number): string {
	const gap = width - visibleWidth(line);
	return gap > 0 ? line + " ".repeat(gap) : line;
}

type FramePaint = {
	theme: FinalResponseFrameTheme | undefined;
	sources: FinalResponseFrameSources;
};

function renderFramed(
	width: number,
	inner: string[],
	prefixLength: number,
	paintState: FramePaint,
): string[] {
	const { theme, sources } = paintState;
	const innerWidth = width - FRAME_SIDE_COLUMNS * 2;
	const paint = (text: string): string => theme?.fg(FRAME_COLOR_NAME, text) ?? text;
	const prefix = inner.slice(0, prefixLength);
	const body = prefixLength ? inner.slice(prefixLength) : inner;
	const framed = [...prefix, paint(`╭${"─".repeat(innerWidth + 2)}╮`)];
	const left = paint("│ ");
	const right = paint(" │");
	for (const line of body) framed.push(`${left}${padLine(line, innerWidth)}${right}`);
	framed.push(paint(`╰${"─".repeat(innerWidth + 2)}╯`));
	if (prefixLength) {
		sources.copyLineSources(inner, prefix);
		sources.copyLineSources(prefix, framed);
		sources.copyLineSources(inner, body, -prefixLength);
	}
	sources.copyLineSources(body, framed, prefixLength + 1, FRAME_SIDE_COLUMNS);
	sources.setLineSource?.(framed, prefixLength, null);
	sources.setLineSource?.(framed, framed.length - 1, null);
	return framed;
}

export function installFinalResponseFrame(
	options: FinalResponseFrameOptions = {},
): FinalResponseFrameHandle {
	const previous = patchRegistry.get<{ dispose(): void }>(FINAL_RESPONSE_FRAME_PATCH_KEY);
	previous?.dispose();

	const prototype = AssistantMessageComponent.prototype as unknown as Record<string, unknown>;
	const containerPrototype = Object.getPrototypeOf(prototype) as Record<string, unknown> | null;
	const originalRender = prototype.render;
	const originalMouse = containerPrototype?.handleMouse;
	if (typeof originalRender !== "function" || typeof originalMouse !== "function") {
		return {
			supported: false,
			dispose: () => {},
			refresh: () => 0,
			stageFinalCandidate: () => false,
			confirmFinalResponses: () => 0,
		};
	}

	const isStyleActive = options.isStyleActive ?? (() => config.mode !== "off");
	const sources: FinalResponseFrameSources | undefined = options.sources ?? resolveHostSources();
	const getTheme = options.getTheme ?? (() => activeTheme);
	/** 终答结算状态机：message_end 暂存，agent_end 确认。每次安装独立一份。 */
	const finality: FinalityStore = createFinalResponseFinality();
	const geometry = new WeakMap<
		ComponentInternals,
		{ width: number; prefix: number; rows: number }
	>();
	const frameState = (component: ComponentInternals, width: number): FramePaint | undefined => {
		if (width < FINAL_RESPONSE_FRAME_MIN_WIDTH || !sources) return undefined;
		if (!shouldFrame(component, isStyleActive)) return undefined;
		// live 组件原生永标 streaming：只认结算标记；回放组件走 !isStreaming。
		if (component.isStreaming !== false && !finality.isFramed(component)) return undefined;
		return { theme: getTheme(), sources };
	};

	const framedRender = function (this: ComponentInternals, width: number): string[] {
		const render = originalRender as ComponentInternals["render"];
		const state = frameState(this, width);
		geometry.delete(this);
		if (!state) return render.call(this, width);
		const innerWidth = width - FRAME_SIDE_COLUMNS * 2;
		const prefix = answerPrefix(this, innerWidth);
		if (prefix === undefined) return render.call(this, width);
		const lines = render.call(this, innerWidth);
		if (prefix >= lines.length) return render.call(this, width);
		geometry.set(this, { width, prefix, rows: lines.length });
		return renderFramed(width, lines, prefix, state);
	};

	const framedMouse = function (this: ComponentInternals, event: MouseEventLike): unknown {
		const dispatch = originalMouse as (this: unknown, event: MouseEventLike) => unknown;
		const frame = geometry.get(this);
		if (!frame || frame.width !== event.width) return dispatch.call(this, event);
		const innerWidth = event.width - FRAME_SIDE_COLUMNS * 2;
		const { prefix, rows } = frame;
		if (event.y === prefix || event.y > rows) return undefined;
		const inside = event.y > prefix;
		const inner = {
			...event,
			x: event.x - (inside ? FRAME_SIDE_COLUMNS : 0),
			y: event.y - (inside ? 1 : 0),
			height: rows,
			width: innerWidth,
		};
		if (inner.x < 0 || inner.x >= innerWidth) return undefined;
		return dispatch.call(this, inner);
	};

	prototype.render = framedRender;
	prototype.handleMouse = framedMouse;

	const patch = {
		dispose: () => {
			if (!patchRegistry.owns(FINAL_RESPONSE_FRAME_PATCH_KEY, patch)) return;
			patchRegistry.dispose(FINAL_RESPONSE_FRAME_PATCH_KEY, patch);
			if (prototype.render === framedRender) prototype.render = originalRender;
			if (prototype.handleMouse === framedMouse) delete prototype.handleMouse;
		},
	};
	patchRegistry.install(FINAL_RESPONSE_FRAME_PATCH_KEY, patch);

	return {
		supported: true,
		dispose: patch.dispose,
		refresh: (root) => {
			let count = 0;
			walkComponentTree(root, (value) => {
				const component = asComponent(value);
				if (!component) return;
				try {
					component.invalidate();
					count++;
				} catch {
					// 单个组件失败不阻断其余（与 refreshMountedTranscript 同策略）。
				}
			});
			return count;
		},
		stageFinalCandidate: (message) => finality.stage(message),
		confirmFinalResponses: (root, agentMessages) => finality.confirm(root, agentMessages),
	};
}
