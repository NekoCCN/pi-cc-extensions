import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { AssistantMessageShape } from "./final-response-frame-finality.ts";

export type ClipboardWriter = {
	readonly write: (text: string, name: string, errorLabel: string) => void;
};

export function responseCopyText(message: AssistantMessageShape): string {
	return (message.content ?? [])
		.flatMap((block) =>
			block.type === "text" && typeof block.text === "string"
				? [stripTerminalSequences(block.text)]
				: [],
		)
		.join("\n\n");
}

export function createClipboardWriter(
	io: {
		readonly copy: (text: string) => Promise<void>;
		readonly notify: (message: string, isError: boolean) => void;
	},
	active: () => boolean,
): ClipboardWriter {
	return {
		write(text, name, errorLabel) {
			if (!active()) return;
			void Promise.resolve()
				.then(() => io.copy(text))
				.then(
					() => {
						if (active()) io.notify(`Copied ${name}`, false);
					},
					(error) => {
						if (active())
							io.notify(
								`${errorLabel} copy failed: ${error instanceof Error ? error.message : String(error)}`,
								true,
							);
					},
				);
		},
	};
}
