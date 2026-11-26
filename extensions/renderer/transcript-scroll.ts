import { matchesKey } from "@earendil-works/pi-tui";

const PAGE_SCROLL_OVERLAP = 4;

type ScrollAction =
	| { readonly kind: "lines"; readonly lines: number }
	| { readonly kind: "half" | "page" | "prompt"; readonly direction: 1 | -1 }
	| { readonly kind: "top" | "bottom" };

type KeyId = Parameters<typeof matchesKey>[1];
const SCROLL_KEYS: ReadonlyArray<readonly [readonly KeyId[], ScrollAction]> = [
	[["j", "down", "ctrl+n"], { kind: "lines", lines: 1 }],
	[["k", "up", "ctrl+p"], { kind: "lines", lines: -1 }],
	[["ctrl+d"], { kind: "half", direction: 1 }],
	[["ctrl+u"], { kind: "half", direction: -1 }],
	[["space", "ctrl+f", "pageDown"], { kind: "page", direction: 1 }],
	[["b", "ctrl+b", "shift+space", "pageUp"], { kind: "page", direction: -1 }],
	[["g", "home"], { kind: "top" }],
	[["shift+g", "end"], { kind: "bottom" }],
	[["}"], { kind: "prompt", direction: 1 }],
	[["{"], { kind: "prompt", direction: -1 }],
];

export function transcriptScrollAction(data: string): ScrollAction | undefined {
	return SCROLL_KEYS.find(([keys]) => keys.some((key) => matchesKey(data, key)))?.[1];
}

export class TranscriptViewport {
	top = 0;
	height = 1;
	total = 0;
	followEnd: boolean;
	#paintedTop: number | undefined;

	constructor(followEnd: boolean) {
		this.followEnd = followEnd;
	}

	get max(): number {
		return Math.max(0, this.total - this.height);
	}

	move(row: number): void {
		this.top = Math.max(0, Math.min(this.max, row));
		this.followEnd = this.top === this.max;
	}

	apply(action: ScrollAction, prompts: readonly number[] = []): void {
		switch (action.kind) {
			case "lines":
				this.move(this.top + action.lines);
				break;
			case "half":
				this.move(this.top + action.direction * Math.max(1, Math.floor(this.height / 2)));
				break;
			case "page":
				this.move(this.top + action.direction * Math.max(1, this.height - PAGE_SCROLL_OVERLAP));
				break;
			case "top":
				this.move(0);
				break;
			case "bottom":
				this.move(this.max);
				break;
			case "prompt": {
				const row =
					action.direction > 0
						? prompts.find((position) => position > this.top)
						: prompts.findLast((position) => position < this.top);
				if (row !== undefined) this.move(row);
				break;
			}
			default: {
				const exhaustive: never = action;
				return exhaustive;
			}
		}
	}

	paint(
		lines: readonly string[],
		height: number,
		scrolled: ((delta: number, bodyHeight: number) => void) | undefined,
	): string[] {
		this.height = height;
		this.total = lines.length;
		this.top = this.followEnd ? this.max : Math.min(this.top, this.max);
		const delta = this.top - (this.#paintedTop ?? this.top);
		if (delta !== 0) scrolled?.(delta, height);
		this.#paintedTop = this.top;
		const visible = lines.slice(this.top, this.top + height);
		while (visible.length < height) visible.push("");
		return visible;
	}
}
