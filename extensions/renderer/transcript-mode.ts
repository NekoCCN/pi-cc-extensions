/**
 * Existing fullscreen Ctrl+O entry point. Pi reserves the expand action; intercept it
 * only over the chat editor, and leave it to Pi when `!`/`!!` output can be expanded.
 */
import { BashExecutionComponent, copyToClipboard } from "@earendil-works/pi-coding-agent";
import { isKeyRelease } from "@earendil-works/pi-tui";
import { config } from "../config/config.ts";
import { walkComponentTree } from "../utils/component-tree.ts";
import { keybindings, setInjectedKeybindings } from "../utils/keybindings.ts";
import { createClipboardWriter } from "./clipboard-actions.ts";
import { fullscreenLazyTui, getToolMouseTui } from "./mouse/scroll.ts";
import {
	collectTranscriptItems,
	findChatContainer,
	type TranscriptCopyPolicy,
} from "./transcript-items.ts";
import { EXPAND_ACTION, TranscriptView } from "./transcript-view.ts";

export { collectTranscriptItems, findChatContainer } from "./transcript-items.ts";
export type { TranscriptCopyPolicy } from "./transcript-items.ts";
export { transcriptScrollAction } from "./transcript-scroll.ts";
export {
	isTranscriptExitKey,
	TranscriptView,
	type TranscriptViewOptions,
} from "./transcript-view.ts";

const BASH_PREVIEW_LINES = 20;

type ScreenPoint = { readonly row: number; readonly col: number; readonly scrollView?: unknown };
type ScreenSelection = {
	selectionAnchor?: ScreenPoint;
	selectionFocus?: ScreenPoint;
	selectionInitialRange?: { readonly start: ScreenPoint; readonly end: ScreenPoint };
	lastClick?: unknown;
	resetTextSelection?: () => void;
};

/** Pi's overlay selection uses screen rows rather than a backing scroll view. */
export function followScreenSelection(
	tui: ScreenSelection | undefined,
	delta: number,
	bodyHeight: number,
): void {
	if (!tui || delta === 0) return;
	const { selectionAnchor: anchor, selectionFocus: focus, selectionInitialRange: range } = tui;
	if (!anchor || !focus || anchor.scrollView || focus.scrollView) return;
	const move = (point: ScreenPoint): ScreenPoint => ({ ...point, row: point.row - delta });
	const nextAnchor = move(anchor);
	const nextFocus = move(focus);
	const inside = (point: ScreenPoint) => point.row >= 0 && point.row < bodyHeight;
	if (!inside(nextAnchor) || !inside(nextFocus)) {
		tui.resetTextSelection?.();
		return;
	}
	tui.selectionAnchor = nextAnchor;
	tui.selectionFocus = nextFocus;
	if (range) tui.selectionInitialRange = { start: move(range.start), end: move(range.end) };
	tui.lastClick = undefined;
}

type TerminalInputHandler = (data: string) => { consume?: boolean } | undefined;
type TranscriptTui = ScreenSelection & {
	readonly terminal?: { readonly rows?: number };
	readonly focusedComponent?: object;
	readonly hasOverlay?: () => boolean;
	readonly flash?: (message: string) => void;
};
type TranscriptUi = {
	onTerminalInput(handler: TerminalInputHandler): () => void;
	notify?: (message: string, type: "error" | "info") => void;
	custom<T>(
		factory: (
			tui: TranscriptTui,
			theme: unknown,
			keybindings: unknown,
			done: () => void,
		) => TranscriptView,
		options: {
			readonly overlay: true;
			readonly overlayOptions: {
				readonly anchor: "top-left";
				readonly width: "100%";
				readonly maxHeight: "100%";
				readonly margin: 0;
			};
		},
	): Promise<T>;
};

let ui: TranscriptUi | undefined;
let unsubscribe: (() => void) | undefined;
let open = false;
let closeOpen: (() => void) | undefined;

export function isTranscriptModeActive(): boolean {
	return open;
}

function canOpen(tui: TranscriptTui | undefined): boolean {
	const focused = tui?.focusedComponent;
	const handlers: unknown = focused && Reflect.get(focused, "actionHandlers");
	return (
		config.mode !== "off" &&
		fullscreenLazyTui(tui) &&
		tui?.hasOverlay?.() !== true &&
		handlers instanceof Map &&
		handlers.has(EXPAND_ACTION)
	);
}

function hasExpandableBashOutput(root: unknown): boolean {
	let found = false;
	walkComponentTree(root, (value) => {
		if (found) return false;
		if (!(value instanceof BashExecutionComponent)) return undefined;
		if (Reflect.get(value, "status") === "running") return undefined;
		const getOutput: unknown = Reflect.get(value, "getOutput");
		const output = typeof getOutput === "function" ? getOutput.call(value) : "";
		if (String(output ?? "").split("\n").length > BASH_PREVIEW_LINES) found = true;
		return undefined;
	});
	return found;
}

function openTranscript(policy: TranscriptCopyPolicy): void {
	const sessionUi = ui;
	if (!sessionUi || open) return;
	open = true;
	void sessionUi
		.custom<void>(
			(tui, theme, injectedKeybindings, done) => {
				setInjectedKeybindings(injectedKeybindings);
				closeOpen = done;
				const copy = createClipboardWriter(
					{
						copy: copyToClipboard,
						notify(message, isError) {
							const host = getToolMouseTui() ?? tui;
							if (!isError && typeof host.flash === "function") host.flash(message);
							else sessionUi.notify?.(message, isError ? "error" : "info");
						},
					},
					() => ui === sessionUi,
				);
				return new TranscriptView({
					rows: () => Number(tui.terminal?.rows) || 24,
					items: () => collectTranscriptItems(findChatContainer(getToolMouseTui() ?? tui), policy),
					theme,
					copy,
					close: done,
					focused: (view) => tui.focusedComponent === view,
					scrolled: (delta, bodyHeight) => followScreenSelection(tui, delta, bodyHeight),
					suspendSelection() {
						const { selectionAnchor, selectionFocus, selectionInitialRange } = tui;
						tui.resetTextSelection?.();
						return () => {
							tui.resetTextSelection?.();
							tui.selectionAnchor = selectionAnchor;
							tui.selectionFocus = selectionFocus;
							tui.selectionInitialRange = selectionInitialRange;
						};
					},
				});
			},
			{
				overlay: true,
				overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 },
			},
		)
		.finally(() => {
			open = false;
			closeOpen = undefined;
		});
}

function handleInput(data: string, policy: TranscriptCopyPolicy): ReturnType<TerminalInputHandler> {
	if (open || !keybindings().matches(data, EXPAND_ACTION)) return undefined;
	const tui = getToolMouseTui();
	if (!canOpen(tui)) return undefined;
	if (isKeyRelease(data)) return { consume: true };
	if (hasExpandableBashOutput(tui)) return undefined;
	openTranscript(policy);
	return { consume: true };
}

export function installTranscriptMode(
	ctx: { readonly mode?: string; readonly hasUI?: boolean; readonly ui?: unknown },
	policy: TranscriptCopyPolicy = {},
): void {
	teardownTranscriptMode();
	if (ctx.mode !== "tui" || !ctx.hasUI || !ctx.ui || typeof ctx.ui !== "object") return;
	if (
		typeof Reflect.get(ctx.ui, "onTerminalInput") !== "function" ||
		typeof Reflect.get(ctx.ui, "custom") !== "function"
	)
		return;
	ui = ctx.ui as TranscriptUi;
	unsubscribe = ui.onTerminalInput((data) => handleInput(data, policy));
}

export function teardownTranscriptMode(): void {
	closeOpen?.();
	unsubscribe?.();
	unsubscribe = undefined;
	ui = undefined;
}
