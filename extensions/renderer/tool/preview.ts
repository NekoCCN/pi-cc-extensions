import { sanitizeToolResultText } from "../../utils/tool-result-sanitize.ts";
import {
	getToolDefinition,
	getToolName,
	isUnifiedToolExecutionComponent,
} from "./native-identity.ts";
import { humanizeToolLabel } from "./names.ts";
import { rawTextFromResult, textFromResult } from "./result.ts";
import { subagentNotificationPreview } from "./subagent-notification.ts";
import { formatToolInputBody } from "./tool-io.ts";

export function toolPreviewTitle(tool: any): string {
	const name = getToolName(tool);
	const label = getToolDefinition(tool)?.label;
	return typeof label === "string" && label !== name ? label : humanizeToolLabel(name);
}

export function toolPreviewBody(tool: any): string {
	const state = tool?.presentationSnapshot?.state;
	const result = tool?.result ?? state?.result;
	const args = tool?.args ?? state?.args;
	const name = getToolName(tool);
	const output =
		sanitizeToolResultText(rawTextFromResult(result)) ||
		textFromResult(result) ||
		(result ? "(no text output)" : "(no result yet)");
	// The patch result already presents the diff; don't display the same patch as Input.
	const input = name === "apply_patch" && result ? "" : formatToolInputBody(args).text;
	return [input && `Input\n${input}`, `Output\n${output}`].filter(Boolean).join("\n\n");
}

export function toolPreviewGroup(tools: readonly any[]): string {
	return tools
		.map((tool) =>
			isUnifiedToolExecutionComponent(tool)
				? `${toolPreviewTitle(tool)}\n\n${toolPreviewBody(tool)}`
				: subagentNotificationPreview(tool),
		)
		.filter(Boolean)
		.join("\n\n───\n\n");
}
