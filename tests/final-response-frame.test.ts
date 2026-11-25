import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	FINAL_RESPONSE_FRAME_MIN_WIDTH,
	installFinalResponseFrame,
	type FinalResponseFrameSources,
} from "../extensions/renderer/final-response-frame.ts";
import { isFinalResponseContent } from "../extensions/renderer/final-response-frame-finality.ts";

initTheme("dark");

const identity = (text: string) => text;
const markdownTheme = Object.fromEntries(
	[
		"heading",
		"link",
		"linkUrl",
		"code",
		"codeBlock",
		"codeBlockBorder",
		"quote",
		"quoteBorder",
		"hr",
		"listBullet",
		"bold",
		"italic",
		"strikethrough",
		"underline",
	].map((key) => [key, identity]),
) as any;

const recordingTheme = (seen: string[]) => ({
	fg: (name: string, text: string) => {
		seen.push(name);
		return `«${name}»${text}`;
	},
});

const sourceCalls: Array<{ row: number; col: number }> = [];
const nullRows: number[] = [];
const sources: FinalResponseFrameSources = {
	copyLineSources: (from, to, row = 0, col = 0) => {
		sourceCalls.push({ row, col });
		return to;
	},
	setLineSource: (_lines, row, _source) => {
		nullRows.push(row);
	},
};

let styleOn = true;
const originalRender = AssistantMessageComponent.prototype.render;

function install(seen: string[]) {
	return installFinalResponseFrame({
		isStyleActive: () => styleOn,
		getTheme: () => recordingTheme(seen),
		sources,
	});
}

function message(content: AssistantMessage["content"], stopReason: string): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		timestamp: 1,
		stopReason: stopReason as AssistantMessage["stopReason"],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

const FINAL_TEXT = "修复完成\n\n```ts\nconst x = 1;\n```\n\n详见上文。";

function create(content: AssistantMessage["content"], stopReason: string, streaming = false) {
	const msg = message(content, stopReason);
	const component = new AssistantMessageComponent(msg, false, markdownTheme, "", 0, []);
	if (streaming) component.updateContent(msg, true);
	return { component, msg };
}

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const hasFrame = (lines: string[]) => {
	const text = plain(lines);
	return text.includes("╭") && text.includes("╮") && text.includes("╰") && text.includes("╯");
};

test("final successful text response uses the accent border without fill", () => {
	const seen: string[] = [];
	const handle = install(seen);
	try {
		const { component } = create([{ type: "text", text: FINAL_TEXT }], "stop");
		const lines = component.render(40);
		assert.ok(hasFrame(lines), "expected rounded border around final text");
		assert.ok(plain(lines).includes("修复完成"), "response text stays inside the frame");
		assert.ok(plain(lines).includes("const x = 1;"), "code stays plain markdown, no extra copy");
		assert.ok(lines[0].startsWith("«borderAccent»╭"));
		assert.ok(lines[1].startsWith("«borderAccent»│ "));
		assert.ok(lines[1].endsWith("«borderAccent» │"));
		assert.ok(lines.at(-1)?.startsWith("«borderAccent»╰"));
		assert.deepEqual(seen, Array<string>(4).fill("borderAccent"));
	} finally {
		handle.dispose();
	}
});

const RESPONSE_LABEL = "[Copy response]";

function frameMouse(component: AssistantMessageComponent, width: number, height: number) {
	return (
		x: number,
		y: number,
		type: TuiMouseEvent["type"] = "click",
		button: TuiMouseEvent["button"] = "left",
	) =>
		component.handleMouse({
			type,
			button,
			x,
			y,
			screenX: x,
			screenY: y,
			width,
			height,
			shift: false,
			alt: false,
			ctrl: false,
		});
}

test("the top edge copies all original markdown blocks once on a visible left click", () => {
	const copied: string[] = [];
	const copy = (text: string) => {
		copied.push(text);
	};
	const options = { sources, getResponseCopy: () => copy };
	const handle = installFinalResponseFrame(options);
	try {
		const first = "  **原文** \n\n```ts\n  const x = 1;\n```\n";
		const last = "[link](https://example.org)  ";
		const { component } = create(
			[
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: first },
				{ type: "text", text: `\x1b[31m${last}\x1b[0m` },
			],
			"stop",
		);
		const width = 40;
		const lines = component.render(width).map(stripTerminalSequences);
		const row = lines.findIndex((line) => line.startsWith("╭"));
		assert.ok(row > 0, "the top edge follows the thinking prefix");
		const edge = lines[row];
		assert.match(edge, /^╭─+\[Copy response\]─╮$/);
		assert.equal(visibleWidth(edge), width);
		const start = edge.indexOf(RESPONSE_LABEL);
		const end = start + RESPONSE_LABEL.length;
		const mouse = frameMouse(component, width, lines.length);

		assert.equal(mouse(start - 1, row, "press"), undefined);
		assert.equal(mouse(end, row), undefined);
		assert.equal(mouse(start, row, "press", "right"), undefined);
		assert.equal(mouse(start, row, "click", "middle"), undefined);
		assert.equal(mouse(start, row, "drag"), undefined);
		assert.equal(mouse(start, row, "wheel"), undefined);
		assert.equal(mouse(start, row, "press")?.handled, true);
		assert.equal(mouse(start, row, "release"), undefined);
		assert.deepEqual(copied, []);
		assert.equal(mouse(end - 1, row)?.handled, true);
		assert.deepEqual(copied, [`${first}\n\n${last}`]);
	} finally {
		handle.dispose();
	}
});

test("a narrow frame or unavailable copy owner leaves no invisible action", () => {
	const copied: string[] = [];
	const copy = (text: string) => {
		copied.push(text);
	};
	let available = true;
	const options = { sources, getResponseCopy: () => (available ? copy : undefined) };
	const handle = installFinalResponseFrame(options);
	try {
		const { component } = create([{ type: "text", text: FINAL_TEXT }], "stop");
		const wide = 40;
		const withCopy = component.render(wide);
		const x = stripTerminalSequences(withCopy[0]).indexOf(RESPONSE_LABEL);
		assert.ok(x > 0, "the preceding render must establish a visible hit");

		const narrow = 16;
		const withoutRoom = component.render(narrow);
		assert.ok(hasFrame(withoutRoom));
		assert.ok(!plain(withoutRoom).includes(RESPONSE_LABEL));
		assert.equal(frameMouse(component, narrow, withoutRoom.length)(1, 0), undefined);
		assert.equal(frameMouse(component, wide, withCopy.length)(x, 0), undefined);

		component.render(wide);
		available = false;
		assert.equal(frameMouse(component, wide, withCopy.length)(x, 0, "press"), undefined);
		assert.equal(frameMouse(component, wide, withCopy.length)(x, 0), undefined);
		const withoutOwner = component.render(wide);
		assert.ok(hasFrame(withoutOwner));
		assert.ok(!plain(withoutOwner).includes(RESPONSE_LABEL));
		assert.equal(frameMouse(component, wide, withoutOwner.length)(x, 0), undefined);
		assert.deepEqual(copied, []);
	} finally {
		handle.dispose();
	}
});

test("streaming intermediate text is never framed", () => {
	const seen: string[] = [];
	const handle = install(seen);
	try {
		const { component } = create([{ type: "text", text: FINAL_TEXT }], "stop", true);
		assert.ok(!hasFrame(component.render(40)), "streaming text must stay unframed");
	} finally {
		handle.dispose();
	}
});

test("tool-use, aborted, error and thinking-only messages stay unframed", () => {
	const seen: string[] = [];
	const handle = install(seen);
	try {
		const toolUse = create(
			[
				{ type: "text", text: "reading" },
				{ type: "toolCall", id: "t1", name: "read", arguments: {} } as any,
			],
			"toolUse",
		);
		assert.ok(!hasFrame(toolUse.component.render(40)), "tool-use message must stay unframed");
		const aborted = create([{ type: "text", text: FINAL_TEXT }], "aborted");
		assert.ok(!hasFrame(aborted.component.render(40)), "cancelled message must stay unframed");
		const errored = message([{ type: "text", text: "boom" }], "error") as any;
		errored.errorMessage = "boom";
		const errorComponent = new AssistantMessageComponent(errored, false, markdownTheme, "", 0, []);
		assert.ok(!hasFrame(errorComponent.render(40)), "error message must stay unframed");
		const thinkingOnly = create([{ type: "thinking", thinking: "hmm" } as any], "stop");
		assert.ok(
			!hasFrame(thinkingOnly.component.render(40)),
			"reasoning-only message must stay unframed",
		);
		const blank = create([{ type: "text", text: "   \n " }], "stop");
		assert.ok(!hasFrame(blank.component.render(40)), "empty message must stay unframed");
	} finally {
		handle.dispose();
	}
});

test("predicate rejects every non-final shape", () => {
	assert.equal(isFinalResponseContent(undefined), false);
	assert.equal(isFinalResponseContent(null), false);
	assert.equal(isFinalResponseContent({}), false);
	assert.equal(isFinalResponseContent(message([{ type: "text", text: "x" }], "toolUse")), false);
	assert.equal(isFinalResponseContent(message([], "stop")), false);
	assert.equal(
		isFinalResponseContent(
			message([{ type: "toolCall", id: "t", name: "bash", arguments: {} } as any], "stop"),
		),
		false,
	);
	assert.equal(isFinalResponseContent(message([{ type: "text", text: "ok" }], "stop")), true);
});

test("message_end stages without touching the component; agent_end marks it framed", () => {
	const seen: string[] = [];
	const handle = install(seen);
	try {
		const live = create([{ type: "text", text: FINAL_TEXT }], "stop", true);
		const root = { children: [live.component] };
		const inner = (live.component as any).contentContainer;
		const before = [...inner.children];
		assert.ok(!hasFrame(live.component.render(40)));
		assert.equal(handle.stageFinalCandidate(live.msg), true);
		assert.ok(
			!hasFrame(live.component.render(40)),
			"message_end alone must not frame: native still marks streaming",
		);
		const marked = handle.confirmFinalResponses(root, [live.msg]);
		assert.equal(marked, 1);
		// 纯视觉标记：不调 updateContent，不重建子树，流式旗语保持原生值。
		assert.equal((live.component as any).isStreaming, true);
		const after = [...inner.children];
		assert.equal(after.length, before.length);
		assert.ok(after.every((child, index) => child === before[index]));
		assert.ok(hasFrame(live.component.render(40)), "agent_end confirms the final frame");
	} finally {
		handle.dispose();
	}
});

test("confirm trusts the settled agent truth over stale staged candidates", () => {
	const seen: string[] = [];
	const handle = install(seen);
	try {
		const stale = create([{ type: "text", text: "old draft" }], "stop", true);
		const extended = create([{ type: "text", text: FINAL_TEXT }], "stop", true);
		const root = { children: [stale.component, extended.component] };
		assert.equal(handle.stageFinalCandidate(stale.msg), true);
		assert.equal(handle.stageFinalCandidate(extended.msg), true);
		// 结算表只有扩展后的终态：只翻它，草稿不动。
		const flipped = handle.confirmFinalResponses(root, [extended.msg]);
		assert.equal(flipped, 1);
		assert.ok(!hasFrame(stale.component.render(40)));
		assert.ok(hasFrame(extended.component.render(40)));
	} finally {
		handle.dispose();
	}
});

test("confirm falls back to agent truth when message_end was missed", () => {
	const seen: string[] = [];
	const handle = install(seen);
	try {
		const live = create([{ type: "text", text: FINAL_TEXT }], "stop", true);
		const root = { children: [live.component] };
		const flipped = handle.confirmFinalResponses(root, [live.msg]);
		assert.equal(flipped, 1);
		assert.ok(hasFrame(live.component.render(40)));
	} finally {
		handle.dispose();
	}
});

test("collapsed and expanded thinking stay outside the final answer frame", () => {
	const seen: string[] = [];
	const handle = install(seen);
	try {
		const content = [
			{ type: "thinking", thinking: "let me think" } as any,
			{ type: "text", text: FINAL_TEXT },
		];
		for (const hidden of [true, false]) {
			const component = new AssistantMessageComponent(
				message(content, "stop"),
				hidden,
				markdownTheme,
				"Thinking",
				0,
				[],
			);
			const rendered = component.render(40);
			const text = plain(rendered);
			assert.ok(hasFrame(rendered));
			const thinking = text.indexOf(hidden ? "Thinking" : "let me think");
			assert.ok(thinking >= 0 && thinking < text.indexOf("╭"));
			assert.ok(text.indexOf("╭") < text.indexOf("修复完成"));
			assert.ok(text.indexOf("详见上文。") < text.indexOf("╯"));
		}
	} finally {
		handle.dispose();
	}
});

test("tool-use and aborted turns never stage nor mark", () => {
	const seen: string[] = [];
	const handle = install(seen);
	try {
		const toolLive = create(
			[
				{ type: "text", text: "working" },
				{ type: "toolCall", id: "t1", name: "bash", arguments: {} } as any,
			],
			"toolUse",
			true,
		);
		const aborted = create([{ type: "text", text: FINAL_TEXT }], "aborted", true);
		const root = { children: [toolLive.component, aborted.component] };
		assert.equal(handle.stageFinalCandidate(toolLive.msg), false);
		assert.equal(handle.stageFinalCandidate(aborted.msg), false);
		assert.equal(handle.confirmFinalResponses(root, [toolLive.msg, aborted.msg]), 0);
		assert.ok(!hasFrame(toolLive.component.render(40)));
		assert.ok(!hasFrame(aborted.component.render(40)));
		// 空结算：无候选无真相，不翻转。
		assert.equal(handle.confirmFinalResponses(root, []), 0);
	} finally {
		handle.dispose();
	}
});

test("frame propagates selection sources with border offsets", () => {
	const seen: string[] = [];
	const handle = install(seen);
	try {
		sourceCalls.length = 0;
		nullRows.length = 0;
		const { component } = create([{ type: "text", text: FINAL_TEXT }], "stop");
		const width = 40;
		const lines = component.render(width);
		assert.ok(hasFrame(lines));
		assert.equal(sourceCalls.length, 1);
		assert.deepEqual(sourceCalls[0], { row: 1, col: 2 });
		assert.deepEqual(nullRows, [0, lines.length - 1]);
	} finally {
		handle.dispose();
	}
});

test("border clicks are swallowed, content clicks delegate with offsets", () => {
	const seen: string[] = [];
	const handle = install(seen);
	try {
		const { component } = create([{ type: "text", text: FINAL_TEXT }], "stop");
		const inner = (component as any).contentContainer;
		inner.clear();
		const received: any[] = [];
		inner.addChild({
			render: () => ["aaa", "bbb"],
			handleMouse: (event: any) => {
				received.push(event);
				return { handled: true };
			},
		});
		const width = 40;
		const lines = component.render(width);
		assert.equal(lines.length, 4);
		const base = { width, height: lines.length, type: "click", button: "left" };
		const click = (x: number, y: number) =>
			(component.handleMouse as unknown as (event: unknown) => unknown)({ ...base, x, y });
		assert.equal(click(5, 0), undefined);
		assert.equal(click(0, 1), undefined);
		assert.equal(click(width - 1, 2), undefined);
		const result = click(2, 1) as { handled?: boolean };
		assert.equal(result?.handled, true);
		assert.equal(received.length, 1);
		assert.equal(received[0].x, 0);
		assert.equal(received[0].y, 0);
		assert.equal(received[0].width, width - 4);
	} finally {
		handle.dispose();
	}
});

test("narrow width and inactive style fall back to native", () => {
	const seen: string[] = [];
	const handle = install(seen);
	try {
		const { component } = create([{ type: "text", text: FINAL_TEXT }], "stop");
		assert.ok(
			!hasFrame(component.render(FINAL_RESPONSE_FRAME_MIN_WIDTH - 1)),
			"narrow render must stay native",
		);
		styleOn = false;
		try {
			assert.ok(!hasFrame(component.render(40)), "off style must stay native");
		} finally {
			styleOn = true;
		}
	} finally {
		handle.dispose();
	}
});

test("missing selection sources gate the frame off instead of crashing", () => {
	const handle = installFinalResponseFrame({
		isStyleActive: () => true,
		getTheme: () => recordingTheme([]),
	});
	try {
		assert.equal(handle.supported, true);
		const { component } = create([{ type: "text", text: FINAL_TEXT }], "stop");
		assert.ok(!hasFrame(component.render(40)), "no sources means no frame on old hosts");
		assert.ok(plain(component.render(40)).includes("修复完成"), "native text still renders");
	} finally {
		handle.dispose();
	}
});

test("dispose restores the native prototype", () => {
	const seen: string[] = [];
	const handle = install(seen);
	try {
		assert.notEqual(AssistantMessageComponent.prototype.render, originalRender);
	} finally {
		handle.dispose();
	}
	assert.equal(AssistantMessageComponent.prototype.render, originalRender);
	assert.equal(Object.hasOwn(AssistantMessageComponent.prototype, "handleMouse"), false);
});
