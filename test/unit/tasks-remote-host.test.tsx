import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import {
  setLabelDefinitionsLoader, setLastTurnLoader, setParentOriginsLoader,
  setProjectIconsLoader, setReadMarksLoader, setSubagentLoader, useTasks,
  type TasksHandle,
} from "../../client/tasks/data";
import { createFakePaseo, makeAgent, makeWorkspace } from "./helpers/fake-paseo";
import "./helpers/quiet-renderer";

vi.mock("react-native", () => import("./helpers/rn-mock"));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("cross-host task store isolation", () => {
  it("never queries this installation's plugin-server loaders with a foreign host's agent IDs", async () => {
    const lastTurns = vi.fn(async () => []);
    const subagents = vi.fn(async () => ({ version: "v1", subagents: [] }));
    const reads = vi.fn(async () => []);
    const origins = vi.fn(async () => ({ version: "v1", origins: [] }));
    const labels = vi.fn(async () => []);
    const projectIcons = vi.fn(async () => []);
    setLastTurnLoader(lastTurns);
    setSubagentLoader(subagents);
    setReadMarksLoader(reads);
    setParentOriginsLoader(origins);
    setLabelDefinitionsLoader(labels);
    setProjectIconsLoader(projectIcons);

    const fake = createFakePaseo({
      agents: [makeAgent({
        id: "remote-only-agent", workspaceId: "remote-ws", status: "running",
        model: "gpt-6", lastUserMessageAt: new Date().toISOString(),
      })],
      workspaces: [makeWorkspace({ id: "remote-ws" })],
    });

    let latest!: TasksHandle;
    function Probe() {
      latest = useTasks(fake.paseo, {
        doneWindow: "all", includeDone: true, remoteHost: true,
      });
      return null;
    }

    let renderer: ReturnType<typeof TestRenderer.create> | undefined;
    try {
      await act(async () => {
        renderer = TestRenderer.create(React.createElement(Probe));
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      });
      expect(latest.lanes.running.cards.map((card) => card.id)).toContain("remote-only-agent");
      await act(async () => {
        latest.refreshReads();
        latest.requestProjectIcon("remote-project");
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
      expect(lastTurns).not.toHaveBeenCalled();
      expect(subagents).not.toHaveBeenCalled();
      expect(reads).not.toHaveBeenCalled();
      expect(origins).not.toHaveBeenCalled();
      expect(labels).not.toHaveBeenCalled();
      expect(projectIcons).not.toHaveBeenCalled();
    } finally {
      if (renderer) await act(async () => renderer.unmount());
      setLastTurnLoader(null);
      setSubagentLoader(null);
      setReadMarksLoader(null);
      setParentOriginsLoader(null);
      setLabelDefinitionsLoader(null);
      setProjectIconsLoader(null);
    }
  });
});
