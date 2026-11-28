import { commandInvocation, resolveHarnessExecutable } from "@codexhost/harness-discovery";

/** Selects the CLI, including the per-user Windows installation. */
export function resolveDevinExecutable(environment: NodeJS.ProcessEnv, command?: string) {
  const resolution = resolveHarnessExecutable(
    {
      id: "devin",
      command: "devin",
      commandEnvironmentVariable: "CODEXHOST_DEVIN_COMMAND",
      installRoots: {
        posix: ["~/.local/bin", "/usr/local/bin", "/opt/homebrew/bin"],
        windows: ["${LOCALAPPDATA}/devin/cli/bin"],
      },
    },
    { environment, ...(command ? { command } : {}) },
  );
  if (!resolution)
    throw new Error("Devin CLI is not installed; install devin or set CODEXHOST_DEVIN_COMMAND");
  return resolution.executable;
}

export function devinInvocation(environment: NodeJS.ProcessEnv, command?: string) {
  return commandInvocation(resolveDevinExecutable(environment, command), ["acp"], environment);
}
