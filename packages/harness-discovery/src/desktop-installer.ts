import { createWriteStream } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { runInstallationCommand } from "./installation.js";

/** Runs the native Windows installer with user-mediated UAC when the install is system-wide. */
export async function runWindowsInstaller(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
  systemWide = false,
): Promise<void> {
  if (!systemWide) {
    await runInstallationCommand(executable, args, environment, 300_000, cwd);
    return;
  }
  const command = [
    "$ErrorActionPreference = 'Stop'",
    "$argsFromHost = ConvertFrom-Json $env:CODEXHOST_INSTALLER_ARGS",
    "$child = Start-Process -FilePath $env:CODEXHOST_INSTALLER_PATH -ArgumentList $argsFromHost -Verb RunAs -Wait -PassThru -WindowStyle Hidden",
    "exit $child.ExitCode",
  ].join("\n");
  await runInstallationCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      ...environment,
      CODEXHOST_INSTALLER_PATH: executable,
      CODEXHOST_INSTALLER_ARGS: JSON.stringify(args),
    },
    300_000,
    cwd,
  );
}

/** Downloads an Adapter-validated official Windows installer, disk image, or AppImage. */
export async function installDesktopHarness(
  url: URL,
  environment: NodeJS.ProcessEnv,
  application?: { name: string; destination: string; alternateName?: string },
): Promise<void> {
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Desktop installer requires a credential-free HTTPS URL");
  const temporary = await mkdtemp(path.join(tmpdir(), "codexhost-desktop-installer-"));
  try {
    const extension = path.extname(url.pathname);
    const installer = path.join(temporary, `installer${extension}`);
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) throw new Error("Could not download the desktop installer");
    await pipeline(response.body, createWriteStream(installer, { mode: 0o600, flags: "wx" }));

    if (process.platform === "win32" && extension === ".exe") {
      await runWindowsInstaller(installer, ["/S"], environment, temporary);
      return;
    }
    if (!application || !path.isAbsolute(application.destination))
      throw new Error("Desktop installation destination is unavailable");

    const parent = path.dirname(application.destination);
    await mkdir(parent, { recursive: true });
    const stage = await mkdtemp(path.join(parent, ".codexhost-desktop-install-"));
    const stagedApp = path.join(stage, application.name);
    try {
      if (process.platform === "darwin" && extension === ".dmg") {
        const mount = path.join(temporary, "mounted");
        await mkdir(mount);
        await runInstallationCommand(
          "/usr/bin/hdiutil",
          ["attach", installer, "-readonly", "-nobrowse", "-mountpoint", mount],
          environment,
          60_000,
        );
        try {
          const mainApp = path.join(mount, application.name);
          const sourceApp =
            application.alternateName && !(await lstat(mainApp).catch(() => null))?.isDirectory()
              ? path.join(mount, application.alternateName)
              : mainApp;
          await runInstallationCommand(
            "/usr/bin/ditto",
            [sourceApp, stagedApp],
            environment,
            120_000,
          );
        } finally {
          await runInstallationCommand("/usr/bin/hdiutil", ["detach", mount], environment);
        }
      } else if (process.platform === "linux" && extension === ".AppImage") {
        await chmod(installer, 0o700);
        await runInstallationCommand(
          installer,
          ["--appimage-extract"],
          environment,
          120_000,
          temporary,
        );
        await cp(path.join(temporary, "squashfs-root"), stagedApp, {
          recursive: true,
          verbatimSymlinks: true,
        });
      } else {
        throw new Error("No supported installer for this desktop platform");
      }
      await lstat(application.destination).then(
        () => {
          throw new Error("The destination is already occupied");
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      await rename(stagedApp, application.destination);
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Runs a vendor's NSIS uninstaller from the identified app directory. */
export async function resolveNsisUninstaller(
  root: string,
  name: string,
  environment: NodeJS.ProcessEnv,
  allUsers = false,
): Promise<(() => Promise<void>) | null> {
  const installed = await realpath(root);
  const uninstaller = path.join(installed, name);
  if (!(await lstat(uninstaller).catch(() => null))?.isFile()) return null;
  return async () => {
    await runWindowsInstaller(
      uninstaller,
      [...(allUsers ? ["/allusers"] : []), "/S"],
      environment,
      path.dirname(installed),
      allUsers,
    );
  };
}

/** A known application bundle with a non-redirected install root. */
export async function resolveAppBundleUninstaller(
  selected: string,
  expected: string,
): Promise<(() => Promise<void>) | null> {
  const parent = await realpath(path.dirname(expected));
  const bundle = path.join(parent, path.basename(expected));
  const selectedPath = path.join(await realpath(path.dirname(selected)), path.basename(selected));
  if (path.relative(bundle, selectedPath) !== "" || !(await lstat(bundle)).isDirectory())
    return null;
  return () => rm(bundle, { recursive: true });
}
