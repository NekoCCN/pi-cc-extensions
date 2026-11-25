import type { TableFormat } from "./markdown-copy-actions.ts";

interface TokenBase {
	readonly type?: string;
	readonly raw?: string;
}

interface InlineToken {
	readonly type?: string;
	readonly text?: string;
	readonly raw?: string;
	readonly tokens?: readonly InlineToken[];
}

interface TableCell {
	readonly text: string;
	readonly tokens?: readonly InlineToken[];
}

export interface MarkdownToken extends TokenBase {
	readonly tokens?: readonly MarkdownToken[];
	readonly items?: ReadonlyArray<{ readonly tokens?: readonly MarkdownToken[] }>;
}

export interface TableToken extends MarkdownToken {
	readonly type: "table";
	readonly raw: string;
	readonly header: readonly TableCell[];
	readonly rows: readonly (readonly TableCell[])[];
}

/** Inline Markdown copies as readable cell text, without ANSI or formatting markers. */
function inlineText(tokens: readonly InlineToken[] | undefined, fallback: string): string {
	if (!tokens?.length) return fallback;
	return tokens
		.map((token) => {
			if (token.type === "br") return " ";
			if (token.tokens?.length) return inlineText(token.tokens, "");
			return token.text ?? token.raw ?? "";
		})
		.join("");
}

function cellText(cell: TableCell): string {
	return inlineText(cell.tokens, cell.text).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function csvCell(text: string): string {
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Serialize the parsed table, never the terminal border or its wrapping. */
export function serializeTable(token: TableToken, format: TableFormat): string {
	if (format === "markdown") return token.raw.replace(/(?:\r?\n)+$/, "");
	const rows = [token.header, ...token.rows].map((row) => row.map(cellText));
	if (format === "tsv") {
		return rows.map((row) => row.map((cell) => cell.replace(/[\t\n]/g, " ")).join("\t")).join("\n");
	}
	return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function isTable(token: MarkdownToken): token is TableToken {
	return token.type === "table" && "header" in token && Array.isArray(token.header);
}

export function collectTables(
	tokens: readonly MarkdownToken[],
	output: TableToken[] = [],
): TableToken[] {
	for (const token of tokens) {
		if (isTable(token) && token.header.length > 0) output.push(token);
		if (token.tokens?.length) collectTables(token.tokens, output);
		for (const item of token.items ?? []) {
			if (item.tokens?.length) collectTables(item.tokens, output);
		}
	}
	return output;
}
