/**
 * Add hover and copy actions to fullscreen assistant Markdown.
 *
 * Pi's transformer supplies provenance; a removable Markdown prototype patch
 * adds mouse actions only to fullscreen assistant-body instances. This module
 * deliberately does not implement cell selection or geometry.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	copyToClipboard,
	getAgentDir,
	VERSION,
	type ExtensionAPI,
	type ExtensionContext,
	type MarkdownTransformContext,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	TuiAltScreen,
	visibleWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { walkComponentTree } from "../utils/component-tree.ts";
import { isFullscreenTui } from "../utils/fullscreen-detect.ts";
import { createClipboardWriter, type ClipboardWriter } from "./clipboard-actions.ts";
import { codeSources } from "./markdown-code-source.ts";
import {
	type ActionHit,
	type ActionHover,
	bindActionRows,
	type CopyPaint,
	paintActionRows,
	TABLE_FORMATS,
	type TableFormat,
	tableFormatName,
} from "./markdown-copy-actions.ts";
import { type CopyFrame, NativeMarkdownCopy } from "./markdown-copy-native.ts";
import {
	collectTables,
	type MarkdownToken,
	serializeTable,
	type TableToken,
} from "./markdown-table-source.ts";
import { isTranscriptComponent, markTranscriptComponent } from "./transcript-scope.ts";

export { serializeTable };

const PATCH = Symbol.for("pi.ccstyle.markdown-table-copy");
const ACTIONS_KEY = Symbol.for("pi.ccstyle.markdown-table-copy.actions");
type CopyText = (text: string) => Promise<void>;
type Notify = (message: string, isError: boolean) => void;

export interface TableCopyOptions {
	tui: { readonly mode?: string };
	paint: CopyPaint;
	readonly tables?: boolean;
	copy?: CopyText;
	notify?: Notify;
	/** Compatibility diagnostics; defaults to an agent-directory debug log, never stdout. */
	debug?: (message: string) => void;
}

export interface TableCopyInstallation {
	/** Called by the entry point's combined transformer; never changes the source. */
	noteSource(context: MarkdownTransformContext, original?: string, display?: string): void;
	getResponseCopy(): ((text: string) => void) | undefined;
	dispose(): void;
}

interface TableCopyOwner extends TableCopyOptions {
	debug: (message: string) => void;
	writer: ClipboardWriter;
}

interface MarkdownInternals {
	cachedTokens?: { deref(): { tokens: MarkdownToken[]; source: string } | undefined };
	clearRenderCache?: () => void;
}

interface ActionState {
	owner: TableCopyOwner;
	lines: string[];
	hits: ActionHit[];
	hover?: ActionHover;
}

interface MarkdownWithActions extends Markdown {
	[ACTIONS_KEY]?: ActionState;
}

type Render = (this: MarkdownWithActions, width: number) => string[];
type RenderTable = (
	this: MarkdownWithActions,
	token: TableToken,
	availableWidth: number,
	nextTokenType?: string,
	styleContext?: unknown,
) => string[];
type HandleMouse = (
	this: MarkdownWithActions,
	event: TuiMouseEvent,
) => TuiMouseEventResult | undefined;

interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: unknown;
}

interface SelectionBounds {
	start: SelectionPoint;
	end: SelectionPoint;
}

interface SelectionInternals {
	getSelectionBounds(): SelectionBounds | undefined;
	getSelectionSourceLine(point: SelectionPoint): string;
}

type SelectionText = (this: SelectionInternals) => string | undefined;
type SelectionColumns = (
	this: SelectionInternals,
	line: string,
	row: number,
	selection: SelectionBounds,
	minColumn?: number,
	maxColumn?: number,
) => { start: number; end: number };

interface Rendering {
	readonly component: MarkdownWithActions;
	readonly transcript: boolean;
	copy: CopyFrame<TableToken>;
}

interface Patch {
	version: 5;
	active: boolean;
	markerPrefix: string;
	selectionTarget: Prototype;
	originalSelectionText: SelectionText;
	originalSelectionColumns: SelectionColumns;
	wrappedSelectionText: SelectionText;
	wrappedSelectionColumns: SelectionColumns;
	owners: Set<TableCopyOwner>;
	components: Set<WeakRef<MarkdownWithActions>>;
	componentRefs: WeakMap<MarkdownWithActions, WeakRef<MarkdownWithActions>>;
	componentOwners: WeakMap<MarkdownWithActions, TableCopyOwner>;
	native: boolean;
	renderer: NativeMarkdownCopy<TableToken>;
	codeKeys: WeakMap<MarkdownWithActions, ReadonlySet<string>>;
	rendering?: Rendering;
	originalRender: Render;
	originalRenderTable: RenderTable;
	originalHandleMouse?: HandleMouse;
	wrappedRender: Render;
	wrappedRenderTable: RenderTable;
	wrappedHandleMouse: HandleMouse;
}

type Prototype = Record<PropertyKey, unknown>;

function label(format: TableFormat, compact = false): string {
	if (compact) return `[${format === "markdown" ? "MD" : format.toUpperCase()}]`;
	return `[Copy ${tableFormatName(format)}]`;
}

/** Zero-width APC markers survive caches; real terminals require ST, not BEL. */
function marker(patch: Patch, kind: string): string {
	return `${patch.markerPrefix}${kind}\x1b\\`;
}

function isActionRow(patch: Patch, line: string): boolean {
	return (
		line.includes(marker(patch, "code:").slice(0, -2)) ||
		line.includes(marker(patch, "skip")) ||
		TABLE_FORMATS.some((format) => line.includes(marker(patch, `action:${format}`)))
	);
}

function diagnostics(options: TableCopyOptions): (message: string) => void {
	const reported = new Set<string>();
	return (message) => {
		if (reported.has(message)) return;
		reported.add(message);
		const entry = `[table-copy] Pi ${VERSION}: ${message}`;
		try {
			if (options.debug) options.debug(entry);
			else {
				const directory = join(getAgentDir(), "logs");
				mkdirSync(directory, { recursive: true });
				appendFileSync(
					join(directory, "pi-cc-extensions-table-copy.log"),
					`${new Date().toISOString()} ${entry}\n`,
				);
			}
		} catch {
			// A read-only log directory or custom logger must not break rendering.
		}
	};
}

function actionLines(patch: Patch, availableWidth: number): string[] {
	const compact = visibleWidth(label("markdown")) > availableWidth;
	const labels = TABLE_FORMATS.map((format) => label(format, compact));
	// Even the compact labels need five columns. Hide actions rather than render
	// a broken label or an unidentifiable one-character button below that width.
	if (labels.some((text) => visibleWidth(text) > availableWidth)) return [];
	const actions = TABLE_FORMATS.map(
		(format, index) =>
			`${marker(patch, `action:${format}`)}${labels[index]}${marker(patch, "end")}`,
	);
	if (visibleWidth(actions.join("   ")) <= availableWidth) return [actions.join("   ")];
	if (visibleWidth(actions.join(" ")) <= availableWidth) return [actions.join(" ")];
	return actions;
}

function parsedMarkdown(component: MarkdownWithActions) {
	const cache = (component as unknown as MarkdownInternals).cachedTokens;
	const parsed = typeof cache?.deref === "function" ? cache.deref() : undefined;
	return Array.isArray(parsed?.tokens) ? parsed : undefined;
}

/** Rebuild hit regions after every new render; identical cached lines reuse them. */
function bindActions(
	patch: Patch,
	component: MarkdownWithActions,
	lines: string[],
	owner: TableCopyOwner,
): void {
	if (component[ACTIONS_KEY]?.lines === lines && component[ACTIONS_KEY]?.owner === owner) return;
	const frame = patch.rendering?.copy;
	const tokens = patch.native ? undefined : parsedMarkdown(component)?.tokens;
	const tables = patch.native
		? (frame?.tables ?? [])
		: owner.tables !== false && tokens
			? collectTables(tokens)
			: [];
	const hits = bindActionRows(
		lines,
		{ tables, codes: frame?.codes, serialize: serializeTable },
		{
			marker: (kind) => marker(patch, kind),
			debug: owner.debug,
		},
	);
	const previousHover = component[ACTIONS_KEY]?.hover;
	const hover = hits.some(
		(hit) => hit.y === previousHover?.y && hit.format === previousHover?.format,
	)
		? previousHover
		: undefined;
	paintActionRows(lines, hits, {
		hover,
		paint: owner.paint,
		endMarker: marker(patch, "end"),
	});
	component[ACTIONS_KEY] = { owner, lines, hits, hover };
}

function currentPatch(target: Prototype): Patch | undefined {
	const held = target[PATCH] as Partial<Patch> | undefined;
	return held?.version === 5 ? (held as Patch) : undefined;
}

function eligibleOwner(patch: Patch, component: MarkdownWithActions): TableCopyOwner | undefined {
	const owner = patch.componentOwners.get(component);
	return patch.active &&
		owner &&
		patch.owners.has(owner) &&
		isFullscreenTui(owner.tui) &&
		!isTranscriptComponent(component)
		? owner
		: undefined;
}

/** Hover changes only row colors, not block layout or syntax highlighting. */
function clearLineCache(component: MarkdownWithActions): void {
	const clear = (component as unknown as MarkdownInternals).clearRenderCache;
	if (typeof clear === "function") clear.call(component);
	else component.invalidate();
}

/** Cached messages may have rendered before session_start and missed our marker. */
function invalidateMountedMarkdown(tui: unknown): void {
	walkComponentTree(tui, (component) => {
		if (component instanceof Markdown) component.invalidate();
	});
}

function trackComponent(patch: Patch, component: MarkdownWithActions): void {
	if (patch.componentRefs.has(component)) return;
	if (patch.components.size >= 100) {
		for (const ref of patch.components) if (!ref.deref()) patch.components.delete(ref);
	}
	const ref = new WeakRef(component);
	patch.componentRefs.set(component, ref);
	patch.components.add(ref);
}

const NO_INSTALLATION: TableCopyInstallation = {
	noteSource: () => undefined,
	getResponseCopy: () => undefined,
	dispose() {},
};

/**
 * Install only for a fullscreen owner. Shared wrappers stay inert after the last
 * owner releases them, even if another extension still holds a wrapper above us.
 */
export function installTableCopy(options: TableCopyOptions): TableCopyInstallation {
	if (!isFullscreenTui(options.tui)) return NO_INSTALLATION;
	const debug = diagnostics(options);
	const target = Markdown.prototype as unknown as Prototype;
	const selectionTarget = TuiAltScreen.prototype as unknown as Prototype;
	let patch = currentPatch(target);
	if (!patch?.active) {
		const native =
			typeof target.ownSources === "function" && typeof target.renderToken === "function";
		const required = [
			[target, "Markdown", "render"],
			[target, "Markdown", "renderTable"],
			...(native ? [] : ([[target, "Markdown", "clearRenderCache"]] as const)),
			[selectionTarget, "TuiAltScreen", "getActiveSelectionText"],
			[selectionTarget, "TuiAltScreen", "getSelectionColumns"],
			[selectionTarget, "TuiAltScreen", "getSelectionBounds"],
			[selectionTarget, "TuiAltScreen", "getSelectionSourceLine"],
		] as const;
		const missing = required.filter(
			([prototype, _name, key]) => typeof prototype[key] !== "function",
		);
		if (missing.length > 0) {
			debug(
				`Table copy not installed: incompatible private API (${missing.map(([_prototype, name, key]) => `${name}.${key}`).join(", ")}).`,
			);
			return NO_INSTALLATION;
		}
		const originalRender = target.render as Render;
		const originalRenderTable = target.renderTable as RenderTable;
		const created: Patch = {
			version: 5,
			active: true,
			markerPrefix: `\x1b_pi:ccstyle-table-copy:${randomUUID()}:`,
			selectionTarget,
			originalSelectionText: selectionTarget.getActiveSelectionText as SelectionText,
			originalSelectionColumns: selectionTarget.getSelectionColumns as SelectionColumns,
			wrappedSelectionColumns(line, row, selection, minColumn, maxColumn) {
				const columns = created.originalSelectionColumns.call(
					this,
					line,
					row,
					selection,
					minColumn,
					maxColumn,
				);
				if (!created.active) return columns;
				if (isActionRow(created, line)) return { start: columns.start, end: columns.start };
				return columns;
			},
			wrappedSelectionText() {
				const text = created.originalSelectionText.call(this);
				if (!created.active || text === undefined) return text;
				const selection = this.getSelectionBounds();
				if (!selection) return text;
				const lines = text.split("\n");
				if (lines.length !== selection.end.row - selection.start.row + 1) return text;
				// Keep Pi's grapheme slicing, scroll coordinates and ordinary blank
				// lines. Only remove rows inserted by this active patch, never labels.
				const selectable = lines.filter(
					(_line, offset) =>
						!isActionRow(
							created,
							this.getSelectionSourceLine({
								...selection.start,
								row: selection.start.row + offset,
							}),
						),
				);
				const selected = selectable.join("\n");
				return selected.length > 0 ? selected : undefined;
			},
			owners: new Set(),
			components: new Set(),
			componentRefs: new WeakMap(),
			componentOwners: new WeakMap(),
			codeKeys: new WeakMap(),
			native,
			renderer: new NativeMarkdownCopy(),
			originalRender,
			originalRenderTable,
			originalHandleMouse: target.handleMouse as HandleMouse | undefined,
			wrappedRenderTable(token, availableWidth, nextTokenType, styleContext) {
				const lines = created.originalRenderTable.call(
					this,
					token,
					availableWidth,
					nextTokenType,
					styleContext,
				);
				const owner = eligibleOwner(created, this);
				if (!owner || owner.tables === false || token.header.length === 0) return lines;
				const frame = created.rendering;
				if (frame?.component === this && created.native) frame.copy.tables.push(token);
				else if (!parsedMarkdown(this)) {
					owner.debug("Table actions skipped: incompatible private API (Markdown.cachedTokens).");
					return lines;
				}
				if (lines.length > 0) lines[0] = marker(created, "table") + lines[0];
				const trailingBlank = lines.at(-1) === "" ? lines.pop() : undefined;
				lines.push(...actionLines(created, availableWidth));
				if (trailingBlank !== undefined) lines.push(trailingBlank);
				return lines;
			},
			wrappedRender(width) {
				if (!created.active) return created.originalRender.call(this, width);
				const previous = created.rendering;
				const transcript = isTranscriptComponent(this);
				if (transcript) markTranscriptComponent(this);
				const frame: Rendering = { component: this, transcript, copy: { tables: [] } };
				created.rendering = frame;
				try {
					// Eligibility affects cached table blocks, unlike hover. Rebuild only
					// when it changes (including runtime regular/fullscreen switches).
					if (Boolean(this[ACTIONS_KEY]) !== Boolean(eligibleOwner(created, this))) {
						delete this[ACTIONS_KEY];
						this.invalidate();
					}
					const rendered = created.renderer.render(this, frame.copy, {
						owner: () => eligibleOwner(created, this),
						marker: (kind) => marker(created, kind),
						render: () => created.originalRender.call(this, width),
					});
					frame.copy = rendered.frame;
					const { lines } = rendered;
					const owner = eligibleOwner(created, this);
					if (owner) {
						trackComponent(created, this);
						bindActions(created, this, lines, owner);
					}
					return lines;
				} finally {
					created.rendering = previous;
				}
			},
			wrappedHandleMouse(event) {
				const owner = eligibleOwner(created, this);
				const state = this[ACTIONS_KEY];
				if (!owner || state?.owner !== owner) return created.originalHandleMouse?.call(this, event);
				const hit = state.hits.find(
					(action) => action.y === event.y && event.x >= action.start && event.x < action.end,
				);
				if (event.type === "move") {
					const hover = hit ? { y: hit.y, format: hit.format } : undefined;
					if (state.hover?.y !== hover?.y || state.hover?.format !== hover?.format) {
						state.hover = hover;
						clearLineCache(this);
						return { handled: true, render: true };
					}
				}
				// Fullscreen release synthesizes click only after capturing this press.
				if (event.type === "press" && event.button === "left" && hit) return { handled: true };
				if (event.type === "click" && event.button === "left" && hit) {
					// Capture the clicked component's owner, never the newest session.
					owner.writer.write(hit.copy(), hit.name, hit.errorLabel);
					return { handled: true };
				}
				return created.originalHandleMouse?.call(this, event);
			},
		};
		target.renderTable = created.wrappedRenderTable;
		target.render = created.wrappedRender;
		target.handleMouse = created.wrappedHandleMouse;
		selectionTarget.getActiveSelectionText = created.wrappedSelectionText;
		selectionTarget.getSelectionColumns = created.wrappedSelectionColumns;
		target[PATCH] = created;
		patch = created;
	}
	const held = patch;
	const copy = options.copy ?? copyToClipboard;
	const notify = options.notify ?? (() => {});
	const writer = createClipboardWriter(
		{ copy, notify },
		() => held.owners.has(owner) && isFullscreenTui(owner.tui),
	);
	const owner: TableCopyOwner = {
		...options,
		debug,
		writer,
	};
	patch.owners.add(owner);
	invalidateMountedMarkdown(owner.tui);
	const responseCopy = (text: string) => writer.write(text, "response", "Response");
	return {
		noteSource(context, original, display = original) {
			const frame = held.rendering;
			if (!held.active || !held.owners.has(owner) || !frame) return;
			const component = frame.component;
			const next = context.messageType === "assistant" && !frame.transcript ? owner : undefined;
			const previous = held.componentOwners.get(component);
			const wasEligible = Boolean(eligibleOwner(held, component));
			if (next) {
				held.componentOwners.set(component, next);
				trackComponent(held, component);
			} else held.componentOwners.delete(component);
			const eligible = Boolean(eligibleOwner(held, component));
			const codes =
				eligible && original !== undefined && display !== undefined
					? codeSources(original, display)
					: undefined;
			frame.copy.codes = codes;
			// Pi's per-block cache keys on normalized raw tokens, not whether
			// they still correspond to literal fences in the original message.
			let codeEligibilityChanged = false;
			if (!held.native) {
				const keys = held.codeKeys.get(component);
				codeEligibilityChanged =
					(keys?.size ?? 0) !== (codes?.size ?? 0) ||
					[...(keys ?? [])].some((key) => !codes?.has(key));
				if (codeEligibilityChanged) {
					if (codes?.size) held.codeKeys.set(component, new Set(codes.keys()));
					else held.codeKeys.delete(component);
				}
			}
			if (wasEligible !== eligible || previous !== next || codeEligibilityChanged) {
				delete component[ACTIONS_KEY];
				component.invalidate();
			}
		},
		getResponseCopy: () =>
			held.owners.has(owner) && isFullscreenTui(owner.tui) ? responseCopy : undefined,
		dispose() {
			if (!held.owners.delete(owner)) return;
			if (held.owners.size === 0) held.active = false;
			for (const ref of held.components) {
				const component = ref.deref();
				if (!component) {
					held.components.delete(ref);
					continue;
				}
				if (held.owners.size > 0 && held.componentOwners.get(component) !== owner) continue;
				held.componentOwners.delete(component);
				held.codeKeys.delete(component);
				held.componentRefs.delete(component);
				held.components.delete(ref);
				delete component[ACTIONS_KEY];
				component.invalidate();
			}
			if (held.active) return;
			if (target.render === held.wrappedRender) target.render = held.originalRender;
			if (target.renderTable === held.wrappedRenderTable)
				target.renderTable = held.originalRenderTable;
			if (target.handleMouse === held.wrappedHandleMouse) {
				if (held.originalHandleMouse) target.handleMouse = held.originalHandleMouse;
				else delete target.handleMouse;
			}
			if (held.selectionTarget.getActiveSelectionText === held.wrappedSelectionText)
				held.selectionTarget.getActiveSelectionText = held.originalSelectionText;
			if (held.selectionTarget.getSelectionColumns === held.wrappedSelectionColumns)
				held.selectionTarget.getSelectionColumns = held.originalSelectionColumns;
			if (currentPatch(target) === held) delete target[PATCH];
			held.componentOwners = new WeakMap();
		},
	};
}

interface FlashTui {
	flash(message: string): void;
}

/** Capture Pi's native flash through an empty below-editor widget. */
export function createTableCopyNotifier(
	ctx: ExtensionContext,
	onTuiReady?: (tui: TUI, notify: Notify) => void,
): {
	notify: Notify;
	dispose: () => void;
} {
	let flashTui: FlashTui | undefined;
	let disposed = false;
	const key = "ccstyle-table-copy-flash";
	const notify: Notify = (message, isError) => {
		if (disposed) return;
		try {
			if (!isError && flashTui) {
				flashTui.flash(message);
				return;
			}
			ctx.ui?.notify?.(message, isError ? "error" : "info");
		} catch {
			// Copying must not fail merely because the host has no notification UI.
		}
	};
	try {
		ctx.ui?.setWidget?.(
			key,
			(tui) => {
				const candidate = tui as unknown as FlashTui;
				flashTui = typeof candidate.flash === "function" ? candidate : undefined;
				const sync = () => {
					if (!disposed) onTuiReady?.(tui, notify);
				};
				sync();
				return {
					render: () => {
						sync();
						return [];
					},
					invalidate: sync,
					dispose: () => {
						if (flashTui === candidate) flashTui = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	} catch {
		// Without a captured TUI, provenance/mode checks fail closed.
	}
	return {
		notify,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			flashTui = undefined;
			try {
				ctx.ui?.setWidget?.(key, undefined);
			} catch {
				// The host may already have disposed its UI during shutdown.
			}
		},
	};
}

/** Lifecycle only; the package entry point composes our marker with enhancement. */
export default function tableCopyExtension(
	pi: ExtensionAPI,
	features = { tables: true },
): Pick<TableCopyInstallation, "noteSource" | "getResponseCopy"> {
	let installation: TableCopyInstallation | undefined;
	let installedTui: TUI | undefined;
	let disposeNotifier: (() => void) | undefined;
	let active = false;
	const cleanup = () => {
		active = false;
		installation?.dispose();
		installation = undefined;
		installedTui = undefined;
		disposeNotifier?.();
		disposeNotifier = undefined;
	};
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		cleanup();
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		active = true;
		const notifier = createTableCopyNotifier(ctx, (tui, notify) => {
			if (!active) return;
			const fullscreen = isFullscreenTui(tui);
			if (fullscreen && installation && installedTui === tui) return;
			if (!fullscreen && !installation) return;
			installation?.dispose();
			installation = undefined;
			installedTui = undefined;
			if (fullscreen) {
				installation = installTableCopy({
					tui,
					notify,
					paint: (color, text) => ctx.ui.theme.fg(color, text),
					tables: features.tables,
				});
				installedTui = tui;
			}
			tui.requestRender();
		});
		disposeNotifier = notifier.dispose;
	});
	pi.on("session_shutdown", cleanup);
	return {
		noteSource: (context, original, display) =>
			installation?.noteSource(context, original, display),
		getResponseCopy: () => installation?.getResponseCopy(),
	};
}
