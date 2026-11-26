import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./helpers/quiet-renderer";

const host = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastShow: vi.fn(),
  settings: null as Record<string, unknown> | null,
  canRead: true,
  canStop: false,
  blockedAgents: new Set<string>(),
  readRpc: vi.fn(async (_input: { agentIds: string[] }) => ({ ok: true, error: null as string | null })),
  availabilityRpc: vi.fn(async (input: { agentIds: string[] }) => ({
    entries: input.agentIds.map((agentId) => ({
      agentId,
      availability: host.blockedAgents.has(agentId)
        ? { issue: { kind: "missingDirectory", path: "/missing" }, blocked: { read: { kind: "missingDirectory", path: "/missing" } } }
        : { issue: null, blocked: {} },
    })),
  })),
  reviewCards: [] as import("../../client/tasks/model").TaskCard[],
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

const paseo = vi.hoisted(() => ({
  agents: {
    ref: () => ({
      timeline: {
        refetch: () => Promise.resolve({ error: null, entries: [], epoch: "test", endCursor: null, window: { nextSeq: 0 } }),
        subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
      },
    }),
  },
}));

vi.mock("@getpaseo/plugin/client", () => ({
  usePaseo: () => paseo,
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
  return {
    ...actual,
    useTasks: () => {
      const lanes = Object.fromEntries(
        LANE_ORDER.map((id) => [
          id,
          { id, cards: id === "review" ? host.reviewCards : [], hasMore: false, loading: false, initialLoading: false },
        ]),
      );
      return {
        lanes,
        counts: { needsInput: 0, running: 0, review: host.reviewCards.length, done: 0 },
        byId: new Map(host.reviewCards.map((card) => [card.id, card])),
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
      };
    },
    useTaskCounts: () => ({ needsInput: 0, running: 0, review: host.reviewCards.length, done: 0, ready: true }),
  };
});

import { READ_VERIFY_MS, useReadControl, type ReadControl } from "../../client/tasks/actions";
import { TasksBoardScreen } from "../../client/tasks/board/board-screen";
import { resetTasksEnabled } from "../../client/tasks/board/enabled";
import { resetBoardSessions } from "../../client/tasks/board/params";
import { isUnreadReviewCard, type TaskCard } from "../../client/tasks/model";
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

const templateCard = sampleCards(Date.parse("2026-10-20T12:00:00Z")).find((card) => card.lane === "review" && card.status === "unread")!;

function makeCard(id: string, overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    ...templateCard,
    id,
    lane: "review",
    status: "unread",
    readable: true,
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
  host.availabilityRpc.mockClear();
  host.reviewCards = [
    makeCard("green-1"),
    makeCard("red-1", { status: "failed" }),
    makeCard("green-2"),
    makeCard("subagent-1", { subagent: { subtitle: "Subagent" } }),
    makeCard("already-done-like", { readable: false }),
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

describe("isUnreadReviewCard", () => {
  it("matches only non-subagent readable green unread cards in the review lane", () => {
    expect(isUnreadReviewCard(makeCard("g"))).toBe(true);
    expect(isUnreadReviewCard(makeCard("r", { status: "failed" }))).toBe(false);
    expect(isUnreadReviewCard(makeCard("s", { subagent: { subtitle: "Subagent" } }))).toBe(false);
    expect(isUnreadReviewCard(makeCard("d", { readable: false }))).toBe(false);
    expect(isUnreadReviewCard(makeCard("o", { lane: "done" }))).toBe(false);
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

    // Move first 29 cards out of readable, leave g-29 stuck to test coalesced timeout toast.
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

describe("Tasks board Mark All Read UI", () => {
  const byId = (testID: string): ReactTestInstance[] =>
    renderer!.root.findAll((node) => typeof node.type === "string" && node.props.testID === testID);

  it("shows Mark All Read on desktop review lane, skips red and blocked tasks, and hides when no green cards exist", async () => {
    host.blockedAgents.add("green-2");
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

    const buttons = byId("lane-read-all-review");
    expect(buttons).toHaveLength(1);

    await act(async () => {
      buttons[0]!.props.onPress();
    });

    expect(host.availabilityRpc).toHaveBeenCalledWith({
      agentIds: ["green-1", "green-2"],
    });
    expect(host.readRpc).toHaveBeenCalledWith({ agentIds: ["green-1"] });

    // Only a red failed card left -> button disappears.
    host.reviewCards = [makeCard("red-only", { status: "failed" })];
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
    expect(byId("lane-read-all-review")).toHaveLength(0);
  });

  it("shows Mark All Read contextual bar on phone when viewing the review lane", async () => {
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(TasksBoardScreen, {
          theme,
          host: { id: "host-1", label: "Local" },
          layout: { compact: true, platform: "ios" },
          navigation: { openAgent: vi.fn(), openWorkspace: vi.fn() },
          params: { lane: "review" },
        }),
      );
    });
    layOut(renderer!, 390);

    await act(async () => {
      byId("phone-stat-review")[0]!.props.onPress();
    });

    expect(byId("phone-review-actions")).toHaveLength(1);
    const phoneButtons = byId("phone-read-all-review");
    expect(phoneButtons).toHaveLength(1);

    await act(async () => {
      phoneButtons[0]!.props.onPress();
    });

    expect(host.availabilityRpc).toHaveBeenCalledWith({
      agentIds: ["green-1", "green-2"],
    });
    expect(host.readRpc).toHaveBeenCalledWith({ agentIds: ["green-1", "green-2"] });

    // Switch to running tab -> contextual bar hides.
    const runningTab = byId("phone-stat-running")[0]!;
    await act(async () => {
      runningTab.props.onPress();
    });
    expect(byId("phone-review-actions")).toHaveLength(0);
  });
});
