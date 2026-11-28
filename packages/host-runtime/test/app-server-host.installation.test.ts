import { describe, expect, it, vi } from "vitest";
import {
  HARNESS_INSTALLATION_METHOD,
  HARNESS_INSTALLATION_START_METHOD,
  HARNESS_INSTALLATION_STATUS_METHOD,
  harnessInstallationTaskSchema,
  type HarnessInstallationState,
} from "@codexhost/shared-contracts";
import {
  createFixture,
  requestId,
  startPiThread,
  startPiTurn,
  stopFixture,
  writeRequest,
} from "./app-server-host-fixture.js";

const state = {
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  updateAvailable: true,
  canUpdate: true,
};

describe("Host Harness CLI installation routing", () => {
  it("preserves application version and manual installer metadata without starting an update", async () => {
    const fixture = createFixture();
    const manual = {
      ...state,
      canUpdate: false,
      versionKind: "application" as const,
      manualUpdateUrl: "https://download.codebuddy.ai/WorkBuddy.dmg",
      notice: { en: "Complete installation with the official installer." },
    };
    const installation = vi.fn(async () => manual);
    Object.assign(fixture.adapter, { installation });
    try {
      await fixture.ready;
      expect(
        await fixture.host.handleConsoleRequest(HARNESS_INSTALLATION_METHOD, {
          harnessId: "pi",
          action: "check",
        }),
      ).toEqual({ result: manual });
      expect(installation.mock.calls).toEqual([["check"]]);
    } finally {
      await stopFixture(fixture);
    }
  });

  it("answers task submission and status before the update ends and admits chat messages meanwhile", async () => {
    const fixture = createFixture({ environment: { CODEXHOST_REMOTE_SSH_MANAGED: "1" } });
    const update = Promise.withResolvers<HarnessInstallationState>();
    const installation = vi.fn(() => update.promise);
    Object.assign(fixture.adapter, { installation });
    try {
      const threadId = await startPiThread(fixture);
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: HARNESS_INSTALLATION_START_METHOD,
        params: { harnessId: "pi", action: "update", confirmedVersion: "1.1.0" },
      });
      const response = await fixture.collector.waitFor((m) => requestId(m, 2));
      const task = harnessInstallationTaskSchema.parse(response.result);
      expect(task.status).toBe("running");
      expect(installation).toHaveBeenCalledExactlyOnceWith("update", "1.1.0");
      expect(
        await fixture.host.handleConsoleRequest(HARNESS_INSTALLATION_STATUS_METHOD, {
          taskId: task.taskId,
        }),
      ).toEqual({ result: task });
      await startPiTurn(fixture, threadId, 4);
      fixture.adapter.sessions[0]?.succeedTurn();
      const preflight = {
        ...state,
        latestVersion: "1.2.0",
        confirmationRequired: true,
      } satisfies HarnessInstallationState;
      update.resolve(preflight);
      await vi.waitFor(async () =>
        expect(
          await fixture.host.handleConsoleRequest(HARNESS_INSTALLATION_STATUS_METHOD, {
            taskId: task.taskId,
          }),
        ).toEqual({ result: { taskId: task.taskId, status: "succeeded", result: preflight } }),
      );
    } finally {
      update.resolve(state);
      await stopFixture(fixture);
    }
  });
  it.each(["install", "check", "update"] as const)(
    "allows console %s through the Host channel",
    async (action) => {
      const fixture = createFixture();
      const installation = vi.fn(async () => state);
      const install = vi.fn(async () => undefined);
      Object.assign(fixture.adapter, {
        installation,
        install,
        inspect: vi.fn(async () => ({ status: "notInstalled" })),
      });
      try {
        await fixture.ready;
        expect(
          await fixture.host.handleConsoleRequest(HARNESS_INSTALLATION_METHOD, {
            harnessId: "pi",
            action,
          }),
        ).toEqual({ result: state });
        expect(installation).toHaveBeenCalledWith(action === "install" ? "check" : action);
        expect(install).toHaveBeenCalledTimes(action === "install" ? 1 : 0);
        expect(
          await fixture.host.handleConsoleRequest(HARNESS_INSTALLATION_METHOD, {
            harnessId: "pi",
            action,
            command: "evil",
          }),
        ).toMatchObject({ error: { code: -32602 } });
        expect(await fixture.host.handleConsoleRequest("thread/start", {})).toMatchObject({
          error: { code: -32601 },
        });
      } finally {
        await stopFixture(fixture);
      }
    },
  );
  it("routes checks and updates without starting a Session or blocking other Host requests", async () => {
    const fixture = createFixture();
    const update = Promise.withResolvers<typeof state>();
    const installation = vi.fn((action: "check" | "update") =>
      action === "check" ? Promise.resolve(state) : update.promise,
    );
    Object.assign(fixture.adapter, { installation });
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 1,
        method: HARNESS_INSTALLATION_METHOD,
        params: { harnessId: "pi", action: "check" },
      });
      expect(await fixture.collector.waitFor((m) => requestId(m, 1))).toMatchObject({
        result: state,
      });
      writeRequest(fixture.desktopInput, {
        id: 2,
        method: HARNESS_INSTALLATION_METHOD,
        params: { harnessId: "pi", action: "update" },
      });
      await vi.waitFor(() => expect(installation).toHaveBeenCalledWith("update"));
      writeRequest(fixture.desktopInput, {
        id: 3,
        method: "codexhost/harness/plugins/list",
        params: {},
      });
      expect(await fixture.collector.waitFor((m) => requestId(m, 3))).toHaveProperty("result");
      update.resolve({ ...state, currentVersion: "1.1.0", updateAvailable: false });
      expect(await fixture.collector.waitFor((m) => requestId(m, 2))).toMatchObject({
        result: { currentVersion: "1.1.0" },
      });
      expect(fixture.adapter.sessions).toHaveLength(0);
    } finally {
      update.resolve(state);
      await stopFixture(fixture);
    }
  });

  it("checks the selected uninstall method and blocks updates while it runs", async () => {
    const fixture = createFixture({ environment: { CODEXHOST_REMOTE_SSH_MANAGED: "1" } });
    const removed = Promise.withResolvers<void>();
    let selected = true;
    Object.assign(fixture.adapter, {
      installation: async () => state,
      resolveUninstaller: async () =>
        selected
          ? async () => {
              await removed.promise;
              selected = false;
            }
          : null,
    });
    const request = (action: string) =>
      fixture.host.handleConsoleRequest(HARNESS_INSTALLATION_METHOD, { harnessId: "pi", action });
    try {
      await fixture.ready;
      expect(await request("checkUninstall")).toMatchObject({ result: { canUninstall: true } });
      expect(await request("check")).toEqual({ result: state });
      const uninstall = request("uninstall");
      expect(await request("update")).toMatchObject({ error: { code: -32077 } });
      removed.resolve();
      expect(await uninstall).toMatchObject({ result: { canUpdate: false } });
      expect(await request("checkUninstall")).toMatchObject({ result: { canUpdate: false } });
      expect(await request("uninstall")).toMatchObject({ error: { code: -32078 } });
    } finally {
      removed.resolve();
      await stopFixture(fixture);
    }
  });
  it("installs and uninstalls a Harness without an optional version manager", async () => {
    const fixture = createFixture({ environment: { CODEXHOST_REMOTE_SSH_MANAGED: "1" } });
    let present = false;
    Object.assign(fixture.adapter, {
      install: async () => {
        present = true;
      },
      inspect: async () => ({ status: present ? "unavailable" : "notInstalled" }),
      resolveUninstaller: async () =>
        present
          ? async () => {
              present = false;
            }
          : null,
    });
    const request = (action: string) =>
      fixture.host.handleConsoleRequest(HARNESS_INSTALLATION_METHOD, { harnessId: "pi", action });
    try {
      await fixture.ready;
      expect(await request("checkInstall")).toMatchObject({ result: { canInstall: true } });
      expect(await request("install")).toHaveProperty("result");
      expect(await request("install")).toMatchObject({ error: { code: -32077 } });
      expect(await request("check")).toMatchObject({ error: { code: -32078 } });
      expect(await request("checkUninstall")).toMatchObject({ result: { canUninstall: true } });
      expect(await request("uninstall")).toHaveProperty("result");
      expect(await request("checkUninstall")).not.toMatchObject({ result: { canUninstall: true } });
    } finally {
      await stopFixture(fixture);
    }
  });

  it("rejects caller-supplied commands, missing capabilities, and sanitizes native errors", async () => {
    const fixture = createFixture();
    try {
      await fixture.ready;
      const send = async (id: number, params: Record<string, string>) => {
        writeRequest(fixture.desktopInput, { id, method: HARNESS_INSTALLATION_METHOD, params });
        return fixture.collector.waitFor((m) => requestId(m, id));
      };
      expect(await send(1, { harnessId: "pi", action: "update", command: "evil" })).toMatchObject({
        error: { code: -32602 },
      });
      // Missing capability is not missing RPC method: the client must not cache
      // -32601 and accidentally disable updates for every other Harness.
      expect(await send(2, { harnessId: "pi", action: "check" })).toMatchObject({
        error: { code: -32078 },
      });
      Object.assign(fixture.adapter, {
        installation: vi.fn(async () => {
          throw new Error("secret-access-token");
        }),
      });
      const failed = await send(3, { harnessId: "pi", action: "update" });
      expect(failed).toMatchObject({ error: { code: -32077 } });
      expect(JSON.stringify(failed)).not.toContain("secret-access-token");
      Object.assign(fixture.adapter, { installation: async () => ({ ...state, token: "secret" }) });
      expect(await send(4, { harnessId: "pi", action: "check" })).toMatchObject({
        error: { code: -32077 },
      });
    } finally {
      await stopFixture(fixture);
    }
  });
});
