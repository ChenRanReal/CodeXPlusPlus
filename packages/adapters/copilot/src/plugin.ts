import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { createHarnessInstaller, resolveNpmUninstaller } from "@codexhost/harness-discovery";
import { CopilotAdapter } from "./adapter.js";
import { resolveCopilotExecutable } from "./command.js";
import { createCopilotInstallation } from "./installation.js";

export function createHarnessAdapter(context: HarnessPluginContext): CopilotAdapter {
  const environment = { ...context.environment };
  return Object.assign(new CopilotAdapter(environment), {
    installation: createCopilotInstallation(environment),
    install: createHarnessInstaller(environment, { npm: "@github/copilot" }),
    resolveUninstaller: () =>
      resolveNpmUninstaller(
        resolveCopilotExecutable({ environment }),
        "@github/copilot",
        environment,
      ),
  });
}
