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
	highlightCode: (text) => text.split("\n").map((line) => `[32m${line}[39m`),
};
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
			installation.noteSource(context);
			return transformMarkdown(markdown, context);
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

test("fenced code renders natively without copy chrome or frames", () => {
	const { md, dispose } = setup(`\`\`\`\`typescript\r\n${code}\r\n\`\`\`\``);
	try {
		for (const width of [26, 40]) {
			const rendered = md.render(width);
			const plain = rendered.map(stripTerminalSequences).join("\n");
			assert.doesNotMatch(plain, /\[Copy\]/);
			assert.doesNotMatch(plain, /[╭╰│]/);
			assert.match(plain, /const 猫/);
			assert.match(plain, /return 猫/);
		}
		assert.ok(md.render(40).some((line) => line.includes("\x1b[32m")));
	} finally {
		dispose();
	}
});

test("paragraphs render without appended copy actions and links stay clickable", () => {
	setCapabilities({ images: null, trueColor: true, hyperlinks: true });
	const { md, copies, dispose } = setup(source);
	try {
		const lines = md.render(31);
		const plain = lines.map(stripTerminalSequences).join("\n");
		assert.doesNotMatch(plain, /\[Copy\]/);
		const linkRow = lines.map(stripTerminalSequences).findIndex((line) => line.includes("双语"));
		assert.ok(linkRow >= 0);
		assert.equal(getOsc8LinkAtColumn(lines[linkRow], 4), "https://example.com");
		return Promise.resolve().then(() => assert.deepEqual(copies, []));
	} finally {
		dispose();
		resetCapabilitiesCache();
	}
});

test("clicking code copies nothing once the inline action is gone", async () => {
	const { md, copies, dispose } = setup(`~~~typescript\r\n${code}\r\n~~~`);
	try {
		const lines = md.render(31);
		assert.doesNotMatch(lines.map(stripTerminalSequences).join("\n"), /\[Copy\]/);
		const row = lines.findIndex((line) => stripTerminalSequences(line).includes("const"));
		assert.ok(row >= 0);
		click(md, { x: 4, y: row });
		await Promise.resolve();
		assert.deepEqual(copies, []);
	} finally {
		dispose();
	}
});

test("a streaming code frame that completes gains no copy chrome", () => {
	const state = { streaming: true };
	const first = "```ts\nconst 猫 = 1;";
	const { md, dispose } = setup(first, state);
	try {
		md.render(28);
		md.setText(`${first}\nreturn 猫;\n\`\`\``);
		state.streaming = false;
		const plain = md.render(28).map(stripTerminalSequences).join("\n");
		assert.doesNotMatch(plain, /\[Copy\]/);
		assert.doesNotMatch(plain, /[╭╰│]/);
		assert.match(plain, /return 猫/);
	} finally {
		dispose();
	}
});

test("diagram art renders without copy buttons", async () => {
	const content = [
		"```sequenceDiagram",
		"A very long actor name ->> B: A very long message",
		"```",
		"",
		"After the diagram: ①",
	].join("\n");
	const { md, copies, dispose } = setup(content);
	try {
		for (const width of [30, 90]) {
			const plain = md.render(width).map(stripTerminalSequences).join("\n");
			assert.doesNotMatch(plain, /\[Copy\]/);
			assert.match(plain, /After the diagram: \(1\)/);
		}
		await Promise.resolve();
		assert.deepEqual(copies, []);
	} finally {
		dispose();
	}
});

test("fullscreen code has no frame chrome and drag selection stays native", async () => {
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
	const { md, dispose } = setup(content, state, tui);
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
		assert.doesNotMatch(screen.join("\n"), /\[Copy\]/);
		assert.doesNotMatch(screen.join("\n"), /[╭╰│]/);
		assert.ok(screen.some((line) => line.includes("console.log")));

		const first = screen.findIndex((line) => line.includes("Before prose"));
		const last = screen.findIndex((line) => line.includes("After prose"));
		send(1, first, 0);
		send(20, last, 32);
		redraw.call(tui);
		send(20, last, 0, true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(selected.length, 1);
		assert.match(selected[0], /console\.log\('猫'\)/);
		assert.doesNotMatch(selected[0], /\[Copy\]/);
	} finally {
		tui.stop();
		dispose();
	}
});

test("tables keep their copy actions while code has none", async () => {
	const { md, copies, dispose } = setup(
		"| A | B |\n| --- | --- |\n| one | two |\n\n```ts\nlet x = 1;\n```",
	);
	try {
		const lines = md.render(80);
		const plain = lines.map(stripTerminalSequences);
		assert.doesNotMatch(plain.join("\n"), /\[Copy\]/);
		const target = plain.flatMap((line, y) => {
			const offset = line.indexOf("Copy TSV");
			return offset < 0 ? [] : [{ x: offset, y }];
		});
		assert.equal(target.length, 1);
		assert.equal(click(md, target[0])?.handled, true);
		await Promise.resolve();
		assert.deepEqual(copies, ["A\tB\none\ttwo"]);
	} finally {
		dispose();
	}
});
