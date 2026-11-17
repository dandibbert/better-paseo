import { describe, expect, it, vi } from "vitest";
import {
  createAgyUsageSource,
  parseAgyQuota,
  versionSupportsQuota,
  type AgyRunner,
} from "../../server/agy-usage-source";

const quota = {
  status: "SUCCESS",
  num_turns: 0,
  command: {
    name: "usage",
    data: {
      groups: [
        { name: "Gemini Models", buckets: [
          { id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.44, reset_time: "2026-11-22T08:00:00Z" },
          { id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 1, reset_time: "2026-11-17T12:00:00Z" },
        ] },
        { name: "Claude and GPT models", buckets: [
          { id: "3p-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.125, reset_time: "2026-11-21T13:00:00Z" },
          { id: "3p-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: null },
        ] },
      ],
    },
  },
};

function fakeRunner(version = "1.2.13") {
  const run = vi.fn<AgyRunner>(async (_cmd, args) =>
    args.includes("--version") ? { stdout: version } : { stdout: JSON.stringify(quota) });
  const source = createAgyUsageSource(run);
  return { run, source };
}

describe("AGY /usage report", () => {
  it("shows Gemini and Claude/GPT quota groups, used/remaining share, and reset times", () => {
    const result = parseAgyQuota(JSON.stringify(quota));
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.windows).toEqual([
      expect.objectContaining({
        id: "Gemini Models/gemini-weekly", label: "Gemini Models · Weekly", shortLabel: "Gemini wk",
        usedPct: 56, remainingPct: 44, resetsAt: "2026-11-22T08:00:00.000Z", summary: true,
      }),
      expect.objectContaining({
        id: "Gemini Models/gemini-5h", shortLabel: "Gemini 5h", usedPct: 0,
        remainingPct: 100, summary: true,
      }),
      expect.objectContaining({
        id: "Claude and GPT models/3p-weekly", shortLabel: "Claude/GPT wk",
        usedPct: 87.5, remainingPct: 12.5, summary: false,
      }),
    ]);
  });

  it("drops incomplete or invalid quota buckets without fabricating exhausted limits", () => {
    const raw = JSON.parse(JSON.stringify(quota));
    raw.command.data.groups[0].buckets = [
      { id: "missing", name: "Unknown", window: "weekly" },
      { id: "negative", name: "Unknown", window: "weekly", remaining_fraction: -1 },
      { id: "spent", name: "Five Hour", window: "5h", remaining_fraction: 0, reset_time: "not-a-date" },
    ];
    const result = parseAgyQuota(JSON.stringify(raw));
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.windows[0]).toMatchObject({
      id: "Gemini Models/spent", usedPct: 100, remainingPct: 0, resetsAt: null,
    });
    expect(result.windows).toHaveLength(2);
  });

  it("rejects a model turn, unrelated commands, missing groups, and text pretending to be a report", () => {
    expect(parseAgyQuota(JSON.stringify({ ...quota, num_turns: 1 }))).toMatchObject({ status: "error" });
    expect(parseAgyQuota(JSON.stringify({ ...quota, command: { ...quota.command, name: "chat" } }))).toMatchObject({ status: "error" });
    expect(parseAgyQuota("Hello from a model")).toMatchObject({ status: "error" });
    expect(parseAgyQuota(JSON.stringify({ ...quota, command: { name: "usage", data: {} } }))).toMatchObject({ status: "unavailable" });
  });

  it("handles signout and accepts /quota as an AGY alias", () => {
    expect(parseAgyQuota("Please sign in to AGY")).toEqual({
      status: "unavailable", problem: { kind: "rejected", status: 401, refreshedBy: "agy" },
    });
    expect(parseAgyQuota(JSON.stringify({ ...quota, command: { ...quota.command, name: "quota" } }))).toMatchObject({ status: "available" });
  });
});

describe("Better Paseo AGY Usage Source", () => {
  it("requires a safe AGY version before querying; never runs a model prompt", async () => {
    expect(versionSupportsQuota("1.1.14")).toBe(false);
    expect(versionSupportsQuota("1.1.15")).toBe(true);
    expect(versionSupportsQuota("1.2.13")).toBe(true);
    expect(versionSupportsQuota("unknown")).toBe(false);
    const { source, run } = fakeRunner("1.1.10");
    expect(await source.discover({ kind: "global" })).toEqual([]);
    expect(run.mock.calls.every((call) => call[1].includes("--version"))).toBe(true);
  });

  it("provides an account card on the existing Usage page only for AGY", async () => {
    const { source, run } = fakeRunner();
    expect(await source.discover({ kind: "session", provider: "codex", env: {} })).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    const accounts = await source.discover({ kind: "global" });
    expect(source.id).toBe("better-paseo-agy");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      key: expect.stringMatching(/^[a-f0-9]{64}$/), label: "AGY CLI",
      harness: "Antigravity", input: { key: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    const report = await source.fetch(accounts[0]!.input);
    expect(report.status).toBe("available");
    const args = run.mock.calls.map((call) => call[1]);
    expect(args).toContainEqual(["-p", "/usage", "--output-format", "json"]);
    expect(args.every((value) => !value.includes("--disable-slash-commands")
      && !value.includes("--input-format") && !value.includes("--conversation") && !value.includes("--model"))).toBe(true);
  });

  it("identifies separate AGY HOME environments without exposing their paths or credentials", async () => {
    const { source } = fakeRunner();
    const first = await source.discover({ kind: "session", provider: "antigravity", env: { HOME: "/first", AGY_KEY: "secret" } });
    const second = await source.discover({ kind: "session", provider: "antigravity", env: { HOME: "/second" } });
    expect(first[0]!.key).not.toBe(second[0]!.key);
    expect(JSON.stringify(first) + JSON.stringify(second)).not.toMatch(/\/first|\/second|secret/);
  });

  it("refuses unknown account locators and reports signed-out AGY without leaking credentials", async () => {
    const { source } = fakeRunner();
    expect(await source.fetch({ key: "a".repeat(64) })).toMatchObject({ status: "error" });
    const run = vi.fn<AgyRunner>(async (_cmd, args) => {
      if (args.includes("--version")) return { stdout: "1.2.13" };
      throw new Error("Please sign in");
    });
    const rejected = createAgyUsageSource(run);
    const discovered = await rejected.discover({ kind: "global" });
    expect(await rejected.fetch(discovered[0]!.input)).toEqual({
      status: "unavailable", problem: { kind: "rejected", status: 401, refreshedBy: "agy" },
    });
  });
});
