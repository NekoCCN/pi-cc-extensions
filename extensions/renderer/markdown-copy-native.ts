import type {
	DefaultTextStyle,
	Markdown,
	MarkdownOptions,
	MarkdownTheme,
} from "@earendil-works/pi-tui";
import {
	type BlockCopyStyle,
	type BlockMarkers,
	type BlockProvenance,
	type CopyBlock,
	type CopyBlockToken,
	copyableBlock,
	decorateCopyBlock,
} from "./markdown-copy-blocks.ts";

export interface CopyFrame<Table> {
	readonly tables: Table[];
	readonly blocks: CopyBlock[];
}

interface NativeOwner {
	readonly blocks?: BlockCopyStyle;
}

interface NativeFrameOptions<Owner> {
	readonly owner: () => Owner | undefined;
	readonly provenance: () => BlockProvenance | undefined;
	readonly marks: BlockMarkers;
}

/**
 * OmO caches fully rendered arrays across instances and does not expose a parsed
 * token cache. Keep metadata on that same cache key, not on rendered label text.
 */
export class NativeMarkdownCopy<Owner extends NativeOwner, Table> {
	readonly #cached = new WeakMap<string[], CopyFrame<Table>>();
	readonly #styles = new WeakMap<Owner, WeakMap<DefaultTextStyle, DefaultTextStyle>>();
	readonly #emptyStyle: DefaultTextStyle = {};

	render(
		component: Markdown,
		frame: CopyFrame<Table>,
		context: NativeFrameOptions<Owner> & { readonly render: () => string[] },
	): { readonly lines: string[]; readonly frame: CopyFrame<Table> } {
		const { owner, provenance, marks } = context;
		const options: MarkdownOptions = Reflect.get(component, "options");
		const defaultTextStyle: DefaultTextStyle | undefined = Reflect.get(
			component,
			"defaultTextStyle",
		);
		const theme: MarkdownTheme = Reflect.get(component, "theme");
		const renderToken: unknown = Reflect.get(component, "renderToken");
		const ownSources: unknown = Reflect.get(component, "ownSources");
		const transform = options.transform;
		if (!transform || typeof renderToken !== "function" || typeof ownSources !== "function") {
			return { lines: context.render(), frame };
		}
		const tokenDescriptor = Object.getOwnPropertyDescriptor(component, "renderToken");
		const sourcesDescriptor = Object.getOwnPropertyDescriptor(component, "ownSources");
		let locate: ReturnType<BlockProvenance["source"]["locate"]>;
		let depth = 0;
		let resolved = frame;
		const scopedOptions: MarkdownOptions = {
			...options,
			transform: (text, width) => {
				const display = transform(text, width);
				const active = owner();
				if (active) {
					// Partition only the render cache. Keeping theme identity leaves the
					// native syntax-highlighting cache shared and intact.
					const original = defaultTextStyle ?? this.#emptyStyle;
					const styles = this.#styles.get(active) ?? new WeakMap();
					this.#styles.set(active, styles);
					const scoped = styles.get(original) ?? { ...original };
					styles.set(original, scoped);
					Reflect.set(component, "defaultTextStyle", scoped);
					locate = provenance()?.source.locate(display.replaceAll("\t", "   "));
				}
				return display;
			},
		};
		Reflect.set(component, "options", scopedOptions);
		Object.defineProperty(component, "renderToken", {
			configurable: true,
			value(token: CopyBlockToken, width: number, next: string | undefined, style: unknown) {
				const topLevel = depth++ === 0;
				try {
					const raw = topLevel && token.raw ? locate?.(token.raw) : undefined;
					const lines: string[] = renderToken.call(component, token, width, next, style);
					const source = provenance();
					const appearance = owner()?.blocks;
					const block = source && appearance ? copyableBlock(token, raw, source) : undefined;
					if (!block || !appearance) return lines;
					frame.blocks.push(block);
					return decorateCopyBlock(
						lines,
						{ ...token, kind: block.kind },
						{
							width,
							indent: theme.codeBlockIndent ?? "  ",
							...appearance,
							marks,
						},
					);
				} finally {
					depth--;
				}
			},
		});
		Object.defineProperty(component, "ownSources", {
			configurable: true,
			value: (lines: string[]) => {
				if (!owner()) return ownSources.call(component, lines);
				resolved = this.#cached.get(lines) ?? frame;
				this.#cached.set(lines, resolved);
				if (!resolved.tables.length && !resolved.blocks.length)
					return ownSources.call(component, lines);
				// OmO's lazy source replay expects byte-identical *native* lines.
				// It cannot resolve added rows; use its regular cell selection instead.
				// Explicit Copy actions bind to the pre-render source regardless.
				return [...lines];
			},
		});
		try {
			return { lines: context.render(), frame: resolved };
		} finally {
			Reflect.set(component, "options", options);
			Reflect.set(component, "defaultTextStyle", defaultTextStyle);
			if (tokenDescriptor) Object.defineProperty(component, "renderToken", tokenDescriptor);
			else Reflect.deleteProperty(component, "renderToken");
			if (sourcesDescriptor) Object.defineProperty(component, "ownSources", sourcesDescriptor);
			else Reflect.deleteProperty(component, "ownSources");
		}
	}
}
