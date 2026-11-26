import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./helpers/quiet-renderer";

type Card = import("../../client/tasks/model").TaskCard;

const host = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastShow: vi.fn(),
  settings: null as Record<string, unknown> | null,
  canRead: true,
  canStop: false,
  blockedAgents: new Set<string>(),
  readRpc: vi.fn(async (_input: { agentIds: string[] }) => ({ ok: true, error: null as string | null })),
  archiveRpc: vi.fn(async (_serverId: string, _agentId: string) => ({ archivedAt: "2026-11-26T00:00:00Z" })),
  detachRpc: vi.fn(async (_serverId: string, _agentId: string) => undefined),
  availabilityRpc: vi.fn(async (input: { agentIds: string[] }) => ({
    entries: input.agentIds.map((agentId) => ({
      agentId,
      availability: host.blockedAgents.has(agentId)
        ? {
            issue: { kind: "missingDirectory", path: "/missing" },
            blocked: {
              read: { kind: "missingDirectory", path: "/missing" },
              archive: { kind: "missingDirectory", path: "/missing" },
            },
          }
        : { issue: null, blocked: {} },
    })),
  })),
  reviewCards: [] as Card[],
  doneCards: [] as Card[],
  configuredHosts: [] as Array<{ serverId: string; label: string; status: "idle" | "connecting" | "online" | "offline" | "error" }>,
  remoteHostCards: new Map<object, { reviewCards: Card[]; doneCards: Card[] }>(),
  clientsByServerId: new Map<string, object>(),
}));

vi.mock("react-native", async () => {
  const rn = await import("./helpers/rn-mock");
  const AppState = { currentState: "active", addEventListener: () => ({ remove() {} }) };
  return { ...rn, AppState, findNodeHandle: (node: { nativeTag?: number } | null) => node?.nativeTag ?? null, default: { ...rn.default, AppState } };
});

vi.mock("../../client/components/selection-actions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../client/components/selection-actions")>(),
  useSelectionActions() {},
}));

vi.mock("@getpaseo/plugin/client/ui", async () => {
  const rn = await import("./helpers/rn-mock");
  const React = await import("react");
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  function FlatList(props: Props) {
    const data = (props.data as unknown[]) ?? [];
    const render = props.renderItem as (info: { item: unknown; index: number }) => React.ReactNode;
    const key = props.keyExtractor as (item: unknown, index: number) => string;
    const empty = props.ListEmptyComponent as React.ReactNode;
    return React.createElement(
      "FlatList",
      { testID: props.testID, data: props.data },
      data.length ? data.map((item, index) => React.createElement(React.Fragment, { key: key(item, index) }, render({ item, index }))) : empty,
      props.ListFooterComponent as React.ReactNode,
    );
  }
  function Modal(props: Props) {
    return props.open ? React.createElement("Modal", { title: props.title }, props.children) : null;
  }
  Modal.Content = (props: Props) => React.createElement("ModalContent", {}, props.children, props.footer as React.ReactNode);
  Modal.supportsFooter = false;
  return {
    Icon: (props: Props) => React.createElement("Icon", { name: props.name, icon: props.icon, size: props.size, color: props.color }),
    FlatList,
    Modal,
    ScrollView: rn.ScrollView,
    TextInput: rn.TextInput,
    SidebarRow: (props: Props) => React.createElement("SidebarRow", { label: props.label }, props.trailing as React.ReactNode),
    useToast: () => ({ show: host.toastShow, error: host.toastError }),
    copyText: async () => {},
  };
});

function makeHostApi(serverId: string) {
  return {
    agents: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id: string) => ({
        archive: () => host.archiveRpc(serverId, id),
        detach: () => host.detachRpc(serverId, id),
        timeline: {
          refetch: () => Promise.resolve({ error: null, entries: [], epoch: "test", endCursor: null, window: { nextSeq: 0 } }),
          subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
        },
      }),
    },
  };
}

const paseo = vi.hoisted(() => ({
  agents: {
    list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
    ref: (id: string) => ({
      archive: () => host.archiveRpc("host-1", id),
      detach: () => host.detachRpc("host-1", id),
      timeline: {
        refetch: () => Promise.resolve({ error: null, entries: [], epoch: "test", endCursor: null, window: { nextSeq: 0 } }),
        subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
      },
    }),
  },
}));

vi.mock("@getpaseo/plugin/client", () => ({
  usePaseo: () => paseo,
  useHosts: () => host.configuredHosts,
  getPaseoClient: (serverId: string) => host.clientsByServerId.get(serverId),
  useRpc: (contract: { name: string }) => {
    if (contract.name === "tasks.capabilities") return () => Promise.resolve({ stop: host.canStop, read: host.canRead });
    if (contract.name === "tasks.availability") return host.availabilityRpc;
    if (contract.name === "tasks.read") return host.readRpc;
    if (contract.name === "settings.agent-updates") return () => Promise.resolve({ state: "idle", entries: [], error: null });
    if (contract.name === "settings.update-check") return () => Promise.resolve({ state: "idle" });
    return () => Promise.resolve({});
  },
  useSettings: (definition: { id: string }) => {
    if (definition.id === "tasks" && host.settings) {
      return {
        status: "ready",
        values: host.settings,
        revision: "1",
        saving: false,
        saveError: null,
        save: async () => true,
        reload: async () => {},
      };
    }
    return { status: "loading" };
  },
}));

vi.mock("../../client/tasks/data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../client/tasks/data")>();
  const { LANE_ORDER } = await import("../../client/tasks/model");
  const React = await import("react");
  const cachedByApi = new WeakMap<object, { reviewCards: Card[]; doneCards: Card[]; handle: ReturnType<typeof actual.useTasks> }>();
  return {
    ...actual,
    useTasks: (api: object) => {
      const override = host.remoteHostCards.get(api);
      const reviewCards = override ? override.reviewCards : host.reviewCards;
      const doneCards = override ? override.doneCards : host.doneCards;
      return React.useMemo(() => {
        const hit = cachedByApi.get(api);
        if (hit && hit.reviewCards === reviewCards && hit.doneCards === doneCards) return hit.handle;
        const allCards = [...reviewCards, ...doneCards];
        const lanes = Object.fromEntries(
          LANE_ORDER.map((id) => [
            id,
            {
              id,
              cards: id === "review" ? reviewCards : id === "done" ? doneCards : [],
              hasMore: false,
              loading: false,
              initialLoading: false,
            },
          ]),
        );
        const handle = {
          lanes,
          counts: { needsInput: 0, running: 0, review: reviewCards.length, done: doneCards.length },
          byId: new Map(allCards.map((card) => [card.id, card])),
          workspaces: [{ id: "wks_1", name: "better-paseo", projectId: "prj_1", projectName: "better-paseo" }],
          providers: [{ id: "codex", label: "Codex" }],
          labels: [],
          ready: true,
          error: null,
          refresh: vi.fn(),
          refreshReads: vi.fn(),
          refreshUnreads: vi.fn(),
          loadMoreDone: vi.fn(),
          resolveParent: vi.fn(),
          refreshParent: vi.fn(async () => false),
          requestProjectIcon: vi.fn(),
        } as unknown as ReturnType<typeof actual.useTasks>;
        cachedByApi.set(api, { reviewCards, doneCards, handle });
        return handle;
      }, [api, reviewCards, doneCards]);
    },
    useTaskCounts: () => ({ needsInput: 0, running: 0, review: host.reviewCards.length, done: host.doneCards.length, ready: true }),
  };
});

import {
  READ_VERIFY_MS,
  useArchiveControl,
  useReadControl,
  type ArchiveControl,
  type ReadControl,
} from "../../client/tasks/actions";
import { TasksBoardScreen } from "../../client/tasks/board/board-screen";
import { resetTasksEnabled } from "../../client/tasks/board/enabled";
import { resetBoardSessions } from "../../client/tasks/board/params";
import { isArchivableDoneCard, isUnreadReviewCard, type TaskCard } from "../../client/tasks/model";
import { sampleCards } from "../../client/tasks/sample-cards";
import { DEFAULT_TASKS_SETTINGS } from "../../shared/tasks-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(globalThis, {
  requestAnimationFrame: (callback: (time: number) => void) => setTimeout(() => callback(Date.now()), 16),
  cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
});

const theme = {
  colors: {
    surface0: "#ffffff",
    surface1: "#f4f4f5",
    surface2: "#e4e4e7",
    border: "#e2e2e6",
    foreground: "#1b1b1f",
    foregroundMuted: "#6b6b75",
    accent: "#2563eb",
    accentForeground: "#ffffff",
    statusSuccess: "#198754",
    statusWarning: "#a36a00",
    statusDanger: "#d92d20",
  },
} as never;

const samples = sampleCards(Date.parse("2026-10-20T12:00:00Z"));
const templateReviewCard = samples.find((card) => card.lane === "review" && card.status === "unread")!;
const templateDoneCard = samples.find((card) => card.lane === "done")!;

function makeCard(id: string, overrides: Partial<TaskCard> = {}): TaskCard {
  const base = overrides.lane === "done" ? templateDoneCard : templateReviewCard;
  return {
    ...base,
    id,
    lane: overrides.lane ?? "review",
    status: overrides.lane === "done" ? "done" : "unread",
    readable: overrides.lane === "done" ? false : true,
    subagent: undefined,
    title: `Task ${id}`,
    ...overrides,
  };
}

function layOut(renderer: TestRenderer.ReactTestRenderer, width: number) {
  const laidOut = new Set<unknown>();
  for (let pass = 0; pass < 4; pass++) {
    const views = renderer.root.findAll(
      (node) =>
        (node.type as unknown) === "View" &&
        node.props.testID !== "lane-width-measure" &&
        node.props.testID !== "filter-bar" &&
        typeof node.props.onLayout === "function" &&
        !laidOut.has(node.props.onLayout),
    );
    if (views.length === 0) return;
    act(() => {
      for (const view of views) {
        laidOut.add(view.props.onLayout);
        view.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 800 } } });
      }
    });
  }
}

let renderer: TestRenderer.ReactTestRenderer | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  resetTasksEnabled();
  host.toastError.mockClear();
  host.toastShow.mockClear();
  host.settings = { ...DEFAULT_TASKS_SETTINGS, enabled: true, board: { ...DEFAULT_TASKS_SETTINGS.board, showArchived: false } };
  host.canRead = true;
  host.canStop = false;
  host.blockedAgents = new Set();
  host.readRpc.mockReset();
  host.readRpc.mockImplementation(async () => ({ ok: true, error: null }));
  host.archiveRpc.mockReset();
  host.archiveRpc.mockImplementation(async () => ({ archivedAt: "2026-11-26T00:00:00Z" }));
  host.detachRpc.mockReset();
  host.detachRpc.mockImplementation(async () => undefined);
  host.availabilityRpc.mockClear();
  host.configuredHosts = [];
  host.remoteHostCards.clear();
  host.clientsByServerId.clear();
  host.reviewCards = [
    makeCard("green-1"),
    makeCard("red-1", { status: "failed" }),
    makeCard("green-2"),
    makeCard("subagent-1", { subagent: { subtitle: "Subagent" } }),
    makeCard("already-done-like", { readable: false }),
  ];
  host.doneCards = [
    makeCard("done-1", { lane: "done" }),
    makeCard("done-2", { lane: "done" }),
    makeCard("done-subagent", { lane: "done", subagent: { subtitle: "Subagent" } }),
  ];
  resetBoardSessions();
});

afterEach(() => {
  if (renderer) {
    act(() => renderer!.unmount());
    renderer = undefined;
  }
  vi.useRealTimers();
});

describe("isUnreadReviewCard & isArchivableDoneCard", () => {
  it("matches only eligible cards per lane", () => {
    expect(isUnreadReviewCard(makeCard("g"))).toBe(true);
    expect(isUnreadReviewCard(makeCard("r", { status: "failed" }))).toBe(false);
    expect(isUnreadReviewCard(makeCard("s", { subagent: { subtitle: "Subagent" } }))).toBe(false);
    expect(isUnreadReviewCard(makeCard("d", { readable: false }))).toBe(false);
    expect(isUnreadReviewCard(makeCard("o", { lane: "done" }))).toBe(false);

    expect(isArchivableDoneCard(makeCard("d1", { lane: "done" }))).toBe(true);
    expect(isArchivableDoneCard(makeCard("d2", { lane: "done", archived: "agent" }))).toBe(false);
    expect(isArchivableDoneCard(makeCard("d3", { lane: "done", subagent: { subtitle: "Subagent" } }))).toBe(false);
    expect(isArchivableDoneCard(makeCard("r1", { lane: "review" }))).toBe(false);
  });
});

describe("useReadControl.pressMany", () => {
  it("filters ineligible cards, chunks >25 agents into batches, tracks batchPending, and coalesces timeout toasts", async () => {
    const onRead = vi.fn();
    let readable = new Set(Array.from({ length: 30 }, (_, index) => `g-${index}`));
    let latest: ReadControl | undefined;

    function Harness() {
      latest = useReadControl({
        onRead,
        isReadable: (id) => readable.has(id),
        toast: { error: host.toastError },
      });
      return null;
    }

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Harness));
    });
    expect(latest!.available).toBe(true);

    const cards: TaskCard[] = [
      ...Array.from({ length: 30 }, (_, index) => makeCard(`g-${index}`)),
      makeCard("failed-1", { status: "failed" }),
      makeCard("sub-1", { subagent: { subtitle: "Subagent" } }),
      makeCard("unreadable-1", { readable: false }),
    ];

    await act(async () => {
      latest!.pressMany(cards);
    });

    expect(host.readRpc.mock.calls).toEqual([
      [{ agentIds: Array.from({ length: 25 }, (_, i) => `g-${i}`) }],
      [{ agentIds: Array.from({ length: 5 }, (_, i) => `g-${25 + i}`) }],
    ]);
    expect(onRead).toHaveBeenCalledTimes(2);
    expect(latest!.batchPending).toBe(false);
    expect(latest!.pending("g-0")).toBe(true);
    expect(latest!.pending("failed-1")).toBe(false);

    readable = new Set(["g-29"]);
    act(() => {
      latest!.reconcile();
    });
    expect(latest!.pending("g-0")).toBe(false);
    expect(latest!.pending("g-29")).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(READ_VERIFY_MS + 10);
    });
    expect(latest!.pending("g-29")).toBe(false);
    expect(host.toastError).toHaveBeenCalledTimes(1);
  });
});

describe("useArchiveControl.pressMany", () => {
  it("archives eligible done cards, detaches children on parent cards, and reports failures", async () => {
    let latest: ArchiveControl | undefined;
    const childDetach = vi.fn(async () => undefined);
    const parentArchive = vi.fn(async () => ({ archivedAt: "2026-11-26T00:00:00Z" }));
    const customApi = {
      agents: {
        list: async () => ({
          entries: [{ agent: { id: "child-1", labels: { "paseo.parent-agent-id": "done-parent" } } }],
          pageInfo: { hasMore: false, nextCursor: null },
        }),
        ref: (id: string) => ({
          detach: childDetach,
          archive: async () => {
            if (id === "done-fail") throw new Error("archive rejected");
            return parentArchive();
          },
        }),
      },
    } as never;

    function Harness() {
      latest = useArchiveControl({ paseo: customApi, toast: { error: host.toastError } });
      return null;
    }

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(Harness));
    });

    const cards: TaskCard[] = [
      makeCard("done-a", { lane: "done" }),
      makeCard("done-parent", {
        lane: "done",
        children: [{ id: "child-1", title: "Child", lane: "done", status: "done", kind: "agent" }],
      }),
      makeCard("done-fail", { lane: "done" }),
      makeCard("review-skip", { lane: "review" }),
      makeCard("sub-skip", { lane: "done", subagent: { subtitle: "Subagent" } }),
    ];

    await act(async () => {
      latest!.pressMany(cards);
    });

    expect(childDetach).toHaveBeenCalledTimes(1);
    expect(parentArchive).toHaveBeenCalledTimes(2);
    expect(latest!.batchPending).toBe(false);
    expect(host.toastError).toHaveBeenCalledWith(expect.stringContaining("Archived 2/3; 1 failed: archive rejected"));
  });
});

describe("Tasks board Mark All Read & Archive All UI", () => {
  const byId = (testID: string): ReactTestInstance[] =>
    renderer!.root.findAll((node) => typeof node.type === "string" && node.props.testID === testID);

  it("shows Mark All Read & Archive All on desktop lanes, skips red and blocked tasks, and hides when empty", async () => {
    host.blockedAgents.add("green-2");
    host.blockedAgents.add("done-2");
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(TasksBoardScreen, {
          theme,
          host: { id: "host-1", label: "Local" },
          layout: { compact: false, platform: "web" },
          navigation: { openAgent: vi.fn(), openWorkspace: vi.fn() },
          params: {},
        }),
      );
    });
    layOut(renderer!, 1400);

    const readButtons = byId("lane-read-all-review");
    expect(readButtons).toHaveLength(1);
    const archiveButtons = byId("lane-archive-all-done");
    expect(archiveButtons).toHaveLength(1);

    await act(async () => {
      readButtons[0]!.props.onPress();
    });
    expect(host.availabilityRpc).toHaveBeenCalledWith({ agentIds: ["green-1", "green-2"] });
    expect(host.readRpc).toHaveBeenCalledWith({ agentIds: ["green-1"] });

    await act(async () => {
      archiveButtons[0]!.props.onPress();
    });
    expect(host.availabilityRpc).toHaveBeenCalledWith({ agentIds: ["done-1", "done-2"] });
    expect(host.archiveRpc).toHaveBeenCalledWith("host-1", "done-1");
    expect(host.archiveRpc).not.toHaveBeenCalledWith("host-1", "done-2");

    // Empty eligible cards -> both buttons hide.
    host.reviewCards = [makeCard("red-only", { status: "failed" })];
    host.doneCards = [];
    await act(async () => {
      renderer!.update(
        React.createElement(TasksBoardScreen, {
          theme,
          host: { id: "host-1", label: "Local" },
          layout: { compact: false, platform: "web" },
          navigation: { openAgent: vi.fn(), openWorkspace: vi.fn() },
          params: {},
        }),
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(byId("lane-read-all-review")).toHaveLength(0);
    expect(byId("lane-archive-all-done")).toHaveLength(0);
  });

  it("shows Mark All Read and Archive All contextual bars on phone for review and done lanes", async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(TasksBoardScreen, {
          theme,
          host: { id: "host-1", label: "Local" },
          layout: { compact: true, platform: "ios" },
          navigation: { openAgent: vi.fn(), openWorkspace: vi.fn() },
          params: {},
        }),
      );
    });
    layOut(renderer!, 390);

    await act(async () => {
      byId("phone-stat-review")[0]!.props.onPress();
    });
    expect(byId("phone-review-actions")).toHaveLength(1);
    expect(byId("phone-done-actions")).toHaveLength(0);
    await act(async () => {
      byId("phone-read-all-review")[0]!.props.onPress();
    });
    expect(host.readRpc).toHaveBeenCalledWith({ agentIds: ["green-1", "green-2"] });

    await act(async () => {
      byId("phone-stat-done")[0]!.props.onPress();
    });
    expect(byId("phone-review-actions")).toHaveLength(0);
    expect(byId("phone-done-actions")).toHaveLength(1);
    await act(async () => {
      byId("phone-archive-all-done")[0]!.props.onPress();
    });
    expect(host.archiveRpc).toHaveBeenCalledWith("host-1", "done-1");
    expect(host.archiveRpc).toHaveBeenCalledWith("host-1", "done-2");
  });

  it("supports Mark All Read for active host and Archive All across all online hosts in AllHostsBoard", async () => {
    const client1 = makeHostApi("host-1");
    const client2 = makeHostApi("host-2");
    host.configuredHosts = [
      { serverId: "host-1", label: "Mac Mini", status: "online" },
      { serverId: "host-2", label: "MacBook Pro", status: "online" },
    ];
    host.clientsByServerId.set("host-1", client1);
    host.clientsByServerId.set("host-2", client2);
    host.remoteHostCards.set(client1, {
      reviewCards: [makeCard("h1-green-1"), makeCard("h1-red", { status: "failed" })],
      doneCards: [makeCard("h1-done-1", { lane: "done" })],
    });
    host.remoteHostCards.set(client2, {
      reviewCards: [makeCard("h2-green-1")],
      doneCards: [makeCard("h2-done-1", { lane: "done" }), makeCard("h2-done-2", { lane: "done" })],
    });

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(TasksBoardScreen, {
          theme,
          host: { id: "host-1", label: "Mac Mini" },
          layout: { compact: false, platform: "web" },
          navigation: { openAgent: vi.fn(), openWorkspace: vi.fn() },
          params: {},
        }),
      );
    });

    const readAllButtons = byId("all-hosts-read-all-review");
    const archiveAllButtons = byId("all-hosts-archive-all-done");
    expect(readAllButtons).toHaveLength(1);
    expect(archiveAllButtons).toHaveLength(1);

    await act(async () => {
      readAllButtons[0]!.props.onPress();
    });
    expect(host.readRpc).toHaveBeenCalledWith({ agentIds: ["h1-green-1"] });
    expect(host.toastShow).toHaveBeenCalledWith(expect.stringContaining("Mac Mini"));

    await act(async () => {
      archiveAllButtons[0]!.props.onPress();
    });
    expect(host.archiveRpc).toHaveBeenCalledWith("host-1", "h1-done-1");
    expect(host.archiveRpc).toHaveBeenCalledWith("host-2", "h2-done-1");
    expect(host.archiveRpc).toHaveBeenCalledWith("host-2", "h2-done-2");
  });
});
