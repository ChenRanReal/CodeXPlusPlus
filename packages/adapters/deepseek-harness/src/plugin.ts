import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";

import { createHarnessInstaller, npmInstallation } from "@codexhost/harness-discovery";
import { deepSeekEnvironment, resolveDeepSeekCommand } from "./executable.js";
import { DeepSeekHarnessAdapter } from "./deepseek-harness-adapter.js";
import { createDeepSeekInstallation } from "./installation.js";

export const DEEPSEEK_HARNESS_COMMAND_ENV = "CODEXHOST_DEEPSEEK_HARNESS_COMMAND";
export const DEEPSEEK_HARNESS_ENDPOINT_ENV = "CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT";

export function createHarnessAdapter(context: HarnessPluginContext): DeepSeekHarnessAdapter {
  const environment = { ...context.environment };
  const openLocalUrl = context.openLocalUrl;
  return Object.assign(
    new DeepSeekHarnessAdapter({
      ...(environment[DEEPSEEK_HARNESS_COMMAND_ENV]
        ? { command: environment[DEEPSEEK_HARNESS_COMMAND_ENV] }
        : {}),
      ...(environment[DEEPSEEK_HARNESS_ENDPOINT_ENV]
        ? { endpoint: environment[DEEPSEEK_HARNESS_ENDPOINT_ENV] }
        : {}),
      environment,
      ...(!context.managedRemoteHost && openLocalUrl
        ? { openWebUi: (url: URL) => openLocalUrl(url.href) }
        : {}),
    }),
    {
      install: createHarnessInstaller(environment, { npm: "@deepseek-ai/dsh@latest" }),
      async resolveUninstaller() {
        const invocation = resolveDeepSeekCommand(
          environment[DEEPSEEK_HARNESS_COMMAND_ENV],
          environment,
        );
        if (!invocation || invocation.kind === "npx") return null;
        return (
          (
            await npmInstallation(
              invocation.command,
              ["@deepseek-ai/dsh"],
              deepSeekEnvironment(invocation.command, environment),
            )
          )?.uninstall ?? null
        );
      },
      installation: createDeepSeekInstallation(
        environment,
        environment[DEEPSEEK_HARNESS_COMMAND_ENV],
      ),
    },
  );
}
