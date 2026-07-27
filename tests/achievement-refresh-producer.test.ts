import { describe, expect, it, vi } from "vitest";

vi.mock("../src/clients/redis.js", () => ({ default: {} }));

import {
  achievementRefreshRemainingTime,
  requestAchievementRefresh,
} from "../src/clients/achievement-refresh.js";

const accepted = {
  jobId: `api-achievement-refresh-${"a".repeat(64)}`,
  workflowId: `api-achievement-refresh-${"a".repeat(64)}`,
  statusUrl: "/v1/jobs/accepted-achievement-refresh",
  deduplicated: false,
};

function createCache() {
  const values = new Map<string, string>();
  return {
    values,
    cacheGet: vi.fn(async (key: string) => values.get(key) ?? null),
    cacheSet: vi.fn(
      async (
        key: string,
        value: string,
        _ttlMs: number,
        onlyIfAbsent: boolean,
      ) => {
        if (onlyIfAbsent && values.has(key)) return null;
        values.set(key, value);
        return "OK";
      },
    ),
  };
}

describe("achievement refresh Temporal producer", () => {
  it("stores accepted Temporal metadata with the original cooldown timestamp", async () => {
    const cache = createCache();
    const submit = vi.fn(async () => accepted);

    const result = await requestAchievementRefresh("account-1", 900_000, {
      ...cache,
      createRequestId: () => "cooldown_request_000001",
      now: () => 1_000_000,
      submit,
    });

    expect(submit).toHaveBeenCalledWith(
      "achievement-refresh",
      { accountId: "account-1" },
      { requestId: "cooldown_request_000001" },
    );
    expect(result).toMatchObject({
      reusedCooldown: false,
      metadata: {
        ...accepted,
        acceptedAt: new Date(1_000_000).toISOString(),
        jobType: "achievement-refresh",
        orchestrator: "temporal",
        timestamp: 1_000_000,
      },
    });

    const stored = cache.values.get("refresh-achievements:account-1");
    expect(stored).toBeDefined();
    expect(JSON.parse(stored ?? "{}")).toMatchObject(result.metadata ?? {});
    expect(cache.cacheSet).toHaveBeenLastCalledWith(
      "refresh-achievements:account-1",
      expect.any(String),
      900_000,
      false,
    );
  });

  it("reuses an existing valid cooldown without starting another workflow", async () => {
    const cache = createCache();
    cache.values.set(
      "refresh-achievements:account-2",
      JSON.stringify({ timestamp: 1_000_000 }),
    );
    const submit = vi.fn(async () => accepted);

    await expect(
      requestAchievementRefresh("account-2", 900_000, {
        ...cache,
        now: () => 1_001_000,
        submit,
      }),
    ).resolves.toEqual({ reusedCooldown: true });
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps the same Redis-backed request identity after an ambiguous failure", async () => {
    const cache = createCache();
    const submit = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ ...accepted, deduplicated: true });
    const createRequestId = vi
      .fn()
      .mockReturnValueOnce("cooldown_request_000003")
      .mockReturnValueOnce("cooldown_request_ignored");
    const dependencies = {
      ...cache,
      createRequestId,
      now: () => 2_000_000,
      submit,
    };

    await expect(
      requestAchievementRefresh("account-3", 120_000, dependencies),
    ).rejects.toThrow("response lost");
    await expect(
      requestAchievementRefresh("account-3", 120_000, dependencies),
    ).resolves.toMatchObject({
      reusedCooldown: false,
      metadata: { deduplicated: true },
    });

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]?.[2]).toEqual({
      requestId: "cooldown_request_000003",
    });
    expect(submit.mock.calls[1]?.[2]).toEqual({
      requestId: "cooldown_request_000003",
    });
  });

  it("calculates the unchanged public cooldown window from stored timestamps", () => {
    expect(
      achievementRefreshRemainingTime(
        JSON.stringify({ timestamp: 1_000_000 }),
        900_000,
        1_150_000,
      ),
    ).toBe(750_000);
    expect(achievementRefreshRemainingTime(null, 900_000, 1_150_000)).toBe(0);
  });
});
