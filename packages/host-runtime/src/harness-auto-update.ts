import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessAdapter } from "@codexhost/harness-adapter";
import {
  DEFAULT_HARNESS_AUTO_UPDATE_SETTINGS,
  harnessAutoUpdateCompletedSchema,
  harnessAutoUpdateDue,
  harnessAutoUpdateEligible,
  harnessAutoUpdateSettingsSchema,
  type HarnessAutoUpdateCompleted,
  type HarnessAutoUpdateSettings,
  type HarnessInstallationTask,
} from "@codexhost/shared-contracts";
import { HarnessInstallationTasks } from "./harness-installation-tasks.js";

function readLastRun(text: string): number | null {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || !("lastRunAt" in value)) return null;
  const lastRunAt = value.lastRunAt;
  return typeof lastRunAt === "number" && Number.isInteger(lastRunAt) && lastRunAt >= 0
    ? lastRunAt
    : null;
}

const CHECK_INTERVAL_MS = 60_000;
const TASK_POLL_MS = 500;
const TASK_WAIT_MS = 12 * 60_000;

/**
 * Updates installed Harness CLIs on the schedule saved in Harness preferences.
 * Manual downloads stay on the connections page. Nothing is announced when
 * every checked CLI is already current.
 */
export class HarnessAutoUpdate {
  readonly #file: string;
  #settings: HarnessAutoUpdateSettings | undefined;
  #remembered: number | null | undefined;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #stopped = false;

  constructor(
    private readonly options: {
      directory: string;
      adapters(): ReadonlyMap<string, HarnessAdapter>;
      waitForPlugins(): Promise<void>;
      tasks: HarnessInstallationTasks;
      label(harnessId: string): string;
      notify(result: HarnessAutoUpdateCompleted): void;
      diagnose(error: unknown): void;
      now?(): Date;
    },
  ) {
    this.#file = join(options.directory, "harness-auto-update-state.json");
  }

  configure(value: unknown): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#settings = harnessAutoUpdateSettingsSchema.parse(value);
    if (!this.#settings.enabled) {
      if (this.#timer) clearInterval(this.#timer);
      this.#timer = undefined;
      return Promise.resolve();
    }
    return this.start();
  }

  start(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    if (!this.#settings) return this.configure(DEFAULT_HARNESS_AUTO_UPDATE_SETTINGS);
    if (!this.#settings.enabled) return Promise.resolve();
    if (!this.#timer) {
      this.#timer = setInterval(() => void this.#run(), CHECK_INTERVAL_MS);
      this.#timer.unref();
    }
    return this.#run();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #run(): Promise<void> {
    if (this.#running || this.#stopped || !this.#settings?.enabled) return;
    this.#running = true;
    try {
      await this.#execute();
    } finally {
      this.#running = false;
    }
  }

  async #execute(): Promise<void> {
    try {
      const settings = this.#settings;
      if (!settings?.enabled) return;
      const now = this.#now();
      if (!harnessAutoUpdateDue(settings, await this.#lastRun(), now)) return;
      await this.options.waitForPlugins();
      const current = this.#settings;
      if (this.#stopped || !current?.enabled) return;
      const started = this.#now();
      if (!harnessAutoUpdateDue(current, await this.#lastRun(), started)) return;
      await this.#remember(started.getTime());
      const adapters = this.options.adapters();
      const ids = [...adapters.keys()]
        .filter((id) => adapters.get(id)?.installation)
        .sort((left, right) => left.localeCompare(right));
      const updated: string[] = [];
      const failed: string[] = [];
      for (const harnessId of ids) {
        if (this.#stopped) return;
        const name = this.options.label(harnessId);
        try {
          const checked = await this.#finish(
            this.options.tasks.start({ harnessId, action: "check" }, adapters),
          );
          if (checked.status !== "succeeded" || !harnessAutoUpdateEligible(checked.result))
            continue;
          const outcome = await this.#install(harnessId, adapters, checked.result.latestVersion);
          if (this.#installed(outcome)) updated.push(name);
          else failed.push(name);
        } catch (error) {
          failed.push(name);
          this.options.diagnose(error);
        }
      }
      if (updated.length || failed.length)
        this.options.notify(harnessAutoUpdateCompletedSchema.parse({ updated, failed }));
    } catch (error) {
      this.options.diagnose(error);
    }
  }

  async #install(
    harnessId: string,
    adapters: ReadonlyMap<string, HarnessAdapter>,
    latestVersion: string,
  ): Promise<HarnessInstallationTask> {
    let outcome = await this.#finish(
      this.options.tasks.start(
        { harnessId, action: "update", confirmedVersion: latestVersion },
        adapters,
      ),
    );
    if (
      outcome.status === "succeeded" &&
      outcome.result.confirmationRequired &&
      outcome.result.latestVersion !== latestVersion
    ) {
      outcome = await this.#finish(
        this.options.tasks.start(
          { harnessId, action: "update", confirmedVersion: outcome.result.latestVersion },
          adapters,
        ),
      );
    }
    return outcome;
  }

  #installed(task: HarnessInstallationTask): boolean {
    return task.status === "succeeded" && task.result.confirmationRequired !== true;
  }

  #now(): Date {
    return this.options.now?.() ?? new Date();
  }

  async #lastRun(): Promise<number | null> {
    if (this.#remembered !== undefined) return this.#remembered;
    try {
      this.#remembered = readLastRun(await readFile(this.#file, "utf8"));
    } catch {
      this.#remembered = null;
    }
    return this.#remembered;
  }

  async #remember(lastRunAt: number): Promise<void> {
    this.#remembered = lastRunAt;
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.options.directory, { recursive: true });
      await writeFile(temporary, `${JSON.stringify({ lastRunAt })}\n`, "utf8");
      await rename(temporary, this.#file);
    } catch (error) {
      this.options.diagnose(error);
    }
  }

  async #finish(task: HarnessInstallationTask): Promise<HarnessInstallationTask> {
    const deadline = Date.now() + TASK_WAIT_MS;
    let current = task;
    while (current.status === "running" && Date.now() <= deadline && !this.#stopped) {
      await new Promise((resolve) => setTimeout(resolve, current === task ? 0 : TASK_POLL_MS));
      try {
        current = this.options.tasks.status({ taskId: task.taskId });
      } catch {
        return current;
      }
    }
    return current;
  }
}
