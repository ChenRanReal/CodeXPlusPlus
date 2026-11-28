import { lstat, realpath, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { npmInstallation } from "@codexhost/harness-discovery";
import { resolveClaudeCodeExecutable } from "./command.js";

/** Matches the native installer layout or Claude's global npm package. */
export async function resolveClaudeUninstaller(environment: NodeJS.ProcessEnv, command?: string) {
  const executable = resolveClaudeCodeExecutable({
    environment,
    ...(command ? { command } : {}),
  });
  const home = path.resolve(environment.HOME ?? environment.USERPROFILE ?? homedir());
  const windows = process.platform === "win32";
  const launcher = path.join(home, ".local", "bin", windows ? "claude.exe" : "claude");
  if (path.relative(launcher, executable) !== "") {
    return (
      (await npmInstallation(executable, ["@anthropic-ai/claude-code"], environment))?.uninstall ??
      null
    );
  }

  const canonicalHome = await realpath(home);
  const launcherDirectory = await realpath(path.dirname(launcher));
  if (path.relative(path.join(canonicalHome, ".local", "bin"), launcherDirectory) !== "") {
    return null;
  }
  const support = path.join(canonicalHome, ".local", "share", "claude");
  const supportInfo = await lstat(support).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (
    supportInfo &&
    (!supportInfo.isDirectory() || path.relative(support, await realpath(support)) !== "")
  ) {
    return null;
  }
  if (supportInfo && environment.CLAUDE_CONFIG_DIR) {
    const config = path.resolve(home, environment.CLAUDE_CONFIG_DIR);
    const relative = path.relative(support, await realpath(config).catch(() => config));
    if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return null;
    }
  }
  const selected = await realpath(executable);
  if (windows) {
    if (path.relative(path.join(launcherDirectory, "claude.exe"), selected) !== "") return null;
  } else {
    const version = path.relative(path.join(support, "versions"), selected);
    if (!supportInfo || !/^\d+(?:\.\d+){2}(?:-[\w.-]+)?$/u.test(version)) return null;
  }

  return async () => {
    await unlink(launcher);
    if (supportInfo) await rm(support, { recursive: true, force: true });
  };
}
