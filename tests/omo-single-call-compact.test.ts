import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { config } from "../extensions/config/config.ts";
import { installDefaultMode, prepareNativeToolRenderer } from "../extensions/renderer/default-mode.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/index.ts";
import { extractApplyPatchPaths, toolCallSummary } from "../extensions/renderer/tool/names.ts";
import {
	getToolName,
	isNativeExplorationGroup,
	isNativeToolExecutionComponent,
} from "../extensions/renderer/tool/native-identity.ts";

initTheme("dark");

const theme = { fg: (_color: string, text: string) => text } as any;
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const renderText = (component: any, width = 120) =>
	component
		.render(width)
		.join("\n")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

// Synthetic fixtures only: no user private data, shapes mimic OMO/native contracts.
const SYNTHETIC_PATCH = [
	"*** Begin Patch",
	"*** Update File: src/a.ts",
	"@@",
	"- old line",
	"+ new line",
	"*** Update File: src/b.ts",
	"@@",
	"- gone",
	"+ here",
	"*** End Patch",
].join("\n");

test("update_goal call stays compact with status, not raw JSON", () => {
	const summary = toolCallSummary(
		"update_goal",
		{ status: "complete" },
		{ title: "Update Goal", variant: "default" },
	);
	assert.match(summary.main, /→ complete/);
	assert.equal(summary.payload, undefined);
	const withReason = toolCallSummary(
		"update_goal",
		{ status: "blocked", reason: "waiting on external signal" },
		{ title: "Update Goal", variant: "default" },
	);
	assert.match(withReason.main, /→ blocked/);
	assert.match(withReason.payload ?? "", /waiting on external signal/);
});

test("apply_patch call reports paths, never the full patch body", () => {
	assert.deepEqual(extractApplyPatchPaths(SYNTHETIC_PATCH), ["src/a.ts", "src/b.ts"]);
	const summary = toolCallSummary(
		"apply_patch",
		{ input: SYNTHETIC_PATCH },
		{ title: "Apply Patch", variant: "default" },
	);
	assert.match(summary.payload ?? "", /src\/a\.ts/);
	assert.match(summary.payload ?? "", /src\/b\.ts/);
	assert.doesNotMatch(summary.payload ?? "", /Begin Patch/);
	assert.doesNotMatch(summary.payload ?? "", /\n/);
});

test("ctx_execute call is a one-line language + code summary", () => {
	const summary = toolCallSummary(
		"ctx_execute",
		{ language: "shell", code: "git log --oneline -5\nsecond line that must fold" },
		{ title: "Ctx Execute", variant: "default" },
	);
	assert.match(summary.payload ?? "", /^shell · /);
	assert.doesNotMatch(summary.payload ?? "", /\n/);
	assert.match(summary.payload ?? "", /git log/);
});

test("native nested identity resolves the real tool name (not empty tool)", () => {
	const nested = {
		identity: { toolName: "update_goal", toolCallId: "call_1", cwd: "/tmp" },
		setExpanded() {},
		render() {
			return [];
		},
	};
	assert.equal(getToolName(nested), "update_goal");
	assert.equal(isNativeToolExecutionComponent(nested), true);
	assert.equal(isNativeExplorationGroup(nested), false);
});

test("goal result preserves the native dedicated renderer", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const ui = { theme, requestRender() {} };
		const definition = {
			name: "update_goal",
			renderShell: "default",
			renderCall: (args: any) => new Text(`native call ${args.status}`, 0, 0),
			renderResult: () => new Text("native goal widget ✓ complete", 0, 0),
		} as any;
		const component = new ToolExecutionComponent(
			"update_goal",
			"goal-native-1",
			{ status: "complete" },
			{},
			definition,
			ui as any,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		component.setExpanded(false);
		const output = renderText(component);
		assert.match(output, /Update Goal → complete.*to show more/);
		assert.equal(output.trim().split("\n").length, 1);
		assert.doesNotMatch(output, /native goal widget/);
		assert.doesNotMatch(output, /1 line returned/);
		component.setExpanded(true);
		assert.match(renderText(component), /native goal widget ✓ complete/);
		component.setExpanded(false);
		assert.doesNotMatch(renderText(component), /native goal widget/);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("apply_patch result preserves single native box instead of duplicated bodies", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const ui = { theme, requestRender() {} };
		const definition = {
			name: "apply_patch",
			renderShell: "default",
			renderCall: () => new Text("native call", 0, 0),
			renderResult: () => new Text("Applied patch • Edited 2 files (+2 -2)", 0, 0),
		} as any;
		const component = new ToolExecutionComponent(
			"apply_patch",
			"patch-native-1",
			{ input: SYNTHETIC_PATCH },
			{},
			definition,
			ui as any,
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "text", text: "Applied patch" }],
			isError: false,
			details: { preview: { files: [{ filePath: "src/a.ts" }], added: 2, removed: 2 } },
		} as any);
		component.setExpanded(false);
		const collapsed = renderText(component);
		assert.match(collapsed, /Apply Patch.*to show more/);
		assert.equal(collapsed.trim().split("\n").length, 1);
		assert.doesNotMatch(collapsed, /Applied patch/);
		assert.doesNotMatch(stripAnsi(collapsed), /Begin Patch/);
		component.setExpanded(true);
		const expanded = renderText(component);
		assert.match(expanded, /Applied patch/);
		// Single body: the raw freeform input must not reappear beside the native preview.
		assert.doesNotMatch(expanded, /Begin Patch/);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("apply_patch fallback without native renderer stays compact", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const ui = { theme, requestRender() {} };
		const component = new ToolExecutionComponent(
			"apply_patch",
			"patch-fallback-1",
			{ input: SYNTHETIC_PATCH },
			{},
			{ name: "apply_patch" } as any,
			ui as any,
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "text", text: "Applied patch" }],
			isError: false,
			details: {
				preview: {
					files: [{ filePath: "src/a.ts" }, { filePath: "src/b.ts" }],
					added: 2,
					removed: 2,
				},
			},
		} as any);
		component.setExpanded(false);
		const collapsed = renderText(component);
		assert.match(collapsed, /2 files/);
		assert.equal(collapsed.trim().split("\n").length, 1);
		assert.doesNotMatch(collapsed, /Begin Patch/);
		component.setExpanded(true);
		const expanded = renderText(component);
		assert.doesNotMatch(expanded, /Begin Patch/);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("ctx_execute collapsed stays a line count, not raw code dump", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const ui = { theme, requestRender() {} };
		const component = new ToolExecutionComponent(
			"ctx_execute",
			"ctx-1",
			{ language: "shell", code: "git log --oneline -5" },
			{},
			{ name: "ctx_execute" } as any,
			ui as any,
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "text", text: "a1b2c3 first\ndef456 second" }],
			isError: false,
		});
		component.setExpanded(false);
		const collapsed = renderText(component);
		assert.match(collapsed, /2 lines returned/);
		assert.match(collapsed, /to show more/);
		assert.equal(collapsed.trim().split("\n").length, 1);
		assert.doesNotMatch(collapsed, /a1b2c3|def456/);
		assert.doesNotMatch(collapsed, /git log --oneline -5.*git log --oneline -5/s);
		component.setExpanded(true);
		assert.match(renderText(component), /def456 second/);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

// OMO-shape: nested identity + a renderer child with NO toolDefinition (MCP tool).
// OMO renders such tools through its raw-JSON fallback; ccstyle must attach a
// synthetic definition so the compact card renders instead.
function makeOmoRenderer(identity: any, onFallbackText: (text: string) => void) {
	const kids = () => {
		const container: any = {
			children: [] as any[],
			addChild(c: any) { container.children.push(c); },
			removeChild(c: any) {
				const i = container.children.indexOf(c);
				if (i >= 0) container.children.splice(i, 1);
			},
			detachAll() { container.children = []; },
		};
		return container;
	};
	const fallbackChild: any = { contentText: true };
	const selfRenderContainer: any = kids();
	const contentBox: any = kids();
	const renderer: any = {
		selfRenderContainer,
		contentBox,
		contentText: {
			setCustomBgFn() {},
			setPaddingX() {},
			setText(text: string) { onFallbackText(text); },
		},
		builtInDefinition: undefined,
		identity,
		state: undefined,
		children: [fallbackChild],
		addChild(child: any) { this.children.push(child); },
		removeChild(child: any) {
			const i = this.children.indexOf(child);
			if (i >= 0) this.children.splice(i, 1);
		},
		onToggleExpanded() {},
		get hasRendererDefinition() {
			return this.builtInDefinition !== undefined || this.identity.toolDefinition !== undefined;
		},
		get renderShell() {
			return this.identity.toolDefinition?.renderShell ?? this.builtInDefinition?.renderShell ?? "default";
		},
		getCallRenderer() {
			return this.identity.toolDefinition?.renderCall ?? this.builtInDefinition?.renderCall;
		},
		getResultRenderer() {
			return this.identity.toolDefinition?.renderResult ?? this.builtInDefinition?.renderResult;
		},
		update(state: any) {
			this.state = state;
			if (!this.hasRendererDefinition) {
				this.contentText.setText("RAW_FALLBACK_JSON");
				return;
			}
			const container = this.renderShell === "self" ? this.selfRenderContainer : this.contentBox;
			container.detachAll();
			const callRenderer = this.getCallRenderer();
			if (callRenderer) {
				container.addChild(callRenderer(state.args, theme, { args: state.args, isPartial: state.isPartial, expanded: state.expanded, isError: false, toolCallId: identity.toolCallId }));
			}
			const resultRenderer = this.getResultRenderer();
			if (state.result && resultRenderer) {
				container.addChild(resultRenderer({ content: state.result.content, details: state.result.details }, { isPartial: state.isPartial, expanded: state.expanded }, theme, { args: state.args }));
			}
		},
	};
	return renderer;
}

test("OMO definition-less ctx_execute attaches a synthetic definition and renders a compact card", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		let fallbackText = "";
		const identity = { toolName: "ctx_execute", toolCallId: "ctx-omo-defless", cwd: "/tmp" };
		const renderer = makeOmoRenderer(identity, (text) => { fallbackText += text; });
		const component: any = {
			renderer,
			identity,
			args: { language: "shell", code: "echo hi" },
			expanded: false,
		};
		assert.equal(renderer.hasRendererDefinition, false);
		prepareNativeToolRenderer(component);
		assert.notEqual(renderer.builtInDefinition, undefined);
		assert.equal(renderer.hasRendererDefinition, true);
		assert.equal(renderer.children.length, 1);
		assert.equal(renderer.children[0], renderer.selfRenderContainer);
		renderer.update({
			args: { language: "shell", code: "echo hi" },
			result: { content: [{ type: "text", text: "line one\nline two" }] },
			isPartial: false,
			expanded: false,
		});
		assert.equal(fallbackText, "");
		const lines = renderer.selfRenderContainer.children.flatMap((child: any) => child.render(120));
		assert.equal(lines.length, 1);
		assert.match(lines[0], /Ctx Execute/);
		assert.match(lines[0], /shell · echo hi/);
		assert.match(lines[0], /2 lines returned/);
		assert.match(lines[0], /click to show more/);
		assert.doesNotMatch(lines[0], /RAW_FALLBACK|language.*code/);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("OMO definition-less tool stays on native fallback when mode is off", () => {
	const previousMode = config.mode;
	config.mode = "off";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		let fallbackText = "";
		const identity = { toolName: "ctx_execute", toolCallId: "ctx-omo-off", cwd: "/tmp" };
		const renderer = makeOmoRenderer(identity, (text) => { fallbackText += text; });
		const component: any = { renderer, identity, args: { language: "shell", code: "echo hi" }, expanded: false };
		prepareNativeToolRenderer(component);
		assert.equal(renderer.builtInDefinition, undefined);
		assert.equal(renderer.children.length, 1);
		renderer.update({ args: { language: "shell", code: "echo hi" }, result: { content: [{ type: "text", text: "x" }] }, isPartial: false, expanded: false });
		assert.match(fallbackText, /RAW_FALLBACK/);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});
