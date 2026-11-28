import { lstat, readFile, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { userInstallationPaths } from "@codexhost/harness-discovery";
import { resolveDevinExecutable } from "./command.js";

/** Matches the public installer distribution and leaves the parent Devin data directory intact. */
export async function resolveDevinUninstaller(environment: NodeJS.ProcessEnv) {
  const selected = resolveDevinExecutable(environment);
  const { home, localAppData } = userInstallationPaths(environment);
  const windows = process.platform === "win32";
  const data = windows
    ? localAppData
    : (environment.XDG_DATA_HOME ?? path.join(home, ".local", "share"));
  const root = path.join(await realpath(data), "devin", "cli");
  if (path.relative(root, await realpath(root)) !== "") return null;
  const launcher = path.join(await realpath(path.dirname(selected)), path.basename(selected));
  const expected = windows
    ? path.join(root, "bin", "devin.exe")
    : path.join(await realpath(home), ".local", "bin", "devin");
  if (path.relative(expected, launcher) !== "") return null;
  const info = await lstat(launcher);
  if (windows ? !info.isFile() : !info.isSymbolicLink()) return null;

  const executable = await realpath(launcher);
  const version = windows ? root : path.dirname(path.dirname(executable));
  if (
    !windows &&
    (path.relative(path.join(root, "_versions"), path.dirname(version)) !== "" ||
      path.relative(path.join(version, "bin", "devin"), executable) !== "")
  )
    return null;
  const distribution = (await readFile(path.join(version, "distribution"), "utf8")).trim();
  if (distribution !== (windows ? "irm-iex" : "curl-bash")) return null;
  return async () => {
    await rm(root, { recursive: true });
    if (!windows) await unlink(launcher);
  };
}
