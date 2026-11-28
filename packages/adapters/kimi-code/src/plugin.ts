import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import {
  createHarnessInstaller,
  resolveBinaryUninstaller,
  resolveNpmUninstaller,
  userInstallationPaths,
} from "@codexhost/harness-discovery";
import { KimiAdapter } from "./kimi-adapter.js";
import { createKimiInstallation } from "./installation.js";
import { KIMI_COMMAND_ENV, resolveKimiExecutable } from "./command.js";

export function createHarnessAdapter(context: HarnessPluginContext): KimiAdapter {
  const environment = { ...context.environment };
  return Object.assign(
    new KimiAdapter({
      ...(environment[KIMI_COMMAND_ENV] ? { command: environment[KIMI_COMMAND_ENV] } : {}),
      environment,
    }),
    {
      installation: createKimiInstallation(environment),
      async resolveUninstaller() {
        const executable = resolveKimiExecutable({ environment });
        const npm = await resolveNpmUninstaller(executable, "@moonshot-ai/kimi-code", environment);
        if (npm) return npm;
        const home = userInstallationPaths(environment).home;
        const name = context.platform === "win32" ? "kimi.exe" : "kimi";
        return environment.KIMI_INSTALL_DIR
          ? resolveBinaryUninstaller(executable, environment.KIMI_INSTALL_DIR, "bin", name)
          : resolveBinaryUninstaller(executable, home, ".kimi-code", "bin", name);
      },
      install: createHarnessInstaller(environment, {
        posix: "https://code.kimi.com/kimi-code/install.sh",
        windows: "https://code.kimi.com/kimi-code/install.ps1",
      }),
    },
  );
}
