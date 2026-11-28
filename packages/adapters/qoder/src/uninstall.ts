import { lstat, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import {
  resolveBinaryUninstaller,
  resolveNpmUninstaller,
  userInstallationPaths,
} from "@codexhost/harness-discovery";
import { resolveQoderExecutable } from "./qoder-command.js";
import type { QoderVariant } from "./qoder-runtime.js";

/** Identifies the selected npm or vendor-native Qoder CLI installation. */
export async function resolveQoderUninstaller(
  environment: NodeJS.ProcessEnv,
  variant: QoderVariant,
  command?: string,
) {
  const cn = variant === "cn";
  const cli = cn ? "qoderclicn" : "qodercli";
  const config = cn ? ".qoder-cn" : ".qoder";
  const windows = process.platform === "win32";
  const name = windows ? `${cli}.exe` : cli;
  const executable = resolveQoderExecutable({
    environment,
    variant,
    ...(command ? { command } : {}),
  });
  const npm = await resolveNpmUninstaller(
    executable,
    cn ? "@qodercn-ai/qoderclicn" : "@qoder-ai/qodercli",
    environment,
  );
  if (npm) return npm;
  const home = await realpath(userInstallationPaths(environment).home);
  const native = (selected: string) =>
    resolveBinaryUninstaller(selected, home, config, "bin", cli, name);
  const direct =
    (await native(executable)) ??
    (await resolveBinaryUninstaller(executable, home, config, "bin", name)) ??
    (await resolveBinaryUninstaller(executable, home, ".local", "bin", name));
  if (direct) return direct;

  const alias = path.join(await realpath(path.dirname(executable)), path.basename(executable));
  const versionDirectory = path.join(home, config, "bin", cli);
  if (
    ![path.join(home, ".local", "bin", name), path.join(versionDirectory, name)].some(
      (candidate) => path.relative(candidate, alias) === "",
    ) ||
    !(await lstat(alias)).isSymbolicLink()
  )
    return null;
  const target = await realpath(alias);
  // The script's stable entrypoint links to a sibling versioned binary.
  const versioned = new RegExp(
    `^${cli}-\\d+(?:\\.\\d+){2}(?:-[\\w.-]+)?${windows ? "\\.exe" : ""}$`,
    "iu",
  );
  const targetUninstall = versioned.test(path.basename(target))
    ? await resolveBinaryUninstaller(target, home, config, "bin", cli, path.basename(target))
    : ((await native(target)) ??
      (await resolveBinaryUninstaller(target, home, config, "bin", name)));
  if (!targetUninstall) return null;
  const inner = path.join(versionDirectory, name);
  const removeInner =
    path.relative(inner, alias) !== "" &&
    (await lstat(inner).catch(() => null))?.isSymbolicLink() &&
    path.relative(target, await realpath(inner).catch(() => inner)) === "";
  return async () => {
    await targetUninstall();
    if ((await lstat(alias).catch(() => null))?.isSymbolicLink()) await unlink(alias);
    if (removeInner) await unlink(inner);
  };
}
