import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeHarnessAdapter } from "@codexhost/harness-adapter/testing";
import { harnessIdSchema, type HarnessInstallationState } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HarnessAutoUpdate } from "../src/harness-auto-update.js";
import { HarnessInstallationTasks } from "../src/harness-installation-tasks.js";

function version(patch: Partial<HarnessInstallationState> = {}): HarnessInstallationState {
  return {
    currentVersion: "1.0.0",
    latestVersion: "1.1.0",
    updateAvailable: true,
    canUpdate: true,
    ...patch,
  };
}

describe("Host Harness auto-update", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("installs every updatable CLI once a day and reports the result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-auto-update-"));
    directories.push(directory);
    const installation = (id: string, state: HarnessInstallationState) =>
      vi.fn(async (action: string) =>
        id === "pi" && action === "update"
          ? version({ currentVersion: "1.1.0", updateAvailable: false })
          : state,
      );
    const pi = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("pi")), {
      installation: installation("pi", version()),
    });
    const claude = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("claude-code")), {
      installation: installation("claude-code", version({ latestVerifiedVersion: "1.0.0" })),
    });
    const grok = Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse("grok")), {
      installation: installation("grok", version({ canUpdate: false })),
    });
    const manual = Object.assign(
      new FakeHarnessAdapter(harnessIdSchema.parse("deepseek-harness")),
      {
        installation: installation(
          "deepseek-harness",
          version({ manualUpdateUrl: "https://example.com/app" }),
        ),
      },
    );
    const adapters = new Map<string, typeof pi>([
      ["deepseek-harness", manual],
      ["claude-code", claude],
      ["grok", grok],
      ["pi", pi],
    ]);
    let now = new Date(2026, 10, 27, 8, 0).getTime();
    const notify = vi.fn();
    const updater = new HarnessAutoUpdate({
      directory,
      adapters: () => adapters,
      waitForPlugins: async () => undefined,
      tasks: new HarnessInstallationTasks(),
      label: (id) => id,
      notify,
      diagnose: () => undefined,
      now: () => new Date(now),
    });
    await updater.start();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ updated: ["claude-code", "pi"], failed: [] });
    expect(pi.installation).toHaveBeenCalledWith("update", "1.1.0");
    expect(claude.installation).toHaveBeenCalledWith("update", "1.1.0");
    expect(grok.installation).not.toHaveBeenCalledWith("update", "1.1.0");
    expect(manual.installation).not.toHaveBeenCalledWith("update", "1.1.0");
    await updater.start();
    expect(notify).toHaveBeenCalledTimes(1);
    now = new Date(2026, 10, 28, 9, 0).getTime();
    await updater.start();
    expect(notify).toHaveBeenCalledTimes(2);
    updater.stop();
  });

  it("updates one Harness at a time", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-auto-update-serial-"));
    directories.push(directory);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const make = (id: "grok" | "pi") =>
      Object.assign(new FakeHarnessAdapter(harnessIdSchema.parse(id)), {
        installation: vi.fn(async (action: string) => {
          if (action === "update") {
            started.push(id);
            if (id === "grok") await gate;
          }
          return version(
            action === "update" ? { currentVersion: "1.1.0", updateAvailable: false } : {},
          );
        }),
      });
    const updater = new HarnessAutoUpdate({
      directory,
      adapters: () =>
        new Map([
          ["pi", make("pi")],
          ["grok", make("grok")],
        ]),
      waitForPlugins: async () => undefined,
      tasks: new HarnessInstallationTasks(),
      label: (id) => id,
      notify: () => undefined,
      diagnose: () => undefined,
      now: () => new Date(2026, 10, 27, 8, 0),
    });
    const running = updater.start();
    await vi.waitFor(() => expect(started).toEqual(["grok"]));
    release();
    await running;
    expect(started).toEqual(["grok", "pi"]);
    updater.stop();
  });
});
