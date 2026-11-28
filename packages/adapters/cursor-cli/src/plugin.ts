import { createHarnessInstaller } from "@codexhost/harness-discovery";
import { CURSOR_COMMAND_CATALOG } from "./slash-commands.js";
import { createCursorInstallation } from "./installation.js";
import { resolveCursorUninstaller } from "./uninstall.js";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { CursorAdapter } from "./adapter.js";
import { CursorNotInstalledError, resolveCursorExecutable } from "./command.js";
import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";
import type { HarnessAdapter } from "@codexhost/harness-adapter";

export function createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter {
  const environment = { ...context.environment };
  const maintenance = {
    resolveUninstaller: () => resolveCursorUninstaller(environment),
    install: createHarnessInstaller(environment, {
      posix: "https://cursor.com/install",
      windows: "https://cursor.com/install?win32=true",
    }),
  };
  if (context.platform === "darwin" && context.managedRemoteHost) {
    return Object.assign(
      new BrokeredHarnessAdapter({
        sessionImport: true,
        accountCredits: false,
        harnessId: "cursor-cli",
        forwardDelegationEnvironment: true,
        commandCatalog: CURSOR_COMMAND_CATALOG,
        liveCommandCatalog: true,
        environment,
        isInstalled: () => {
          try {
            resolveCursorExecutable(environment);
            return true;
          } catch (error) {
            return !(error instanceof CursorNotInstalledError);
          }
        },
      }),
      maintenance,
    );
  }
  return Object.assign(new CursorAdapter({ environment }), {
    installation: createCursorInstallation(environment),
    ...maintenance,
  });
}
