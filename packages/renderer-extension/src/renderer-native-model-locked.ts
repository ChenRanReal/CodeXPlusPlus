import { committedReactAncestors } from "@codexhost/desktop-control/renderer-bindings";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Codex keeps the Model chip visible for a label it cannot put in its own
 * catalog, with `disabledAppearance: "unchanged"` and no menu. That chip is
 * the external Harness model, and it must be hidden so the Host picker can
 * change the model after the Thread exists.
 */
export function isNativeModelLockedAppearanceButton(button: Element): boolean {
  if (
    !("disabled" in button) ||
    button.disabled !== true ||
    button.getAttribute("data-composer-navigation-target") !== "reasoning" ||
    button.hasAttribute("aria-haspopup") ||
    button.hasAttribute("data-codexhost-model-control")
  ) {
    return false;
  }
  const fiberKey = Object.getOwnPropertyNames(button).find((key) =>
    key.startsWith("__reactFiber$"),
  );
  if (!fiberKey) return false;
  const ancestors = committedReactAncestors(
    Object.getOwnPropertyDescriptor(button, fiberKey)?.value,
  );
  return ancestors.slice(0, 8).some((owner) => {
    const props = record(owner.memoizedProps);
    return (
      props?.disabledAppearance === "unchanged" &&
      props["data-composer-navigation-target"] === "reasoning"
    );
  });
}
