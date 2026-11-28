import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { environmentValue } from "@codexhost/harness-discovery";
import { cursorBundleVersionPattern, resolveCursorExecutable } from "./command.js";

/** Missing files are normal when looking for optional launchers. */
function fileInfo(file: string) {
  return lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

/** A Windows installer copies each launcher out of the version bundle. */
async function windowsLaunchers(install: string, versions: string): Promise<string[]> {
  const entries = await readdir(versions, { withFileTypes: true });
  const bundles: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !cursorBundleVersionPattern.test(entry.name)) continue;
    const bundle = path.join(versions, entry.name);
    if (
      (await fileInfo(path.join(bundle, "node.exe")))?.isFile() &&
      (await fileInfo(path.join(bundle, "index.js")))?.isFile()
    ) {
      bundles.push(bundle);
    }
  }
  const launchers: string[] = [];
  for (const extension of [".cmd", ".ps1", ".exe"]) {
    const bundledName = "cursor-agent" + extension;
    for (const name of [bundledName, "agent" + extension]) {
      const launcher = path.join(install, name);
      const info = await fileInfo(launcher);
      if (!info?.isFile()) continue;
      for (const bundle of bundles) {
        const copy = path.join(bundle, bundledName);
        const copyInfo = await fileInfo(copy);
        if (
          copyInfo?.isFile() &&
          info.size === copyInfo.size &&
          (await readFile(launcher)).equals(await readFile(copy))
        ) {
          launchers.push(launcher);
          break;
        }
      }
    }
  }
  return launchers;
}

/** POSIX launchers are symlinks to a dated version under the installer directory. */
async function posixLaunchers(home: string, versions: string): Promise<string[]> {
  const bin = path.join(home, ".local", "bin");
  if (path.relative(bin, await realpath(bin)) !== "") return [];
  const launchers: string[] = [];
  for (const name of ["cursor-agent", "agent"]) {
    const launcher = path.join(bin, name);
    if (!(await fileInfo(launcher))?.isSymbolicLink()) continue;
    const target = await realpath(launcher).catch(() => "");
    if (!target) continue;
    const [version, executable, ...rest] = path.relative(versions, target).split(path.sep);
    if (
      version &&
      cursorBundleVersionPattern.test(version) &&
      executable === "cursor-agent" &&
      rest.length === 0
    ) {
      launchers.push(launcher);
    }
  }
  return launchers;
}

/** Creates an uninstaller only for the selected CLI from Cursor's official installer. */
export async function resolveCursorUninstaller(environment: NodeJS.ProcessEnv) {
  const selected = resolveCursorExecutable(environment).executable;
  const windows = process.platform === "win32";
  const home =
    environmentValue(environment, "HOME") ??
    environmentValue(environment, "USERPROFILE") ??
    homedir();
  const base = windows
    ? (environmentValue(environment, "LOCALAPPDATA") ?? path.join(home, "AppData", "Local"))
    : home;
  const canonicalBase = await realpath(base);
  const install = path.join(canonicalBase, ...(windows ? [] : [".local", "share"]), "cursor-agent");
  const versions = path.join(install, "versions");
  if (path.relative(versions, await realpath(versions)) !== "") return null;
  const explicitConfig = environmentValue(environment, "CURSOR_CONFIG_DIR");
  const xdg = environmentValue(environment, "XDG_CONFIG_HOME");
  const config = explicitConfig || (xdg && path.join(xdg, "cursor"));
  if (config) {
    const configPath = path.resolve(config);
    const relative = path.relative(versions, await realpath(configPath).catch(() => configPath));
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      return null;
  }
  const launchers = windows
    ? await windowsLaunchers(install, versions)
    : await posixLaunchers(canonicalBase, versions);
  const selectedDirectory = await realpath(path.dirname(selected));
  const selectedLauncher = path.join(selectedDirectory, path.basename(selected));
  if (!launchers.some((launcher) => path.relative(launcher, selectedLauncher) === "")) return null;

  return async () => {
    await rm(versions, { recursive: true });
    for (const launcher of launchers) await rm(launcher, { force: true });
  };
}
