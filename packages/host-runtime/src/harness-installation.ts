import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  harnessInstallationParamsSchema,
  harnessInstallationStateSchema,
  type HarnessInstallationState,
} from "@codexhost/shared-contracts";

export class HarnessInstallationError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "HarnessInstallationError";
  }
}

const mutations = new WeakMap<
  HarnessAdapter,
  { action: "install" | "update" | "uninstall"; result: Promise<HarnessInstallationState> }
>();

const withoutVersion = {
  currentVersion: "Unknown",
  latestVersion: "Unknown",
  updateAvailable: false,
  canUpdate: false,
};

/** Public plugin capability only. The Renderer cannot supply commands, URLs or paths. */
export async function handleHarnessInstallation(
  params: unknown,
  adapters: ReadonlyMap<string, HarnessAdapter>,
): Promise<HarnessInstallationState> {
  const parsed = harnessInstallationParamsSchema.safeParse(params);
  if (!parsed.success)
    throw new HarnessInstallationError(-32602, "Invalid Harness installation request");
  const adapter = adapters.get(parsed.data.harnessId);
  if (!adapter?.installation)
    throw new HarnessInstallationError(
      -32078,
      "Harness version management is unavailable on this Host",
    );
  const install = adapter.install?.bind(adapter);
  const resolveUninstaller = adapter.resolveUninstaller?.bind(adapter);
  const installation = adapter.installation.bind(adapter);
  const { action, confirmedVersion } = parsed.data;
  if (action === "install" && !install)
    throw new HarnessInstallationError(
      -32078,
      "Automatic installation is unavailable on this Host. Use the official installation guide.",
    );
  if (action === "checkUninstall") {
    const supported = !mutations.has(adapter) && (await resolveUninstaller?.().catch(() => null));
    return supported ? { ...withoutVersion, canUninstall: true } : withoutVersion;
  }
  const pending = mutations.get(adapter);
  if (pending) {
    if (action === pending.action || (action === "check" && pending.action !== "uninstall"))
      return pending.result;
    throw new HarnessInstallationError(-32077, "Another Harness operation is in progress.");
  }
  const run = async (): Promise<HarnessInstallationState> => {
    try {
      if (action === "uninstall") {
        const uninstall = await resolveUninstaller?.().catch(() => null);
        if (!uninstall)
          throw new HarnessInstallationError(
            -32078,
            "Automatic uninstall is unavailable for the selected CLI installation.",
          );
        await uninstall();
        return withoutVersion;
      }
      if (action === "install") {
        // Never overwrite an existing or merely unauthenticated installation.
        const inspection = await adapter.inspect({ refresh: true });
        if (inspection.status !== "notInstalled")
          throw new Error("Harness is already installed or its state is uncertain");
        if (!install) throw new Error("Installation capability unavailable");
        await install();
        return harnessInstallationStateSchema.parse(await installation("check"));
      }
      return harnessInstallationStateSchema.parse(
        await (confirmedVersion === undefined
          ? installation(action)
          : installation(action, confirmedVersion)),
      );
    } catch (error) {
      // Native output may include credentials or paths.
      if (error instanceof HarnessInstallationError && error.code === -32078) throw error;
      throw new HarnessInstallationError(
        -32077,
        action === "uninstall"
          ? "Harness uninstall failed. Close running CLI processes and check the installation before retrying."
          : action === "install"
            ? "Harness installation failed or its CLI version could not be confirmed. Check network access, prerequisites and installation permissions in the official guide, then diagnose the connection before retrying."
            : action === "update"
              ? "Harness update failed or its new version could not be confirmed. Check the native installation and check for updates again."
              : "Could not check Harness versions. Check the native installation and retry.",
      );
    }
  };
  if (action === "check") return run();
  const result = run().finally(() => mutations.delete(adapter));
  mutations.set(adapter, { action, result });
  return result;
}
