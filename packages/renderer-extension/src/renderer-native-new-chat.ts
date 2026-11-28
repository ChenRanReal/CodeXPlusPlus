import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Codex's project new-chat button carries `onStartChat` on its component fiber. */
export function nativeNewChatButton(root: ParentNode): HTMLButtonElement | null {
  for (const button of root.querySelectorAll("button")) {
    if (button.tagName !== "BUTTON") continue;
    const fiberKey = Object.getOwnPropertyNames(button).find((key) =>
      key.startsWith("__reactFiber$"),
    );
    if (!fiberKey) continue;
    const ancestors = committedReactAncestors(
      Object.getOwnPropertyDescriptor(button, fiberKey)?.value,
    );
    const matched = ancestors.slice(0, 8).some((owner) => {
      const props = record(owner.memoizedProps);
      return typeof props?.onStartChat === "function";
    });
    if (matched) return button as HTMLButtonElement;
  }
  return null;
}

export function clickNativeNewChat(root: ParentNode): boolean {
  const button = nativeNewChatButton(root);
  if (!button) return false;
  button.click();
  return true;
}
