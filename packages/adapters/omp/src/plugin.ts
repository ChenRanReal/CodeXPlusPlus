import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import {
  createHarnessInstaller,
  resolveBinaryUninstaller,
  resolveNpmUninstaller,
  userInstallationPaths,
} from "@codexhost/harness-discovery";
import { OmpAdapter } from "./omp-adapter.js";
import { createOmpInstallation } from "./installation.js";
import { resolveOmpExecutable } from "./command.js";

export const OMP_COMMAND_ENV = "CODEXHOST_OMP_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): OmpAdapter {
  const environment = { ...context.environment };
  return Object.assign(
    new OmpAdapter({
      ...(environment[OMP_COMMAND_ENV] ? { command: environment[OMP_COMMAND_ENV] } : {}),
      environment,
    }),
    {
      installation: createOmpInstallation(environment, environment[OMP_COMMAND_ENV]),
      async resolveUninstaller() {
        const command = environment[OMP_COMMAND_ENV];
        const executable = resolveOmpExecutable({ environment, ...(command ? { command } : {}) });
        const npm = await resolveNpmUninstaller(
          executable,
          "@oh-my-pi/pi-coding-agent",
          environment,
        );
        if (npm) return npm;
        const paths = userInstallationPaths(environment);
        const windows = context.platform === "win32";
        if (environment.PI_INSTALL_DIR)
          return resolveBinaryUninstaller(
            executable,
            environment.PI_INSTALL_DIR,
            windows ? "omp.exe" : "omp",
          );
        return windows
          ? resolveBinaryUninstaller(executable, paths.localAppData, "omp", "omp.exe")
          : resolveBinaryUninstaller(executable, paths.home, ".local", "bin", "omp");
      },
      install: createHarnessInstaller(environment, {
        posix: "https://omp.sh/install",
        windows: "https://omp.sh/install.ps1",
        shell: "sh",
      }),
    },
  );
}
