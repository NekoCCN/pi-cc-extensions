import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { CopyBlock } from "./markdown-copy-blocks.ts";

export const TABLE_FORMATS = ["tsv", "csv", "markdown"] as const;
export type TableFormat = (typeof TABLE_FORMATS)[number];
export type CopyPaint = (color: "dim" | "text", text: string) => string;

export function tableFormatName(format: TableFormat): string {
	return format === "markdown" ? "Markdown" : format.toUpperCase();
}

interface ClipboardAction {
	readonly format: TableFormat | "block-copy";
	readonly name: string;
	readonly errorLabel: string;
	readonly copy: () => string;
}

export interface ActionHit extends ClipboardAction {
	readonly y: number;
	readonly start: number;
	readonly end: number;
	readonly marker: string;
	readonly text: string;
}

export type ActionHover = Pick<ActionHit, "y" | "format">;

export function codeBodyBounds(line: string, mark: (kind: "body-start" | "body-end") => string) {
	const opening = mark("body-start");
	const start = line.indexOf(opening);
	if (start < 0) return undefined;
	const end = line.indexOf(mark("body-end"), start + opening.length);
	if (end < 0) return undefined;
	return { start: visibleWidth(line.slice(0, start)), end: visibleWidth(line.slice(0, end)) };
}

interface ActionSources<Table> {
	readonly tables: readonly Table[];
	readonly blocks: readonly CopyBlock[];
	readonly serialize: (table: Table, format: TableFormat) => string;
}

interface ActionContext {
	readonly marker: (kind: string) => string;
	readonly debug: (message: string) => void;
}

/** Bind markers on the final rows, after all terminal wrapping and margins. */
export function bindActionRows<Table>(
	lines: readonly string[],
	source: ActionSources<Table>,
	context: ActionContext,
): ActionHit[] {
	const { marker, debug } = context;
	const tableMarker = marker("table");
	const blockMarker = marker("block-copy");
	const endMarker = marker("end");
	const formats = TABLE_FORMATS.map((format) => ({ format, mark: marker(`action:${format}`) }));
	const tableHits: ActionHit[] = [];
	const blockHits: ActionHit[] = [];
	let tableIndex = -1;
	let blockIndex = 0;
	for (const [y, line] of lines.entries()) {
		if (line.includes(tableMarker)) tableIndex++;
		const table = source.tables[tableIndex];
		const add = (mark: string, action: ClipboardAction, hits: ActionHit[]) => {
			const index = line.indexOf(mark);
			if (index < 0) return;
			const startIndex = index + mark.length;
			const endIndex = line.indexOf(endMarker, startIndex);
			if (endIndex < 0) return;
			const text = stripTerminalSequences(line.slice(startIndex, endIndex));
			const start = visibleWidth(line.slice(0, startIndex));
			hits.push({ y, start, end: start + visibleWidth(text), marker: mark, text, ...action });
		};
		if (table) {
			for (const { format, mark } of formats) {
				if (!line.includes(mark)) continue;
				add(
					mark,
					{
						format,
						name: `table as ${tableFormatName(format)}`,
						errorLabel: "Table",
						copy: () => source.serialize(table, format),
					},
					tableHits,
				);
			}
		}
		if (!line.includes(blockMarker)) continue;
		const block = source.blocks[blockIndex++];
		if (block) {
			add(
				blockMarker,
				{
					format: "block-copy",
					name: block.kind,
					errorLabel: block.kind === "code" ? "Code" : "Paragraph",
					copy: () => block.payload,
				},
				blockHits,
			);
		}
	}
	if (tableIndex + 1 !== source.tables.length) {
		tableHits.length = 0;
		debug("Table actions skipped: Markdown.cachedTokens and internal table markers disagree.");
	}
	if (blockIndex !== source.blocks.length) {
		blockHits.length = 0;
		debug("Block actions skipped: parsed blocks and internal block markers disagree.");
	}
	return [...tableHits, ...blockHits];
}

/** Layout and hit ranges are independent of hover; recolor only the marker contents. */
export function paintActionRows(
	lines: string[],
	hits: readonly ActionHit[],
	{
		hover,
		paint,
		endMarker,
		blockMuted,
	}: {
		readonly hover: ActionHover | undefined;
		readonly paint: CopyPaint;
		readonly endMarker: string;
		readonly blockMuted?: (text: string) => string;
	},
): void {
	for (const hit of hits) {
		const line = lines[hit.y];
		if (line === undefined) continue;
		const markerIndex = line.indexOf(hit.marker);
		if (markerIndex < 0) continue;
		const start = markerIndex + hit.marker.length;
		const end = line.indexOf(endMarker, start);
		if (end < 0) continue;
		const hovered = hover?.y === hit.y && hover.format === hit.format;
		const label =
			!hovered && hit.format === "block-copy" && blockMuted
				? blockMuted(hit.text)
				: paint(hovered ? "text" : "dim", hit.text);
		lines[hit.y] = `${line.slice(0, start)}${label}${line.slice(end)}`;
	}
}
