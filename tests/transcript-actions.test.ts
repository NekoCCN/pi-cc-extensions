import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	CompactionSummaryMessageComponent,
	createBashToolDefinition,
	initTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, ProcessTerminal, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import { installFinalResponseFrame } from "../extensions/renderer/final-response-frame.ts";
import { transcript, updateReply } from "./fixtures/transcript-actions.ts";

initTheme("dark");

const TAB = "\t";
const BACK_TAB = "\x1b[Z";
const ENTER = "\r";
const ESC = "\x1b";
const TABLE = '| 键 | Value |\n| --- | --- |\n| 甲 | "x,y" |';
const SECOND_TABLE = "| Month | Count |\n| --- | --- |\n| May | 3 |";
const REPLY = `Earlier reply\n\n\`\`\`sh\nprintf '\t界'  \n\`\`\`\n\n\`\`\`sh\necho second\n\`\`\`\n\n${TABLE}`;

test("Tab labels distinct fences and tables and Enter copies each exact payload", async () => {
	const reply = new AssistantMessageComponent(undefined);
	const text = `${REPLY}\n\n${SECOND_TABLE}`;
	updateReply(reply, text);
	const chat = new Container();
	chat.addChild(reply);
	const t = transcript(chat, 8, { tablesEnabled: true });
	t.render(36);
	const previews = [
		/Copy response/,
		/printf/,
		/echo second/,
		/键/,
		/键/,
		/键/,
		/Month/,
		/Month/,
		/Month/,
	];
	for (const preview of previews) {
		t.view.handleInput(TAB);
		const frame = t.render(36);
		assert.match(frame.at(-2) ?? "", preview);
		assert.ok(frame.every((line) => visibleWidth(line) <= 36));
		t.view.handleInput(ENTER);
	}
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(t.copies, [
		text,
		"printf '\t界'  ",
		"echo second",
		'键\tValue\n甲\t"x,y"',
		'键,Value\n甲,"""x,y"""',
		TABLE,
		"Month\tCount\nMay\t3",
		"Month,Count\nMay,3",
		SECOND_TABLE,
	]);
	assert.equal(t.notices.at(-1), "Copied table as Markdown");
});

test("disabled table copy leaves history response and fence actions available", async () => {
	const reply = new AssistantMessageComponent(undefined);
	updateReply(reply, REPLY);
	const chat = new Container();
	chat.addChild(reply);
	const t = transcript(chat, 8, { tablesEnabled: false });
	t.render();
	t.view.handleInput(BACK_TAB);
	assert.doesNotMatch(t.render().at(-2) ?? "", /table|TSV|CSV|Markdown/);
	t.view.handleInput(ENTER);
	t.view.handleInput(BACK_TAB);
	t.view.handleInput(BACK_TAB);
	t.view.handleInput(ENTER);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(t.copies, ["echo second", REPLY]);
});

test("Copy response waits for the same live settlement as the mouse frame", async () => {
	const reply = new AssistantMessageComponent(undefined);
	const message = updateReply(reply, "In-flight answer", true);
	const chat = new Container();
	chat.addChild(reply);
	const frame = installFinalResponseFrame();
	try {
		const t = transcript(chat, 8, { canCopyResponse: (value) => frame.canCopyResponse(value) });
		t.render();
		t.view.handleInput(TAB);
		const pending = t.render();
		t.view.handleInput(ENTER);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.doesNotMatch(pending.at(-2) ?? "", /Copy response/);
		assert.deepEqual(t.copies, []);

		frame.stageFinalCandidate(message);
		assert.equal(frame.confirmFinalResponses(chat, [message]), 1);
		t.render();
		t.view.handleInput(TAB);
		assert.match(t.render().at(-2) ?? "", /Copy response/);
		t.view.handleInput(ENTER);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(t.copies, ["In-flight answer"]);
	} finally {
		frame.dispose();
	}
});

test("reverse traversal reveals an offscreen action and keeps its identity while streaming", async () => {
	const earlier = new AssistantMessageComponent(undefined);
	const earlierMessage = updateReply(earlier, REPLY, true);
	const tail = new AssistantMessageComponent(undefined);
	updateReply(tail, Array.from({ length: 40 }, (_, n) => `Tail row ${n}`).join("\n\n"));
	const chat = new Container();
	chat.addChild(earlier);
	chat.addChild(tail);
	const t = transcript(chat, 8, { tablesEnabled: true });

	assert.match(t.render().join("\n"), /Tail row 39/);
	t.view.handleInput(BACK_TAB);
	t.render();
	t.view.handleInput(BACK_TAB);
	const frame = t.render(28);
	assert.match(frame.join("\n"), /Earlier reply/);
	assert.match(frame.at(-2) ?? "", /Markdown/);
	assert.ok(frame.every((line) => visibleWidth(line) <= 28));
	const updatedTable = `${TABLE}\n| 乙 | streamed |`;
	for (const block of earlierMessage.content) block.text = REPLY.replace(TABLE, updatedTable);
	Reflect.apply(earlier.updateContent, earlier, [earlierMessage, true]);
	updateReply(tail, `${REPLY}\n\nNew terminal text`, true);
	t.render(72);
	t.view.handleInput(ENTER);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(t.copies, [updatedTable]);
});

function bashCard(id: string, command: string) {
	const cwd = process.cwd();
	const toolUi = new TuiAltScreen(new ProcessTerminal());
	const tool = new ToolExecutionComponent(
		"bash",
		id,
		{ command },
		{},
		createBashToolDefinition(cwd),
		toolUi,
		cwd,
	);
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: `Result for ${id}` }], isError: false });
	return tool;
}

test("Esc returns from owned tool detail to the same focused historical row", () => {
	const tool = bashCard("transcript-detail", "echo historical-tool");
	const chat = new Container();
	chat.addChild(tool);
	const t = transcript(chat);
	t.render();
	t.view.handleInput(TAB);
	const selected = t.render();
	t.view.handleInput(ENTER);
	assert.match(t.render().join("\n"), /Input[\s\S]*echo historical-tool[\s\S]*Output/);
	t.view.handleInput(ESC);
	assert.equal(t.closed(), false);
	assert.deepEqual(t.render(), selected);
	t.view.handleInput(ESC);
	assert.equal(t.closed(), true);
});

test("an OmO exploration group offers group detail and separate member detail", () => {
	const first = bashCard("primary", "echo first");
	const second = bashCard("secondary", "echo second");
	const group = new Container();
	Object.assign(group, {
		calls: [{ component: first }, { component: second }],
		rules: [],
		setMembers() {},
	});
	group.addChild(first);
	group.addChild(second);
	const chat = new Container();
	chat.addChild(group);
	const t = transcript(chat, 24);
	t.render();
	t.view.handleInput(TAB);
	t.view.handleInput(ENTER);
	const grouped = t.render();
	assert.match(grouped.at(-2) ?? "", /Multiple Tools/);
	assert.match(grouped.join("\n"), /Result for primary[\s\S]*Result for secondary/);
	t.view.handleInput(ESC);
	t.render();
	t.view.handleInput(BACK_TAB);
	t.view.handleInput(ENTER);
	const detail = t.render().join("\n");
	assert.match(detail, /Input[\s\S]*echo second[\s\S]*Result for secondary/);
	assert.doesNotMatch(detail, /Result for primary/);
});

test("Enter opens the full Markdown of a historical folded compaction summary", () => {
	const summary = "Folded summary with **historical evidence**.";
	const chat = new Container();
	chat.addChild(
		new CompactionSummaryMessageComponent({
			role: "compactionSummary",
			summary,
			timestamp: 1,
			tokensBefore: 600,
		}),
	);
	const t = transcript(chat);
	t.render();
	t.view.handleInput(TAB);
	t.view.handleInput(ENTER);
	const detail = t.render();
	assert.match(detail.join("\n"), /Folded summary with historical evidence/);
	assert.match(detail.at(-1) ?? "", /Esc back/);
});

test("OmO's folded handoff opens from the transcript and returns without unfolding the transcript", () => {
	const reply = new AssistantMessageComponent(undefined);
	updateReply(
		reply,
		"Ask: Check results. For you: Ready. Now: preserve state. Next: confirm output.",
	);
	const chat = new Container();
	chat.addChild(reply);
	const t = transcript(chat);
	const original = t.render();
	// Pi does not provide the native handoff folding capability.
	if (typeof Reflect.get(reply, "withHandoffToggle") !== "function") {
		assert.match(original.join("\n"), /Ask: Check results/);
		return;
	}
	assert.doesNotMatch(original.join("\n"), /Ask: Check results/);
	t.view.handleInput(TAB);
	t.view.handleInput(TAB);
	const selected = t.render();
	t.view.handleInput(ENTER);
	assert.match(t.render().join("\n"), /Ask: Check results[\s\S]*Next: confirm\s+output/);
	t.view.handleInput(ESC);
	assert.deepEqual(t.render(), selected);
});
