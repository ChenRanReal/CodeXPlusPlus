import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import type { HarnessAccountSnapshot, HarnessLocalizations } from "@codexhost/shared-contracts";
import os from "node:os";
import path from "node:path";

const XAI_ISSUER = "https://auth.x.ai";
export const GROK_CREDITS_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/** The native CLI reads the subscription name from here (`subscription_tier_display`). */
export const GROK_SETTINGS_ENDPOINT = "https://cli-chat-proxy.grok.com/v1/settings";
const REQUEST_TIMEOUT_MS = 15_000;
/** The plan is optional decoration, so it never delays the quota for long. */
const PLAN_TIMEOUT_MS = 2_000;

export interface GrokProductUsage {
  product: string;
  localizations?: HarnessLocalizations | undefined;
  usagePercent: number;
}

export interface GrokCreditsSnapshot {
  usedPercent: number;
  resetsAt?: string;
  periodType: "weekly" | "monthly" | "unknown";
  productUsage?: GrokProductUsage[];
  fetchedAt: string;
}

export interface FetchGrokCreditsInput {
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  now?: Date;
  readAuthFile?(filePath: string): Promise<string>;
  writeAuthFile?(filePath: string, contents: string): Promise<void>;
  fetch?(url: string, init: RequestInit): Promise<Response>;
}

export interface FetchGrokAccountInput extends FetchGrokCreditsInput {
  /** Also read the subscription name for the account page; Composer polling skips it. */
  includePlan?: boolean;
  planTimeoutMs?: number;
}

/** The subscription name from native /v1/settings, or undefined when it is not usable. */
export function parseGrokPlan(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.subscription_tier_display !== "string") return undefined;
  const plan = value.subscription_tier_display.trim();
  return plan && plan.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(plan) ? plan : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePercent(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(100, Math.max(0, value));
}

function nonNegativeCentValue(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  // Grok's Cent wrapper can omit val for zero amounts.
  const amount = value.val === undefined ? 0 : value.val;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return undefined;
  return amount;
}

function grokHome(environment: NodeJS.ProcessEnv): string {
  return (
    environment.GROK_HOME ??
    path.join(environment.HOME ?? environment.USERPROFILE ?? os.homedir(), ".grok")
  );
}

function periodTypeFrom(value: unknown): GrokCreditsSnapshot["periodType"] {
  if (typeof value !== "string") return "unknown";
  const normalized = value.toUpperCase();
  if (normalized.includes("WEEKLY")) return "weekly";
  if (normalized.includes("MONTHLY")) return "monthly";
  return "unknown";
}

function productUsageFrom(value: unknown): GrokProductUsage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const products = value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.product !== "string") return [];
    const usagePercent = finitePercent(entry.usagePercent);
    const labels: Readonly<Record<string, string>> = {
      GrokBuild: "Build",
      GrokChat: "Chat",
      GrokImagine: "Imagine",
      GrokVoice: "Voice",
    };
    const label = Object.hasOwn(labels, entry.product) ? labels[entry.product] : undefined;
    return usagePercent === undefined
      ? []
      : [
          {
            product: entry.product,
            ...(label ? { localizations: { en: { label }, "zh-CN": { label } } } : {}),
            usagePercent,
          },
        ];
  });
  return products.length > 0 ? products : undefined;
}

export function parseGrokCreditsResponse(
  value: unknown,
  fetchedAt = new Date().toISOString(),
): GrokCreditsSnapshot | null {
  if (!isRecord(value) || !isRecord(value.config)) return null;
  const config = value.config;
  const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
  const periodType = periodTypeFrom(period?.type);
  const resetsAt =
    (typeof period?.end === "string" && period.end.length > 0 ? period.end : undefined) ??
    (typeof config.billingPeriodEnd === "string" && config.billingPeriodEnd.length > 0
      ? config.billingPeriodEnd
      : undefined);
  let usedPercent = finitePercent(config.creditUsagePercent);
  if (config.creditUsagePercent === undefined) {
    const monthlyLimit = nonNegativeCentValue(config.monthlyLimit);
    const used = nonNegativeCentValue(config.used);
    if (
      (config.monthlyLimit !== undefined && monthlyLimit === undefined) ||
      (config.used !== undefined && used === undefined)
    )
      return null;
    // Follow Grok's included-credit calculation, never the separate on-demand spending cap.
    if (monthlyLimit !== undefined && monthlyLimit > 0) {
      usedPercent = Math.min(100, ((used ?? 0) / monthlyLimit) * 100);
    } else if (
      periodType !== "unknown" &&
      resetsAt !== undefined &&
      Number.isFinite(Date.parse(resetsAt))
    ) {
      // Grok defaults omitted usage to zero. Require a recognizable period, not just any config.
      usedPercent = 0;
    }
  }
  if (usedPercent === undefined) return null;
  const productUsage = productUsageFrom(config.productUsage);
  return {
    usedPercent,
    periodType,
    fetchedAt,
    ...(resetsAt ? { resetsAt } : {}),
    ...(productUsage ? { productUsage } : {}),
  };
}

function isXaiIssuer(issuer: string): boolean {
  return issuer === XAI_ISSUER || issuer.startsWith(`${XAI_ISSUER}::`);
}

interface GrokAccess {
  key: string;
  email?: string;
  label?: string;
}

interface GrokAuthCandidate {
  issuer: string;
  entry: Record<string, unknown>;
}

function xaiEntries(auth: Record<string, unknown>): GrokAuthCandidate[] {
  return Object.entries(auth)
    .flatMap(([issuer, value]) =>
      isXaiIssuer(issuer) && isRecord(value) ? [{ issuer, entry: value }] : [],
    )
    .sort(
      (left, right) => Number(right.issuer === XAI_ISSUER) - Number(left.issuer === XAI_ISSUER),
    );
}

function accessFromEntry(entry: Record<string, unknown>): GrokAccess | null {
  if (typeof entry.key !== "string" || !entry.key) return null;
  return {
    key: entry.key,
    ...(typeof entry.email === "string" && entry.email.trim() ? { email: entry.email.trim() } : {}),
    ...(typeof entry.user_id === "string" && entry.user_id.trim()
      ? { label: entry.user_id.trim() }
      : {}),
  };
}

function accessExpired(entry: Record<string, unknown>, now: Date): boolean {
  if (typeof entry.expires_at !== "string") return false;
  const expiresAt = Date.parse(entry.expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

function refreshTokenOf(entry: Record<string, unknown>): string | undefined {
  return typeof entry.refresh_token === "string" && entry.refresh_token
    ? entry.refresh_token
    : undefined;
}

async function defaultWriteAuthFile(filePath: string, contents: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function requestSignal(input: FetchGrokAccountInput): AbortSignal {
  return input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

/** Refresh the native auth.json entry the same way the Grok CLI renews an expired OIDC access token. */
async function refreshGrokAccess(
  auth: Record<string, unknown>,
  candidate: GrokAuthCandidate,
  authPath: string,
  input: FetchGrokAccountInput,
  now: Date,
): Promise<GrokAccess | null> {
  const refreshToken = refreshTokenOf(candidate.entry);
  const clientId = candidate.entry.oidc_client_id;
  if (!refreshToken || typeof clientId !== "string" || !clientId.trim()) return null;
  if (candidate.entry.oidc_issuer !== undefined && candidate.entry.oidc_issuer !== XAI_ISSUER)
    return null;
  const fetchImpl = input.fetch ?? fetch;
  const discovery = await fetchImpl(`${XAI_ISSUER}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
    signal: requestSignal(input),
  });
  if (!discovery.ok) return null;
  const discovered = await discovery.json();
  const endpoint = isRecord(discovered) ? discovered.token_endpoint : undefined;
  if (typeof endpoint !== "string") return null;
  let tokenUrl: URL;
  try {
    tokenUrl = new URL(endpoint);
  } catch {
    return null;
  }
  if (tokenUrl.protocol !== "https:" || tokenUrl.origin !== XAI_ISSUER) return null;
  const refreshed = await fetchImpl(tokenUrl.href, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: requestSignal(input),
  });
  if (!refreshed.ok) return null;
  const body = await refreshed.json();
  if (!isRecord(body) || typeof body.access_token !== "string" || !body.access_token.trim())
    return null;
  candidate.entry.key = body.access_token;
  if (typeof body.refresh_token === "string" && body.refresh_token.trim()) {
    candidate.entry.refresh_token = body.refresh_token;
  }
  if (
    typeof body.expires_in === "number" &&
    Number.isFinite(body.expires_in) &&
    body.expires_in > 0
  ) {
    candidate.entry.expires_at = new Date(now.getTime() + body.expires_in * 1000).toISOString();
  } else {
    delete candidate.entry.expires_at;
  }
  const persist = input.writeAuthFile ?? (input.readAuthFile ? undefined : defaultWriteAuthFile);
  if (persist) await persist(authPath, `${JSON.stringify(auth, null, 2)}\n`).catch(() => undefined);
  return accessFromEntry(candidate.entry);
}

function selectAccessToken(auth: unknown, now: Date): GrokAccess | null {
  if (!isRecord(auth)) return null;
  for (const { entry } of xaiEntries(auth)) {
    if (accessExpired(entry, now)) continue;
    const access = accessFromEntry(entry);
    if (access) return access;
  }
  return null;
}

export async function fetchGrokAccount(
  input: FetchGrokAccountInput = {},
): Promise<HarnessAccountSnapshot | null> {
  try {
    const environment = input.environment ?? process.env;
    // Do not attribute a saved OAuth account to an explicitly API-configured environment.
    if (
      [environment.XAI_API_KEY, environment.GROK_API_KEY, environment.GROK_TOKEN].some((value) =>
        value?.trim(),
      )
    )
      return null;
    const now = input.now ?? new Date();
    const authPath = path.join(grokHome(environment), "auth.json");
    const raw = input.readAuthFile
      ? await input.readAuthFile(authPath)
      : await readFile(authPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    let token = selectAccessToken(parsed, now);
    let renewed = false;
    if (!token) {
      if (!isRecord(parsed)) return null;
      const candidate = xaiEntries(parsed).find((entry) => refreshTokenOf(entry.entry));
      if (!candidate) return null;
      token = await refreshGrokAccess(parsed, candidate, authPath, input, now);
      if (!token) return null;
      renewed = true;
    }
    const access = token;
    const fetchImpl = input.fetch ?? fetch;
    const request = (url: string, timeoutMs: number, bearer = access.key): Promise<Response> =>
      fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "x-xai-token-auth": "xai-grok-cli",
          Accept: "application/json",
        },
        signal: input.signal
          ? AbortSignal.any([input.signal, AbortSignal.timeout(timeoutMs)])
          : AbortSignal.timeout(timeoutMs),
      });
    const credits = request(GROK_CREDITS_ENDPOINT, REQUEST_TIMEOUT_MS);
    // Read in parallel with the quota; any failure only omits the plan.
    const plan =
      input.includePlan === false
        ? Promise.resolve(undefined)
        : request(GROK_SETTINGS_ENDPOINT, input.planTimeoutMs ?? PLAN_TIMEOUT_MS)
            .then(async (response) =>
              response.ok ? parseGrokPlan(await response.json()) : undefined,
            )
            .catch(() => undefined);
    let response = await credits;
    if (response.status === 401 && !renewed && isRecord(parsed)) {
      const candidate = xaiEntries(parsed).find((entry) => refreshTokenOf(entry.entry));
      const next = candidate
        ? await refreshGrokAccess(parsed, candidate, authPath, input, now)
        : null;
      if (!next) return null;
      token = next;
      response = await request(GROK_CREDITS_ENDPOINT, REQUEST_TIMEOUT_MS, next.key);
    }
    if (!response.ok) return null;
    const snapshot = parseGrokCreditsResponse(await response.json(), now.toISOString());
    if (!snapshot) return null;
    const planName = await plan;
    return {
      credits: {
        usedPercent: snapshot.usedPercent,
        periodType: snapshot.periodType,
        ...(snapshot.resetsAt ? { resetsAt: snapshot.resetsAt } : {}),
        ...(snapshot.productUsage ? { productUsage: [...snapshot.productUsage] } : {}),
      },
      ...(token.email ? { email: token.email } : {}),
      ...(token.label ? { label: token.label } : {}),
      ...(planName ? { plan: planName } : {}),
    };
  } catch {
    return null;
  }
}

export async function fetchGrokCredits(
  input: FetchGrokCreditsInput = {},
): Promise<GrokCreditsSnapshot | null> {
  const account = await fetchGrokAccount({ ...input, includePlan: false });
  if (!account?.credits) return null;
  const { credits } = account;
  return {
    usedPercent: credits.usedPercent,
    periodType:
      credits.periodType === "weekly" || credits.periodType === "monthly"
        ? credits.periodType
        : "unknown",
    fetchedAt: (input.now ?? new Date()).toISOString(),
    ...(credits.resetsAt ? { resetsAt: credits.resetsAt } : {}),
    ...(credits.productUsage ? { productUsage: credits.productUsage } : {}),
  };
}
