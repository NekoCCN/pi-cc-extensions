import assert from "node:assert/strict";
import { test } from "node:test";
import type { MarkdownTransformContext } from "@earendil-works/pi-coding-agent";
import {
	getOsc8LinkAtColumn,
	Markdown,
	type MarkdownTheme,
	resetCapabilitiesCache,
	setCapabilities,
	stripTerminalSequences,
	type Terminal,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { transformMarkdown } from "../extensions/renderer/markdown-enhance.ts";
import { installTableCopy } from "../extensions/renderer/table-copy.ts";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
	highlightCode: (text) => text.split("\n").map((line) => `\x1b[32m${line}\x1b[39m`),
};
const label = "[Copy]";
const source = "看 [双语\n 文档](https://example.com) 和 `inline()`，方案①。";
const code = "\tconst 猫 = '宽字符';          \r\n\r\nreturn 猫;";

function setup(
	text: string,
	state = { streaming: false },
	tui: { readonly mode?: string } = { mode: "fullscreen" },
) {
	const copies: string[] = [];
	const installation = installTableCopy({
		tui,
		paint: (_color, value) => value,
		blocks: { border: (value) => `\x1b[90m${value}\x1b[39m` },
		copy: async (value) => {
			copies.push(value);
		},
	});
	const md = new Markdown(text, 1, 0, theme, undefined, {
		transform: (markdown, availableWidth) => {
			const context: MarkdownTransformContext = {
				messageType: "assistant",
				isStreaming: state.streaming,
				availableWidth,
			};
			return transformMarkdown(markdown, context, installation.noteSource(context, markdown));
		},
	});
	return { md, copies, dispose: installation.dispose };
}

function click(md: Markdown, point: { x: number; y: number }) {
	const handle: unknown = Reflect.get(md, "handleMouse");
	assert.ok(typeof handle === "function");
	return handle.call(md, {
		...point,
		type: "click",
		button: "left",
		shift: false,
		alt: false,
		ctrl: false,
	});
}

test("code frame keeps corners and side rules in the exact same cells as CJK wraps", () => {
	const { md, dispose } = setup(`\`\`\`\`typescript\r\n${code}\r\n\`\`\`\``);
	try {
		for (const [width, expectedBodyRows] of [
			[26, 4],
			[40, 3],
		]) {
			const rendered = md.render(width);
			const lines = rendered.map(stripTerminalSequences);
			assert.equal(lines.length, expectedBodyRows + 2);
			assert.equal(lines[0], ` ╭─ typescript ${"─".repeat(width - 26)} [Copy] ─╮ `);
			assert.equal(lines.at(-1), ` ╰${"─".repeat(width - 4)}╯ `);
			for (const line of lines.slice(1, -1)) {
				assert.equal(visibleWidth(line), width);
				assert.match(line, /^ │.*│ $/);
			}
			assert.ok(rendered.some((line) => line.includes("\x1b[32m")));
			assert.ok(rendered.every((line) => !/\x1b\[(?:4[0-8]|10[0-7])(?:;|m)/.test(line)));
		}
	} finally {
		dispose();
	}
});

test("clicking only the marked code and prose buttons copies unwrapped original source", async () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const { md, copies, dispose } = setup(`${source}\n\n~~~typescript\r\n${code}\r\n~~~`);
	try {
		const lines = md.render(31);
		const plain = lines.map(stripTerminalSequences);
		const targets = plain.flatMap((line, y) => {
			const offset = line.indexOf(label);
			return offset < 0 ? [] : [{ x: visibleWidth(line.slice(0, offset)), y }];
		});
		assert.equal(targets.length, 2);
		const linkRow = plain.findIndex((line) => line.includes("双语"));
		assert.equal(getOsc8LinkAtColumn(lines[linkRow], 4), "https://example.com");
		assert.equal(click(md, { x: 4, y: linkRow }), undefined);
		for (const point of targets) {
			assert.equal(click(md, { ...point, x: point.x - 1 }), undefined);
			assert.equal(click(md, point)?.handled, true);
		}
		await Promise.resolve();
		assert.deepEqual(copies, [source, code]);
	} finally {
		dispose();
		resetCapabilitiesCache();
	}
});

test("a cached streaming code frame copies the newest payload, not an earlier render", async () => {
	const state = { streaming: true };
	const first = "```ts\nconst 猫 = 1;";
	const { md, copies, dispose } = setup(first, state);
	try {
		md.render(28);
		md.setText(`${first}\nreturn 猫;\n\`\`\``);
		state.streaming = false;
		md.render(28);
		const lines = md.render(28).map(stripTerminalSequences);
		assert.equal(click(md, { x: lines[0].indexOf(label), y: 0 })?.handled, true);
		await Promise.resolve();
		assert.deepEqual(copies, ["const 猫 = 1;\nreturn 猫;"]);
	} finally {
		dispose();
	}
});

test("fullscreen mouse clicks copy a cached code frame and drag omits all inserted chrome", async () => {
	const idle = () => {};
	const terminal: Terminal = {
		columns: 42,
		rows: 24,
		kittyProtocolActive: false,
		start: idle,
		stop: idle,
		write: idle,
		drainInput: async () => {},
		moveBy: idle,
		hideCursor: idle,
		showCursor: idle,
		clearLine: idle,
		clearFromCursor: idle,
		clearScreen: idle,
		setTitle: idle,
		setProgress: idle,
		setProgramStatus: idle,
	};
	const selected: string[] = [];
	const tui = new TuiAltScreen(terminal, false, undefined, {
		copySelection: async (value) => {
			selected.push(value);
			return true;
		},
	});
	const state = { streaming: false };
	const content = "Before prose\n\n```ts\n  console.log('猫');\n```\n\nAfter prose";
	const { md, copies, dispose } = setup(content, state, tui);
	// An assistant overlay with the same source/theme must not get a cached action
	// from the real body, and vice versa.
	const passive = new Markdown(content, 1, 0, theme);
	tui.addChild(md);
	tui.start();
	const redraw: unknown = Reflect.get(tui, "doRender");
	const input: unknown = Reflect.get(tui, "handleViewportInput");
	assert.ok(typeof redraw === "function" && typeof input === "function");
	const send = (x: number, y: number, button: number, release = false) => {
		input.call(tui, `\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
	};
	try {
		passive.render(42);
		redraw.call(tui);
		const screen = tui.getScreenLines().map(stripTerminalSequences);
		const top = screen.findIndex((line) => line.includes("╭─ ts"));
		assert.ok(top >= 0);
		const button = screen[top].indexOf(label);
		assert.ok(button >= 0);
		send(button, top, 0);
		send(button, top, 0, true);
		await Promise.resolve();
		assert.deepEqual(copies, ["  console.log('猫');"]);
		assert.equal(
			passive.render(42).some((line) => line.includes(label)),
			false,
		);

		const first = screen.findIndex((line) => line.includes("Before prose"));
		const last = screen.findIndex((line) => line.includes("After prose"));
		send(1, first, 0);
		send(20, last, 32);
		redraw.call(tui);
		send(20, last, 0, true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(selected, ["Before prose\n\n  console.log('猫');\n\n After prose"]);
	} finally {
		tui.stop();
		dispose();
	}
});

test("diagram art and source fallback are not mistaken for user prose or fenced code", async () => {
	const content = [
		"```sequenceDiagram",
		"A very long actor name ->> B: A very long message",
		"```",
		"",
		"After the diagram: ①",
	].join("\n");
	const { md, copies, dispose } = setup(content);
	try {
		for (const width of [30, 90, 30]) {
			const lines = md.render(width).map(stripTerminalSequences);
			const buttons = lines.flatMap((line, y) =>
				line.includes(label) ? [{ x: line.indexOf(label), y }] : [],
			);
			assert.equal(buttons.length, 1);
			assert.match(lines[buttons[0].y - 1], /After the diagram: \(1\)/);
			assert.equal(click(md, buttons[0])?.handled, true);
		}
		await Promise.resolve();
		assert.deepEqual(copies, Array(3).fill("After the diagram: ①"));
	} finally {
		dispose();
	}
});

test("a hidden duplicate cannot supply the visible paragraph's copy source", async () => {
	for (const hidden of ["<!--\n方案(1)\n-->", "[unused]: /方案(1)"]) {
		const { md, copies, dispose } = setup(`${hidden}\n\n方案①`);
		try {
			const lines = md.render(42).map(stripTerminalSequences);
			const y = lines.findIndex((line) => line.trim() === label);
			assert.ok(y >= 0);
			assert.equal(click(md, { x: lines[y].indexOf(label), y })?.handled, true);
			await Promise.resolve();
			assert.deepEqual(copies, ["方案①"]);
		} finally {
			dispose();
		}
	}
});
