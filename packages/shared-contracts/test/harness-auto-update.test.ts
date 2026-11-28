import { describe, expect, it } from "vitest";
import {
  DEFAULT_HARNESS_AUTO_UPDATE_SETTINGS,
  harnessAutoUpdateDue,
  harnessAutoUpdateEligible,
  type HarnessAutoUpdateSettings,
} from "@codexhost/shared-contracts";

const daily: HarnessAutoUpdateSettings = { ...DEFAULT_HARNESS_AUTO_UPDATE_SETTINGS };

describe("Harness auto-update schedule", () => {
  it("runs immediately, then again at the selected local time", () => {
    const now = new Date(2026, 10, 27, 8, 30);
    expect(harnessAutoUpdateDue(daily, null, now)).toBe(true);
    expect(harnessAutoUpdateDue(daily, now.getTime(), new Date(2026, 10, 27, 9, 0))).toBe(true);
    expect(harnessAutoUpdateDue(daily, now.getTime(), new Date(2026, 10, 27, 8, 59))).toBe(false);
    const afterNine = new Date(2026, 10, 27, 9, 0).getTime();
    expect(harnessAutoUpdateDue(daily, afterNine, new Date(2026, 10, 28, 8, 59))).toBe(false);
    expect(harnessAutoUpdateDue(daily, afterNine, new Date(2026, 10, 28, 9, 0))).toBe(true);
  });

  it("stays quiet while automatic updates are off", () => {
    expect(
      harnessAutoUpdateDue({ ...daily, enabled: false }, null, new Date(2026, 10, 27, 9, 0)),
    ).toBe(false);
  });

  it("updates installable CLIs and leaves manual downloads alone", () => {
    const ready = { updateAvailable: true, canUpdate: true };
    expect(harnessAutoUpdateEligible(ready)).toBe(true);
    expect(harnessAutoUpdateEligible({ ...ready, canUpdate: false })).toBe(false);
    expect(
      harnessAutoUpdateEligible({ ...ready, manualUpdateUrl: "https://example.com/app" }),
    ).toBe(false);
    expect(harnessAutoUpdateEligible({ ...ready, updateAvailable: false })).toBe(false);
  });
});
