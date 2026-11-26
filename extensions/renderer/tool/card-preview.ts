import { ThinkingPreviewBlock } from "../../feature/compact-thinking.ts";
import { getCompactRoundPreview, isCompactAssistantComponent } from "../compact-mode.ts";
import { isToolExecutionComponent } from "../mouse/packets.ts";
import { ToolGroupComponent } from "./grouping.ts";
import { messageDisplayPreview } from "./message-display.ts";
import { nativeExplorationTools } from "./native-identity.ts";
import { toolPreviewBody, toolPreviewGroup, toolPreviewTitle } from "./preview.ts";
import { subagentNotificationPreview } from "./subagent-notification.ts";

export type CardPreview = {
	readonly title: string;
	readonly body: () => string;
	readonly literal: boolean;
};

/** Native handoffs already have a semantic expanded projection. Use it on the clone only. */
export function handoffPreviews(view: object): readonly (CardPreview & { readonly id: string })[] {
	const expand: unknown = Reflect.get(view, "setExpanded");
	const descriptors: unknown = Reflect.get(view, "renderDescriptors");
	if (typeof expand !== "function" || !Array.isArray(descriptors)) return [];
	return descriptors.flatMap((descriptor) => {
		const block: unknown = descriptor?.handoffBlock;
		if (descriptor?.kind !== "handoff-line" || typeof block !== "number") return [];
		return [
			{
				id: `handoff:${block}`,
				title: "Handoff",
				literal: true,
				body() {
					const expanded = Reflect.get(view, "expanded") === true;
					try {
						expand.call(view, true);
						const parts: unknown = Reflect.get(view, "renderDescriptors");
						const text: unknown = Array.isArray(parts)
							? parts.find((part) => part?.kind === "handoff-body" && part.handoffBlock === block)
									?.text
							: undefined;
						return typeof text === "string" ? text : "";
					} finally {
						expand.call(view, expanded);
					}
				},
			},
		];
	});
}

export function formatRoundPreviewBody(preview: {
	readonly thinking: readonly string[];
	readonly prose: readonly string[];
	readonly tools: readonly unknown[];
}): string {
	const sections: string[] = [];
	const prose = (preview.prose ?? []).filter((text) => text.trim());
	const thinking = (preview.thinking ?? []).filter((text) => text.trim());
	if (prose.length > 0) sections.push(`Response\n\n${prose.join("\n\n")}`);
	if (thinking.length > 0) sections.push(`Thinking\n\n${thinking.join("\n\n")}`);
	const tools = toolPreviewGroup(preview.tools ?? []);
	if (tools) sections.push(`Tools\n\n${tools}`);
	return sections.join("\n\n───\n\n");
}

/** Build the same detail content for both the mouse popup and the owned transcript detail. */
export function cardPreview(component: unknown): CardPreview | undefined {
	const tools =
		component instanceof ToolGroupComponent
			? component.children
			: nativeExplorationTools(component);
	if (tools) {
		return {
			title: "Multiple Tools",
			body: () => toolPreviewGroup(tools),
			literal: true,
		};
	}
	if (isToolExecutionComponent(component)) {
		return {
			title: toolPreviewTitle(component),
			body: () => toolPreviewBody(component),
			literal: true,
		};
	}
	if (isCompactAssistantComponent(component)) {
		const round = getCompactRoundPreview(component);
		if (!round) return undefined;
		return { title: "Turn details", body: () => formatRoundPreviewBody(round), literal: true };
	}
	if (component instanceof ThinkingPreviewBlock) {
		return { title: "Thinking", body: () => component.getPreviewText(), literal: true };
	}
	const message = messageDisplayPreview(component);
	if (message) return { title: message.title, body: () => message.body, literal: false };
	const notification = subagentNotificationPreview(component);
	if (notification === undefined) return undefined;
	return { title: "Subagent details", body: () => notification, literal: true };
}
