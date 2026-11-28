import React from "react";
import TestRenderer, { act, type ReactTestInstance } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import type { PaseoProviderModelsResult } from "@getpaseo/client";
import "./helpers/quiet-renderer";

const runtime = vi.hoisted(() => ({
  agent: { status: "idle", cwd: "/workspace", provider: "codex", model: "sol", thinkingOptionId: "medium" },
  listeners: new Set<() => void>(),
  api: {} as object,
  copyText: vi.fn(async (_text: string) => {}),
  translate: vi.fn(() => new Promise<never>(() => {})),
  family: vi.fn(async ({ provider }: { provider: string }) => ({ codex: ["my-codex", "gemini", "grok"].includes(provider) })),
  turnUsage: vi.fn(async () => ({ turns: [] as Array<Record<string, unknown>> })),
}));

vi.mock("react-native", () => import("./helpers/rn-mock"));
vi.mock("../../client/state/home-directory", () => ({ useHomeDirectory: () => "/home/test" }));
vi.mock("@getpaseo/plugin/client", () => ({
  useAgent: (_id: string, selector: (agent: typeof runtime.agent) => unknown) =>
    React.useSyncExternalStore(
      (listener) => {
        runtime.listeners.add(listener);
        return () => {
          runtime.listeners.delete(listener);
        };
      },
      () => selector(runtime.agent),
    ),
  usePaseo: () => runtime.api,
  useRpc: (rpc: unknown) =>
    rpc === translateTimelineItemRpc
      ? runtime.translate
      : rpc === providerFamilyRpc
        ? runtime.family
        : rpc === turnUsageRpc
          ? runtime.turnUsage
          : () => Promise.resolve(null),
  useWorkspace: () => null,
  useSettings: () => ({ status: "loading" }),
}));
vi.mock("@getpaseo/plugin/client/ui", async () => {
  const rn = await import("./helpers/rn-mock");
  return {
    Icon: (props: Record<string, unknown>) => React.createElement("Icon", props),
    TextInput: rn.TextInput,
    ScrollView: rn.ScrollView,
    FlatList: rn.ScrollView,
    Modal: rn.View,
    copyText: runtime.copyText,
    useToast: () => ({ show() {}, error() {} }),
  };
});
vi.mock("../../client/components/hub-live", () => ({ TimelineTailHub: () => null }));
vi.mock("../../client/state/preference-sync-slot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../client/state/preference-sync-slot")>()),
  PreferenceSyncSlot: () => null,
}));
vi.mock("../../client/components/selection-actions", () => ({ useSelectionActions: () => {} }));
vi.mock("../../client/components/tool-callouts", () => ({ ToolCallout: () => null }));
vi.mock("../../client/components/markdown/markdown-view", async () => {
  const rn = await import("./helpers/rn-mock");
  return {
    MarkdownView: ({ text }: { text: string }) => React.createElement(rn.Text, { testID: "reply-markdown" }, text),
  };
});

import contribute from "../../index.client";
import { LiveAssistantRenderer, type LiveAssistantPayload } from "../../client/live-renderers";
import { AssistantFooter } from "../../client/components/turn-footer";
import { FooterDetails } from "../../client/components/footer-details";
import { NativeTurnFooterItem } from "../../client/components/native-turn-footer";
import { resetEnhancerPreferences, updateEnhancerPreferences } from "../../client/preferences";
import {
  hasNativeTurnFooter,
  registerAssistantReply,
  resetNativeTurnFooterForTests,
  setNativeTurnFooterActive,
} from "../../client/state/native-turn-footer";
import { translateTimelineItemRpc } from "../../shared/timeline-translation";
import { providerFamilyRpc } from "../../shared/provider-family-rpc";
import { turnUsageRpc } from "../../shared/turn-usage-rpc";
import { resetTimelineTailsForTests } from "../../client/timeline-tail";
import { timelineEntry as entry, timelinePage as page } from "./helpers/turn-timeline";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const theme = {
  colors: {
    surface0: "#fff",
    surface1: "#eee",
    surface2: "#ddd",
    border: "#ccc",
    foreground: "#111",
    foregroundMuted: "#666",
    accent: "#00f",
    accentForeground: "#fff",
    statusSuccess: "#198754",
    statusWarning: "#a36a00",
    statusDanger: "#d92d20",
  },
};

const catalog: PaseoProviderModelsResult = {
  provider: "codex",
  fetchedAt: "now",
  requestId: "r",
  models: [{ provider: "codex", id: "sol", label: "GPT-6.1-Sol", thinkingOptions: [{ id: "medium", label: "Medium" }] }],
};

let renderer: TestRenderer.ReactTestRenderer | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  resetNativeTurnFooterForTests();
  resetTimelineTailsForTests();
  resetEnhancerPreferences();
  runtime.turnUsage.mockImplementation(async () => ({ turns: [] }));
  runtime.agent = { status: "idle", cwd: "/workspace", provider: "codex", model: "sol", thinkingOptionId: "medium" };
  runtime.api = {
    providers: { listModels: vi.fn(async () => catalog) },
    agents: {
      ref: () => ({
        timeline: {
          refetch: vi.fn(async () =>
            page([
              entry({ type: "user_message", text: "Hi" }, 1, 1000, "one"),
              entry({ type: "assistant_message", text: "Done." }, 2, 52_000, "one"),
            ]),
          ),
          subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
        },
      }),
    },
  };
});

afterEach(() => {
  if (renderer) {
    act(() => renderer!.unmount());
    renderer = undefined;
  }
  resetNativeTurnFooterForTests();
  resetEnhancerPreferences();
});

function assistantProps(text: string, timestamp = new Date(52_000)): PluginTimelineItemProps<LiveAssistantPayload> {
  return {
    agentId: "agent-1",
    item: {
      id: "assistant-1",
      kind: "omp-assistant",
      version: 1,
      data: { text, phase: "complete" },
    },
    theme,
    host: { id: "host-1", label: "Host" },
    layout: { compact: true, platform: "ios" },
    timestamp,
  } as unknown as PluginTimelineItemProps<LiveAssistantPayload>;
}

describe("native turn footer slot integration", () => {
  it("suppresses plugin AssistantFooter when native turn footer slot is active and keeps it on legacy hosts", async () => {
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(LiveAssistantRenderer, assistantProps("Done.")));
    });
    expect(renderer!.root.findAllByType(AssistantFooter)).toHaveLength(1);

    act(() => {
      setNativeTurnFooterActive(true);
    });
    expect(renderer!.root.findAllByType(AssistantFooter)).toHaveLength(0);
  });

  it("renders model, metric, and whole-reply translate inside NativeTurnFooterItem without duplicate copy or timing", async () => {
    updateEnhancerPreferences({ footerMetric: "tps" });
    const unregister = registerAssistantReply(runtime.api, "agent-1", 52_000, "Done.");

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(NativeTurnFooterItem, {
          theme,
          host: { id: "host-1", label: "Host" },
          layout: { compact: true, platform: "ios" },
          agentId: "agent-1",
          turnId: "turn-1",
          model: "sol",
          provider: "codex",
          completedAt: new Date(52_000),
          durationMs: 51_000,
          telemetry: { outputTps: 667.9, usage: { inputTokens: 100, outputTokens: 200 } },
        }),
      );
    });

    const text = (node: ReactTestInstance): string =>
      node.children.map((c) => (typeof c === "string" ? c : text(c))).join(" ");
    const extras = renderer!.root.findByProps({ testID: "native-footer-extras" });
    const content = text(extras);

    expect(content).toContain("GPT-6.1-Sol");
    expect(content).toContain("667.9 t/s");
    const translateButtons = () =>
      renderer!.root.findAll((node) => typeof node.type === "string" && node.props.testID === "footer-translate");
    expect(translateButtons()).toHaveLength(1);

    // No duplicate Copy reply, Clock, or Hourglass icons inside the plugin slot.
    const icons = extras.findAllByType("Icon" as never).map((icon) => icon.props.name);
    expect(icons).not.toContain("Clock");
    expect(icons).not.toContain("Hourglass");
    expect(extras.findAll((node) => node.props.accessibilityLabel === "Copy reply")).toHaveLength(0);

    // Clicking model badge copies the raw modelId.
    const modelButton = extras.find((node) => typeof node.type === "string" && node.props.accessibilityLabel === "Copy model name");
    await act(async () => {
      modelButton.props.onPress();
    });
    expect(runtime.copyText).toHaveBeenCalledWith("sol");

    // Tool-only / unregistered reply hides the translate button while keeping model + metric.
    act(() => {
      unregister();
    });
    expect(translateButtons()).toHaveLength(0);
    expect(text(renderer!.root.findByProps({ testID: "native-footer-extras" }))).toContain("667.9 t/s");
  });

  it("registers addTurnFooterItem when supported by host and deactivates cleanly on unload or chatEnabled=false", () => {
    const removed = vi.fn();
    const addTurnFooterItem = vi.fn(() => removed);
    const fakeClient = {
      paseo: {
        observeEvents: () => ({
          subscribe: () => () => {},
          release: () => Promise.resolve(),
        }),
      },
      addTimelineTransformer: () => () => {},
      addTimelineRenderer: () => () => {},
      addSlashCommand: () => () => {},
      addSettingsScreen: () => () => {},
      addScreen: () => () => {},
      addSidebarView: () => () => {},
      addCommandCenterItem: () => () => {},
      addComposerPill: () => ({ update: () => {}, remove: () => {} }),
      addTurnFooterItem,
      rpc: () => new Promise(() => {}),
      subscribe: () => ({ close: () => {}, ready: Promise.resolve() }),
    };

    const cleanup = contribute(fakeClient as never);
    expect(addTurnFooterItem).toHaveBeenCalledTimes(1);
    expect(hasNativeTurnFooter()).toBe(true);

    updateEnhancerPreferences({ chatEnabled: false });
    expect(removed).toHaveBeenCalledTimes(1);
    expect(hasNativeTurnFooter()).toBe(false);

    updateEnhancerPreferences({ chatEnabled: true });
    expect(addTurnFooterItem).toHaveBeenCalledTimes(2);
    expect(hasNativeTurnFooter()).toBe(true);

    cleanup();
    expect(removed).toHaveBeenCalledTimes(2);
    expect(hasNativeTurnFooter()).toBe(false);
  });

  it("unions host props with Better Paseo turn-footers store data in FooterDetails and metric badge", async () => {
    updateEnhancerPreferences({ footerMetric: "outputTokens", language: "en" });
    runtime.api = {
      providers: { listModels: vi.fn(async () => catalog) },
      agents: {
        ref: () => ({
          timeline: {
            refetch: vi.fn(async () =>
              page([
                entry({ type: "user_message", text: "Hi" }, 1, 1000, "one"),
                Object.assign(entry({ type: "assistant_message", text: "Done." }, 2, 52_000, "one"), {
                  telemetry: { ttftMs: 420, apiTurnCount: 2 },
                }),
              ]),
            ),
            subscribe: () => Object.assign(() => {}, { ready: Promise.resolve() }),
          },
        }),
      },
    };
    runtime.turnUsage.mockResolvedValue({
      turns: [
        {
          turnId: "one",
          startedAt: 1_000,
          endedAt: 52_000,
          usage: { inputTokens: 12_500, cachedInputTokens: 4_000, outputTokens: 850 },
        },
      ],
    });
    const unregister = registerAssistantReply(runtime.api, "agent-1", 52_000, "Done.");

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(NativeTurnFooterItem, {
          theme,
          host: { id: "host-1", label: "Host" },
          layout: { compact: true, platform: "ios" },
          agentId: "agent-1",
          turnId: "one",
          model: "sol",
          provider: "codex",
          completedAt: new Date(52_000),
          durationMs: null,
          telemetry: { outputTps: 667.9 },
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const text = (node: ReactTestInstance): string =>
      node.children.map((c) => (typeof c === "string" ? c : text(c))).join(" ");
    const extras = renderer!.root.findByProps({ testID: "native-footer-extras" });
    expect(text(extras)).toContain("850");

    act(() => {
      extras.props.onLongPress();
    });
    const details = renderer!.root.findByType(FooterDetails);
    expect(details.props.startedAt).toBe(1_000);
    expect(details.props.completedAt).toBe(52_000);
    expect(details.props.durationMs).toBe(51_000);
    expect(details.props.usage).toEqual({
      inputTokens: 12_500,
      cachedInputTokens: 4_000,
      outputTokens: 850,
    });
    expect(details.props.telemetry).toMatchObject({
      outputTps: 667.9,
      ttftMs: 420,
      apiTurnCount: 2,
    });
    const detailText = text(details);
    expect(detailText).toContain("Start time");
    expect(detailText).toContain("End time");
    expect(detailText).toContain("Elapsed time");
    expect(detailText).toContain("Input");
    expect(detailText).toContain("Cached");
    expect(detailText).toContain("Output");
    expect(detailText).toContain("TPS");
    expect(detailText).toContain("TTFT");
    unregister();
  });

  it("recovers timing by completion timestamp when reply is unregistered and derives startedAt from durationMs", async () => {
    updateEnhancerPreferences({ footerMetric: "outputTokens", language: "en" });
    runtime.turnUsage.mockResolvedValue({
      turns: [
        {
          turnId: "one",
          startedAt: 1_000,
          endedAt: 52_000,
          usage: { inputTokens: 3_000, outputTokens: 200 },
        },
      ],
    });

    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(NativeTurnFooterItem, {
          theme,
          host: { id: "host-1", label: "Host" },
          layout: { compact: true, platform: "ios" },
          agentId: "agent-1",
          turnId: null,
          model: "sol",
          provider: "codex",
          completedAt: new Date(52_000),
          durationMs: 51_000,
          telemetry: null,
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const text = (node: ReactTestInstance): string =>
      node.children.map((c) => (typeof c === "string" ? c : text(c))).join(" ");
    const extras = renderer!.root.findByProps({ testID: "native-footer-extras" });
    expect(text(extras)).toContain("200");

    act(() => {
      extras.props.onLongPress();
    });
    const details = renderer!.root.findByType(FooterDetails);
    expect(details.props.startedAt).toBe(1_000);
    expect(details.props.durationMs).toBe(51_000);
    expect(details.props.usage).toEqual({ inputTokens: 3_000, outputTokens: 200 });
  });

  it("avoids model negative-margin clipping on web/desktop and reserves non-wrapping timing room on compact native", async () => {
    const rn = await import("./helpers/rn-mock");
    const winWidth = rn.Dimensions.get().width;

    // 1. Desktop web: flexShrink: 1, no maxWidth cap, no negative-margin + maxWidth: 100% chop.
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(NativeTurnFooterItem, {
          theme,
          host: { id: "host-1", label: "Host" },
          layout: { compact: false, platform: "web" },
          agentId: "agent-1",
          turnId: "one",
          model: "sol",
          provider: "codex",
          completedAt: new Date(52_000),
          durationMs: 41_000,
          telemetry: { outputTps: 27.1 },
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const webExtras = renderer!.root.findByProps({ testID: "native-footer-extras" });
    const webContainerStyle = rn.StyleSheet.flatten(webExtras.props.style);
    expect(webContainerStyle.flexShrink).toBe(1);
    expect(webContainerStyle.maxWidth).toBeUndefined();
    const webModelButton = webExtras.find((node) => typeof node.type === "string" && node.props.accessibilityLabel === "Copy model name");
    const webModelStyle = rn.StyleSheet.flatten(webModelButton.props.style);
    expect(webModelStyle.marginHorizontal).toBeUndefined();
    expect(webModelStyle.maxWidth).toBeUndefined();

    act(() => renderer!.unmount());
    renderer = undefined;

    // 2. Compact iOS: flexShrink: 0 with maxWidth reserving enough room for host timing label.
    updateEnhancerPreferences({ language: "zh" });
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(NativeTurnFooterItem, {
          theme,
          host: { id: "host-1", label: "Host" },
          layout: { compact: true, platform: "ios" },
          agentId: "agent-1",
          turnId: "one",
          model: "sol",
          provider: "codex",
          completedAt: new Date(52_000),
          durationMs: 41_000,
          telemetry: { outputTps: 27.6 },
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const iosExtras = renderer!.root.findByProps({ testID: "native-footer-extras" });
    const iosContainerStyle = rn.StyleSheet.flatten(iosExtras.props.style);
    expect(iosContainerStyle.flexShrink).toBe(0);
    expect(iosContainerStyle.width).toBe(Math.max(110, Math.floor(winWidth) - 184));
    expect(iosContainerStyle.maxWidth).toBe(Math.max(110, Math.floor(winWidth) - 184));
    const iosModelButton = iosExtras.find((node) => typeof node.type === "string" && node.props.accessibilityLabel === "Copy model name");
    const iosMetricButton = iosExtras.find((node) => typeof node.type === "string" && node.props.accessibilityLabel?.startsWith("Output TPS:"));
    const iosModelStyle = rn.StyleSheet.flatten(iosModelButton.props.style);
    expect(iosModelStyle.marginHorizontal).toBeUndefined();
    expect(iosModelStyle.maxWidth).toBeUndefined();
    expect(iosModelStyle.paddingHorizontal).toBe(0);
    expect(rn.StyleSheet.flatten(iosMetricButton.props.style).paddingHorizontal).toBe(0);

    act(() => renderer!.unmount());
    renderer = undefined;

    // 3. Compact iOS without durationMs (host displays short HH:MM timestamp): reserves 158pt.
    await act(async () => {
      renderer = TestRenderer.create(
        React.createElement(NativeTurnFooterItem, {
          theme,
          host: { id: "host-1", label: "Host" },
          layout: { compact: true, platform: "ios" },
          agentId: "agent-1",
          turnId: "one",
          model: "sol",
          provider: "codex",
          completedAt: new Date(52_000),
          durationMs: null,
          telemetry: { outputTps: 27.6 },
        }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const tsExtras = renderer!.root.findByProps({ testID: "native-footer-extras" });
    expect(rn.StyleSheet.flatten(tsExtras.props.style).width).toBe(Math.max(110, Math.floor(winWidth) - 158));
    expect(rn.StyleSheet.flatten(tsExtras.props.style).maxWidth).toBe(Math.max(110, Math.floor(winWidth) - 158));
  });

  it("enforces single-line host timing, zero mid-row whitespace chasm, and consistent visual gaps under Yoga across phone widths", async () => {
    const YogaModule = await import("yoga-layout");
    const Yoga = YogaModule.default;
    const { Align, FlexDirection, Gutter, MeasureMode } = YogaModule;
    const rn = await import("./helpers/rn-mock");

    for (const [windowW, durationMs, textW] of [
      [375, null, 32],
      [390, null, 32],
      [430, null, 32],
      [375, 41_000, 58],
      [390, 41_000, 58],
      [430, 41_000, 58],
      [375, 290_000, 72],
      [390, 290_000, 72],
    ] as const) {
      updateEnhancerPreferences({ language: "zh" });
      await act(async () => {
        renderer = TestRenderer.create(
          React.createElement(NativeTurnFooterItem, {
            theme,
            host: { id: "host-1", label: "Host" },
            layout: { compact: true, platform: "ios" },
            agentId: "agent-1",
            turnId: "one",
            model: "sol",
            provider: "codex",
            completedAt: new Date(52_000),
            durationMs,
            telemetry: { outputTps: 27.6 },
          }),
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const extras = renderer!.root.findByProps({ testID: "native-footer-extras" });
      const style = rn.StyleSheet.flatten(extras.props.style);
      // Scale configured reserve delta against the current viewport width.
      const reserve = rn.Dimensions.get().width - (style.width as number);
      const pluginW = Math.max(110, windowW - reserve);

      const rowW = windowW - 16;
      const root = Yoga.Node.create();
      root.setWidth(rowW);
      const cont = Yoga.Node.create();
      cont.setFlexDirection(FlexDirection.Row);
      cont.setGap(Gutter.Column, 8);
      const actNode = Yoga.Node.create();
      actNode.setWidth(88);
      actNode.setHeight(24);
      cont.insertChild(actNode, 0);

      const lblBtn = Yoga.Node.create();
      lblBtn.setFlexDirection(FlexDirection.Row);
      lblBtn.setFlexShrink(1);
      lblBtn.setMinWidth(0);
      lblBtn.setMinHeight(24);
      lblBtn.setAlignItems(Align.Center);
      const lblText = Yoga.Node.create();
      lblText.setWidthPercent(100);
      lblText.setFlexShrink(0);
      lblText.setMeasureFunc((mw, wm) =>
        wm === MeasureMode.Undefined || mw >= textW
          ? { width: textW, height: 18 }
          : { width: mw, height: Math.ceil(textW / Math.max(1, mw)) * 18 },
      );
      lblBtn.insertChild(lblText, 0);
      cont.insertChild(lblBtn, 1);

      const plug = Yoga.Node.create();
      plug.setFlexDirection(FlexDirection.Row);
      plug.setGap(Gutter.Column, style.gap as number);
      plug.setFlexShrink(0);
      plug.setMinWidth(0);
      plug.setWidth(pluginW);
      plug.setMaxWidth(pluginW);

      const tr = Yoga.Node.create();
      tr.setWidth(24 - 8); // 24px button with marginHorizontal: -4
      tr.setHeight(24);
      tr.setFlexShrink(0);
      const mod = Yoga.Node.create();
      mod.setWidth(65);
      mod.setHeight(24);
      mod.setFlexShrink(1);
      mod.setMinWidth(0);
      const met = Yoga.Node.create();
      met.setWidth(56);
      met.setHeight(24);
      met.setFlexShrink(0);
      plug.insertChild(tr, 0);
      plug.insertChild(mod, 1);
      plug.insertChild(met, 2);

      cont.insertChild(plug, 2);
      root.insertChild(cont, 0);
      root.calculateLayout(rowW, undefined);

      // 1. Host timing never wraps to two lines.
      expect(lblBtn.getComputedHeight()).toBe(24);
      // 2. No extra whitespace chasm after the host timing label before Translate.
      const slackAfterLabel = lblBtn.getComputedWidth() - textW;
      expect(slackAfterLabel).toBeGreaterThanOrEqual(0);
      expect(slackAfterLabel).toBeLessThanOrEqual(8);
      // 3. Visual gaps across host-metrics->label, label->translate, translate->model, model->metric stay within 4pt.
      const metricsToLabel = 5 + 8; // 24px Metrics icon (5px right pad) + 8px container gap
      const labelToTranslate = slackAfterLabel + 8 + 1;
      const translateToModel = 1 + (style.gap as number);
      const modelToMetric = style.gap as number;
      const gaps = [metricsToLabel, labelToTranslate, translateToModel, modelToMetric];
      expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(5);

      act(() => renderer!.unmount());
      renderer = undefined;
    }
  });
});
