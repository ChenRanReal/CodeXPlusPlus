import { lstat, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { environmentValue } from "./environment.js";

/** Account paths used by user-scoped vendor installers. */
export function userInstallationPaths(environment: NodeJS.ProcessEnv) {
  const home =
    environmentValue(environment, "HOME") ??
    environmentValue(environment, "USERPROFILE") ??
    homedir();
  return {
    home,
    localAppData:
      environmentValue(environment, "LOCALAPPDATA") ?? path.join(home, "AppData", "Local"),
  };
}

/** Remove only the selected regular binary in a known vendor layout. */
export async function resolveBinaryUninstaller(
  selected: string | undefined,
  base: string,
  ...relativePath: string[]
): Promise<(() => Promise<void>) | null> {
  if (!selected || !path.isAbsolute(selected) || !path.isAbsolute(base)) return null;
  const expected = path.join(await realpath(base), ...relativePath);
  const launcher = path.join(await realpath(path.dirname(selected)), path.basename(selected));
  if (path.relative(expected, launcher) !== "" || !(await lstat(launcher)).isFile()) return null;
  return () => unlink(launcher);
}
