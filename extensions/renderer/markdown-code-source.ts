import { createHash } from "node:crypto";

const OPEN = /^ {0,3}(`{3,}(?!`)|~{3,}(?!~))(.*)$/;
const DIAGRAM = /^(?:mermaid|(?:state|class)diagram(?:-v2)?|erdiagram|sequencediagram)$/i;
const QUOTE = /^ {0,3}>[ \t]?/;
const LIST = /^ {0,3}(?:[-*+]|\d{1,9}[.)]) {1,4}(?= {0,3}(?:`{3,}|~{3,}))/;
const EOL = /(?:\r\n?|\n)$/;

function opening(line: string) {
	const match = OPEN.exec(line);
	if (!match || (match[1][0] === "`" && match[2].includes("`"))) return undefined;
	const fence = match[1];
	return {
		close: new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*$`),
		diagram: DIAGRAM.test(match[2].trim().split(/\s+/, 1)[0]),
	};
}

function fenceKey(raw: string, quoteDepth: number): string {
	return createHash("sha256")
		.update(`${quoteDepth}\0`)
		.update(raw.replace(/\r\n?/g, "\n").replaceAll("\t", "   "))
		.digest("base64url");
}

export function codeTokenKey(raw: string, quoteDepth: number): string | undefined {
	const lines = raw.trimEnd().split(/\r\n?|\n/);
	const fence = opening(lines[0]);
	if (!fence || fence.diagram || lines.length < 2 || !fence.close.test(lines.at(-1) ?? "")) {
		return undefined;
	}
	return fenceKey(lines.join("\n"), quoteDepth);
}

function fences(source: string): Map<string, string[]> {
	const result = new Map<string, string[]>();
	if (!source.includes("```") && !source.includes("~~~")) return result;
	const rows = source.match(/[^\r\n]*(?:\r\n?|\n|$)/g) ?? [];
	let commentDepth: number | undefined;
	scan: for (let start = 0; start < rows.length; start++) {
		let line = rows[start].replace(EOL, "");
		let depth = 0;
		for (let prefix = QUOTE.exec(line); prefix; prefix = QUOTE.exec(line)) {
			line = line.slice(prefix[0].length);
			depth++;
		}
		if (commentDepth !== undefined && depth < commentDepth) commentDepth = undefined;
		if (/^ {0,3}<!--/.test(line)) commentDepth = depth;
		if (commentDepth !== undefined) {
			if (line.includes("-->")) commentDepth = undefined;
			continue;
		}
		const listIndent = LIST.exec(line)?.[0].length ?? 0;
		const fence = opening(line.slice(listIndent));
		if (!fence) continue;
		const content: string[] = [];
		for (let end = start + 1; end < rows.length; end++) {
			let row = rows[end];
			for (let quote = 0; quote < depth; quote++) {
				const prefix = QUOTE.exec(row);
				if (!prefix) {
					// An unprefixed line ends a fenced quote block, not the outer scan.
					start = end - 1;
					continue scan;
				}
				row = row.slice(prefix[0].length);
			}
			if (listIndent) {
				// Skip explicitly introduced list fences without treating their
				// closing delimiter as an opening standalone fence.
				const indent = /^ */.exec(row)?.[0].length ?? 0;
				if (indent < listIndent && row.trim()) {
					start = end - 1;
					continue scan;
				}
				row = row.slice(Math.min(indent, listIndent));
			}
			if (fence.close.test(row.replace(EOL, ""))) {
				if (!fence.diagram && !listIndent) {
					const body = content.join("");
					const key = fenceKey(`${line}\n${body}${row.trimEnd()}`, depth);
					const matches = result.get(key) ?? [];
					matches.push(body.replace(EOL, ""));
					result.set(key, matches);
				}
				start = end;
				continue scan;
			}
			content.push(row);
		}
		break;
	}
	return result;
}

/** Accept only closed literal fences that survive enhancement, not generated diagram fallback. */
export function codeSources(
	original: string,
	display: string,
): ReadonlyMap<string, readonly string[]> {
	const originals = fences(original);
	if (original !== display && originals.size) {
		const rendered = fences(display);
		for (const [key, bodies] of originals) {
			if (rendered.get(key)?.length !== bodies.length) originals.delete(key);
		}
	}
	return originals;
}
