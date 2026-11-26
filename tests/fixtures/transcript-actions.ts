import type { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { createClipboardWriter } from "../../extensions/renderer/clipboard-actions.ts";
import {
	collectTranscriptItems,
	type TranscriptCopyPolicy,
	TranscriptView,
} from "../../extensions/renderer/transcript-mode.ts";

export function updateReply(reply: AssistantMessageComponent, text: string, streaming = false) {
	const message = {
		role: "assistant",
		timestamp: 1,
		content: [{ type: "text", text }],
		stopReason: "stop",
	};
	// The rendering fixture does not need provider metadata.
	Reflect.apply(reply.updateContent, reply, [message, streaming]);
	return message;
}

export function transcript(chat: Container, rows = 8, policy: TranscriptCopyPolicy = {}) {
	const copies: string[] = [];
	const notices: string[] = [];
	const copy = createClipboardWriter(
		{
			async copy(text) {
				copies.push(text);
			},
			notify(message) {
				notices.push(message);
			},
		},
		() => true,
	);
	let closed = false;
	const view = new TranscriptView({
		rows: () => rows,
		items: () => collectTranscriptItems(chat, policy),
		theme: undefined,
		close: () => {
			closed = true;
		},
		focused: () => true,
		copy,
	});
	return {
		view,
		copies,
		notices,
		closed: () => closed,
		render: (width = 72) => view.render(width).map(stripTerminalSequences),
	};
}
