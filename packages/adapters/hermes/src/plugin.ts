import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { createHarnessInstaller, runInstallationCommand } from "@codexhost/harness-discovery";
import { HermesAdapter } from "./hermes-adapter.js";
import { createHermesInstallation } from "./installation.js";
import { resolveHermesExecutable } from "./command.js";

export const HERMES_COMMAND_ENV = "CODEXHOST_HERMES_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): HermesAdapter {
  const environment = { ...context.environment };
  return Object.assign(
    new HermesAdapter({
      ...(environment[HERMES_COMMAND_ENV] ? { command: environment[HERMES_COMMAND_ENV] } : {}),
      environment,
    }),
    {
      installation: createHermesInstallation(environment, environment[HERMES_COMMAND_ENV]),
      async resolveUninstaller() {
        const command = environment[HERMES_COMMAND_ENV];
        const executable = resolveHermesExecutable({
          environment,
          ...(command ? { command } : {}),
        });
        const plan = await runInstallationCommand(executable, ["update", "--plan"], environment);
        if (!/Install:\s*git\b/iu.test(plan)) return null;
        const help = await runInstallationCommand(executable, ["uninstall", "--help"], environment);
        if (!help.includes("--yes")) return null;
        return async () => {
          await runInstallationCommand(executable, ["uninstall", "--yes"], environment, 300_000);
        };
      },
      install: createHarnessInstaller(environment, {
        posix: "https://hermes-agent.nousresearch.com/install.sh",
        windows: "https://hermes-agent.nousresearch.com/install.ps1",
      }),
    },
  );
}
