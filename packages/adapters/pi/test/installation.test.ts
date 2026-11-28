import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ run: vi.fn(), fetch: vi.fn(), resolve: vi.fn() }));
vi.mock("@codexhost/harness-discovery", async (original) => ({
  ...(await original<object>()),
  runInstallationCommand: mocks.run,
  fetchInstallationText: mocks.fetch,
}));
vi.mock("../src/command.js", () => ({ resolvePiExecutable: mocks.resolve }));
import { createPiInstallation } from "../src/installation.js";
import { resolvePiUninstaller } from "../src/uninstall.js";

describe("Pi native version maintenance", () => {
  it("removes the managed launcher and releases while preserving Pi settings", async () => {
    const agent = await mkdtemp(path.join(tmpdir(), "codexhost-pi-uninstall-"));
    try {
      const install = path.join(agent, "install");
      const bin = path.join(agent, "bin");
      const launcher = path.join(bin, process.platform === "win32" ? "pi.cmd" : "pi");
      const settings = path.join(agent, "settings.json");
      await Promise.all([mkdir(bin), mkdir(install)]);
      await Promise.all([
        writeFile(launcher, "fixture"),
        writeFile(settings, "{}"),
        writeFile(
          path.join(install, "managed-install.json"),
          JSON.stringify({
            kind: "pi-managed-install",
            schemaVersion: 1,
            layout: "releases-v1",
            entrypoint: { type: "script", path: launcher },
          }),
        ),
      ]);
      mocks.resolve.mockReturnValue(launcher);
      const uninstall = await resolvePiUninstaller({ PI_CODING_AGENT_DIR: agent });
      expect(uninstall).toBeTypeOf("function");
      await uninstall?.();
      await expect(readFile(launcher)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(install, "managed-install.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(readFile(settings, "utf8")).resolves.toBe("{}");
    } finally {
      await rm(agent, { recursive: true, force: true });
    }
  });

  it("uses the selected installation and pi update, not an unrelated npm prefix", async () => {
    const environment = { CODEXHOST_PI_COMMAND: "/chosen/pi" };
    mocks.resolve.mockReturnValue("/chosen/pi");
    mocks.fetch.mockResolvedValue(JSON.stringify({ version: "0.85.2" }));
    let version = "0.85.1";
    mocks.run.mockImplementation(async (_command, args) => {
      if (args[0] === "update") version = "0.85.2";
      return version;
    });
    const installation = createPiInstallation(environment, "/chosen/pi");
    await expect(installation("update")).resolves.toMatchObject({
      currentVersion: "0.85.2",
      updateAvailable: false,
    });
    expect(mocks.fetch).toHaveBeenCalledWith("https://pi.dev/api/latest-version");
    expect(mocks.run).toHaveBeenCalledWith("/chosen/pi", ["update"], environment, 300_000);
  });
});
