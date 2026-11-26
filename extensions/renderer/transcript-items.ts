import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { config } from "../config/config.ts";
import { walkComponentTree } from "../utils/component-tree.ts";
import { type ClipboardWriter, responseCopyText } from "./clipboard-actions.ts";
import { isCompactAssistantComponent, isCompactRoundTail } from "./compact-mode.ts";
import { isResponseCopyReady } from "./final-response-frame.ts";
import { cardPreview, type CardPreview, handoffPreviews } from "./tool/card-preview.ts";
import { ToolGroupComponent } from "./tool/grouping.ts";
import {
	getToolCallId,
	getToolDefinition,
	getToolName,
	nativeExplorationTools,
} from "./tool/native-identity.ts";
import { assistantMarkdownActions } from "./transcript-markdown.ts";
import { markTranscriptComponent, withTranscriptScope } from "./transcript-scope.ts";

export type TranscriptAction = {
	readonly id: string;
	readonly label: string;
	readonly activate: () => CardPreview | undefined;
};

export type TranscriptCopyPolicy = {
	readonly tablesEnabled?: boolean;
	readonly canCopyResponse?: (component: AssistantMessageComponent) => boolean;
};

export type TranscriptItem = {
	readonly view: Pick<Component, "render">;
	readonly prompt: boolean;
	readonly actions?: (
		width: number,
		copy: ClipboardWriter | undefined,
	) => readonly TranscriptAction[];
	readonly identity?: object | string;
};

type CloneEntry = { readonly view: Component; readonly signature: readonly unknown[] };
const clones = new WeakMap<object, CloneEntry>();

function reuseOrClone(
	live: object,
	signature: readonly unknown[],
	build: () => Component,
): Component {
	const cached = clones.get(live);
	if (
		cached &&
		cached.signature.length === signature.length &&
		signature.every((value, index) => value === cached.signature[index])
	)
		return cached.view;
	const view = withTranscriptScope(build);
	markTranscriptComponent(view);
	clones.set(live, { view, signature });
	return view;
}

function cloneTool(live: ToolExecutionComponent): Component {
	// Native keeps tool fields in identity/presentation state; Pi exposes them directly.
	const snapshot = Reflect.get(live, "presentationSnapshot");
	const { state, identity } = snapshot ?? {};
	const args = Reflect.get(live, "args") ?? state?.args;
	const result = Reflect.get(live, "result") ?? state?.result;
	const isPartial = Reflect.get(live, "isPartial") ?? state?.isPartial;
	const started = Reflect.get(live, "executionStarted") ?? state?.executionStarted;
	const argsComplete = Reflect.get(live, "argsComplete") ?? state?.argsComplete;
	const id = getToolCallId(live);
	if (!id) return live;
	return reuseOrClone(live, [args, result, isPartial, started, argsComplete], () => {
		const view = new ToolExecutionComponent(
			getToolName(live),
			id,
			args,
			{
				showImages: Reflect.get(live, "showImages"),
				imageWidthCells: Reflect.get(live, "imageWidthCells"),
				outputPad: Reflect.get(live, "outputPad"),
			},
			getToolDefinition(live),
			Reflect.get(live, "ui"),
			Reflect.get(live, "cwd") ?? identity?.cwd,
		);
		if (argsComplete) view.setArgsComplete();
		if (started) view.markExecutionStarted();
		if (result) view.updateResult(result, isPartial === true);
		view.setExpanded(true);
		return view;
	});
}

function assistantItem(
	live: AssistantMessageComponent,
	policy: TranscriptCopyPolicy,
): TranscriptItem | undefined {
	const message: Parameters<AssistantMessageComponent["updateContent"]>[0] | undefined =
		Reflect.get(live, "lastMessage");
	if (!message) return undefined;
	const messageId: unknown = Reflect.get(live, "messageId");
	const streaming = Reflect.get(live, "isStreaming") === true;
	// Some host updates reuse the message object while appending to its text blocks.
	const content = message.content.flatMap((block) => {
		switch (block.type) {
			case "text":
				return [block.type, block.text];
			case "thinking":
				return [block.type, block.thinking];
			case "toolCall":
				return [block.type, block.id];
			default: {
				const exhaustive: never = block;
				return exhaustive;
			}
		}
	});
	const signature = [message, streaming, message.stopReason, message.errorMessage, ...content];
	const view = reuseOrClone(live, signature, () => {
		const clone = new AssistantMessageComponent(
			undefined,
			false,
			Reflect.get(live, "markdownTheme"),
			Reflect.get(live, "hiddenThinkingLabel"),
			Reflect.get(live, "outputPad"),
			Reflect.get(live, "markdownTransformers"),
			Reflect.get(live, "messageId"),
			Reflect.get(live, "timestamp"),
		);
		clone.updateContent(message, streaming);
		return clone;
	});
	return {
		view,
		prompt: false,
		identity: typeof messageId === "string" && messageId ? `assistant:${messageId}` : live,
		actions(width, copy) {
			const actions: TranscriptAction[] = [];
			if (copy && (policy.canCopyResponse ?? isResponseCopyReady)(live)) {
				actions.push({
					id: "response",
					label: "Copy response",
					activate() {
						copy.write(responseCopyText(message), "response", "Response");
						return undefined;
					},
				});
			}
			// Only the round anchor offers this action, and materializing the preview
			// scans the current round state only when the user actually opens it.
			if (isCompactAssistantComponent(live) && Reflect.get(live, "roundAnchor") === live) {
				actions.push({
					id: "detail",
					label: "Detail: Turn details",
					activate: () => cardPreview(live),
				});
			}
			for (const preview of handoffPreviews(view)) {
				actions.push({ id: preview.id, label: "Detail: Handoff", activate: () => preview });
			}
			if (copy)
				actions.push(
					...assistantMarkdownActions(view, width, {
						writer: copy,
						tablesEnabled: policy.tablesEnabled ?? config.enableTableCopy,
					}),
				);
			return actions;
		},
	};
}

function detailActions(component: unknown): TranscriptAction[] {
	const preview = cardPreview(component);
	return preview
		? [{ id: "detail", label: `Detail: ${preview.title}`, activate: () => preview }]
		: [];
}

/** Pi's chatContainer directly owns assistant or user messages. */
export function findChatContainer(root: unknown): object | undefined {
	let found: object | undefined;
	walkComponentTree(root, (value) => {
		if (found) return false;
		const children: unknown = Reflect.get(value, "children");
		if (
			Array.isArray(children) &&
			children.some(
				(child) =>
					child instanceof AssistantMessageComponent || child instanceof UserMessageComponent,
			)
		) {
			found = value;
			return false;
		}
		return undefined;
	});
	return found;
}

/** Keep the expanded duplicate rendering; actions refer back to stable live owners. */
export function collectTranscriptItems(
	container: object | undefined,
	policy: TranscriptCopyPolicy = {},
): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	const children: unknown = container && Reflect.get(container, "children");
	const pushTool = (tool: unknown) => {
		if (tool instanceof ToolExecutionComponent) {
			const id = getToolCallId(tool);
			items.push({
				view: cloneTool(tool),
				prompt: false,
				identity: id ? `tool:${id}` : tool,
				actions: () => detailActions(tool),
			});
		}
	};
	for (const child of Array.isArray(children) ? children : []) {
		if (isCompactRoundTail(child)) continue;
		const nativeTools = nativeExplorationTools(child);
		if (child instanceof ToolGroupComponent) {
			items.push({
				view: { render: () => [] },
				prompt: false,
				identity: child,
				actions: () => detailActions(child),
			});
			for (const tool of child.children) pushTool(tool);
		} else if (nativeTools && typeof child.render === "function") {
			const firstId = getToolCallId(nativeTools[0]);
			items.push({
				view: child,
				prompt: false,
				identity: firstId ? `exploration:${firstId}` : child,
				actions: () => [
					...detailActions(child),
					...nativeTools.flatMap((tool) => {
						const id = getToolCallId(tool);
						return id ? detailActions(tool).map((detail) => ({ ...detail, id })) : [];
					}),
				],
			});
		} else if (child instanceof ToolExecutionComponent) {
			pushTool(child);
		} else if (child instanceof AssistantMessageComponent) {
			const item = assistantItem(child, policy);
			if (item) items.push(item);
		} else if (child && typeof child.render === "function") {
			items.push({
				view: child,
				prompt: child instanceof UserMessageComponent,
				identity: child,
				actions: () => detailActions(child),
			});
		}
	}
	return items;
}
