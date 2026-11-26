import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import * as pluginClient from "@getpaseo/plugin/client";
import type { PaseoApi } from "@getpaseo/client";
import { effectiveCard, type CardSettings, type DoneWindow, type TasksSettings } from "../../../shared/tasks-settings";
import { tasksAvailabilityRpc } from "../../../shared/task-availability";
import { checkTaskAvailabilityBatch, taskOperationIssue } from "../availability";
import { taskIssueText } from "../cards/availability-tag";
import { useTasks, type TasksHandle, type TasksOptions } from "../data";
import { useTasksLanguage, type TasksLanguage } from "../i18n";
import { LANE_ORDER, isArchivableDoneCard, isUnreadReviewCard, type LaneId, type TaskCard } from "../model";
import { StatusIcon, TaskCardView } from "../cards";
import { archiveCardsWithApi, permissionButtons, respondToPermission, useReadControl, type PermissionButton } from "../actions";
import { useToast } from "@getpaseo/plugin/client/ui";
import { ArchiveAllButton, MarkAllReadButton } from "./board-parts";
import { BOARD_STRINGS } from "./strings";
import { aggregateHostTasks, type AggregateTask, type HostTaskSnapshots } from "./all-hosts-model";

/**
 * Each connected host has its own SDK client and Tasks store. Never merge the
 * SDK clients or agent IDs themselves: data and actions must stay host-scoped.
 * SDK-backed task state is read from each host; local-server-only enrichers
 * are deliberately not queried for remote hosts.
 */
interface LiveHost {
  serverId: string;
  label: string;
  status: "idle" | "connecting" | "online" | "offline" | "error";
}

type ChangeSnapshot = (serverId: string, tasks: TasksHandle | null) => void;

function ConnectedHostReader({
  serverId, activeHostId, paseo, options, onChange,
}: {
  serverId: string;
  activeHostId: string;
  paseo: PaseoApi;
  options: TasksOptions;
  onChange: ChangeSnapshot;
}) {
  // Non-active hosts use SDK-only stores so global plugin-server RPC loaders
  // never enrich a remote daemon's cards. The active host keeps its plugin store
  // so batch Mark All Read and read marks stay in sync.
  const hostOptions = useMemo<TasksOptions>(
    () => (serverId === activeHostId ? options : { ...options, remoteHost: true }),
    [options, serverId, activeHostId],
  );
  const tasks = useTasks(paseo, hostOptions);
  useEffect(() => { onChange(serverId, tasks); }, [serverId, tasks, onChange]);
  useEffect(() => () => onChange(serverId, null), [serverId, onChange]);
  return null;
}

function HostReader({
  serverId, activeHostId, options, onChange,
}: {
  serverId: string;
  activeHostId: string;
  options: TasksOptions;
  onChange: ChangeSnapshot;
}) {
  const paseo = useMemo(() => {
    try {
      const acquire = (pluginClient as unknown as { getPaseoClient?: (id: string) => PaseoApi }).getPaseoClient;
      return acquire?.(serverId) ?? null;
    } catch {
      // Host may have changed state between the connected-host snapshot and
      // the SDK lookup. The board displays it as still connecting.
      return null;
    }
  }, [serverId]);

  return paseo ? (
    <ConnectedHostReader serverId={serverId} activeHostId={activeHostId} paseo={paseo} options={options} onChange={onChange} />
  ) : null;
}

const words = {
  en: {
    all: "All hosts",
    host: "Host",
    search: "Search all hosts",
    empty: "No matching tasks",
    offline: "offline",
    connecting: "connecting",
    active: "online",
    open: "Open agent",
    archived: "Archived tasks must be unarchived on their host",
    refresh: "Refresh",
    loading: "Loading hosts",
    loaded: "Shown",
    more: "Show more",
    older: "Load older tasks",
    error: "Could not load some hosts",
    hostUnavailable: "Host is not connected; its tasks are not counted",
    navUnavailable: "Open this agent from its host",
    noHosts: "No connected hosts",
  },
  zh: {
    all: "全部主机",
    host: "主机",
    search: "搜索所有主机的任务",
    empty: "没有符合条件的任务",
    offline: "离线",
    connecting: "连接中",
    active: "在线",
    open: "打开 Agent",
    archived: "请先在所属主机取消归档",
    refresh: "刷新",
    loading: "正在读取主机",
    loaded: "已显示",
    more: "显示更多",
    older: "加载更早的任务",
    error: "部分主机读取失败",
    hostUnavailable: "主机未连接，其任务未计入统计",
    navUnavailable: "请从所属主机打开 Agent",
    noHosts: "没有可连接的主机",
  },
} as const;

const INITIAL_LANE_LIMIT = 30;
const MORE_LANE_LIMIT = 30;

function chipStyle(selected: boolean, colors: PluginScreenProps["theme"]["colors"]) {
  return {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: selected ? colors.accent : colors.border,
    backgroundColor: selected ? colors.surface2 : colors.surface1,
  } as const;
}

function HostChip({
  label, selected, onPress, screen, count,
}: {
  label: string;
  selected: boolean;
  onPress(): void;
  screen: PluginScreenProps;
  count?: number;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected }}
      onPress={onPress} style={chipStyle(selected, screen.theme.colors)}>
      <Text style={{ color: selected ? screen.theme.colors.foreground : screen.theme.colors.foregroundMuted, fontSize: 12, fontWeight: selected ? "600" : "400" }}>
        {label}{count === undefined ? "" : ` · ${count}`}
      </Text>
    </Pressable>
  );
}

/** The existing Better Paseo card, with a small source-host label above it. */
function TaskPreview({
  task, screen, onOpen, onPermission, fields, language,
}: {
  task: AggregateTask;
  screen: PluginScreenProps;
  onOpen(task: AggregateTask, agentId: string): void;
  onPermission(task: AggregateTask, button: PermissionButton): void;
  fields: CardSettings;
  language: TasksLanguage;
}) {
  const { card } = task;
  const colors = screen.theme.colors;
  const [expanded, setExpanded] = useState(false);
  const buttons = useMemo(() => card.permission ? permissionButtons(card.permission, language) : [], [card.permission, language]);
  const navigate = screen.navigation?.openAgent
    ? (agentId: string) => onOpen(task, card.subagent && agentId === card.id
      ? card.parent?.id ?? agentId : agentId)
    : undefined;
  return (
    <View style={{ gap: 3 }}>
      <View style={{ paddingHorizontal: 5, paddingTop: 2, flexDirection: "row", alignItems: "center", gap: 5 }}>
        <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>
          {task.hostLabel}
        </Text>
      </View>
      <TaskCardView card={card} theme={screen.theme} compact={screen.layout.compact}
        fields={fields} titleLines={2} hostId={task.serverId} language={language}
        focused={false} highlighted={false} stopPhase="idle"
        permissionButtons={buttons} subtasksExpanded={expanded}
        onSubtasksExpandedChange={(_agentId, value) => setExpanded(value)}
        onOpen={navigate}
        onReveal={(agentId, parentId) => onOpen(task, parentId ?? agentId)}
        onPermission={(_card, button) => onPermission(task, button)}
      />
    </View>
  );
}

function LaneColumn({
  laneId, tasks, screen, compact, label, emptyLabel, limit, onMore, onLoadOlder, onOpen,
  onPermission, fields, language, moreText, olderText, headerAction,
}: {
  laneId: LaneId;
  tasks: AggregateTask[];
  screen: PluginScreenProps;
  compact: boolean;
  label: string;
  emptyLabel: string;
  limit: number;
  onMore(): void;
  onLoadOlder?(): void;
  onOpen(task: AggregateTask, agentId: string): void;
  onPermission(task: AggregateTask, button: PermissionButton): void;
  fields: CardSettings;
  language: TasksLanguage;
  moreText: string;
  olderText: string;
  headerAction?: React.ReactNode;
}) {
  const colors = screen.theme.colors;
  return (
    <View style={{
      width: compact ? "100%" : 302, flex: compact ? 1 : undefined, minWidth: compact ? 0 : 302,
      alignSelf: "stretch",
      borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface0,
      borderRadius: 12, overflow: "hidden",
    }}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <StatusIcon kind={laneId === "needs_input" ? "needs_input" : laneId === "running" ? "running" :
          laneId === "review" ? "unread" : laneId === "archived" ? "archived" : "done"}
          theme={screen.theme} size={16} />
        <Text style={{ color: colors.foreground, fontWeight: "600", fontSize: 13 }}>{label}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{tasks.length}</Text>
        <View style={{ flex: 1 }} />
        {headerAction}
      </View>
      <ScrollView nestedScrollEnabled style={{ flex: 1 }}
        contentContainerStyle={{ paddingHorizontal: 8, paddingBottom: 12, gap: 8 }}>
        {tasks.slice(0, limit).map((task) => (
          <TaskPreview key={task.key} task={task} screen={screen} onOpen={onOpen}
            onPermission={onPermission} fields={fields} language={language} />
        ))}
        {tasks.length === 0 ? (
          <Text style={{ color: colors.foregroundMuted, fontSize: 12, padding: 12, textAlign: "center" }}>
            {emptyLabel}
          </Text>
        ) : null}
        {tasks.length > limit ? (
          <Pressable accessibilityRole="button" onPress={onMore} style={{ padding: 12, alignItems: "center" }}>
            <Text style={{ color: colors.accent, fontSize: 12 }}>{moreText} · {tasks.length - limit}</Text>
          </Pressable>
        ) : null}
        {onLoadOlder ? (
          <Pressable accessibilityRole="button" onPress={onLoadOlder} style={{ padding: 12, alignItems: "center" }}>
            <Text style={{ color: colors.accent, fontSize: 12 }}>{olderText}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

export function AllHostsBoard({
  screen, hosts, settings,
}: {
  screen: PluginScreenProps;
  hosts: readonly LiveHost[];
  settings: TasksSettings;
}) {
  const language = useTasksLanguage();
  const ui = words[language];
  const labels = BOARD_STRINGS[language];
  const colors = screen.theme.colors;
  const toast = useToast();
  const fields = useMemo(() => effectiveCard(settings, screen.layout.compact), [settings, screen.layout.compact]);
  const [hostFilter, setHostFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [window, setWindow] = useState<DoneWindow>(settings.board.doneWindow);
  const [lane, setLane] = useState<LaneId>("needs_input");
  const [limits, setLimits] = useState<Record<LaneId, number>>({
    needs_input: INITIAL_LANE_LIMIT, running: INITIAL_LANE_LIMIT,
    review: INITIAL_LANE_LIMIT, done: INITIAL_LANE_LIMIT, archived: INITIAL_LANE_LIMIT,
  });
  const [snapshots, setSnapshots] = useState<Record<string, TasksHandle>>({});
  const onSnapshot = useCallback<ChangeSnapshot>((serverId, tasks) => {
    setSnapshots((previous) => {
      if (tasks === null) {
        if (!(serverId in previous)) return previous;
        const next = { ...previous };
        delete next[serverId];
        return next;
      }
      if (previous[serverId] === tasks) return previous;
      return { ...previous, [serverId]: tasks };
    });
  }, []);
  const options = useMemo<TasksOptions>(() => ({
    doneWindow: window, includeDone: true, includeArchived: showArchived,
  }), [window, showArchived]);
  const online = useMemo(() => hosts.filter((host) => host.status === "online"), [hosts]);
  // Never show a stale card as live after its host disconnects: snapshot
  // removal happens in an effect, but online-host filtering is synchronous.
  const aggregated = useMemo(() => aggregateHostTasks(
    online, snapshots as HostTaskSnapshots, hostFilter, query,
  ), [online, snapshots, hostFilter, query]);
  const laneOrder = showArchived ? LANE_ORDER : LANE_ORDER.filter((id) => id !== "archived");
  const activeCount = laneOrder.reduce((total, id) => total + aggregated[id].length, 0);
  const waiting = online.filter((host) => !snapshots[host.serverId]?.ready);
  const failed = online.filter((host) => snapshots[host.serverId]?.error);
  const notOnline = hosts.filter((host) => host.status !== "online");
  const compact = screen.layout.compact;
  const onOpen = useCallback((task: AggregateTask, agentId: string) => {
    screen.navigation?.openAgent({ serverId: task.serverId, agentId });
  }, [screen.navigation]);
  const onPermission = useCallback((task: AggregateTask, button: PermissionButton) => {
    if (button.kind === "open") {
      onOpen(task, task.card.id);
      return;
    }
    const requestId = task.card.permission?.requestId;
    if (!requestId) return;
    try {
      const acquire = (pluginClient as unknown as { getPaseoClient?: (id: string) => PaseoApi }).getPaseoClient;
      const api = acquire?.(task.serverId);
      if (!api) throw new Error("Host unavailable");
      void respondToPermission(api, task.card.id, button, requestId).catch((error: unknown) =>
        toast.error(error instanceof Error ? error.message : String(error)));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [onOpen, toast]);
  const refresh = useCallback(() => {
    for (const host of online) {
      if (hostFilter && host.serverId !== hostFilter) continue;
      void snapshots[host.serverId]?.refresh();
    }
  }, [online, snapshots, hostFilter]);
  const loadOlder = useCallback(() => {
    for (const host of online) {
      if (hostFilter && host.serverId !== hostFilter) continue;
      const snapshot = snapshots[host.serverId];
      if (snapshot?.lanes.done.hasMore) snapshot.loadMoreDone();
    }
  }, [online, snapshots, hostFilter]);
  const hasMoreHistory = online.some((host) => (!hostFilter || hostFilter === host.serverId) &&
    snapshots[host.serverId]?.lanes.done.hasMore);
  const showMore = useCallback((id: LaneId) => {
    setLimits((current) => ({ ...current, [id]: current[id] + MORE_LANE_LIMIT }));
  }, []);
  const activeHostId = screen.host.id;
  const activeHostLabel = hosts.find((host) => host.serverId === activeHostId)?.label ?? screen.host.label;
  const snapshotsRef = useRef(snapshots);
  snapshotsRef.current = snapshots;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const availabilityRpc = pluginClient.useRpc(tasksAvailabilityRpc);
  const read = useReadControl({
    isReadable: (agentId) => snapshotsRef.current[activeHostId]?.byId.get(agentId)?.readable === true,
    onRead: () => {
      snapshotsRef.current[activeHostId]?.refreshReads();
      snapshotsRef.current[activeHostId]?.refreshUnreads();
    },
    toast,
  });
  const reconcileRead = read.reconcile;
  const activeById = snapshots[activeHostId]?.byId;
  useEffect(() => reconcileRead(), [activeById, reconcileRead]);

  const [checkingAllRead, setCheckingAllRead] = useState(false);
  const checkingAllReadRef = useRef(false);
  const hostUnreadReviewCards = useMemo<TaskCard[]>(
    () => aggregated.review.filter((task) => task.serverId === activeHostId && isUnreadReviewCard(task.card)).map((task) => task.card),
    [aggregated.review, activeHostId],
  );
  const otherHostUnreadCount = useMemo(
    () => aggregated.review.filter((task) => task.serverId !== activeHostId && isUnreadReviewCard(task.card)).length,
    [aggregated.review, activeHostId],
  );
  const readAllPending = checkingAllRead || read.batchPending || hostUnreadReviewCards.some((card) => read.pending(card.id));
  const readAll = useCallback(() => {
    if (!read.available || checkingAllReadRef.current || read.batchPending || hostUnreadReviewCards.length === 0) return;
    checkingAllReadRef.current = true;
    setCheckingAllRead(true);
    const ids = hostUnreadReviewCards.map((card) => card.id);
    void checkTaskAvailabilityBatch(availabilityRpc, ids, "read", undefined, () => mountedRef.current).then(({ allowed, blocked }) => {
      if (!mountedRef.current) return;
      if (allowed.length === 0) {
        if (blocked[0]) toast.error(taskIssueText(blocked[0].issue, language));
        return;
      }
      const allowedSet = new Set(allowed);
      read.pressMany(hostUnreadReviewCards.filter((card) => allowedSet.has(card.id)));
      if (blocked[0]) {
        toast.error(taskIssueText(blocked[0].issue, language));
      } else if (otherHostUnreadCount > 0) {
        toast.show(labels.allHostsReadOthersNote(activeHostLabel, otherHostUnreadCount));
      }
    }).finally(() => {
      checkingAllReadRef.current = false;
      if (mountedRef.current) setCheckingAllRead(false);
    });
  }, [read, hostUnreadReviewCards, availabilityRpc, toast, language, otherHostUnreadCount, labels, activeHostLabel]);

  const archivableDoneTasks = useMemo(
    () => aggregated.done.filter((task) => isArchivableDoneCard(task.card) && !taskOperationIssue(task.card, "archive")),
    [aggregated.done],
  );
  const [archiveAllPending, setArchiveAllPending] = useState(false);
  const archiveAllRef = useRef(false);
  const archiveAll = useCallback(() => {
    if (archiveAllRef.current || archivableDoneTasks.length === 0) return;
    const byHost = new Map<string, TaskCard[]>();
    for (const task of archivableDoneTasks) {
      const list = byHost.get(task.serverId) ?? [];
      list.push(task.card);
      byHost.set(task.serverId, list);
    }
    archiveAllRef.current = true;
    setArchiveAllPending(true);
    const acquire = (pluginClient as unknown as { getPaseoClient?: (id: string) => PaseoApi }).getPaseoClient;
    void (async () => {
      let archived = 0;
      let failedCount = 0;
      let firstError: string | null = null;
      await Promise.all(
        [...byHost.entries()].map(async ([serverId, cards]) => {
          let api: PaseoApi | null = null;
          try {
            api = acquire?.(serverId) ?? null;
          } catch {
            api = null;
          }
          if (!api) {
            failedCount += cards.length;
            firstError ??= "Host unavailable";
            return;
          }
          const result = await archiveCardsWithApi({ paseo: api, cards, language });
          archived += result.archived;
          failedCount += result.failed;
          firstError ??= result.firstError;
        }),
      );
      if (!mountedRef.current) return;
      if (failedCount > 0) {
        const detail = firstError ?? (language === "zh" ? "未知错误。" : "Unknown error.");
        toast.error(
          language === "zh"
            ? `部分归档失败（${failedCount}/${archivableDoneTasks.length}）：${detail}`
            : `Archived ${archived}/${archivableDoneTasks.length}; ${failedCount} failed: ${detail}`,
        );
      }
    })().finally(() => {
      archiveAllRef.current = false;
      if (mountedRef.current) setArchiveAllPending(false);
    });
  }, [archivableDoneTasks, language, toast]);

  const laneHeaderAction = (id: LaneId) => {
    if (id === "review" && read.available && hostUnreadReviewCards.length > 0) {
      return (
        <MarkAllReadButton
          count={hostUnreadReviewCards.length}
          pending={readAllPending}
          compact={false}
          theme={screen.theme}
          strings={labels}
          onPress={readAll}
          testID="all-hosts-read-all-review"
        />
      );
    }
    if (id === "done" && archivableDoneTasks.length > 0) {
      return (
        <ArchiveAllButton
          count={archivableDoneTasks.length}
          pending={archiveAllPending}
          compact={false}
          theme={screen.theme}
          strings={labels}
          onPress={archiveAll}
          testID="all-hosts-archive-all-done"
        />
      );
    }
    return undefined;
  };

  useEffect(() => {
    setLimits({
      needs_input: INITIAL_LANE_LIMIT, running: INITIAL_LANE_LIMIT,
      review: INITIAL_LANE_LIMIT, done: INITIAL_LANE_LIMIT, archived: INITIAL_LANE_LIMIT,
    });
  }, [query, hostFilter, window, showArchived]);

  const compactLaneId = laneOrder.includes(lane) ? lane : "running";

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
      {online.map((host) => (
        <HostReader key={host.serverId} serverId={host.serverId} activeHostId={activeHostId} options={options}
          onChange={onSnapshot} />
      ))}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 7, alignItems: "center" }}
        style={{ flexGrow: 0 }}>
        <HostChip label={ui.all} selected={hostFilter === null} onPress={() => setHostFilter(null)}
          screen={screen} count={activeCount} />
        {hosts.map((host) => (
          <HostChip key={host.serverId} label={`${host.label} · ${host.status === "online" ? ui.active :
            host.status === "offline" || host.status === "error" ? ui.offline : ui.connecting}`}
            selected={hostFilter === host.serverId} onPress={() => setHostFilter(host.serverId)} screen={screen} />
        ))}
      </ScrollView>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 7, paddingHorizontal: 12, paddingBottom: 8, flexWrap: "wrap" }}>
        <TextInput value={query} onChangeText={setQuery} placeholder={ui.search}
          placeholderTextColor={colors.foregroundMuted}
          style={{ flexGrow: 1, flexBasis: compact ? "100%" : 240, minWidth: 160, height: 36,
            backgroundColor: colors.surface1, borderColor: colors.border, borderWidth: 1, borderRadius: 9,
            paddingHorizontal: 10, color: colors.foreground, fontSize: 13 }} />
        {(["24h", "7d", "all"] as const).map((option) => (
          <HostChip key={option} label={labels.windows[option]} selected={window === option}
            onPress={() => setWindow(option)} screen={screen} />
        ))}
        <HostChip label={labels.lanes.archived} selected={showArchived} onPress={() => setShowArchived(!showArchived)} screen={screen} />
        <HostChip label={ui.refresh} selected={false} onPress={refresh} screen={screen} />
      </View>
      {waiting.length > 0 || failed.length > 0 || notOnline.length > 0 ? (
        <Text style={{ paddingHorizontal: 14, paddingBottom: 7, color: colors.foregroundMuted, fontSize: 11 }}>
          {[
            ...(waiting.length ? [`${ui.loading}: ${waiting.map((h) => h.label).join(", ")}`] : []),
            ...(failed.length ? [`${ui.error}: ${failed.map((h) => h.label).join(", ")}`] : []),
            ...(notOnline.length ? [`${ui.hostUnavailable}: ${notOnline.map((h) => h.label).join(", ")}`] : []),
          ].join(" · ")}
        </Text>
      ) : null}
      {hosts.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted, padding: 20 }}>{ui.noHosts}</Text>
      ) : null}
      {compact ? (
        <>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}
            contentContainerStyle={{ gap: 7, paddingHorizontal: 12, paddingBottom: 10 }}>
            {laneOrder.map((id) => (
              <HostChip key={id} screen={screen} label={labels.tabs[id]} count={aggregated[id].length}
                selected={lane === id} onPress={() => setLane(id)} />
            ))}
          </ScrollView>
          <View style={{ flex: 1, paddingHorizontal: 12, paddingBottom: 12 }}>
            <LaneColumn laneId={compactLaneId}
              tasks={aggregated[compactLaneId]} screen={screen}
              compact label={labels.lanes[compactLaneId]}
              emptyLabel={ui.empty} limit={limits[compactLaneId]} onMore={() => showMore(compactLaneId)}
              onLoadOlder={compactLaneId === "done" && hasMoreHistory ? loadOlder : undefined}
              onOpen={onOpen} onPermission={onPermission} fields={fields} language={language}
              moreText={ui.more} olderText={ui.older} headerAction={laneHeaderAction(compactLaneId)} />
          </View>
        </>
      ) : (
        <ScrollView horizontal style={{ flex: 1 }} showsHorizontalScrollIndicator={true}
          contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 12, gap: 10 }}>
          {laneOrder.map((id) => (
            <LaneColumn key={id} laneId={id} tasks={aggregated[id]} screen={screen} compact={false}
              label={labels.lanes[id]} emptyLabel={ui.empty} limit={limits[id]} onMore={() => showMore(id)}
              onLoadOlder={id === "done" && hasMoreHistory ? loadOlder : undefined}
              onOpen={onOpen} onPermission={onPermission} fields={fields} language={language}
              moreText={ui.more} olderText={ui.older} headerAction={laneHeaderAction(id)} />
          ))}
        </ScrollView>
      )}
    </View>
  );
}
