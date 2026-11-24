import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark");
import { Container } from "@earendil-works/pi-tui";
import {
	getToolCallId,
	getToolDefinition,
	getToolName,
	isNativeExplorationGroup,
	isNativeToolExecutionComponent,
	isToolExpanded,
	isUnifiedToolExecutionComponent,
} from "../extensions/renderer/tool/native-identity.ts";
import { isToolExecutionComponent } from "../extensions/renderer/mouse/packets.ts";
import {
	collapsedHintHitbox,
	collectFullscreenToolCards,
	componentAtLocalRow,
} from "../extensions/renderer/mouse/layout.ts";
import { toolCardStatus } from "../extensions/renderer/tool/tool-state.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import { installCompactMode } from "../extensions/renderer/compact-mode.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";
import { config } from "../extensions/config/config.ts";
import { markCompactRoundToolExpanded } from "../extensions/renderer/compact-mode.ts";

function piCard(name = "read", id = "pi-1") {
	return { toolName: name, toolCallId: id, setExpanded() {}, render: () => [] };
}

function nativeCard(name = "bash", id = "native-1") {
	const component: any = {
		identity: { toolName: name, toolCallId: id, cwd: "/tmp", toolDefinition: { name } },
		args: {},
		result: undefined,
		expanded: false,
		executionStarted: false,
		isPartial: true,
		setExpanded(expanded: boolean) {
			component.expanded = expanded;
		},
		render: () => [],
	};
	Object.defineProperty(component, "presentationSnapshot", {
		get() {
			return {
				identity: component.identity,
				state: {
					args: component.args,
					executionStarted: component.executionStarted,
					isPartial: component.isPartial,
					expanded: component.expanded,
					result: component.result,
				},
				presentation: "classic",
			};
		},
	});
	return component;
}

function nativeGroup() {
	return {
		calls: [{ component: nativeCard("read", "g-1"), call: { action: "Read", label: "a" } }],
		rules: [],
		bodyKey: "k",
		memberSnapshot: [],
		setMembers() {},
		children: [],
	};
}

test("native identity helpers accept Pi flat fields and OmO nested identity", () => {
	const pi = piCard("grep", "pi-grep");
	assert.equal(getToolName(pi), "grep");
	assert.equal(getToolCallId(pi), "pi-grep");
	assert.equal(isUnifiedToolExecutionComponent(pi), true);
	assert.equal(isNativeToolExecutionComponent(pi), false);

	const native = nativeCard("bash", "native-bash");
	assert.equal(getToolName(native), "bash");
	assert.equal(getToolCallId(native), "native-bash");
	assert.equal(getToolDefinition(native)?.name, "bash");
	assert.equal(isNativeToolExecutionComponent(native), true);
	assert.equal(isUnifiedToolExecutionComponent(native), true);
	assert.equal(isToolExecutionComponent(native), true);

	assert.equal(isUnifiedToolExecutionComponent({ render() {} }), false);
	assert.equal(getToolName({}), "tool");
});

test("native ExplorationGroup is preserved, never grouped", () => {
	const group = nativeGroup();
	assert.equal(isNativeExplorationGroup(group), true);
	assert.equal(isNativeExplorationGroup({ calls: [] }), false);
	assert.equal(isUnifiedToolExecutionComponent(group), false);
});

test("tool status reads native snapshot state", () => {
	assert.equal(toolCardStatus(nativeCard()), "pending");
	const done: any = nativeCard("read", "done");
	done.result = { content: [{ type: "text", text: "ok" }] };
	done.isPartial = false;
	done.executionStarted = true;
	assert.equal(toolCardStatus(done), "success");
	const failed: any = nativeCard("read", "failed");
	failed.result = { content: [], isError: true };
	failed.isPartial = false;
	assert.equal(toolCardStatus(failed), "error");
});

test("fullscreen collection preserves native group without descending", () => {
	const group: any = nativeGroup();
	const out: any[] = [];
	collectFullscreenToolCards({ children: [group] }, out);
	assert.equal(out.length, 1);
	assert.equal(out[0], group);
});

test("componentAtLocalRow returns native group directly", () => {
	const group: any = nativeGroup();
	const hit = componentAtLocalRow(group, 0, 80);
	assert.equal(hit?.component, group);
});

test("isToolExpanded follows Pi flag and native snapshot", () => {
	assert.equal(isToolExpanded({ expanded: true }), true);
	const native: any = nativeCard();
	assert.equal(isToolExpanded(native), false);
	native.expanded = true;
	assert.equal(isToolExpanded(native), true);
});

test("ccstyle grouping still groups adjacent Pi cards", () => {
	const hooks = installToolGrouping(() => true);
	try {
		const parent: any = new Container();
		const ui = { theme: { fg: (_c: string, text: string) => text }, requestRender() {} } as any;
		parent.addChild(new ToolExecutionComponent("read", "pi-a", {}, {}, undefined, ui, "/tmp"));
		parent.addChild(new ToolExecutionComponent("bash", "pi-b", {}, {}, undefined, ui, "/tmp"));
		assert.ok(parent.children[0] instanceof ToolGroupComponent);
	} finally {
		hooks.shutdown();
	}
});

/**
 * Fork-baseline regression (qa/baseline-on-120-tools.txt): three settled native
 * cards (read, bash, fixture_scan) collapsed to `Tool: 3 done` with every row
 * titled `Tool`, while the provider really called read/bash/fixture_scan and the
 * expanded native render shows the real names. Collapsed header/rows must use
 * the nested identity; the GROUP hint stays the expand target (it worked at 120),
 * distinct from per-card rows and nested show-more targets.
 */
class ForkNativeCard extends Container {
	identity: any;
	args: any;
	result: any;
	// NOTE: `expanded` must stay a plain field (not a getter): grouping and the
	// mouse layer read/write `card.expanded` directly on native cards.
	expanded = false;
	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}
	executionStarted = true;
	argsComplete = true;
	isPartial = false;
	constructor(name: string, id: string, args: any, resultText: string) {
		super();
		this.identity = { toolName: name, toolCallId: id, cwd: "/tmp", toolDefinition: { name } };
		this.args = args;
		this.result = { content: [{ type: "text", text: resultText }] };
	}
	get presentationSnapshot(): any {
		return {
			identity: this.identity,
			state: {
				args: this.args,
				executionStarted: this.executionStarted,
				isPartial: this.isPartial,
				expanded: this.expanded,
				result: this.result,
			},
			presentation: "classic",
		};
	}
}

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("diverse native cards collapse with real names, not bare Tool", () => {
	const hooks = installToolGrouping(() => true);
	hooks.setTheme({ fg: (_color: string, text: string) => text });
	try {
		const parent: any = new Container();
		parent.addChild(new ForkNativeCard("read", "call_0", { path: "sample.txt" }, "ok"));
		parent.addChild(
			new ForkNativeCard("bash", "call_1", { command: "printf 'WORKFLOW_FIXTURE_OK\\n'" }, "ok"),
		);
		parent.addChild(new ForkNativeCard("fixture_scan", "call_2", {}, "scanned"));
		const group = parent.children[0] as ToolGroupComponent;
		assert.ok(group instanceof ToolGroupComponent);
		const lines = group.render(100).map(stripAnsi);
		const header = lines[1] ?? "";
		assert.ok(header.includes("3 done"), `header counts three settled cards: ${header}`);
		assert.ok(!/\bTool:/.test(header), `header must not use the bare fallback: ${header}`);
		const rows = lines.slice(2).join("\n");
		assert.ok(rows.includes("Read"), `read row keeps its name:\n${rows}`);
		assert.ok(rows.includes("sample.txt"), `read row keeps its path:\n${rows}`);
		assert.ok(rows.includes("Bash"), `bash row keeps its name:\n${rows}`);
		assert.ok(rows.includes("Fixture Scan"), `custom tool row keeps its name:\n${rows}`);
		assert.ok(!/✓ Tool([\s]|$)/.test(rows), `no row may use the bare fallback:\n${rows}`);
		// GROUP hint is the collapsed expand target: the header carries a clickable
		// hint hitbox (this is the click that worked at 120). Collapsed rows are
		// display-only; per-card targets resolve once expanded (distinct targets).
		assert.ok(collapsedHintHitbox(lines[1] ?? ""), "header exposes the GROUP hint hitbox");
		assert.equal(group.childAtRow(2, 100), null, "collapsed rows belong to the group");
		group.setExpanded(true);
		const hit = group.childAtRow(2, 100);
		assert.ok(hit && hit.component instanceof ForkNativeCard, "row hit resolves to its own card");
	} finally {
		hooks.shutdown();
	}
});

/**
 * Compact-baseline regression (qa/baseline-compact-88-tools.txt): with three
 * settled native calls (read, bash, fixture_scan) compact showed only the native
 * `Explored / Read sample.txt` line; bash and fixture_scan vanished and the
 * tail counted `read×1`. Root cause: every component↔message join keyed on the
 * flat `toolCallId`, which is undefined on snapshot-backed cards, so no round
 * ever claimed them while the patched render hid every collapsed card.
 *
 * A Pi card with its flat identity stripped (identity-only, like OmO native)
 * driven through the real patched prototype must: expose a joinable id, hide
 * when collapsed, render when independently expanded (per-card click target),
 * and survive the round-expand marking path without id collisions.
 */
function snapshotCard(name: string, id: string, args: any) {
	const ui = { theme: { fg: (_c: string, text: string) => text }, requestRender() {} } as any;
	const card: any = new ToolExecutionComponent(name, id, args, {}, { name } as any, ui, "/tmp");
	card.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
	delete card.toolName;
	delete card.toolCallId;
	delete card.toolDefinition;
	card.identity = { toolName: name, toolCallId: id, cwd: "/tmp", toolDefinition: { name } };
	Object.defineProperty(card, "presentationSnapshot", {
		get() {
			return {
				identity: card.identity,
				state: {
					args: card.args,
					executionStarted: card.executionStarted,
					isPartial: card.isPartial,
					expanded: card.expanded,
					result: card.result,
				},
				presentation: "classic",
			};
		},
		configurable: true,
	});
	return card;
}

test("compact claims snapshot cards by nested identity and expands them per-card", () => {
	const previousMode = config.mode;
	config.mode = "compact";
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		const messageIds = new Set(["call_0", "call_1", "call_2"]);
		const cards = [
			snapshotCard("read", "call_0", { path: "sample.txt" }),
			snapshotCard("bash", "call_1", { command: "printf 'WORKFLOW_FIXTURE_OK\\n'" }),
			snapshotCard("fixture_scan", "call_2", {}),
		];
		// Round join (toolsById / matchesTool / collapse predicates): every card
		// resolves to its provider id. Pre-fix all three collapsed to "".
		for (const card of cards) {
			const id = getToolCallId(card);
			assert.ok(
				typeof id === "string" && id && messageIds.has(id),
				`card joins its message id: ${id}`,
			);
		}
		assert.deepEqual(
			new Set(cards.map((card) => getToolCallId(card))),
			messageIds,
			"no id collisions across snapshot cards",
		);
		// Patched render: collapsed cards hide (round tail re-shows them),
		// independently expanded cards render (per-card click target), with real names.
		for (const card of cards) {
			assert.deepEqual(card.render(100), [], `${getToolName(card)} hides when collapsed`);
		}
		const bash = cards[1];
		bash.setExpanded(true);
		const expanded = bash.render(100).join("\n");
		assert.ok(expanded.length > 0, "expanded snapshot card renders its own content");
		bash.setExpanded(false);
		// Round-expand marking path tolerates snapshot cards (single-expand bookkeeping).
		assert.doesNotThrow(() => markCompactRoundToolExpanded(cards[0]));
		// Hover is keyed by the real id, not a shared empty key.
		assert.equal(getToolCallId(cards[0]), "call_0");
		assert.equal(getToolCallId(cards[2]), "call_2");
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("homogeneous native cards keep the shared real name in the header", () => {
	const hooks = installToolGrouping(() => true);
	hooks.setTheme({ fg: (_color: string, text: string) => text });
	try {
		const parent: any = new Container();
		parent.addChild(new ForkNativeCard("read", "call_0", { path: "a.txt" }, "ok"));
		parent.addChild(new ForkNativeCard("read", "call_1", { path: "b.txt" }, "ok"));
		const group = parent.children[0] as ToolGroupComponent;
		assert.ok(group instanceof ToolGroupComponent);
		const header = stripAnsi(group.render(100)[1] ?? "");
		assert.ok(header.includes("Read"), `shared name survives: ${header}`);
		assert.ok(!/\bTool:/.test(header), `no fallback header: ${header}`);
	} finally {
		hooks.shutdown();
	}
});
