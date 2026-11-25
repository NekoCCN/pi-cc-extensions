import type { Markdown } from "@earendil-works/pi-tui";

export interface CopyFrame<Table> {
	readonly tables: Table[];
}

interface NativeFrameOptions {
	readonly owner: () => unknown | undefined;
}

/**
 * OmO caches fully rendered arrays across instances and does not expose a parsed
 * token cache. Keep table metadata on that same cache key, not on rendered label text.
 */
export class NativeMarkdownCopy<Table> {
	readonly #cached = new WeakMap<string[], CopyFrame<Table>>();

	render(
		component: Markdown,
		frame: CopyFrame<Table>,
		context: NativeFrameOptions & { readonly render: () => string[] },
	): { readonly lines: string[]; readonly frame: CopyFrame<Table> } {
		const { owner } = context;
		const ownSources: unknown = Reflect.get(component, "ownSources");
		if (typeof ownSources !== "function") {
			return { lines: context.render(), frame };
		}
		const sourcesDescriptor = Object.getOwnPropertyDescriptor(component, "ownSources");
		Object.defineProperty(component, "ownSources", {
			configurable: true,
			value: (lines: string[]) => {
				if (!owner()) return ownSources.call(component, lines);
				const resolved = this.#cached.get(lines) ?? frame;
				this.#cached.set(lines, resolved);
				if (!resolved.tables.length) return ownSources.call(component, lines);
				// OmO's lazy source replay expects byte-identical *native* lines.
				// It cannot resolve added rows; use its regular cell selection instead.
				// Explicit Copy actions bind to the pre-render source regardless.
				return [...lines];
			},
		});
		try {
			return { lines: context.render(), frame };
		} finally {
			if (sourcesDescriptor) Object.defineProperty(component, "ownSources", sourcesDescriptor);
			else Reflect.deleteProperty(component, "ownSources");
		}
	}
}
