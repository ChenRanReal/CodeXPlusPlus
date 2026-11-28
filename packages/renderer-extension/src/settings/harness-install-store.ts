import type { ExternalRendererAgent } from "../agent-selection-state.js";
import type { RendererConnectionDiagnostics } from "./connections-page.js";

type InstallState = {
  status: "installing" | "uninstalling" | "checking" | "error";
  error?: string;
};

// Connection-owned, not page-owned: switching Hosts or closing settings does not
// cancel a request or lose its result. No commands or install sources live here.
function errorMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message.slice(0, 2048)
    : "Could not install the Harness. Check the official installation guide and retry.";
}

function unknownInstallOutcome(message: string): boolean {
  return /outcome is unknown|do not retry automatically|did not answer in time/i.test(message);
}

const stores = new WeakMap<RendererConnectionDiagnostics, ReturnType<typeof createStore>>();
function createStore(diagnostics: RendererConnectionDiagnostics) {
  const states = new Map<string, InstallState>();
  const uninstallChecks = new Map<string, boolean | Promise<void>>();
  const listeners = new Set<() => void>();
  const key = (host: string, agent: ExternalRendererAgent) => JSON.stringify([host, agent]);
  const notify = () => listeners.forEach((listener) => listener());
  return {
    get: (host: string, agent: ExternalRendererAgent) => states.get(key(host, agent)),
    canUninstall: (host: string, agent: ExternalRendererAgent) =>
      uninstallChecks.get(key(host, agent)) === true,
    checkUninstall(host: string, agent: ExternalRendererAgent) {
      const id = key(host, agent);
      if (
        !diagnostics.installation ||
        uninstallChecks.has(id) ||
        states.get(id)?.status === "uninstalling"
      )
        return;
      const check = diagnostics
        .installation(host, agent, "checkUninstall")
        .then(
          (result) => result.canUninstall === true,
          () => false,
        )
        .then((supported) => {
          if (uninstallChecks.get(id) !== check) return;
          uninstallChecks.set(id, supported);
          notify();
        });
      uninstallChecks.set(id, check);
    },
    clearErrors() {
      for (const [id, state] of states) if (state.status === "error") states.delete(id);
      uninstallChecks.clear();
      notify();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async run(
      host: string,
      agent: ExternalRendererAgent,
      action: "install" | "uninstall",
      uninstallFailure?: string,
    ) {
      const id = key(host, agent);
      const previous = states.get(id);
      if (!diagnostics.installation || (previous && previous.status !== "error")) return;
      states.set(id, { status: action === "install" ? "installing" : "uninstalling" });
      notify();
      let failure: string | undefined;
      let outcomeUnknown = false;
      let stillInstalled = false;
      try {
        await diagnostics.installation(host, agent, action);
        if (action === "install") {
          states.set(id, { status: "checking" });
          notify();
        }
      } catch (error) {
        outcomeUnknown = unknownInstallOutcome(errorMessage(error));
        failure = uninstallFailure ?? errorMessage(error);
      }
      // Reconcile the row with fresh diagnostics even after a mutation fails.
      try {
        await diagnostics.refresh(host);
        const refreshed = diagnostics
          .snapshot()
          .hosts.find((candidate) => candidate.hostId === host)
          ?.agents.find((candidate) => candidate.agent === agent);
        // A successful fresh diagnosis is authoritative even when version
        // readback (e.g. its latest-version endpoint) failed after installation.
        // A timed-out installer may still have written the CLI; protocol or
        // Provider setup can remain incomplete without that being an install miss.
        if (action === "uninstall") {
          stillInstalled = Boolean(refreshed && refreshed.availability !== "notInstalled");
          if (outcomeUnknown && refreshed?.availability === "notInstalled") failure = undefined;
        } else if (refreshed?.availability === "ready") failure = undefined;
        else if (
          failure &&
          outcomeUnknown &&
          refreshed &&
          refreshed.availability !== "notInstalled"
        ) {
          failure = undefined;
        }
      } catch (error) {
        failure ??= uninstallFailure ?? errorMessage(error);
      }
      uninstallChecks.delete(id);
      if (failure) states.set(id, { status: "error", error: failure });
      else states.delete(id);
      notify();
      return stillInstalled;
    },
  };
}

export function harnessInstallStore(diagnostics: RendererConnectionDiagnostics) {
  let store = stores.get(diagnostics);
  if (!store) {
    store = createStore(diagnostics);
    stores.set(diagnostics, store);
  }
  return store;
}
