import { z } from "zod";
import type { HarnessInstallationState } from "./harness-installation.js";

export const HARNESS_AUTO_UPDATE_INTERVAL_HOURS = [1, 6, 12, 24, 168] as const;
export const harnessAutoUpdateSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  intervalHours: z.union([
    z.literal(1),
    z.literal(6),
    z.literal(12),
    z.literal(24),
    z.literal(168),
  ]),
  /** Minutes from local midnight, 0–1439. */
  timeMinutes: z.number().int().min(0).max(1439),
  /** Local weekday, 0 Sunday through 6 Saturday. Used for a weekly interval. */
  weekday: z.number().int().min(0).max(6),
});
export type HarnessAutoUpdateSettings = z.infer<typeof harnessAutoUpdateSettingsSchema>;
export const DEFAULT_HARNESS_AUTO_UPDATE_SETTINGS: Readonly<HarnessAutoUpdateSettings> =
  Object.freeze({
    enabled: true,
    intervalHours: 24,
    timeMinutes: 9 * 60,
    weekday: 1,
  });
export const HARNESS_AUTO_UPDATE_COMPLETED_METHOD = "codexhost/harness/auto-update/completed";
export const harnessAutoUpdateCompletedSchema = z.strictObject({
  updated: z.array(z.string().min(1).max(128)).max(64),
  failed: z.array(z.string().min(1).max(128)).max(64),
});
export type HarnessAutoUpdateCompleted = z.infer<typeof harnessAutoUpdateCompletedSchema>;

/** Installed CLIs this Host can update, including targets that would otherwise ask for confirmation. */
export function harnessAutoUpdateEligible(
  state: Pick<HarnessInstallationState, "updateAvailable" | "canUpdate" | "manualUpdateUrl">,
): boolean {
  return state.updateAvailable && state.canUpdate && state.manualUpdateUrl === undefined;
}

const DAY_MINUTES = 24 * 60;

function atMinutes(day: Date, minutes: number): Date {
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    Math.floor(minutes / 60),
    minutes % 60,
    0,
    0,
  );
}

/** Latest local slot at or before `now`. */
function previousSlot(settings: HarnessAutoUpdateSettings, now: Date): Date {
  if (settings.intervalHours === 168) {
    for (let back = 0; back < 8; back += 1) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
      if (day.getDay() !== settings.weekday) continue;
      const slot = atMinutes(day, settings.timeMinutes);
      if (slot.getTime() <= now.getTime()) return slot;
    }
  } else if (settings.intervalHours === 24) {
    const today = atMinutes(now, settings.timeMinutes);
    if (today.getTime() <= now.getTime()) return today;
    return atMinutes(
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
      settings.timeMinutes,
    );
  } else {
    const intervalMinutes = settings.intervalHours * 60;
    const residue = settings.timeMinutes % intervalMinutes;
    for (let back = 0; back < 2; back += 1) {
      const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
      const maxMinute = back === 0 ? now.getHours() * 60 + now.getMinutes() : DAY_MINUTES - 1;
      const delta = (maxMinute - residue) % intervalMinutes;
      const minute = maxMinute - ((delta + intervalMinutes) % intervalMinutes);
      if (minute < 0) continue;
      const slot = atMinutes(day, minute);
      if (slot.getTime() <= now.getTime()) return slot;
    }
  }
  return atMinutes(now, 0);
}

/**
 * The first enabled run happens as soon as the Host is ready. Later runs wait
 * for the next selected slot, including one missed while the Host was down.
 */
export function harnessAutoUpdateDue(
  settings: HarnessAutoUpdateSettings,
  lastRunAt: number | null,
  now: Date,
): boolean {
  if (!settings.enabled) return false;
  if (lastRunAt === null) return true;
  return lastRunAt < previousSlot(settings, now).getTime();
}
