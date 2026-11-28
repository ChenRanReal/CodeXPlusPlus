import {
  createHarnessInstaller,
  npmInstallation,
  resolveHarnessExecutable,
} from "@codexhost/harness-discovery";
import { codeBuddyDiscoverySpec } from "./command.js";
import { CODEBUDDY_COMMAND_CATALOG } from "./slash-commands.js";
import type { HarnessPluginContext } from "@codexhost/harness-adapter/plugin";
import { CodeBuddyAdapter } from "./codebuddy-adapter.js";
import { createCodeBuddyInstallation } from "./installation.js";
import { BrokeredHarnessAdapter } from "@codexhost/harness-broker";

export function createHarnessAdapter(context: HarnessPluginContext) {
  const environment = { ...context.environment };
  const maintenance = {
    async resolveUninstaller() {
      const executable = resolveHarnessExecutable(codeBuddyDiscoverySpec, {
        environment,
      })?.executable;
      if (!executable) return null;
      return (
        (await npmInstallation(executable, ["@tencent-ai/codebuddy-code"], environment))
          ?.uninstall ?? null
      );
    },
    install: createHarnessInstaller(environment, { npm: "@tencent-ai/codebuddy-code" }),
  };
  if (context.platform === "darwin" && context.managedRemoteHost) {
    return Object.assign(
      new BrokeredHarnessAdapter({
        sessionImport: true,
        accountCredits: false,
        harnessId: "codebuddy",
        forwardDelegationEnvironment: true,
        commandCatalog: CODEBUDDY_COMMAND_CATALOG,
        liveCommandCatalog: true,
        environment,
        isInstalled: () =>
          resolveHarnessExecutable(codeBuddyDiscoverySpec, { environment }) !== undefined,
      }),
      maintenance,
    );
  }
  return Object.assign(new CodeBuddyAdapter({ environment }), {
    installation: createCodeBuddyInstallation(environment),
    ...maintenance,
  });
}
