import React, { type ReactNode } from "react";
import { Platform, type TextProps } from "react-native";
import { ProseSpan } from "../../../ui/prose-text";
import type { NativeFileLinkSource } from "../native-file-links";
import type { RenderContext } from "./context";

type InlineLinkTextProps = Pick<TextProps,
  "accessibilityRole" | "accessibilityLabel" | "accessibilityHint" | "selectable" | "style">;

/**
 * A link stays inline with the surrounding selectable prose. In particular,
 * never wrap it in a React Native View or Pressable: that breaks Text layout.
 *
 * RN Web Text does not expose a native anchor, so a web-only DOM span receives
 * the real contextmenu event. On Android / streaming native prose the Text
 * receives onLongPress. Settled iOS uses EnrichedMarkdown's onLinkLongPress
 * instead (prose.tsx), which can identify a link inside the native text view.
 *
 * Without the host's optional showMenu action, neither event is intercepted.
 */
export function InteractiveLinkSpan({
  children, context, source, onPress, ...textProps
}: InlineLinkTextProps & {
  children: ReactNode;
  context: RenderContext;
  source: NativeFileLinkSource;
  onPress(): void;
}) {
  const showMenu = context.onShowLinkMenu;
  const element = (
    <ProseSpan
      {...textProps}
      selectable={showMenu && Platform.OS !== "web" ? false : textProps.selectable}
      onPress={onPress}
      onLongPress={showMenu && Platform.OS !== "web" ? () => showMenu(source) : undefined}
    >
      {children}
    </ProseSpan>
  );

  if (Platform.OS !== "web" || !showMenu) return element;

  return (
    <span onContextMenu={(event: React.MouseEvent<HTMLSpanElement>) => {
      event.preventDefault();
      event.stopPropagation();
      showMenu(source, { x: event.pageX, y: event.pageY });
    }}>
      {element}
    </span>
  );
}
