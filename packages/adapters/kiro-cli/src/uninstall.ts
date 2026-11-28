import path from "node:path";
import { lstat, realpath, unlink } from "node:fs/promises";
import {
  resolveBinaryUninstaller,
  runInstallationCommand,
  runWindowsInstaller,
  userInstallationPaths,
} from "@codexhost/harness-discovery";
import { resolveKiroExecutable } from "./command.js";

const listKiroMsi = [
  "$ErrorActionPreference = 'Stop'",
  "$roots = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
  "$products = @(Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $_.WindowsInstaller -eq 1 -and $_.DisplayName -match '^Kiro CLI(?:$| [0-9(])' -and $_.Publisher -match '^Amazon' } | Select-Object PSChildName, InstallLocation)",
  "ConvertTo-Json -InputObject $products -Compress",
].join("\n");

/** Uses the selected MSI's ProductCode on Windows, or the official standalone launchers on Unix. */
export async function resolveKiroUninstaller(environment: NodeJS.ProcessEnv) {
  const executable = resolveKiroExecutable({ environment });
  const { home, localAppData } = userInstallationPaths(environment);
  if (process.platform !== "win32") {
    const uninstall =
      (await resolveBinaryUninstaller(executable, home, ".local", "bin", "kiro-cli")) ??
      (await resolveBinaryUninstaller(executable, home, ".kiro", "bin", "kiro-cli")) ??
      (await resolveBinaryUninstaller(executable, "/usr/local", "bin", "kiro-cli").catch(
        () => null,
      ));
    if (!uninstall) return null;
    const companion = path.join(path.dirname(executable), "kiro-cli-chat");
    return async () => {
      if ((await lstat(companion).catch(() => null))?.isFile()) await unlink(companion);
      await uninstall();
    };
  }

  if (!/^kiro-cli\.exe$/iu.test(path.basename(executable))) return null;
  const root = await realpath(path.dirname(executable));
  const standard = [localAppData, environment.ProgramFiles]
    .filter((base): base is string => typeof base === "string" && path.isAbsolute(base))
    .some((base) => path.relative(path.join(base, "Kiro-Cli"), root) === "");
  const products = JSON.parse(
    await runInstallationCommand(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", listKiroMsi],
      environment,
    ),
  ) as { PSChildName?: string; InstallLocation?: string }[];
  const matches = products.filter(
    ({ PSChildName, InstallLocation }) =>
      typeof PSChildName === "string" &&
      /^\{[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\}$/iu.test(PSChildName) &&
      (InstallLocation
        ? path.isAbsolute(InstallLocation) && path.relative(InstallLocation, root) === ""
        : standard && products.length === 1),
  );
  const [product] = matches;
  if (matches.length !== 1 || !product?.PSChildName) return null;
  const id = product.PSChildName;
  const systemWide =
    !!environment.ProgramFiles &&
    path.relative(path.join(environment.ProgramFiles, "Kiro-Cli"), root) === "";
  return async () => {
    await runWindowsInstaller(
      path.join(environment.SystemRoot ?? "C:\\Windows", "System32", "msiexec.exe"),
      ["/x", id, "/qn", "/norestart"],
      environment,
      path.dirname(root),
      systemWide,
    );
  };
}
