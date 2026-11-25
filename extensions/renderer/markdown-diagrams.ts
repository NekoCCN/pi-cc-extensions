import { diagramKind, render as renderMermaid, sourceBox } from "grok-mermaid";

// Standard Mermaid stays with the host renderer. Only convert grok-mermaid's dialect fences.
const DIAGRAM_FENCE =
	/^(`{3,})\s*(statediagram|statediagram-v2|classdiagram|classdiagram-v2|erdiagram|sequencediagram)\s*$/i;
const FENCE_OPEN = /^(`{3,})/;
const FENCE_CLOSE = /^`{3,}\s*$/;
const ART_CACHE = new Map<string, ReturnType<typeof renderMermaid>>();
const ART_CACHE_MAX = 50;

function codeSpan(line: string): string {
	const content = line || "\u00a0";
	const longestRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (m) => m[0].length));
	const fence = "`".repeat(longestRun + 1);
	const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
	return `${fence}${padding}${content}${padding}${fence}`;
}

function framedSource(src: string, width: number): string {
	const box = sourceBox(src, Math.max(8, width - 2));
	return `\`\`\`\n${box.plain.join("\n")}\n\`\`\``;
}

function collectFence(lines: string[], i: number): { diagram: string; next: number } | null {
	const open = lines[i].match(FENCE_OPEN)?.[0] ?? "```";
	const src: string[] = [];
	for (let j = i + 1; j < lines.length; j++) {
		if (lines[j].match(FENCE_CLOSE) && lines[j].startsWith(open)) {
			return { diagram: src.join("\n"), next: j + 1 };
		}
		src.push(lines[j]);
	}
	return null;
}

function getArt(src: string): ReturnType<typeof renderMermaid> | null {
	const cached = ART_CACHE.get(src);
	if (cached) return cached;
	let art: ReturnType<typeof renderMermaid>;
	try {
		art = renderMermaid(src);
	} catch (error) {
		if (error instanceof Error) return null;
		throw error;
	}
	if (ART_CACHE.size >= ART_CACHE_MAX) ART_CACHE.clear();
	ART_CACHE.set(src, art);
	return art;
}

/** Standard Mermaid stays with the host renderer; only grok-mermaid dialects become art. */
export function renderDiagrams(
	markdown: string,
	context?: { readonly isStreaming?: boolean; readonly availableWidth?: number },
): string {
	const { isStreaming = false, availableWidth = 80 } = context ?? {};
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
				const src = diagramKind(diagram) ? diagram : `${fence[2]}\n${diagram}`;
				const art = getArt(src);
				// Hard breaks keep the diagram's rows separate without wrapping its box glyphs together.
				out.push(
					art && art.width <= availableWidth
						? art.plain.map(codeSpan).join("  \n")
						: framedSource(src, availableWidth),
				);
				i = next;
				continue;
			}
		}
		out.push(line);
		i++;
	}
	return out.join("\n");
}
