import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  harnessAccountSnapshotSchema,
  type HarnessAccountSnapshot,
} from "@codexhost/shared-contracts";

const execute = promisify(execFile);
const DPAPI_BLOB = /^[A-Za-z0-9+/]+={0,2}$/u;
const DPAPI_UNPROTECT = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  "Add-Type -AssemblyName System.Security",
  "$r=[Console]::In.ReadToEnd()|ConvertFrom-Json",
  "$s=[Security.Cryptography.DataProtectionScope]::CurrentUser",
  "$d=[Convert]::FromBase64String($r.data)",
  "try{$u=[Security.Cryptography.ProtectedData]::Unprotect($d,$null,$s)}catch{[Console]::Error.Write($_.Exception.GetBaseException().GetType().FullName);exit 3}",
  "[Console]::Out.Write('F'+[Convert]::ToBase64String($u))",
].join(";");
const ENDPOINT = "https://api2.cursor.sh/aiserver.v1.DashboardService/";
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const percent = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(100, value)
    : undefined;

/** Use native percentage fields. Spend divided by limit omits bonus and model buckets. */
export function projectCursorAccountUsage(
  usage: unknown,
  identity: unknown,
  plan: unknown,
): HarnessAccountSnapshot | null {
  const data = record(usage);
  const buckets = record(data.planUsage);
  const usedPercent = percent(buckets.autoPercentUsed);
  if (usedPercent === undefined) return null;
  const end =
    typeof data.billingCycleEnd === "string" || typeof data.billingCycleEnd === "number"
      ? Number(data.billingCycleEnd)
      : NaN;
  const date = new Date(end);
  const resetsAt = Number.isFinite(date.getTime()) && end > 0 ? date.toISOString() : undefined;
  const apiPercent = percent(buckets.apiPercentUsed);
  const email = record(identity).email;
  const planName = record(record(plan).planInfo).planName;
  const result = harnessAccountSnapshotSchema.safeParse({
    ...(typeof email === "string" && email.trim() ? { email } : {}),
    ...(typeof planName === "string" && planName.trim() ? { plan: planName } : {}),
    credits: {
      usedPercent,
      label: "Auto · monthly",
      scope: { id: "auto", label: "Auto" },
      periodType: "monthly",
      ...(resetsAt ? { resetsAt } : {}),
      ...(apiPercent === undefined
        ? {}
        : {
            productUsage: [
              {
                product: "API · monthly",
                periodType: "monthly",
                scope: { id: "api", label: "API" },
                usagePercent: apiPercent,
                ...(resetsAt ? { resetsAt } : {}),
              },
            ],
          }),
    },
  });
  return result.success ? result.data : null;
}

function powershellExecutable(environment: NodeJS.ProcessEnv): string {
  const root = environment.SystemRoot ?? environment.SYSTEMROOT;
  return root
    ? path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function runPowershell(
  environment: NodeJS.ProcessEnv,
  script: string,
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellExecutable(environment),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("DPAPI unprotect timed out"));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", () => undefined);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`DPAPI unprotect failed (${code ?? "unknown"})`));
    });
    child.stdin.end(input);
  });
}

/** Cursor CLI stores the OAuth token beside auth.json when auth.json only says `os-secret-store`. */
export async function readWindowsCursorAccessToken(
  directory: string,
  unprotect: (blob: string) => Promise<string>,
): Promise<string | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(directory, "auth.dpapi"), "utf8"));
  } catch {
    return undefined;
  }
  const blob = record(parsed).dpapi;
  if (record(parsed).version !== 1 || typeof blob !== "string" || !DPAPI_BLOB.test(blob))
    return undefined;
  let plain: string;
  try {
    plain = await unprotect(blob);
  } catch {
    return undefined;
  }
  let secret: unknown;
  try {
    secret = JSON.parse(plain);
  } catch {
    return undefined;
  }
  const token = record(secret).accessToken;
  return typeof token === "string" && token.trim() ? token : undefined;
}

async function unprotectWindowsDpapi(
  environment: NodeJS.ProcessEnv,
  blob: string,
): Promise<string> {
  const stdout = (
    await runPowershell(environment, DPAPI_UNPROTECT, JSON.stringify({ data: blob }))
  ).trim();
  const encoded = stdout.startsWith("F") ? stdout.slice(1) : "";
  if (!DPAPI_BLOB.test(encoded)) throw new Error("DPAPI unprotect returned an unexpected response");
  return Buffer.from(encoded, "base64").toString("utf8");
}

async function accessToken(environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (environment.CURSOR_API_KEY?.trim() || environment.AGENT_CLI_CREDENTIAL_STORE === "memory")
    return undefined;
  if (process.platform === "darwin" && environment.AGENT_CLI_CREDENTIAL_STORE !== "file") {
    const result = await execute(
      "/usr/bin/security",
      ["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"],
      { timeout: 5000, maxBuffer: 64 * 1024 },
    );
    return result.stdout.trim() || undefined;
  }
  const home = environment.HOME ?? environment.USERPROFILE ?? homedir();
  const authPath =
    process.platform === "darwin"
      ? path.join(home, ".cursor", "auth.json")
      : process.platform === "win32"
        ? path.join(
            environment.APPDATA ?? path.join(home, "AppData", "Roaming"),
            "Cursor",
            "auth.json",
          )
        : path.join(
            environment.XDG_CONFIG_HOME ?? path.join(home, ".config"),
            "cursor",
            "auth.json",
          );
  let auth: Record<string, unknown>;
  try {
    auth = record(JSON.parse(await readFile(authPath, "utf8")));
  } catch {
    return undefined;
  }
  if (typeof auth.accessToken === "string" && auth.accessToken.trim()) return auth.accessToken;
  if (process.platform === "win32" && auth.storedIn === "os-secret-store") {
    return readWindowsCursorAccessToken(path.dirname(authPath), (blob) =>
      unprotectWindowsDpapi(environment, blob),
    );
  }
  return undefined;
}

export async function fetchCursorAccount(
  input: {
    environment?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    readAccessToken?: () => Promise<string | undefined>;
  } = {},
): Promise<HarnessAccountSnapshot | null> {
  try {
    const environment = input.environment ?? process.env;
    if (environment.CURSOR_API_KEY?.trim() || environment.AGENT_CLI_CREDENTIAL_STORE === "memory")
      return null;
    const token = await (input.readAccessToken
      ? input.readAccessToken()
      : accessToken(environment));
    if (!token) return null;
    const signal = input.signal
      ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    const request = async (method: string): Promise<unknown> => {
      const response = await (input.fetch ?? fetch)(ENDPOINT + method, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        body: "{}",
        signal,
      });
      return response.ok ? response.json() : null;
    };
    const [usage, identity, plan] = await Promise.all([
      request("GetCurrentPeriodUsage"),
      request("GetMe").catch(() => null),
      request("GetPlanInfo").catch(() => null),
    ]);
    return projectCursorAccountUsage(usage, identity, plan);
  } catch {
    return null;
  }
}
