/**
 * OmO Native 5.1.81 tool identity compatibility.
 *
 * Pi exposes flat fields on the card (`toolName`, `toolCallId`, `toolDefinition`).
 * Native `ToolExecutionComponent` nests them under `identity` and exposes a
 * read-only `presentationSnapshot` (`{ identity, state, presentation }`).
 * Native transcript grouping uses `ExplorationGroup` (non-owning view over the
 * original cards, see `exploration-group.js`); ccstyle must preserve it and must
 * not wrap its members a second time.
 */

export type NativeToolIdentity = {
	toolName?: unknown;
	toolCallId?: unknown;
	toolDefinition?: unknown;
	cwd?: unknown;
};

function isObject(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null;
}

/** Nested native identity (`component.identity`), if present. */
export function nativeIdentityOf(component: any): NativeToolIdentity | undefined {
	const identity = component?.identity;
	if (!isObject(identity)) return undefined;
	if (typeof identity.toolName !== "string" || typeof identity.toolCallId !== "string") {
		return undefined;
	}
	return identity as NativeToolIdentity;
}

/** `presentationSnapshot.identity` mirrors `component.identity` on native cards. */
export function presentationIdentityOf(component: any): NativeToolIdentity | undefined {
	const snapshot = component?.presentationSnapshot;
	if (!isObject(snapshot)) return undefined;
	const identity = (snapshot as any).identity;
	if (!isObject(identity)) return undefined;
	if (typeof identity.toolName !== "string" || typeof identity.toolCallId !== "string") {
		return undefined;
	}
	return identity as NativeToolIdentity;
}

/** True for OmO native tool cards (nested identity, no Pi flat fields). */
export function isNativeToolExecutionComponent(component: any): boolean {
	if (!isObject(component)) return false;
	if (typeof (component as any).setExpanded !== "function") return false;
	if (typeof (component as any).render !== "function") return false;
	// Pi cards already carry flat fields; native cards do not.
	if (typeof (component as any).toolCallId === "string") return false;
	if (typeof (component as any).toolName === "string") return false;
	return (
		nativeIdentityOf(component) !== undefined || presentationIdentityOf(component) !== undefined
	);
}

/** Tool name for Pi flat cards and native identity cards. */
export function getToolName(tool: any): string {
	if (typeof tool?.toolName === "string" && tool.toolName) return tool.toolName;
	const nested = nativeIdentityOf(tool) ?? presentationIdentityOf(tool);
	if (typeof nested?.toolName === "string" && nested.toolName) return nested.toolName;
	const definitionName = tool?.toolDefinition?.name ?? tool?.toolDefinition?.toolName;
	if (typeof definitionName === "string" && definitionName) return definitionName;
	const snapshotDefinitionName =
		(tool as any)?.presentationSnapshot?.identity?.toolDefinition?.name ??
		(tool as any)?.presentationSnapshot?.identity?.toolDefinition?.toolName;
	if (typeof snapshotDefinitionName === "string" && snapshotDefinitionName) {
		return snapshotDefinitionName;
	}
	return "tool";
}

/** Tool call id for Pi flat cards and native identity cards. */
export function getToolCallId(tool: any): string | undefined {
	if (typeof tool?.toolCallId === "string" && tool.toolCallId) return tool.toolCallId;
	const nested = nativeIdentityOf(tool) ?? presentationIdentityOf(tool);
	if (typeof nested?.toolCallId === "string" && nested.toolCallId) return nested.toolCallId;
	return undefined;
}

export function getToolResultView(tool: any): any {
	return tool?.resultRendererComponent ?? tool?.renderer?.resultRendererComponent;
}

export function getLiveToolResult(tool: any): any {
	const state = tool?.presentationSnapshot?.state;
	return (tool?.isPartial ?? state?.isPartial) === true
		? (tool?.result ?? state?.result)
		: undefined;
}

/** Tool definition for Pi flat cards and native identity cards. */
export function getToolDefinition(tool: any): any {
	if (tool?.toolDefinition !== undefined) return tool.toolDefinition;
	const nested = nativeIdentityOf(tool) ?? presentationIdentityOf(tool);
	if (nested?.toolDefinition !== undefined) return nested.toolDefinition;
	return (tool as any)?.presentationSnapshot?.identity?.toolDefinition;
}

/** Unified Pi + native tool-card check (flat fields or nested identity). */
export function isUnifiedToolExecutionComponent(component: any): boolean {
	if (!isObject(component)) return false;
	if (typeof (component as any).setExpanded !== "function") return false;
	if (typeof (component as any).render !== "function") return false;
	if (typeof (component as any).toolCallId === "string") return true;
	return isNativeToolExecutionComponent(component);
}

/**
 * Native `ExplorationGroup`: non-owning Codex-style view (`calls`, `rules`,
 * `bodyKey`, `memberSnapshot`, `setMembers`). The transcript still owns the
 * cards, so ccstyle must treat it as a boundary: never wrap it, never regroup
 * its members, and let its own `handleMouse` own clicks.
 */
export function isNativeExplorationGroup(component: any): boolean {
	if (!isObject(component)) return false;
	if (!Array.isArray((component as any).calls)) return false;
	if (typeof (component as any).setMembers !== "function") return false;
	return (
		Array.isArray((component as any).rules) ||
		Array.isArray((component as any).memberSnapshot) ||
		typeof (component as any).bodyKey === "string"
	);
}

/** Expanded flag shared by Pi (`expanded`) and native (`expanded` + snapshot state). */
export function isToolExpanded(component: any): boolean {
	if ((component as any)?.expanded === true) return true;
	return (component as any)?.presentationSnapshot?.state?.expanded === true;
}
