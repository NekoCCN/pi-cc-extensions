import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

export const TABLE_FORMATS = ["tsv", "csv", "markdown"] as const;
export type TableFormat = (typeof TABLE_FORMATS)[number];
export type CopyPaint = (color: "dim" | "text", text: string) => string;
export const CODE_LABEL = "[Copy code]";

export function tableFormatName(format: TableFormat): string {
	return format === "markdown" ? "Markdown" : format.toUpperCase();
}

interface ClipboardAction {
	readonly format: TableFormat | "code";
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

interface ActionSources<Table> {
	readonly tables: readonly Table[];
	readonly codes?: ReadonlyMap<string, readonly string[]>;
	readonly serialize: (table: Table, format: TableFormat) => string;
}

interface ActionContext {
	readonly marker: (kind: string) => string;
	readonly debug: (message: string) => void;
}

/** Bind markers on the final rows, after all terminal wrapping and margins. */
export function bindActionRows<Table>(
	lines: string[],
	source: ActionSources<Table>,
	context: ActionContext,
): ActionHit[] {
	const { marker, debug } = context;
	const tableMarker = marker("table");
	const endMarker = marker("end");
	const formats = TABLE_FORMATS.map((format) => ({ format, mark: marker(`action:${format}`) }));
	const bound: ActionHit[] = [];
	const codeHits = new Map<string, ActionHit[]>();
	const codePrefix = marker("code:").slice(0, -2);
	let tableIndex = -1;
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
					bound,
				);
			}
		}
		const codeStart = line.indexOf(codePrefix);
		if (codeStart < 0) continue;
		const codeEnd = line.indexOf("\x1b\\", codeStart + codePrefix.length);
		if (codeEnd < 0) continue;
		const key = line.slice(codeStart + codePrefix.length, codeEnd);
		const bodies = source.codes?.get(key);
		if (!bodies) continue;
		const hits = codeHits.get(key) ?? [];
		const body = bodies[hits.length];
		add(
			marker(`code:${key}`),
			{ format: "code", name: "code", errorLabel: "Code", copy: () => body },
			hits,
		);
		codeHits.set(key, hits);
	}
	if (tableIndex + 1 !== source.tables.length) {
		bound.length = 0;
		debug("Table actions skipped: Markdown.cachedTokens and internal table markers disagree.");
	}
	for (const [key, hits] of codeHits) {
		if (hits.length === source.codes?.get(key)?.length) {
			bound.push(...hits);
			continue;
		}
		// Never advertise a click when a native occurrence cannot be matched
		// to its exact source. Leave the row in place to preserve selection maps.
		for (const hit of hits) {
			const line = lines[hit.y];
			const start = line.indexOf(hit.marker) + hit.marker.length;
			const end = line.indexOf(endMarker, start);
			lines[hit.y] = `${line.slice(0, start)}${" ".repeat(hit.end - hit.start)}${line.slice(end)}`;
		}
		debug("Code actions skipped: native fence rows and literal source occurrences disagree.");
	}
	return bound;
}

/** Layout and hit ranges are independent of hover; recolor only the marker contents. */
export function paintActionRows(
	lines: string[],
	hits: readonly ActionHit[],
	{
		hover,
		paint,
		endMarker,
	}: {
		readonly hover: ActionHover | undefined;
		readonly paint: CopyPaint;
		readonly endMarker: string;
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
		const label = paint(hovered ? "text" : "dim", hit.text);
		lines[hit.y] = `${line.slice(0, start)}${label}${line.slice(end)}`;
	}
}
