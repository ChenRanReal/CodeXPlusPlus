import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("../src/command.js", async (original) => ({
  ...(await original<object>()),
  resolveCursorExecutable: mocks.resolve,
}));
import { resolveCursorUninstaller } from "../src/uninstall.js";

afterEach(() => vi.unstubAllGlobals());

describe("Cursor official installer uninstall", () => {
  it.each(["official", "custom launcher", "redirected versions", "config in versions"])(
    "only removes Cursor-owned Windows files in the official layout (%s)",
    async (layout) => {
      vi.stubGlobal("process", { ...process, platform: "win32" });
      const base = await mkdtemp(path.join(tmpdir(), "codexhost-cursor-uninstall-"));
      try {
        const install = path.join(base, "cursor-agent");
        const versions = path.join(install, "versions");
        const contents = layout === "redirected versions" ? path.join(base, "different") : versions;
        const version = path.join(contents, "2026.11.22-e9042b2");
        const launcher = path.join(install, "cursor-agent.cmd");
        const matchedAlias = path.join(install, "agent.ps1");
        const customAlias = path.join(install, "agent.cmd");
        const state = path.join(install, "settings.json");
        await mkdir(install);
        await mkdir(version, { recursive: true });
        if (contents !== versions) await symlink(contents, versions, "junction");
        await Promise.all([
          writeFile(path.join(version, "node.exe"), "Node"),
          writeFile(path.join(version, "index.js"), "Cursor"),
          writeFile(path.join(version, "cursor-agent.cmd"), "official CMD"),
          writeFile(path.join(version, "cursor-agent.ps1"), "official PS"),
          writeFile(launcher, layout === "custom launcher" ? "custom CMD" : "official CMD"),
          writeFile(matchedAlias, "official PS"),
          writeFile(customAlias, "custom alias"),
          writeFile(state, "settings"),
        ]);
        mocks.resolve.mockReturnValue({ executable: launcher });
        const environment = {
          LOCALAPPDATA: base,
          ...(layout === "config in versions"
            ? { CURSOR_CONFIG_DIR: path.join(contents, "settings") }
            : {}),
        };
        const uninstall = await resolveCursorUninstaller(environment);
        if (layout === "official") {
          expect(uninstall).toBeTypeOf("function");
          await uninstall?.();
          for (const removed of [launcher, matchedAlias, path.join(version, "node.exe")]) {
            await expect(readFile(removed)).rejects.toMatchObject({ code: "ENOENT" });
          }
        } else {
          expect(uninstall).toBeNull();
          await expect(readFile(path.join(version, "node.exe"), "utf8")).resolves.toBe("Node");
        }
        await expect(readFile(customAlias, "utf8")).resolves.toBe("custom alias");
        await expect(readFile(state, "utf8")).resolves.toBe("settings");
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves a POSIX alias owned by another tool",
    async () => {
      const home = await mkdtemp(path.join(tmpdir(), "codexhost-cursor-uninstall-"));
      try {
        const bin = path.join(home, ".local", "bin");
        const release = path.join(
          home,
          ".local",
          "share",
          "cursor-agent",
          "versions",
          "2026.11.22-e9042b2",
        );
        const executable = path.join(release, "cursor-agent");
        const launcher = path.join(bin, "cursor-agent");
        const alias = path.join(bin, "agent");
        await Promise.all([mkdir(release, { recursive: true }), mkdir(bin, { recursive: true })]);
        await writeFile(executable, "Cursor");
        await symlink(executable, launcher);
        await writeFile(alias, "different tool");
        mocks.resolve.mockReturnValue({ executable: launcher });
        const uninstall = await resolveCursorUninstaller({ HOME: home });
        expect(uninstall).toBeTypeOf("function");
        await uninstall?.();
        for (const removed of [executable, launcher]) {
          await expect(readFile(removed)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await expect(readFile(alias, "utf8")).resolves.toBe("different tool");
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
