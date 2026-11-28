import { readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { npmInstallation } from "@codexhost/harness-discovery";
import { resolvePiExecutable } from "./command.js";

/** Matches the official managed launcher or Pi's global npm package. */
export async function resolvePiUninstaller(environment: NodeJS.ProcessEnv, command?: string) {
  const executable = resolvePiExecutable({ environment, ...(command ? { command } : {}) });
  if (!path.isAbsolute(executable)) return null;
  const npm = await npmInstallation(executable, ["@earendil-works/pi-coding-agent"], environment);
  if (npm) return npm.uninstall;

  const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
  const agent = await realpath(
    environment.PI_CODING_AGENT_DIR || path.join(home, ".pi", "agent"),
  ).catch(() => null);
  if (!agent) return null;
  const install = path.join(agent, "install");
  const bin = path.join(agent, "bin");
  if (
    path.relative(install, await realpath(install)) !== "" ||
    path.relative(bin, await realpath(bin)) !== ""
  )
    return null;
  const marker = JSON.parse(
    (await readFile(path.join(install, "managed-install.json"), "utf8")).replace(/^\uFEFF/u, ""),
  ) as {
    kind?: string;
    schemaVersion?: number;
    layout?: string;
    entrypoint?: { type?: string; path?: string };
  } | null;
  if (
    marker?.kind !== "pi-managed-install" ||
    marker.schemaVersion !== 1 ||
    marker.layout !== "releases-v1" ||
    typeof marker.entrypoint?.path !== "string" ||
    !path.isAbsolute(marker.entrypoint.path)
  )
    return null;
  const entrypoint = marker.entrypoint.path;
  const windows = process.platform === "win32";
  const launcher = path.join(bin, windows ? "pi.cmd" : "pi");
  const selected = await realpath(executable);
  if (path.relative(launcher, selected) !== "") return null;
  if (marker.entrypoint.type === "script") {
    if (path.relative(launcher, entrypoint) !== "") return null;
  } else if (
    windows ||
    marker.entrypoint.type !== "symlink" ||
    path.basename(entrypoint) !== "pi" ||
    path.relative(launcher, await realpath(entrypoint)) !== ""
  ) {
    return null;
  }

  return async () => {
    await rm(install, { recursive: true });
    // Remove the installer's entrypoint and the known launchers in its own bin directory.
    await rm(entrypoint, { force: true });
    for (const file of windows ? ["pi", "pi.ps1", "pi-launcher.js"] : ["pi"]) {
      await rm(path.join(bin, file), { force: true });
    }
  };
}
