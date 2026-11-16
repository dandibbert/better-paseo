import { describe, expect, it } from "vitest";
import { estimateTurn, findRates, sessionSpend } from "../../server/session-spend";

const rates = { input: 2, output: 8, cache_read: 0.5, cache_write: 2.5 };

describe("session API-equivalent pricing", () => {
  it("uses exact model identity and rejects conflicting provider prices", () => {
    const models = [
      { id: "gpt-6", provider: "openai", cost: rates },
      { id: "gpt-6", provider: "third-party", cost: { input: 3, output: 10 } },
    ];
    expect(findRates(models, "gpt-6")).toBeNull();
    expect(findRates(models, "gpt-6", "codex")).toEqual(rates);
    expect(findRates(models, "missing", "codex")).toBeNull();
  });

  it("subtracts cached tokens from inclusive OpenAI input and counts write cache separately", () => {
    const usage = { inputTokens: 1000, cachedInputTokens: 600, cacheCreationInputTokens: 0, outputTokens: 200 };
    expect(estimateTurn(usage, rates, "codex")).toBeCloseTo((400 * 2 + 600 * 0.5 + 200 * 8) / 1_000_000);
    expect(estimateTurn({ ...usage, inputTokens: 100, cachedInputTokens: 0, cacheCreationInputTokens: 50 }, rates, "claude"))
      .toBeCloseTo((100 * 2 + 50 * 2.5 + 200 * 8) / 1_000_000);
  });

  it("uses the last cumulative reported cost instead of summing snapshots", async () => {
    const turns = [
      { turnId: "a", endedAt: 1, usage: { totalCostUsd: 0.8 } },
      { turnId: "b", endedAt: 2, usage: { totalCostUsd: 1.2 } },
    ];
    expect(await sessionSpend(turns, "claude")).toEqual({
      usd: 1.2, source: "reported", pricedTurns: 2, totalTurns: 2, priceSource: null,
    });
  });
});
