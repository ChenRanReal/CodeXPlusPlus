import { describe, expect, it } from "vitest";
import { formatHarnessAutoUpdateNotice } from "../src/renderer-auto-update-notice.js";

describe("Harness auto-update notice", () => {
  it("says what finished and stays quiet when nothing changed", () => {
    expect(formatHarnessAutoUpdateNotice({ updated: [], failed: [] }, true)).toBeNull();
    expect(formatHarnessAutoUpdateNotice({ updated: ["Pi", "Grok"], failed: [] }, true)).toBe(
      "已更新 Pi、Grok",
    );
    expect(formatHarnessAutoUpdateNotice({ updated: ["Pi"], failed: ["Grok"] }, true)).toBe(
      "已更新 Pi。Grok 更新失败。",
    );
    expect(formatHarnessAutoUpdateNotice({ updated: [], failed: ["Grok"] }, false)).toBe(
      "Grok failed to update",
    );
  });
});
