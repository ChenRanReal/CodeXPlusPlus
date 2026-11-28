import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { createHarnessInstaller, resolveNpmUninstaller } from "@codexhost/harness-discovery";
import { resolveQwenCodeExecutable } from "./command.js";

import { QwenCodeAdapter } from "./qwen-code-adapter.js";

export const QWEN_CODE_COMMAND_ENV = "CODEXHOST_QWEN_COMMAND";

export function createHarnessAdapter(context: HarnessPluginContext): QwenCodeAdapter {
  const environment = { ...context.environment };
  const name = "@qwen-code/qwen-code";
  return Object.assign(
    new QwenCodeAdapter({
      ...(environment[QWEN_CODE_COMMAND_ENV]
        ? { command: environment[QWEN_CODE_COMMAND_ENV] }
        : {}),
      environment,
    }),
    {
      install: createHarnessInstaller(environment, { npm: name }),
      resolveUninstaller: () =>
        resolveNpmUninstaller(resolveQwenCodeExecutable({ environment }), name, environment),
    },
  );
}
