import {
	visibleWidth,
	type DefaultTextStyle,
	type Markdown,
	type MarkdownOptions,
} from "@earendil-works/pi-tui";
import { codeTokenKey } from "./markdown-code-source.ts";
import { CODE_LABEL } from "./markdown-copy-actions.ts";

export interface CopyFrame<Table> {
	readonly tables: Table[];
	codes?: ReadonlyMap<string, readonly string[]>;
}

interface NativeFrameOptions {
	readonly owner: () => object | undefined;
	readonly marker: (kind: string) => string;
}

/**
 * OmO caches fully rendered arrays across instances and does not expose a parsed
 * token cache. Keep clipboard metadata on that same cache key, not on rendered label text.
 */
export class NativeMarkdownCopy<Table> {
	readonly #cached = new WeakMap<string[], CopyFrame<Table>>();
	readonly #styles = new WeakMap<object, WeakMap<DefaultTextStyle, DefaultTextStyle>>();
	readonly #emptyStyle: DefaultTextStyle = {};

	render(
		component: Markdown,
		frame: CopyFrame<Table>,
		context: NativeFrameOptions & { readonly render: () => string[] },
	): { readonly lines: string[]; readonly frame: CopyFrame<Table> } {
		const { owner, marker } = context;
		const ownSources: unknown = Reflect.get(component, "ownSources");
		const renderToken: unknown = Reflect.get(component, "renderToken");
		const options: MarkdownOptions = Reflect.get(component, "options");
		if (!options?.transform || typeof renderToken !== "function") {
			return { lines: context.render(), frame };
		}
		const transform = options.transform;
		const sourcesDescriptor = Object.getOwnPropertyDescriptor(component, "ownSources");
		const tokenDescriptor = Object.getOwnPropertyDescriptor(component, "renderToken");
		const defaultStyle: DefaultTextStyle | undefined = Reflect.get(component, "defaultTextStyle");
		const collectSources: unknown = Reflect.get(component, "collectSources");
		let resolved = frame;
		let quoteDepth = 0;
		let listDepth = 0;
		if (typeof ownSources === "function") {
			Reflect.set(component, "options", {
				...options,
				transform: (text, width) => {
					const display = transform(text, width);
					const active = owner();
					if (active) {
						// Separate decorated renders from passive Markdown and other owners,
						// without changing theme identity or the native highlights cache.
						const styles = this.#styles.get(active) ?? new WeakMap();
						this.#styles.set(active, styles);
						const original = defaultStyle ?? this.#emptyStyle;
						const scoped = styles.get(original) ?? { ...original };
						styles.set(original, scoped);
						Reflect.set(component, "defaultTextStyle", scoped);
						// Lazy replay requires identical rows; collect provenance while
						// rendering the original code plus its unmapped action row instead.
						if (frame.codes?.size) Reflect.set(component, "collectSources", true);
					}
					return display;
				},
			} satisfies MarkdownOptions);
			Object.defineProperty(component, "ownSources", {
				configurable: true,
				value: (lines: string[]) => {
					if (!owner()) return ownSources.call(component, lines);
					resolved = this.#cached.get(lines) ?? frame;
					this.#cached.set(lines, resolved);
					// Keep the existing table selection fallback.
					return resolved.tables.length ? [...lines] : ownSources.call(component, lines);
				},
			});
		}
		Object.defineProperty(component, "renderToken", {
			configurable: true,
			value(
				token: { readonly type: string; readonly raw?: string },
				width: number,
				next: string | undefined,
				style: unknown,
			) {
				if (token.type === "blockquote") quoteDepth++;
				if (token.type === "list") listDepth++;
				let lines: string[];
				try {
					lines = renderToken.call(component, token, width, next, style);
				} finally {
					if (token.type === "blockquote") quoteDepth--;
					if (token.type === "list") listDepth--;
				}
				if (
					token.type === "code" &&
					token.raw &&
					// List continuation indentation cannot be recovered from a
					// standalone native raw token; never bind it to another fence.
					listDepth === 0 &&
					frame.codes?.size &&
					visibleWidth(CODE_LABEL) <= width
				) {
					const key = codeTokenKey(token.raw, quoteDepth);
					if (key && frame.codes.has(key)) {
						const row = `${marker(`code:${key}`)}${CODE_LABEL}${marker("end")}`;
						// The optional trailing blank is not source-mapped. Keep all
						// existing ranges on their original native row indices.
						lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, row);
					}
				}
				return lines;
			},
		});
		try {
			const lines = context.render();
			return { lines, frame: resolved };
		} finally {
			if (typeof ownSources === "function") {
				Reflect.set(component, "options", options);
				Reflect.set(component, "defaultTextStyle", defaultStyle);
				Reflect.set(component, "collectSources", collectSources);
			}
			if (tokenDescriptor) Object.defineProperty(component, "renderToken", tokenDescriptor);
			else Reflect.deleteProperty(component, "renderToken");
			if (sourcesDescriptor) Object.defineProperty(component, "ownSources", sourcesDescriptor);
			else Reflect.deleteProperty(component, "ownSources");
		}
	}
}
