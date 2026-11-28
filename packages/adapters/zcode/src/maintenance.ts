import path from "node:path";
import {
  fetchInstallationText,
  installDesktopHarness,
  resolveAppBundleUninstaller,
  resolveNsisUninstaller,
} from "@codexhost/harness-discovery";
import { portableZcodeApp, resolveInstallation } from "./installation.js";

/** Installs the official desktop app that ships the ZCode CLI. */
export function createZcodeInstaller(environment: NodeJS.ProcessEnv) {
  const arch = process.arch;
  if (arch !== "arm64" && arch !== "x64") return;
  const target =
    process.platform === "win32"
      ? ["windows", "win", "exe"]
      : process.platform === "darwin"
        ? ["macos", "mac", "dmg"]
        : process.platform === "linux"
          ? ["linux", "linux", "AppImage"]
          : undefined;
  if (!target) return;
  const [platform, label, extension] = target;
  return async () => {
    const page = await fetchInstallationText("https://zcode.z.ai/en");
    const asset = page.match(
      new RegExp(
        `https://cdn-zcode\\.z\\.ai/zcode/electron/releases/(\\d+(?:\\.\\d+){2})/${platform}-${arch}/ZCode-\\1-${label}-${arch}\\.${extension}(?![\\w.])`,
        "u",
      ),
    )?.[0];
    if (!asset) throw new Error("ZCode's official page has no installer for this platform");
    await installDesktopHarness(new URL(asset), environment, {
      name: process.platform === "darwin" ? "ZCode.app" : "ZCode",
      destination:
        process.platform === "darwin" ? "/Applications/ZCode.app" : portableZcodeApp(environment),
    });
  };
}

/** Resolves removal for the selected official app, preserving its separate data root. */
export async function resolveZcodeUninstaller(environment: NodeJS.ProcessEnv, app?: string) {
  const installation = await resolveInstallation(environment, app);
  const root =
    process.platform === "darwin"
      ? path.resolve(installation.cli, "../../../..")
      : path.dirname(installation.runtime);
  const relative = path.relative(root, installation.dataRoot);
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    return null;
  if (process.platform === "win32") {
    const allUsers = [environment.ProgramFiles, environment["ProgramFiles(x86)"]].some(
      (base) => base && path.relative(base, path.dirname(root)) === "",
    );
    return resolveNsisUninstaller(root, "Uninstall ZCode.exe", environment, allUsers);
  }
  if (process.platform === "darwin")
    return resolveAppBundleUninstaller(root, "/Applications/ZCode.app");
  return resolveAppBundleUninstaller(root, portableZcodeApp(environment));
}
