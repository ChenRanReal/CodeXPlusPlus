import {
  HARNESS_AUTO_UPDATE_COMPLETED_METHOD,
  harnessAutoUpdateCompletedSchema,
  type HarnessAutoUpdateCompleted,
} from "@codexhost/shared-contracts";
import type { RendererMessageTarget } from "./renderer-manual-compaction.js";

const STYLE_ID = "codexhost-auto-update-notice-style";
const NOTICE_ID = "codexhost-auto-update-notice";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function chinese(document: Document): boolean {
  const language = `${document.documentElement.lang} ${globalThis.navigator?.language ?? ""}`;
  return language.toLowerCase().includes("zh");
}

export function formatHarnessAutoUpdateNotice(
  result: HarnessAutoUpdateCompleted,
  useChinese: boolean,
): string | null {
  if (!result.updated.length && !result.failed.length) return null;
  const join = (names: readonly string[]) => names.join(useChinese ? "、" : ", ");
  const updated = join(result.updated);
  const failed = join(result.failed);
  if (updated && failed) {
    return useChinese
      ? `已更新 ${updated}。${failed} 更新失败。`
      : `Updated ${updated}. ${failed} failed.`;
  }
  if (updated) return useChinese ? `已更新 ${updated}` : `Updated ${updated}`;
  return useChinese ? `${failed} 更新失败` : `${failed} failed to update`;
}

function ensureStyle(document: Document): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    #${NOTICE_ID} {
      position: fixed;
      z-index: 10000;
      top: 12px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: min(560px, calc(100vw - 24px));
      margin: 0;
      padding: 10px 12px;
      color: #f5f5f5;
      font: 13px/18px sans-serif;
      background: #2a2a2a;
      border: 1px solid rgb(255 255 255 / 12%);
      border-radius: 10px;
      box-shadow: 0 10px 30px rgb(0 0 0 / 28%);
    }
    #${NOTICE_ID} button {
      flex: none;
      padding: 0;
      color: inherit;
      font: inherit;
      background: transparent;
      border: 0;
      cursor: pointer;
    }
  `;
  document.head.append(style);
}

function show(document: Document, body: string): void {
  ensureStyle(document);
  document.getElementById(NOTICE_ID)?.remove();
  const notice = document.createElement("div");
  notice.id = NOTICE_ID;
  notice.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = body;
  const close = document.createElement("button");
  close.type = "button";
  close.setAttribute("aria-label", chinese(document) ? "关闭" : "Dismiss");
  close.textContent = "×";
  const remove = (): void => notice.remove();
  close.addEventListener("click", remove);
  notice.append(text, close);
  document.body.append(notice);
  document.defaultView?.setTimeout(remove, 15_000);
  const title = chinese(document) ? "Harness 更新" : "Harness updates";
  const notifier = globalThis.Notification;
  if (typeof notifier === "function" && notifier.permission !== "denied") {
    try {
      new notifier(title, { body });
    } catch {
      /* The in-app notice is already visible. */
    }
  }
}

/** Desktop drops codexhost notifications from its own table; the window still receives them. */
export function installHarnessAutoUpdateNotice(
  hostId: string,
  messages: RendererMessageTarget | null,
): (() => void) | null {
  if (hostId !== "local" || !messages) return null;
  const document = globalThis.document;
  if (!document?.body) return null;
  const listener = (event: { data?: unknown; source?: unknown }): void => {
    if (event.source != null && event.source !== messages) return;
    const message = event.data;
    if (
      !isRecord(message) ||
      message.type !== "mcp-notification" ||
      message.hostId !== hostId ||
      message.method !== HARNESS_AUTO_UPDATE_COMPLETED_METHOD
    )
      return;
    const parsed = harnessAutoUpdateCompletedSchema.safeParse(message.params);
    if (!parsed.success) return;
    const body = formatHarnessAutoUpdateNotice(parsed.data, chinese(document));
    if (body) show(document, body);
  };
  messages.addEventListener("message", listener);
  return () => messages.removeEventListener("message", listener);
}
