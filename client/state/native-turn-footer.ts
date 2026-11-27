import { useCallback, useSyncExternalStore } from "react";

export interface RegisteredAssistantReply {
  replyAt: number;
  text: string;
}

let nativeTurnFooterActive = false;
const slotListeners = new Set<() => void>();

export function setNativeTurnFooterActive(active: boolean): void {
  if (nativeTurnFooterActive === active) return;
  nativeTurnFooterActive = active;
  for (const listener of slotListeners) listener();
}

export function hasNativeTurnFooter(): boolean {
  return nativeTurnFooterActive;
}

function subscribeNativeFooterSlot(listener: () => void): () => void {
  slotListeners.add(listener);
  return () => {
    slotListeners.delete(listener);
  };
}

export function useHasNativeTurnFooter(): boolean {
  return useSyncExternalStore(subscribeNativeFooterSlot, hasNativeTurnFooter, hasNativeTurnFooter);
}

interface AgentReplyRegistry {
  replies: Map<number, string>;
  listeners: Set<() => void>;
  cachedMatch: Map<string, RegisteredAssistantReply | null>;
}

const registries = new WeakMap<object, Map<string, AgentReplyRegistry>>();

function agentRegistry(paseo: object, agentId: string): AgentReplyRegistry {
  let byAgent = registries.get(paseo);
  if (!byAgent) {
    byAgent = new Map();
    registries.set(paseo, byAgent);
  }
  let entry = byAgent.get(agentId);
  if (!entry) {
    entry = { replies: new Map(), listeners: new Set(), cachedMatch: new Map() };
    byAgent.set(agentId, entry);
  }
  return entry;
}

function notifyAgent(entry: AgentReplyRegistry): void {
  entry.cachedMatch.clear();
  for (const listener of entry.listeners) listener();
}

export function registerAssistantReply(
  paseo: object,
  agentId: string,
  replyAt: number,
  text: string,
): () => void {
  if (!paseo || !agentId) return () => {};
  const entry = agentRegistry(paseo, agentId);
  const prev = entry.replies.get(replyAt);
  if (prev !== text) {
    entry.replies.set(replyAt, text);
    notifyAgent(entry);
  }
  return () => {
    if (entry.replies.get(replyAt) !== text) return;
    entry.replies.delete(replyAt);
    notifyAgent(entry);
  };
}

function resolveReply(
  entry: AgentReplyRegistry,
  completedAtMs: number | null,
  durationMs: number | null,
): RegisteredAssistantReply | null {
  if (completedAtMs == null || !Number.isFinite(completedAtMs)) return null;
  const cacheKey = `${completedAtMs}|${durationMs ?? ""}`;
  if (entry.cachedMatch.has(cacheKey)) {
    return entry.cachedMatch.get(cacheKey) ?? null;
  }
  const exact = entry.replies.get(completedAtMs);
  let matched: RegisteredAssistantReply | null = null;
  if (exact !== undefined) {
    matched = { replyAt: completedAtMs, text: exact };
  } else {
    const minReplyAt =
      durationMs != null && Number.isFinite(durationMs) && durationMs >= 0
        ? completedAtMs - durationMs - 1000
        : -Infinity;
    let bestAt = -Infinity;
    let bestText = "";
    for (const [replyAt, text] of entry.replies) {
      if (replyAt <= completedAtMs && replyAt >= minReplyAt && replyAt > bestAt) {
        bestAt = replyAt;
        bestText = text;
      }
    }
    if (bestAt > -Infinity) matched = { replyAt: bestAt, text: bestText };
  }
  entry.cachedMatch.set(cacheKey, matched);
  return matched;
}

export function useRegisteredAssistantReply(
  paseo: object,
  agentId: string,
  completedAtMs: number | null,
  durationMs: number | null,
): RegisteredAssistantReply | null {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!paseo || !agentId) return () => {};
      const entry = agentRegistry(paseo, agentId);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [paseo, agentId],
  );
  const getSnapshot = useCallback(() => {
    if (!paseo || !agentId) return null;
    return resolveReply(agentRegistry(paseo, agentId), completedAtMs, durationMs);
  }, [paseo, agentId, completedAtMs, durationMs]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function resetNativeTurnFooterForTests(): void {
  nativeTurnFooterActive = false;
  slotListeners.clear();
}
