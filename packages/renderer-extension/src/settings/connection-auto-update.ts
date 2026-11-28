import {
  DEFAULT_HARNESS_AUTO_UPDATE_SETTINGS,
  HARNESS_AUTO_UPDATE_INTERVAL_HOURS,
  harnessAutoUpdateSettingsSchema,
  type HarnessAutoUpdateSettings,
} from "@codexhost/shared-contracts";
import {
  HARNESS_PREFERENCES_UPDATED_EVENT,
  rendererHarnessPreferences,
  rendererHarnessPreferenceStatus,
  writeRendererHarnessPreferences,
} from "../renderer-harness-preferences.js";
import type { RendererSettingsMessages } from "./localization.js";
import {
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  preferenceId,
} from "./preference-ui.js";

function intervalLabel(
  messages: RendererSettingsMessages,
  hours: (typeof HARNESS_AUTO_UPDATE_INTERVAL_HOURS)[number],
): string {
  switch (hours) {
    case 1:
      return messages.harnessAutoUpdateHourly;
    case 6:
      return messages.harnessAutoUpdateEvery6Hours;
    case 12:
      return messages.harnessAutoUpdateEvery12Hours;
    case 24:
      return messages.harnessAutoUpdateDaily;
    case 168:
      return messages.harnessAutoUpdateWeekly;
  }
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function minutesFromClock(value: string): number | undefined {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return undefined;
  return hours * 60 + minutes;
}

/** Connections-page controls for this computer's Harness update schedule. */
export function mountConnectionAutoUpdate(
  document: Document,
  messages: RendererSettingsMessages,
  signal: AbortSignal,
) {
  const { group, card } = createPreferenceGroup(document, messages.harnessAutoUpdateSection);
  group.className = `${group.className} settings-connection-auto-update`;
  group.dataset.connectionAutoUpdate = "settings";
  const owner = document.defaultView;
  if (!owner) return { element: group, dispose: () => undefined };

  const enabledId = preferenceId("harness-auto-update");
  const toggle = createPreferenceItem(document, {
    title: messages.harnessAutoUpdateTitle,
    description: messages.harnessAutoUpdateDescription,
    controlId: enabledId,
  });
  const enabled = createPreferenceSwitch(document, enabledId, toggle.description.id);
  toggle.item.append(enabled);

  const intervalId = preferenceId("harness-auto-update-interval");
  const intervalRow = createPreferenceItem(document, {
    title: messages.harnessAutoUpdateInterval,
    description: messages.harnessAutoUpdateIntervalDescription,
    controlId: intervalId,
  });
  const interval = document.createElement("select");
  interval.id = intervalId;
  interval.className = "settings-connection-auto-update__control";
  for (const hours of HARNESS_AUTO_UPDATE_INTERVAL_HOURS) {
    const option = document.createElement("option");
    option.value = String(hours);
    option.textContent = intervalLabel(messages, hours);
    interval.append(option);
  }
  intervalRow.item.append(interval);

  const weekdayId = preferenceId("harness-auto-update-weekday");
  const weekdayRow = createPreferenceItem(document, {
    title: messages.harnessAutoUpdateWeekday,
    description: messages.harnessAutoUpdateWeekdayDescription,
    controlId: weekdayId,
  });
  const weekday = document.createElement("select");
  weekday.id = weekdayId;
  weekday.className = "settings-connection-auto-update__control";
  messages.harnessAutoUpdateWeekdays.forEach((name, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = name;
    weekday.append(option);
  });
  weekdayRow.item.append(weekday);

  const timeId = preferenceId("harness-auto-update-time");
  const timeRow = createPreferenceItem(document, {
    title: messages.harnessAutoUpdateTime,
    description: messages.harnessAutoUpdateTimeDescription,
    controlId: timeId,
  });
  const time = document.createElement("input");
  time.id = timeId;
  time.type = "time";
  time.className = "settings-connection-auto-update__control";
  timeRow.item.append(time);

  const status = document.createElement("p");
  status.className = "settings-connection-auto-update__status";
  status.setAttribute("role", "status");
  status.hidden = true;
  card.append(toggle.item, intervalRow.item, weekdayRow.item, timeRow.item, status);

  let draft: HarnessAutoUpdateSettings = {
    ...(rendererHarnessPreferences("local")?.values.harnessAutoUpdate ??
      DEFAULT_HARNESS_AUTO_UPDATE_SETTINGS),
  };
  const showStatus = (): void => {
    const failed = rendererHarnessPreferenceStatus("local") === "failed";
    status.hidden = !failed;
    status.textContent = failed ? messages.harnessAutoUpdateFailed : "";
  };
  const applyDraft = (): void => {
    enabled.checked = draft.enabled;
    interval.value = String(draft.intervalHours);
    weekday.value = String(draft.weekday);
    weekdayRow.item.hidden = draft.intervalHours !== 168;
    time.value = clock(draft.timeMinutes);
    const locked = !draft.enabled;
    interval.disabled = locked;
    weekday.disabled = locked;
    time.disabled = locked;
  };
  const sync = (): void => {
    showStatus();
    if (rendererHarnessPreferenceStatus("local") !== "pending") {
      draft = {
        ...(rendererHarnessPreferences("local")?.values.harnessAutoUpdate ??
          DEFAULT_HARNESS_AUTO_UPDATE_SETTINGS),
      };
    }
    applyDraft();
  };
  const save = (settings: HarnessAutoUpdateSettings): void => {
    const parsed = harnessAutoUpdateSettingsSchema.safeParse(settings);
    if (
      !parsed.success ||
      !rendererHarnessPreferences("local") ||
      rendererHarnessPreferenceStatus("local") === "unavailable"
    ) {
      status.hidden = false;
      status.textContent = messages.harnessAutoUpdateFailed;
      applyDraft();
      return;
    }
    void writeRendererHarnessPreferences(owner, "local", [
      { kind: "harnessAutoUpdate", value: parsed.data },
    ]).catch(() => undefined);
    draft = parsed.data;
    applyDraft();
  };

  enabled.addEventListener("change", () => save({ ...draft, enabled: enabled.checked }));
  interval.addEventListener("change", () => {
    const intervalHours = HARNESS_AUTO_UPDATE_INTERVAL_HOURS.find(
      (hours) => hours === Number(interval.value),
    );
    if (intervalHours === undefined) return;
    save({ ...draft, intervalHours });
  });
  weekday.addEventListener("change", () => save({ ...draft, weekday: Number(weekday.value) }));
  time.addEventListener("change", () => {
    const timeMinutes = minutesFromClock(time.value);
    if (timeMinutes === undefined) {
      time.value = clock(draft.timeMinutes);
      return;
    }
    save({ ...draft, timeMinutes });
  });

  const onPreferences = (): void => sync();
  const dispose = (): void => {
    owner.removeEventListener(HARNESS_PREFERENCES_UPDATED_EVENT, onPreferences);
  };
  owner.addEventListener(HARNESS_PREFERENCES_UPDATED_EVENT, onPreferences);
  signal.addEventListener("abort", dispose, { once: true });
  sync();
  return { element: group, dispose };
}
