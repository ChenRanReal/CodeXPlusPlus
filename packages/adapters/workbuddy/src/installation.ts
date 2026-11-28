import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  fetchInstallationText,
  installDesktopHarness,
  installationVersion,
  newerInstallationVersion,
  runInstallationCommand,
  resolveAppBundleUninstaller,
  resolveNsisUninstaller,
  targetPath,
  versionFromOutput,
} from "@codexhost/harness-discovery";
import type { HarnessInstallationState } from "@codexhost/shared-contracts";
import { resolveWorkBuddyLaunch } from "./command.js";

interface WorkBuddyProduct {
  applicationName?: unknown;
  genieVersion?: unknown;
  updateUrl?: unknown;
}

const applicationNotice = {
  en: "These are WorkBuddy desktop app versions. Its bundled CLI updates with the app. Download the official installer, complete installation, then reopen Connections to verify the version. Existing sessions keep their running CLI.",
  "zh-CN":
    "此处显示 WorkBuddy 桌面应用版本，内置 CLI 随应用更新。请下载官方安装包并完成安装，再重新打开连接页确认版本。已有会话继续使用运行中的 CLI。",
};

/** WorkBuddy's feed appends a numeric build ID to the desktop app's three-part version. */
function appVersion(value: unknown): string {
  const version = installationVersion(value);
  return version.replace(/^(\d+\.\d+\.\d+)\.\d+$/u, "$1");
}

/** The official public WorkBuddy release manifest for a CPU and operating system. */
async function workBuddyRelease(
  root: "https://www.workbuddy.ai" | "https://www.workbuddy.cn",
  target: string,
  fetchText = fetchInstallationText,
) {
  const feed = JSON.parse(await fetchText(`${root}/v2/update?platform=workbuddy-${target}`)) as {
    version?: unknown;
    url?: unknown;
  };
  const version = installationVersion(feed.version);
  const download = new URL(typeof feed.url === "string" ? feed.url : "");
  const host = root.endsWith(".ai") ? "download.codebuddy.ai" : "download.codebuddy.cn";
  const darwin = target.startsWith("darwin-");
  if (
    download.origin !== `https://${host}` ||
    download.username ||
    download.password ||
    download.search ||
    download.hash ||
    !download.pathname.startsWith(`/workbuddy/saas/${target}/WorkBuddy-${target}-${version}-`) ||
    !download.pathname.endsWith(darwin ? ".zip" : ".exe")
  )
    throw new Error("WorkBuddy update feed returned an invalid installer URL");
  if (darwin) download.pathname = download.pathname.replace(/\.zip$/u, ".dmg");
  return { version: appVersion(version), download };
}

/** Installs the public vendor app, including the CLI it ships. */
export function createWorkBuddyInstaller(environment: NodeJS.ProcessEnv) {
  const target =
    process.platform === "darwin" && ["arm64", "x64"].includes(process.arch)
      ? `darwin-${process.arch}`
      : process.platform === "win32" && ["arm64", "x64"].includes(process.arch)
        ? "win32-x64-user"
        : null;
  if (!target) return;
  return async () => {
    const root =
      environment.WORKBUDDY_UPDATE_URL === "https://www.workbuddy.cn"
        ? "https://www.workbuddy.cn"
        : "https://www.workbuddy.ai";
    const { download } = await workBuddyRelease(root, target);
    await installDesktopHarness(download, environment, {
      name: "WorkBuddy.app",
      alternateName: "WorkBuddy AI.app",
      destination: "/Applications/WorkBuddy.app",
    });
  };
}

/** Uninstalls the selected vendor app; custom WorkBuddy CLI paths have no app uninstaller. */
export async function resolveWorkBuddyUninstaller(environment: NodeJS.ProcessEnv) {
  const { bundle } = resolveWorkBuddyLaunch(environment);
  if (!bundle) return null;
  if (process.platform === "win32") {
    const root = path.dirname(bundle.executable);
    const allUsers = [environment.ProgramFiles, environment["ProgramFiles(x86)"]].some(
      (base) => base && path.relative(base, path.dirname(root)) === "",
    );
    return (
      (await resolveNsisUninstaller(root, "Uninstall WorkBuddy.exe", environment, allUsers)) ??
      (await resolveNsisUninstaller(root, "Uninstall WorkBuddy AI.exe", environment, allUsers))
    );
  }
  if (process.platform === "darwin") {
    const app = path.resolve(bundle.executable, "../../..");
    const name = path.basename(app);
    if (name === "WorkBuddy.app" || name === "WorkBuddy AI.app")
      return resolveAppBundleUninstaller(app, path.join("/Applications", name));
  }
  return null;
}

async function readProduct(file: string): Promise<WorkBuddyProduct> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 8 * 1024 * 1024)
    throw new Error("WorkBuddy product metadata is unavailable");
  return JSON.parse(await readFile(file, "utf8")) as WorkBuddyProduct;
}

export function createWorkBuddyInstallation(
  environment: NodeJS.ProcessEnv,
  dependencies: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    readProduct?: (file: string) => Promise<WorkBuddyProduct>;
    fetchText?: (url: string) => Promise<string>;
  } = {},
) {
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  return async (action: "check" | "update"): Promise<HarnessInstallationState> => {
    if (action === "update")
      throw new Error("Complete the update with WorkBuddy's official desktop installer");
    const { executable, bundle } = resolveWorkBuddyLaunch(environment, { platform });
    if (!bundle)
      return {
        currentVersion: versionFromOutput(
          await runInstallationCommand(executable, ["--version"], environment),
        ),
        latestVersion: "Unknown",
        latestVersionKind: "unknown",
        updateAvailable: false,
        canUpdate: false,
        notice: {
          en: "This is a custom CLI. Use its original installer to update; WorkBuddy desktop releases do not identify this CLI's latest version.",
          "zh-CN":
            "当前使用自定义 CLI，请通过原安装方式更新；WorkBuddy 桌面应用版本不代表此 CLI 的最新版本。",
        },
      };

    const paths = targetPath(platform);
    const product = await (dependencies.readProduct ?? readProduct)(
      paths.join(paths.dirname(paths.dirname(bundle.cli)), "product.json"),
    );
    const currentVersion = appVersion(product.genieVersion);
    const unknown: HarnessInstallationState = {
      currentVersion,
      versionKind: "application",
      latestVersion: "Unknown",
      latestVersionKind: "unknown",
      updateAvailable: false,
      canUpdate: false,
      notice: {
        en: "The installed WorkBuddy desktop app version is shown. Check and install updates in WorkBuddy itself; this installation's update channel could not be checked here.",
        "zh-CN":
          "此处显示已安装的 WorkBuddy 桌面应用版本。当前无法查询此安装的更新渠道，请在 WorkBuddy 应用内检查并安装更新。",
      },
    };
    // Public SaaS channels only; private/enterprise products keep their own updater.
    const root =
      product.applicationName === "workbuddy-ai" && product.updateUrl === "https://www.workbuddy.ai"
        ? "https://www.workbuddy.ai"
        : product.applicationName === "workbuddy" &&
            product.updateUrl === "https://www.workbuddy.cn"
          ? "https://www.workbuddy.cn"
          : undefined;
    const target =
      platform === "darwin" && (arch === "arm64" || arch === "x64")
        ? `darwin-${arch}`
        : platform === "win32" && arch === "x64"
          ? "win32-x64-user"
          : undefined;
    if (
      !root ||
      !target ||
      (environment.WORKBUDDY_UPDATE_URL?.trim() && environment.WORKBUDDY_UPDATE_URL.trim() !== root)
    )
      return unknown;
    try {
      // The public download page uses this feed without account or tenant identifiers.
      const { version: latestVersion, download } = await workBuddyRelease(
        root,
        target,
        dependencies.fetchText,
      );
      const updateAvailable = newerInstallationVersion(currentVersion, latestVersion);
      return {
        currentVersion,
        versionKind: "application",
        latestVersion,
        updateAvailable,
        canUpdate: false,
        ...(updateAvailable ? { manualUpdateUrl: download.href } : {}),
        notice: applicationNotice,
      };
    } catch {
      return unknown;
    }
  };
}
