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
	const create = (source: string) =>
		new Markdown(source, 1, 0, theme, undefined, {
			transform: (markdown, availableWidth) => {
				const context: MarkdownTransformContext = {
					messageType: "assistant",
					isStreaming: state.streaming,
					availableWidth,
				};
				const display = transformMarkdown(markdown, context);
				installation.noteSource(context, markdown, display);
				return display;
			},
		});
	return { md: create(text), create, copies, dispose: installation.dispose };
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

test("fenced code keeps native highlighting with one separate copy row and no frame", () => {
	const { md, dispose } = setup(`\`\`\`\`typescript\r\n${code}\r\n\`\`\`\``);
	try {
		for (const width of [26, 40]) {
			const rendered = md.render(width);
			const plain = rendered.map(stripTerminalSequences).join("\n");
			assert.equal(
				rendered.map(stripTerminalSequences).filter((line) => /^\s*\[Copy code\]\s*$/.test(line))
					.length,
				1,
			);
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
		assert.doesNotMatch(plain, /\[Copy(?: code)?\]/);
		const linkRow = lines.map(stripTerminalSequences).findIndex((line) => line.includes("双语"));
		assert.ok(linkRow >= 0);
		assert.equal(getOsc8LinkAtColumn(lines[linkRow], 4), "https://example.com");
		return Promise.resolve().then(() => assert.deepEqual(copies, []));
	} finally {
		dispose();
		resetCapabilitiesCache();
	}
});

test("only the action copies the exact unwrapped body after resizing", async () => {
	const { md, copies, dispose } = setup(`~~~typescript\r\n${code}\r\n~~~`);
	try {
		const lines = md.render(31);
		assert.doesNotMatch(lines.map(stripTerminalSequences).join("\n"), /\[Copy\]/);
		const row = lines.findIndex((line) => stripTerminalSequences(line).includes("const"));
		assert.ok(row >= 0);
		click(md, { x: 4, y: row });
		await Promise.resolve();
		assert.deepEqual(copies, []);
		for (const width of [80, 19]) {
			const y = md
				.render(width)
				.findIndex((line) => stripTerminalSequences(line).includes("[Copy code]"));
			assert.ok(y >= 0);
			assert.equal(click(md, { x: 1, y })?.handled, true);
		}
		await Promise.resolve();
		assert.deepEqual(copies, [code, code]);
	} finally {
		dispose();
	}
});

test("cached duplicate fences copy each raw occurrence even when their rendered bodies match", async () => {
	const fence = (body: string) => `\`\`\`ts\n${body}\n\`\`\``;
	const first = "\t猫();";
	const second = "   猫();";
	const hidden = `<!--\n${fence(first)}\n-->`;
	const initial = `${hidden}\n\n${fence(first)}\n\n${fence(second)}`;
	const { md, create, copies, dispose } = setup(initial);
	const shared = create(initial);
	try {
		const copyBoth = (component: Markdown) => {
			component.render(40);
			const rows = component
				.render(40)
				.flatMap((line, y) => (stripTerminalSequences(line).includes("[Copy code]") ? [y] : []));
			assert.equal(rows.length, 2);
			for (const y of rows) assert.equal(click(component, { x: 1, y })?.handled, true);
		};
		copyBoth(md);
		copyBoth(shared);
		md.setText(`${hidden}\n\n${fence(second)}\n\n${fence(first)}`);
		copyBoth(md);
		await Promise.resolve();
		assert.deepEqual(copies, [first, second, first, second, second, first]);
	} finally {
		dispose();
	}
});

test("quoted fences discard only the quote prefix and indented fences retain original body spaces", async () => {
	const { md, copies, dispose } = setup(
		"> > ```ts\n> > \t猫();\n> > > literal\n> > ```\n\n   ~~~ts\n     奥();\n   ~~~",
	);
	try {
		const targets = md.render(60).flatMap((line, y) => {
			const x = stripTerminalSequences(line).indexOf("[Copy code]");
			return x < 0 ? [] : [{ x, y }];
		});
		assert.equal(targets.length, 2);
		for (const target of targets) assert.equal(click(md, target)?.handled, true);
		await Promise.resolve();
		assert.deepEqual(copies, ["\t猫();\n> literal", "     奥();"]);
	} finally {
		dispose();
	}
});

test("list-contained fences cannot borrow the copy source of a matching standalone fence", async () => {
	const { md, copies, dispose } = setup(
		"- ```ts\n     猫();\n  ```\n\n```ts\n\t猫();\n```\n\n    ```ts\n    not a fence\n    ```",
	);
	try {
		const plain = md.render(60).map(stripTerminalSequences);
		const targets = plain.flatMap((line, y) => (line.includes("[Copy code]") ? [y] : []));
		assert.equal(targets.length, 1);
		assert.ok(targets[0] > plain.findLastIndex((line) => line.includes("猫();")));
		assert.equal(click(md, { x: 1, y: targets[0] })?.handled, true);
		await Promise.resolve();
		assert.deepEqual(copies, ["\t猫();"]);
	} finally {
		dispose();
	}
});

test("a streaming code block that completes gains a copy action without a frame", () => {
	const state = { streaming: true };
	const first = "```ts\nconst 猫 = 1;";
	const { md, dispose } = setup(first, state);
	try {
		assert.doesNotMatch(md.render(28).map(stripTerminalSequences).join("\n"), /\[Copy code\]/);
		md.setText(`${first}\nreturn 猫;\n\`\`\``);
		state.streaming = false;
		const plain = md.render(28).map(stripTerminalSequences).join("\n");
		assert.match(plain, /\[Copy code\]/);
		assert.doesNotMatch(plain, /[╭╰│]/);
		assert.match(plain, /return 猫/);
	} finally {
		dispose();
	}
});

test("response copy reports success and failure through the shared clipboard path", async () => {
	const notices: Array<[string, boolean]> = [];
	const received: string[] = [];
	const installation = installTableCopy({
		tui: { mode: "fullscreen" },
		paint: (_color, value) => value,
		copy: async (text) => {
			received.push(text);
			if (text === "reject") throw new Error("clipboard unavailable");
		},
		notify: (message, error) => notices.push([message, error]),
	});
	try {
		const copy = installation.getResponseCopy();
		assert.ok(copy);
		copy(" # 猫\r\n\n");
		copy("reject");
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(received, [" # 猫\r\n\n", "reject"]);
		assert.deepEqual(notices, [
			["Copied response", false],
			["Response copy failed: clipboard unavailable", true],
		]);
		installation.dispose();
		copy("stale");
		await Promise.resolve();
		assert.equal(received.length, 2);
	} finally {
		installation.dispose();
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
			assert.doesNotMatch(plain, /\[Copy(?: code)?\]/);
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
	const { md, copies, dispose } = setup(content, state, tui);
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
		const action = screen.findIndex((line) => line.includes("[Copy code]"));
		assert.ok(action >= 0);
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
		assert.doesNotMatch(selected[0], /\[Copy(?: code)?\]/);
		send(1, action, 0);
		send(1, action, 0, true);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(copies, ["  console.log('猫');"]);
	} finally {
		tui.stop();
		dispose();
	}
});

test("tables keep their copy actions alongside fenced code", async () => {
	const { md, copies, dispose } = setup(
		"| A | B |\n| --- | --- |\n| one | two |\n\n```ts\nlet x = 1;\n```",
	);
	try {
		const lines = md.render(80);
		const plain = lines.map(stripTerminalSequences);
		assert.match(plain.join("\n"), /\[Copy code\]/);
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
