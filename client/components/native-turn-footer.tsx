import React, { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useAgent, usePaseo } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { resolveLanguage } from "../i18n/settings-strings";
import { toolbarLabel } from "../i18n/toolbar-strings";
import { useEnhancerPreferences } from "../preferences";
import { useFooterModel } from "../state/footer-model";
import { useRegisteredAssistantReply } from "../state/native-turn-footer";
import type { TurnTelemetry } from "../state/turn-duration";
import type { TurnUsage } from "./user-message";
import { useTurnFooterMatch } from "../state/turn-footers";
import { replyTranslationKey } from "../translation/reply-pending";
import { WholeReplyTranslateButton } from "../translation/reply-whole";
import { useTranslationSettingsState } from "../translation/settings-store";
import { DISCLOSURE_HEADER } from "../ui/disclosure-header";
import { useScrollDismiss } from "../ui/scroll-anchor";
import { CenteredToolbarDetails, ToolbarItem, TooltipSideContext } from "../ui/toolbar-button";
import { TYPE } from "../ui/tokens/typography";
import { useCopy } from "../ui/use-copy";
import { useInputCapabilities } from "../ui/use-input-capabilities";
import { FooterDetails, useFooterDetailsWidth } from "./footer-details";
import { ProviderLogo } from "./provider-logo";
import { unselectable } from "./selection";
import { radiusV2, space, useThemeTokens } from "./theme-tokens";
import { formatFooterMetric } from "./turn-footer";

export interface NativeTurnFooterItemProps extends PluginHostProps {
  agentId: string;
  turnId: string | null;
  model: string | null;
  provider: string | null;
  completedAt: Date | null;
  durationMs: number | null;
  telemetry: TurnTelemetry | null;
}

const FOOTER_HEIGHT = 24;

function mergeDefinedFields<T extends object>(
  primary: T | null | undefined,
  secondary: T | null | undefined,
): Partial<T> | undefined {
  if (!primary && !secondary) return undefined;
  const merged: Record<string, unknown> = {};
  for (const source of [secondary, primary]) {
    if (!source) continue;
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== null) merged[key] = value;
    }
  }
  return Object.keys(merged).length > 0 ? (merged as Partial<T>) : undefined;
}

function mergeTurnTelemetry(
  primary: TurnTelemetry | null | undefined,
  secondary: TurnTelemetry | null | undefined,
  timingUsage: TurnUsage | null | undefined,
): { telemetry: TurnTelemetry | undefined; usage: TurnUsage | null } {
  type TelemetryUsage = NonNullable<TurnTelemetry["usage"]>;
  const mergedTelemetryUsage = mergeDefinedFields<TelemetryUsage>(
    primary?.usage,
    mergeDefinedFields<TelemetryUsage>(secondary?.usage, timingUsage),
  );
  const mergedUsage =
    (mergeDefinedFields<TurnUsage>(
      timingUsage,
      mergeDefinedFields<TurnUsage>(primary?.usage, secondary?.usage),
    ) as TurnUsage | undefined) ?? null;
  const baseTelemetry = mergeDefinedFields<TurnTelemetry>(primary, secondary);
  if (!baseTelemetry && !mergedTelemetryUsage) {
    return { telemetry: undefined, usage: mergedUsage };
  }
  const telemetry: TurnTelemetry = {
    ...(baseTelemetry as TurnTelemetry),
    ...(mergedTelemetryUsage ? { usage: mergedTelemetryUsage as TelemetryUsage } : {}),
  };
  return { telemetry, usage: mergedUsage };
}

/**
 * Renders Better Paseo's model, metric, and translation enhancements inside the
 * host's native `AssistantTurnFooter` slot so Copy, Fork, Metrics, and Timing
 * stay on a single row without duplicating the footer.
 */
export function NativeTurnFooterItem({
  agentId,
  turnId,
  model,
  provider,
  completedAt,
  durationMs,
  telemetry,
  theme,
  layout,
}: NativeTurnFooterItemProps) {
  const preferences = useEnhancerPreferences();
  const tokens = useThemeTokens(theme, preferences, layout.platform);
  const compact = layout.compact;
  const { width: windowWidth } = useWindowDimensions();
  const { language, footerMetric } = preferences;
  const hintLanguage = resolveLanguage(language);
  const paseo = usePaseo();
  const status = useAgent(agentId, (agent) => agent.status);
  const storeProvider = useAgent(agentId, (agent) => agent.provider);
  const storeModel = useAgent(agentId, (agent) => agent.model);
  const thinkingOptionId = useAgent(agentId, (agent) => agent.thinkingOptionId);
  const cwd = useAgent(agentId, (agent) => agent.cwd);
  const hostCompletedAtMs = completedAt ? completedAt.getTime() : null;
  const reply = useRegisteredAssistantReply(
    paseo,
    agentId,
    hostCompletedAtMs,
    durationMs,
  );
  const timing = useTurnFooterMatch(
    paseo,
    agentId,
    {
      replyAt: reply?.replyAt ?? null,
      text: reply?.text ?? null,
      completedAt: hostCompletedAtMs,
      turnId,
    },
    status ? status === "running" : false,
  );
  const { telemetry: mergedTelemetry, usage: mergedUsage } = mergeTurnTelemetry(
    telemetry,
    timing?.telemetry,
    timing?.usage,
  );
  const agentName = provider ?? storeProvider;
  const modelId = model ?? mergedTelemetry?.model ?? storeModel;
  const resolvedModel = useFooterModel(paseo, agentName, modelId, thinkingOptionId, cwd);
  const mergedCompletedAt = hostCompletedAtMs ?? timing?.completedAt ?? null;
  const rawDurationMs = durationMs ?? timing?.durationMs ?? mergedTelemetry?.durationMs ?? null;
  const mergedStartedAt =
    timing?.startedAt ??
    (mergedCompletedAt !== null && rawDurationMs !== null ? mergedCompletedAt - rawDurationMs : null);
  const mergedDurationMs =
    rawDurationMs ??
    (mergedStartedAt !== null && mergedCompletedAt !== null ? Math.max(0, mergedCompletedAt - mergedStartedAt) : null);
  const settings = useTranslationSettingsState();
  const canTranslate = settings.status !== "ready" || settings.values.enabled;
  const metric = formatFooterMetric(footerMetric, mergedTelemetry, mergedUsage);

  const modelCopy = useCopy();
  const capabilities = useInputCapabilities(compact);
  const footerRef = useRef<View>(null);
  const [pressedAnchor, setPressedAnchor] = useState<RefObject<View | null> | null>(null);
  const showDetails = useCallback((anchor: RefObject<View | null>) => setPressedAnchor(anchor), []);
  const closeDetails = useCallback(() => setPressedAnchor(null), []);
  useScrollDismiss(pressedAnchor !== null, closeDetails);
  const longPress = capabilities.touch ? showDetails : undefined;
  const detailsWidth = useFooterDetailsWidth();
  const copyModel = useCallback(() => {
    if (modelId) void modelCopy.copy(modelId, { label: "Copy model name" });
  }, [modelId, modelCopy.copy]);

  const details = (
    <FooterDetails
      agentName={agentName}
      modelId={modelId}
      modelName={resolvedModel.modelName}
      thinkingLabel={resolvedModel.thinkingLabel}
      startedAt={mergedStartedAt}
      completedAt={mergedCompletedAt}
      durationMs={mergedDurationMs}
      usage={mergedUsage}
      telemetry={mergedTelemetry}
      tokens={tokens}
    />
  );

  // On native (Yoga), host `AssistantTurnFooter` puts `width: "100%", flexShrink: 0`
  // on the timing `<Text>` inside a `flexShrink: 1` Pressable, which takes the
  // entire row as its flex basis and starves any `flexShrink: 1` sibling. Using
  // `flexShrink: 0` with a conservative `maxWidth` keeps the timing label on a
  // single line while still allowing `modelAnchor` to ellipsize.
  // On web/desktop, `flexShrink: 1` lets the plugin row expand naturally to its
  // full width without truncating model names, and removing negative horizontal
  // margin avoids `maxWidth: 100%` border-box clipping of short model labels.
  const isWebLayout = layout.platform === "web";
  const hasHostDuration = durationMs !== undefined && durationMs !== null;
  const compactReserve = hasHostDuration
    ? hintLanguage === "zh"
      ? 200
      : 220
    : completedAt
      ? 166
      : 114;
  const maxRowWidth =
    !isWebLayout && windowWidth > 0
      ? Math.max(compact ? 110 : 240, Math.floor(windowWidth) - (compact ? compactReserve : 220))
      : undefined;

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          minHeight: FOOTER_HEIGHT,
          flexDirection: "row",
          flexWrap: "nowrap",
          alignItems: "center",
          gap: space.sm,
          flexShrink: isWebLayout ? 1 : 0,
          minWidth: 0,
          ...(maxRowWidth !== undefined ? { maxWidth: maxRowWidth } : {}),
        },
        translateWrap: {
          flexShrink: 0,
        },
        modelAnchor: {
          flexShrink: 1,
          minWidth: 0,
        },
        metadata: {
          width: "auto",
          minHeight: FOOTER_HEIGHT,
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          borderRadius: radiusV2.block,
        },
        modelButton: {
          flexShrink: 1,
          minWidth: 0,
          paddingHorizontal: compact ? 2 : space.xs,
          paddingVertical: space.xs / 2,
        },
        metricButton: {
          flexShrink: 0,
        },
        time: {
          fontFamily: tokens.fontUi,
          fontSize: TYPE.button.size,
          lineHeight: TYPE.button.lineHeight,
          fontVariant: ["tabular-nums"],
          color: tokens.foregroundMuted,
          ...unselectable,
        },
        modelText: {
          flexShrink: 1,
          minWidth: 0,
        },
      }),
    [tokens, compact, isWebLayout, maxRowWidth],
  );

  const showTranslate = Boolean(reply && canTranslate);
  const showModel = Boolean(resolvedModel.modelName);
  const showMetric = Boolean(metric);
  if (!showTranslate && !showModel && !showMetric) return null;

  return (
    <TooltipSideContext.Provider value="auto">
      <Pressable
        ref={footerRef}
        testID="native-footer-extras"
        accessible={false}
        focusable={false}
        onLongPress={longPress ? () => longPress(footerRef) : undefined}
        style={styles.container}
      >
        {reply && canTranslate ? (
          <View style={styles.translateWrap}>
            <WholeReplyTranslateButton
              agentId={agentId}
              replyKey={replyTranslationKey(agentId, reply.replyAt)}
              text={reply.text}
              theme={theme}
            />
          </View>
        ) : null}
        {resolvedModel.modelName ? (
          <ToolbarItem
            label={modelCopy.copied ? "Copied" : "Copy model name"}
            tokens={tokens}
            align="start"
            accessibilityLabel={modelCopy.copied ? "Model name copied" : "Copy model name"}
            onPress={copyModel}
            onLongPress={longPress}
            hitSlop={compact ? (44 - FOOTER_HEIGHT) / 2 : 0}
            anchorStyle={styles.modelAnchor}
            buttonStyle={[styles.metadata, styles.modelButton]}
            details={details}
            detailsWidth={detailsWidth}
          >
            {modelCopy.copied ? (
              <Icon name="Check" size={DISCLOSURE_HEADER.icon} color={tokens.success} />
            ) : agentName ? (
              <ProviderLogo provider={agentName} size={DISCLOSURE_HEADER.icon} color={tokens.foregroundMuted} />
            ) : (
              <Icon name="Copy" size={DISCLOSURE_HEADER.icon} color={tokens.foregroundMuted} />
            )}
            <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.time, styles.modelText]}>
              {resolvedModel.modelName}
            </Text>
          </ToolbarItem>
        ) : null}
        {metric ? (
          <ToolbarItem
            label={`${toolbarLabel(metric.label, language)}${hintLanguage === "zh" ? "：" : ":"} ${metric.value}`}
            accessibilityLabel={`${metric.label}: ${metric.value}`}
            tokens={tokens}
            align="end"
            buttonStyle={[styles.metadata, styles.metricButton]}
            details={details}
            detailsWidth={detailsWidth}
            onLongPress={longPress}
          >
            <Icon name="Gauge" size={DISCLOSURE_HEADER.icon} color={tokens.foregroundMuted} />
            <Text style={styles.time}>{metric.value}</Text>
          </ToolbarItem>
        ) : null}
      </Pressable>
      {pressedAnchor ? (
        <CenteredToolbarDetails close={closeDetails} width={detailsWidth} tokens={tokens}>
          {details}
        </CenteredToolbarDetails>
      ) : null}
    </TooltipSideContext.Provider>
  );
}
