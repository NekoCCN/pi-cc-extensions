import {
	Markdown,
	type MarkdownOptions,
	stripTerminalSequences,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ClipboardWriter } from "./clipboard-actions.ts";
import {
	type ClipboardAction,
	codeCopyAction,
	TABLE_FORMATS,
	tableCopyAction,
	tableFormatName,
} from "./markdown-copy-actions.ts";
import { NativeMarkdownCopy, type CopyFrame } from "./markdown-copy-native.ts";
import { codeSources, codeTokenKey } from "./markdown-code-source.ts";
import {
	collectTables,
	type MarkdownToken,
	serializeTable,
	type TableToken,
} from "./markdown-table-source.ts";
import type { TranscriptAction } from "./transcript-items.ts";

type SourceAction = ClipboardAction & { readonly id: string; readonly label: string };

const native = new NativeMarkdownCopy<TableToken>();
const transcriptCacheOwner = {};
const frames = new WeakMap<
	Markdown,
	{ readonly lines: string[]; readonly actions: readonly SourceAction[] }
>();

function collectCodeKeys(tokens: readonly MarkdownToken[], depth = 0): string[] {
	return tokens.flatMap((token) => {
		if (token.type === "blockquote") return collectCodeKeys(token.tokens ?? [], depth + 1);
		if (token.type !== "code" || !token.raw) return [];
		const key = codeTokenKey(token.raw, depth);
		return key === undefined ? [] : [key];
	});
}

function sourcePreview(text: string): string {
	const line = (stripTerminalSequences(text).split(/\r\n?|\n/, 1)[0] ?? "")
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.trim();
	return line ? `: ${truncateToWidth(line, 18)}` : "";
}

/** Read the host's actual parsed tokens, never painted labels or screen coordinates. */
function transcriptMarkdownActions(component: Markdown, width: number): readonly SourceAction[] {
	const options: MarkdownOptions | undefined = Reflect.get(component, "options");
	const transform = options?.transform;
	if (!transform) return [];
	let literal: ReadonlyMap<string, readonly string[]> | undefined;
	Reflect.set(component, "options", {
		...options,
		transform: (original, availableWidth) => {
			const display = transform(original, availableWidth);
			literal = codeSources(original, display);
			return display;
		},
	} satisfies MarkdownOptions);
	let rendered: { readonly lines: string[]; readonly frame: CopyFrame<TableToken> };
	const frame: CopyFrame<TableToken> = { tables: [], tokens: [] };
	try {
		rendered = native.render(component, frame, {
			owner: () => transcriptCacheOwner,
			// Semantic capture never supplies frame.codes, so no markers are emitted.
			marker: () => "",
			render: () => component.render(width),
		});
	} finally {
		Reflect.set(component, "options", options);
	}
	const previous = frames.get(component);
	if (previous?.lines === rendered.lines) return previous.actions;

	const hasNativeRenderCache = typeof Reflect.get(component, "ownSources") === "function";
	const cache: WeakRef<{ readonly tokens: readonly MarkdownToken[] }> | undefined = Reflect.get(
		component,
		"cachedTokens",
	);
	const tokens = hasNativeRenderCache ? rendered.frame.tokens : cache?.deref()?.tokens;
	const keys = collectCodeKeys(tokens ?? []);
	const counts = new Map<string, number>();
	for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
	const occurrences = new Map<string, number>();
	const actions: SourceAction[] = [];
	for (const key of keys) {
		const bodies = literal?.get(key);
		if (!bodies || bodies.length !== counts.get(key)) continue;
		const occurrence = occurrences.get(key) ?? 0;
		const body = bodies[occurrence];
		if (body === undefined) continue;
		occurrences.set(key, occurrence + 1);
		actions.push({
			...codeCopyAction(body),
			id: `code:${key}:${occurrence}`,
			label: `Copy code ${actions.length + 1}${sourcePreview(body)}`,
		});
	}
	for (const [index, table] of collectTables(tokens ?? []).entries()) {
		for (const format of TABLE_FORMATS) {
			const action = tableCopyAction(table, format, serializeTable);
			actions.push({
				...action,
				id: `table:${index}:${format}`,
				label: `Copy ${tableFormatName(format)} table ${index + 1}${sourcePreview(table.header[0]?.text ?? "")}`,
			});
		}
	}
	frames.set(component, { lines: rendered.lines, actions });
	return actions;
}

export function assistantMarkdownActions(
	view: object,
	width: number,
	copy: { readonly writer: ClipboardWriter; readonly tablesEnabled: boolean },
): TranscriptAction[] {
	const children: readonly unknown[] = Reflect.get(view, "contentContainer")?.children ?? [];
	let slot = 0;
	const actions: TranscriptAction[] = [];
	for (const child of children) {
		// Thinking is wrapped in a MouseRegion by Pi; exclude styled Markdown too.
		if (!(child instanceof Markdown) || Reflect.get(child, "defaultTextStyle")) continue;
		for (const action of transcriptMarkdownActions(child, width)) {
			if (action.format !== "code" && !copy.tablesEnabled) continue;
			actions.push({
				id: `${slot}:${action.id}`,
				label: action.label,
				activate() {
					copy.writer.write(action.copy(), action.name, action.errorLabel);
					return undefined;
				},
			});
		}
		slot++;
	}
	return actions;
}
