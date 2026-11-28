import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { ZcodeAdapter } from "./adapter.js";
import { createZcodeInstallation } from "./installation.js";
import { createZcodeInstaller, resolveZcodeUninstaller } from "./maintenance.js";
export function createHarnessAdapter(context: HarnessPluginContext) {
  const environment = { ...context.environment };
  const install =
    context.launchCommand || environment.CODEXHOST_ZCODE_APP
      ? undefined
      : createZcodeInstaller(environment);
  return Object.assign(
    new ZcodeAdapter({
      environment,
      ...(context.launchCommand ? { app: context.launchCommand } : {}),
      ...(context.openLocalPage ? { openLocalPage: context.openLocalPage } : {}),
    }),
    {
      installation: createZcodeInstallation(environment, context.launchCommand),
      ...(install ? { install } : {}),
      resolveUninstaller: () => resolveZcodeUninstaller(environment, context.launchCommand),
    },
  );
}
