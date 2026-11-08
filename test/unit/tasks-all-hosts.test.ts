import { describe, expect, it } from "vitest";
import { aggregateHostTasks } from "../../client/tasks/board/all-hosts-model";
import type { HostTaskSnapshots } from "../../client/tasks/board/all-hosts-model";
import type { LaneId, LaneModel, TaskCard } from "../../client/tasks/model";

const hosts = [
  { serverId: "m1", label: "M1 Builder" },
  { serverId: "m5", label: "M5 Pro" },
  { serverId: "bero", label: "Bero" },
] as const;
const LANE_IDS: LaneId[] = ["needs_input", "running", "review", "done", "archived"];

function task(id: string, lane: LaneId, title: string, time: string): TaskCard {
  return {
    id, lane, title, provider: "codex", providerLabel: "Codex",
    model: "gpt-6", modelLabel: "GPT-6", labels: [{ name: "build", color: null }],
    location: {
      projectName: "app", workspaceName: "main", branch: "feature",
      cwd: "/repo/app", projectId: "p", workspaceId: "w",
    },
    timing: { updatedAt: time },
  } as unknown as TaskCard;
}

function snapshot(cards: TaskCard[], ready = true): HostTaskSnapshots[string] {
  const lanes = Object.fromEntries(LANE_IDS.map((id) => [id, {
    id, cards: cards.filter((card) => card.lane === id),
    hasMore: false, loading: false,
  } satisfies LaneModel])) as Record<LaneId, LaneModel>;
  return { lanes, ready };
}

const initial: HostTaskSnapshots = {
  m1: snapshot([
    task("same-id", "running", "Build iOS", "2026-11-08T07:01:00Z"),
    task("old", "done", "Finished old build", "2026-11-05T07:01:00Z"),
  ]),
  m5: snapshot([
    task("same-id", "running", "Implement search", "2026-11-08T07:02:00Z"),
    task("input", "needs_input", "Approve shell", "2026-11-08T07:03:00Z"),
  ]),
  bero: snapshot([task("remote", "review", "Review results", "2026-11-08T06:00:00Z")]),
};

describe("all-hosts Tasks aggregation", () => {
  it("keeps equal agent ids on different daemons as distinct cards", () => {
    const result = aggregateHostTasks(hosts, initial, null, "");
    expect(result.running).toHaveLength(2);
    expect(new Set(result.running.map((item) => item.key)).size).toBe(2);
    expect(result.running.map((item) => item.hostLabel)).toEqual(["M5 Pro", "M1 Builder"]);
    expect(result.running.map((item) => item.card.title)).toEqual(["Implement search", "Build iOS"]);
  });

  it("filters by host without changing other hosts' snapshots", () => {
    const selected = aggregateHostTasks(hosts, initial, "m1", "");
    expect(selected.running).toHaveLength(1);
    expect(selected.running[0]?.serverId).toBe("m1");
    expect(selected.needs_input).toHaveLength(0);
    expect(initial.m5?.lanes.running.cards).toHaveLength(1);
  });

  it("searches host names, titles, paths and labels without cross-host mixing", () => {
    expect(aggregateHostTasks(hosts, initial, null, "bero").review).toHaveLength(1);
    expect(aggregateHostTasks(hosts, initial, null, "approve").needs_input).toHaveLength(1);
    expect(aggregateHostTasks(hosts, initial, null, "BUILD").running).toHaveLength(1);
    expect(aggregateHostTasks(hosts, initial, null, "nomatch").running).toHaveLength(0);
  });

  it("does not treat an unready or disconnected host as having finished tasks", () => {
    const sources: HostTaskSnapshots = { m1: initial.m1!, m5: snapshot([
      task("waiting", "needs_input", "Yet to load", "2026-11-08T07:04:00Z"),
    ], false) };
    const result = aggregateHostTasks(hosts, sources, null, "");
    expect(result.running).toHaveLength(1);
    expect(result.needs_input).toHaveLength(0);
    expect(result.review).toHaveLength(0);
  });

  it("preserves every lane, even when no host has any entries", () => {
    const result = aggregateHostTasks([], {}, null, "");
    expect(Object.keys(result)).toEqual(LANE_IDS);
    expect(LANE_IDS.every((lane) => result[lane].length === 0)).toBe(true);
  });
});
