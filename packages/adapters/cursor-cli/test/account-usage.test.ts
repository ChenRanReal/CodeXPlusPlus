import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  fetchCursorAccount,
  projectCursorAccountUsage,
  readWindowsCursorAccessToken,
} from "../src/account-usage.js";

describe("Cursor account usage", () => {
  it("projects native Auto and API percentages without deriving spend", () => {
    expect(
      projectCursorAccountUsage(
        {
          billingCycleEnd: Date.parse("2026-10-01T00:00:00.000Z"),
          planUsage: { autoPercentUsed: 20, apiPercentUsed: 35 },
        },
        { email: "cursor@example.com" },
        { planInfo: { planName: "Pro" } },
      ),
    ).toEqual({
      email: "cursor@example.com",
      plan: "Pro",
      credits: {
        usedPercent: 20,
        label: "Auto · monthly",
        scope: { id: "auto", label: "Auto" },
        periodType: "monthly",
        resetsAt: "2026-10-01T00:00:00.000Z",
        productUsage: [
          {
            product: "API · monthly",
            periodType: "monthly",
            scope: { id: "api", label: "API" },
            usagePercent: 35,
            resetsAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      },
    });
    expect(projectCursorAccountUsage({ planUsage: { spend: 5, limit: 10 } }, {}, {})).toBeNull();
  });

  it("queries only the native Cursor dashboard with the supplied OAuth token", async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer native-token" });
      return new Response(
        JSON.stringify(
          url.endsWith("GetCurrentPeriodUsage")
            ? { planUsage: { autoPercentUsed: 12 } }
            : url.endsWith("GetMe")
              ? { email: "cursor@example.com" }
              : { planInfo: { planName: "Business" } },
        ),
        { status: 200 },
      );
    });
    await expect(
      fetchCursorAccount({
        environment: {},
        readAccessToken: async () => "native-token",
        fetch: fetch as typeof globalThis.fetch,
      }),
    ).resolves.toMatchObject({
      email: "cursor@example.com",
      plan: "Business",
      credits: { usedPercent: 12, periodType: "monthly" },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toMatch(/^https:\/\/api2\.cursor\.sh\/aiserver\.v1\.DashboardService\//u);
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer native-token",
      });
    }
  });

  it("reads the Windows DPAPI auth file when auth.json only names the OS secret store", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "cursor-auth-"));
    try {
      await writeFile(
        path.join(directory, "auth.dpapi"),
        JSON.stringify({ version: 1, dpapi: Buffer.from("blob").toString("base64") }),
        "utf8",
      );
      await expect(
        readWindowsCursorAccessToken(directory, async () =>
          JSON.stringify({ accessToken: "dpapi-token" }),
        ),
      ).resolves.toBe("dpapi-token");
      await expect(
        readWindowsCursorAccessToken(directory, async () => "not-json"),
      ).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
