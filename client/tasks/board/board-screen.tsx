import React, { useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { TasksTypography, HOST_FONT as F, HOST_LINE } from "../typography";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import * as pluginClient from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useDeviceTasksPreferences } from "../device-preferences";
import { useTasksLanguage } from "../i18n";
import { pluginRoot } from "../../components/focus-ring";
import { HAIRLINE } from "./board-style";
import type { TasksSettings } from "../../../shared/tasks-settings";
import { SearchCoverageProvider } from "./search-loading";
import { DesktopBoard } from "./desktop-board";
import { MenuBoundsContext } from "./menu";
import { carriedSettings } from "./carry";
import { tasksSettingsOpener, useTasksEnabledStore, useTasksSettings } from "./enabled";
import { boardIsCompact } from "./navigation";
import { PhoneBoard } from "./phone-board";
import { AllHostsBoard } from "./all-hosts-screen";
import { BOARD_STRINGS } from "./strings";
import { useBoard, type BoardLayoutHandlers } from "./use-board";

/**
 * The Tasks board (`addScreen` id `tasks`): the lanes side by side, scrolling
 * sideways when the board is narrow; one lane behind a tab bar only on a
 * phone, the host's compact layout (`boardIsCompact`). Filters
 * live in the session per host and travel as the screen's params; see
 * `params.ts`.
 *
 * Always registered, so a reload, a restored tab or a link resolves before
 * the settings arrive (the host resolves the route once). It mounts only
 * when open. Off, it says so and how to turn it on, from what the startup
 * read or the settings page already told the store: no read of its own.
 * While the startup read is out it draws an empty page and waits for it;
 * without one (or after it failed) it reads the settings itself.
 */
export function TasksBoardScreen(props: PluginScreenProps) {
  const store = useTasksEnabledStore();
  // Off, as the startup read or the settings page said: say so, and read nothing more.
  if (store.enabled === false) return <BoardOff {...props} />;
  // The startup read is still out: wait for it rather than read a second time,
  // unless this host's board was on before a reconnect (`carry.ts`): then draw
  // it now, from what it carried, and let the board's own read catch up.
  if (store.enabled === null && store.startupRead === "pending" && carriedSettings(props.host.id)?.enabled !== true) {
    return <BoardBlank {...props} />;
  }
  return <BoardReader {...props} />;
}

/** The settings, read (or shared with the board's own read when on), and followed. */
function BoardReader(props: PluginScreenProps) {
  const settings = useTasksSettings(props.host.id);
  const device = useDeviceTasksPreferences(settings);
  if (!device.ready && device.error) throw new Error(device.error);
  if (!device.ready) return <BoardBlank {...props} />;
  if (!settings) return <BoardBlank {...props} />;
  if (!settings.enabled) return <BoardOff {...props} />;
  return <BoardContent {...props} cardSettings={device.settings ?? settings} />;
}

function BoardBlank(props: PluginScreenProps) {
  return <View style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }} />;
}

/** The layout follows the host's: the phone layout on its compact layout, the lanes everywhere else. */
/**
 * Host enumeration is a client capability. A stock or older Paseo client may
 * omit it; that client keeps the original single-daemon board unchanged.
 * This stable wrapper calls the real SDK hook when the host supports it.
 */
interface ConfiguredHost {
  serverId: string;
  label: string;
  status: "idle" | "connecting" | "online" | "offline" | "error";
}
const EMPTY_HOSTS: readonly ConfiguredHost[] = [];
const readConfiguredHosts =
  (pluginClient as { useHosts?: () => readonly ConfiguredHost[] }).useHosts ?? (() => EMPTY_HOSTS);
let rememberedScope: "all" | "current" = "all";

function BoardContent(props: PluginScreenProps & { cardSettings: TasksSettings }) {
  const hosts = readConfiguredHosts();
  const [scope, setScope] = useState<"all" | "current">(() => rememberedScope);
  const language = useTasksLanguage();
  const multiHost = hosts.length > 1;
  const selectedAll = multiHost && scope === "all";
  const changeScope = (next: "all" | "current") => {
    rememberedScope = next;
    setScope(next);
  };
  const colors = props.theme.colors;
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
      {multiHost ? (
        <View style={{ flexDirection: "row", gap: 7, alignItems: "center", paddingHorizontal: 12,
          paddingVertical: 8, borderBottomWidth: HAIRLINE, borderBottomColor: colors.border }}>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: selectedAll }}
            onPress={() => changeScope("all")}
            style={{ paddingVertical: 7, paddingHorizontal: 12, borderRadius: 8,
              backgroundColor: selectedAll ? colors.surface2 : colors.surface1 }}>
            <Text style={{ fontSize: 13, fontWeight: selectedAll ? "600" : "400",
              color: selectedAll ? colors.foreground : colors.foregroundMuted }}>
              {language === "zh" ? "全部主机" : "All hosts"} · {hosts.length}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityState={{ selected: !selectedAll }}
            onPress={() => changeScope("current")}
            style={{ paddingVertical: 7, paddingHorizontal: 12, borderRadius: 8,
              backgroundColor: !selectedAll ? colors.surface2 : colors.surface1 }}>
            <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: !selectedAll ? "600" : "400",
              color: !selectedAll ? colors.foreground : colors.foregroundMuted }}>
              {props.host.label}
            </Text>
          </Pressable>
        </View>
      ) : null}
      {selectedAll ? (
        <TasksTypography theme={props.theme}>
          <AllHostsBoard screen={props} hosts={hosts} settings={props.cardSettings} />
        </TasksTypography>
      ) : (
        <LocalBoardContent {...props} />
      )}
    </View>
  );
}

/** Local board retains the complete existing operations, filters and details. */
function LocalBoardContent(props: PluginScreenProps) {
  const rootRef = useRef<View>(null);
  const handlers = useRef<BoardLayoutHandlers | null>(null);
  const compact = boardIsCompact(props.layout.compact);
  const board = useBoard(props, rootRef, handlers, compact);
  const Layout = compact ? PhoneBoard : DesktopBoard;
  const layout = useMemo(() => <Layout screen={props} board={board} rootRef={rootRef} handlers={handlers} />, [Layout, props, board]);
  return (
    <TasksTypography theme={props.theme}>
      <View {...pluginRoot} style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}>
        <SearchCoverageProvider cancelled={board.searchCancelled} setCancelled={board.setSearchCancelled} cancelText={board.strings.cancelSearch} resumeText={board.strings.resumeSearch} stoppedText={board.strings.searchStopped} status={board.searchStatus} historyLoading={board.searchHistoryLoading} historyError={board.tasks.historyError} retryHistory={board.tasks.clearHistoryError} historyLoadingText={board.strings.historyLoading} historyFailedText={board.strings.historyFailed} query={board.params.query} strings={board.fullConversationSearch ? board.strings.conversationSearchCoverage : board.strings.searchCoverage} total={board.total} fullConversation={board.fullConversationSearch} onFullConversationChange={board.setFullConversationSearch} fullConversationLabel={board.strings.fullConversationSearch} fullConversationShortLabel={board.strings.fullConversationShort} fullConversationHint={board.strings.fullConversationHint(board.fullConversationSearch)}>
          <MenuBoundsContext.Provider value={rootRef}>
            {layout}
          </MenuBoundsContext.Provider>
        </SearchCoverageProvider>
      </View>
    </TasksTypography>
  );
}

function BoardOff(props: PluginScreenProps) {
  const strings = BOARD_STRINGS[useTasksLanguage()];
  const colors = props.theme.colors;
  const open = tasksSettingsOpener();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: colors.surface0 }}>
      <View style={{ maxWidth: 360, alignItems: "center", gap: 8 }}>
        <Icon name="SquareKanban" size={20} color={colors.foregroundMuted} />
        <Text style={{ fontSize: F.lg, fontWeight: "600", color: colors.foreground, textAlign: "center" }}>{strings.boardOff}</Text>
        <Text style={{ fontSize: F.sm, lineHeight: HOST_LINE.sm, color: colors.foregroundMuted, textAlign: "center" }}>{strings.boardOffHint}</Text>
        {open ? (
          <Pressable
            accessibilityRole="button"
            onPress={open}
            style={{ marginTop: 6, height: 32, paddingHorizontal: 14, borderRadius: 6, borderWidth: HAIRLINE, borderColor: colors.border, justifyContent: "center" }}
          >
            <Text style={{ fontSize: F.base, fontWeight: "500", color: colors.foreground }}>{strings.openSettings}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}
