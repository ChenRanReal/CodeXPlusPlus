import type { RendererSettingsMessages } from "./localization.js";
import { preferenceId } from "./preference-ui.js";

export function confirmHarnessUpdate(
  container: HTMLElement,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
  name: string,
  target: string,
  verified?: string,
): Promise<boolean> {
  const template = verified
    ? messages.harnessUpdateUnverifiedDetail
    : messages.harnessUpdateTargetChangedDetail;
  const detail = template.replace(
    /\{(name|target|verified)\}/gu,
    (_, field: "name" | "target" | "verified") =>
      ({ name, target, verified: verified ?? "" })[field],
  );
  return confirmHarnessAction(container, signal, {
    title: verified
      ? messages.harnessUpdateUnverifiedTitle
      : messages.harnessUpdateTargetChangedTitle,
    detail,
    cancel: messages.harnessUpdateSkip,
    confirm: verified ? messages.harnessUpdateAnyway : messages.harnessVersionUpdate,
  });
}

/** Opens a confirmation dialog that is dismissed when the settings page closes. */
export function confirmHarnessAction(
  container: HTMLElement,
  signal: AbortSignal,
  copy: { title: string; detail: string; cancel: string; confirm: string; destructive?: boolean },
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  const document = container.ownerDocument;
  const dialog = document.createElement("dialog");
  dialog.className = "settings-account-dialog settings-credential-dialog";
  const heading = document.createElement("h2");
  heading.id = preferenceId("harness-confirmation-title");
  heading.textContent = copy.title;
  dialog.setAttribute("aria-labelledby", heading.id);
  const detail = document.createElement("p");
  detail.id = preferenceId("harness-confirmation-detail");
  detail.textContent = copy.detail;
  dialog.setAttribute("aria-describedby", detail.id);
  const actions = document.createElement("div");
  actions.className = "settings-credential-dialog__actions";
  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "settings-command-button settings-command-button--secondary";
  skip.textContent = copy.cancel;
  skip.setAttribute("autofocus", "");
  const update = document.createElement("button");
  update.type = "button";
  update.className = "settings-command-button";
  if (copy.destructive) update.classList.add("settings-harness-uninstall-button");
  update.textContent = copy.confirm;
  actions.append(skip, update);
  dialog.append(heading, detail, actions);

  return new Promise((resolve) => {
    let confirmed = false;
    const abort = (): void => dialog.close();
    skip.addEventListener("click", () => dialog.close());
    update.addEventListener("click", () => {
      confirmed = true;
      dialog.close();
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation?.();
      dialog.close();
    });
    dialog.addEventListener(
      "close",
      () => {
        signal.removeEventListener("abort", abort);
        dialog.remove();
        resolve(confirmed && !signal.aborted);
      },
      { once: true },
    );
    signal.addEventListener("abort", abort, { once: true });
    container.append(dialog);
    dialog.showModal();
  });
}
