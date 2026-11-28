import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import { createHarnessInstaller } from "@codexhost/harness-discovery";
import { DevinAdapter } from "./adapter.js";
import { resolveDevinUninstaller } from "./uninstall.js";

export function createHarnessAdapter(context: HarnessPluginContext): HarnessAdapter {
  const environment = { ...context.environment };
  return Object.assign(new DevinAdapter({ environment }), {
    install: createHarnessInstaller(environment, {
      posix: "https://cli.devin.ai/install.sh",
      windows: "https://cli.devin.ai/install.ps1",
    }),
    resolveUninstaller: () => resolveDevinUninstaller(environment),
  });
}
