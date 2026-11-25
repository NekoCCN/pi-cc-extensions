/**
 * 终答结算（只标记、不改组件）：message_end 暂存候选签名，agent_end 用结算
 * 消息表确认后，把命中的流式组件记入 framed 集合，渲染层凭集合罩框。
 * 全程不调 updateContent：不碰原生流式态、不重建 thinking 子树；暂存签名与
 * 扩展/原生订阅顺序无关，确认发生在更晚的 agent_end。确认只认交集
 * （候选 ∩ 结算）或结算真相本身；结算表为空则无证明，不标记。
 */

import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent";
import { walkComponentTree } from "../utils/component-tree.ts";

export type AssistantMessageShape = {
	role?: string;
	stopReason?: string | null;
	errorMessage?: string | null;
	content?: readonly { type?: string; text?: string }[] | null;
};

type StreamingComponent = {
	lastMessage?: AssistantMessageShape;
	isStreaming?: boolean;
};

export type FinalityStore = {
	/** message_end 暂存候选签名。eligible 才收，返回是否收下。 */
	stage(message: unknown): boolean;
	/** agent_end 结算：标记命中的流式组件。返回标记数。 */
	confirm(root: unknown, agentMessages: unknown): number;
	/** 组件是否被结算标记（渲染层罩框的 live 依据）。 */
	isFramed(component: unknown): boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 纯内容判定：最终成功态的纯文本回答。不含流式态，由调用方另行判断。
 * thinking-only（无 text）、toolCall、aborted/error、空消息一律 false。
 * 跨事件的身份（message_end 事件对象、agent_end 消息表、组件 lastMessage
 * 未必同一引用）用下面的 finalSignature 匹配。
 */
export function isFinalResponseContent(message: unknown): boolean {
	if (!isRecord(message)) return false;
	if (message.stopReason !== "stop") return false;
	if (typeof message.errorMessage === "string" && message.errorMessage !== "") return false;
	const content = message.content;
	if (!Array.isArray(content) || content.length === 0) return false;
	let sawText = false;
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "toolCall") return false;
		if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
			sawText = true;
		}
	}
	return sawText;
}

/** stopReason + 文本块签名：head 切片在纯文本时与原消息恒等，其余场景回退到签名。 */
export function finalSignature(message: AssistantMessageShape): string {
	const texts: string[] = [];
	const blocks = Array.isArray(message.content) ? message.content : [];
	for (const block of blocks) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		texts.push(block.text);
	}
	return `${message.stopReason ?? ""}\n${texts.join("\n")}`;
}

function asStreamingComponent(value: unknown): StreamingComponent | undefined {
	if (value instanceof AssistantMessageComponent) return value as unknown as StreamingComponent;
	return undefined;
}

export function createFinalResponseFinality(): FinalityStore {
	/** message_end 暂存的终答签名：agent_end 结算确认后清空。 */
	const staged = new Set<string>();
	/** 结算命中的 live 组件：只增不改，渲染层凭此罩框（GC 随组件走）。 */
	const framed = new WeakSet<object>();
	return {
		stage(message) {
			if (!isFinalResponseContent(message)) return false;
			staged.add(finalSignature(message as AssistantMessageShape));
			return true;
		},
		confirm(root, agentMessages) {
			const settled = new Set<string>();
			if (Array.isArray(agentMessages)) {
				for (const item of agentMessages) {
					if (!isRecord(item) || item.role !== "assistant") continue;
					if (!isFinalResponseContent(item)) continue;
					settled.add(finalSignature(item as AssistantMessageShape));
				}
			}
			// 交集优先（迟到增量扩展了消息时，旧候选自动失效）；无交集信结算真相；
			// 结算表为空则无证明，不翻转。
			const hit = [...staged].filter((signature) => settled.has(signature));
			const wanted = hit.length > 0 ? new Set(hit) : settled;
			staged.clear();
			if (wanted.size === 0) return 0;
			let marked = 0;
			walkComponentTree(root, (value) => {
				const component = asStreamingComponent(value);
				if (!component || component.isStreaming !== true) return;
				const last = component.lastMessage;
				if (!isFinalResponseContent(last)) return;
				if (!wanted.has(finalSignature(last as AssistantMessageShape))) return;
				framed.add(component);
				marked++;
			});
			return marked;
		},
		isFramed(component) {
			return isRecord(component) && framed.has(component);
		},
	};
}
