import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	Markdown,
	matchesKey,
	stripTerminalSequences,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { styledPreviewLines } from "../feature/context.ts";
import { keybindings } from "../utils/keybindings.ts";
import type { ClipboardWriter } from "./clipboard-actions.ts";
import { stripToolFrameMarkers } from "./mouse/packets.ts";
import type { CardPreview } from "./tool/card-preview.ts";
import { expandShortcutText } from "./tool/names.ts";
import type { TranscriptAction, TranscriptItem } from "./transcript-items.ts";
import { withTranscriptScope } from "./transcript-scope.ts";
import { transcriptScrollAction, TranscriptViewport } from "./transcript-scroll.ts";

export const EXPAND_ACTION = "app.tools.expand";
const WHEEL_LINES = 3;

export function isTranscriptExitKey(data: string): boolean {
	return (
		matchesKey(data, "escape") ||
		matchesKey(data, "q") ||
		matchesKey(data, "ctrl+c") ||
		keybindings().matches(data, EXPAND_ACTION)
	);
}

export type TranscriptViewOptions = {
	readonly rows: () => number;
	readonly items: () => readonly TranscriptItem[];
	readonly theme: Parameters<typeof styledPreviewLines>[1];
	readonly close: () => void;
	readonly focused: (view: object) => boolean;
	readonly scrolled?: (delta: number, bodyHeight: number) => void;
	readonly suspendSelection?: () => () => void;
	readonly copy?: ClipboardWriter;
};

type LocatedAction = TranscriptAction & { readonly row: number; readonly owner: object | string };
type Detail = {
	readonly preview: CardPreview;
	readonly component: Text | Markdown;
	readonly viewport: TranscriptViewport;
	readonly restoreSelection: (() => void) | undefined;
};

export class TranscriptView {
	readonly #viewport = new TranscriptViewport(true);
	#promptRows: number[] = [];
	#actions: LocatedAction[] = [];
	#selection: LocatedAction | undefined;
	#detail: Detail | undefined;
	#hadFocus = false;
	#closed = false;
	readonly #options: TranscriptViewOptions;

	constructor(options: TranscriptViewOptions) {
		this.#options = options;
	}

	#nextAction(direction: 1 | -1): void {
		const { top, height } = this.#viewport;
		const count = this.#actions.length;
		if (!count) return;
		const previous = this.#selection ? this.#actions.indexOf(this.#selection) : -1;
		const start =
			direction === 1
				? this.#actions.findIndex(({ row }) => row >= top)
				: this.#actions.findLastIndex(({ row }) => row < top + height);
		const fallback = direction === 1 ? 0 : count - 1;
		const index = previous >= 0 ? (previous + direction + count) % count : start;
		this.#selection = this.#actions[index < 0 ? fallback : index];
		if (this.#selection) {
			const { row } = this.#selection;
			if (row < top || row >= top + height) this.#viewport.move(row);
		}
	}

	#close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#options.close();
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
		if (this.#detail && matchesKey(data, "escape")) {
			this.#detail.restoreSelection?.();
			this.#detail = undefined;
			return;
		}
		if (isTranscriptExitKey(data)) {
			this.#close();
			return;
		}
		if (!this.#detail && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
			this.#nextAction(matchesKey(data, "shift+tab") ? -1 : 1);
			return;
		}
		if (!this.#detail && matchesKey(data, "enter") && this.#selection) {
			const preview = this.#selection.activate();
			if (preview) {
				const body = stripTerminalSequences(preview.body() || "(no details available)")
					.replace(/\r\n?/g, "\n")
					.replace(/\t/g, "  ")
					.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
				this.#detail = {
					preview,
					component: preview.literal
						? new Text(body, 0, 0)
						: new Markdown(body, 0, 0, getMarkdownTheme()),
					viewport: new TranscriptViewport(false),
					restoreSelection: this.#options.suspendSelection?.(),
				};
			}
			return;
		}
		const action = transcriptScrollAction(data);
		if (action) {
			if (this.#detail) this.#detail.viewport.apply(action);
			else this.#viewport.apply(action, this.#promptRows);
		}
	}

	/** Pi still owns clicks, drags and screen text selection. */
	handleMouse(event: {
		readonly type?: string;
		readonly wheelDelta?: number;
		readonly button?: string;
	}): { handled: boolean } | undefined {
		if (event?.type !== "wheel") return undefined;
		const delta = Number(event.wheelDelta) || 0;
		if (delta !== 0)
			(this.#detail?.viewport ?? this.#viewport).apply({
				kind: "lines",
				lines: Math.sign(delta) * WHEEL_LINES,
			});
		return { handled: true };
	}

	render(width: number): string[] {
		const { focused, rows, scrolled, theme, copy } = this.#options;
		if (focused(this)) this.#hadFocus = true;
		else if (this.#hadFocus) queueMicrotask(() => this.#close());
		const height = Math.max(3, rows()) - 2;
		if (this.#detail) {
			const { component, preview, viewport } = this.#detail;
			const raw = component.render(width);
			const lines = preview.literal ? styledPreviewLines(raw, theme) : raw;
			return [
				...viewport.paint(lines, height, scrolled),
				truncateToWidth(preview.title, width),
				truncateToWidth("Esc back · j/k scroll", width),
			];
		}
		const lines: string[] = [];
		const prompts: number[] = [];
		const actions: LocatedAction[] = [];
		withTranscriptScope(() => {
			for (const item of this.#options.items()) {
				const row = lines.length;
				if (item.prompt) prompts.push(row);
				for (const action of item.actions?.(width, copy) ?? []) {
					actions.push({ ...action, row, owner: item.identity ?? item.view });
				}
				for (const line of item.view.render(width)) lines.push(stripToolFrameMarkers(line));
			}
		});
		const selection = this.#selection;
		this.#selection =
			selection &&
			actions.find(
				(candidate) => candidate.owner === selection.owner && candidate.id === selection.id,
			);
		this.#actions = actions;
		this.#promptRows = prompts;
		const body = this.#viewport.paint(lines, height, scrolled);
		const { top } = this.#viewport;
		let footer = actions.length ? "Tab/⇧Tab · Enter actions" : "";
		if (this.#selection) {
			const { row, label } = this.#selection;
			const marker = row < top ? "↑" : row >= top + height ? "↓" : "›";
			footer = `${marker} ${label} · ${actions.indexOf(this.#selection) + 1}/${actions.length}`;
		}
		return [...body, truncateToWidth(footer, width), this.#hintLine(width)];
	}

	#hintLine(width: number): string {
		const { theme } = this.#options;
		const { top, height, total } = this.#viewport;
		const position =
			total > height ? ` (${Math.min(100, Math.round(((top + height) / total) * 100))}%)` : "";
		const hint = `  Showing detailed transcript${position} · esc/q to exit · ${expandShortcutText()} to toggle · j/k scroll`;
		return truncateToWidth(typeof theme?.fg === "function" ? theme.fg("dim", hint) : hint, width);
	}

	invalidate(): void {}
}
