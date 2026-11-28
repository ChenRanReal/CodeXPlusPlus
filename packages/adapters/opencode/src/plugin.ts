import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { createHarnessInstaller, npmInstallation } from "@codexhost/harness-discovery";
import { resolveOpenCodeExecutable } from "./command.js";
import { OpenCodeAdapter } from "./versioned-adapter.js";
import { createOpenCodeInstallation } from "./installation.js";

export const OPENCODE_COMMAND_ENV = "CODEXHOST_OPENCODE_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): OpenCodeAdapter {
  const environment = { ...context.environment };
  return Object.assign(
    new OpenCodeAdapter({
      ...(environment[OPENCODE_COMMAND_ENV] ? { command: environment[OPENCODE_COMMAND_ENV] } : {}),
      environment,
    }),
    {
      installation: createOpenCodeInstallation(environment, environment[OPENCODE_COMMAND_ENV]),
      async resolveUninstaller() {
        const command = environment[OPENCODE_COMMAND_ENV];
        const executable = resolveOpenCodeExecutable({
          environment,
          ...(command ? { command } : {}),
        });
        return (await npmInstallation(executable, ["opencode-ai"], environment))?.uninstall ?? null;
      },
      install: createHarnessInstaller(environment, { npm: "opencode-ai" }),
    },
  );
}
