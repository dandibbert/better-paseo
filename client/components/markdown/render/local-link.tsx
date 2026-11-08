import React, { useContext, type ReactNode } from "react";
import { InteractiveLinkSpan } from "./interactive-link";
import { resolveLocalLink } from "./local-path";
import { PathContext } from "../../../ui/path-text";
import { useCopy } from "../../../ui/use-copy";
import { useInputCapabilities } from "../../../ui/use-input-capabilities";
import type { RenderContext } from "./context";

/**
 * A link in the prose that points at a file. It behaves as a path does
 * everywhere else (plan §3.9): a pointer reveals the file in the file
 * manager, and touch copies the absolute path, because revealing would open
 * a window on the daemon's machine rather than the phone in hand.
 */
export function LocalLink({
  path,
  href,
  sourceType,
  context,
  children,
}: {
  path: string;
  /** Original Markdown href, without premature percent-decoding. */
  href?: string;
  sourceType?: "inline-code";
  context: RenderContext;
  children: ReactNode;
}) {
  const pathContext = useContext(PathContext);
  const capabilities = useInputCapabilities();
  const { copy } = useCopy();
  const absolutePath = resolveLocalLink(path, pathContext.cwd);
  const reveal = context.onRevealPath ?? pathContext.reveal;
  const copies = (capabilities.touch && !capabilities.hover) || !reveal;
  const openNative = context.onOpenFileLink;
  const source = sourceType === "inline-code"
    ? { href: href ?? path, text: path, sourceType } as const
    : { href: href ?? path };
  const onPress = () => {
    if (openNative) {
      openNative(source, "preferred");
    } else if (copies) {
      void copy(absolutePath, { feedback: "toast", label: "Copy path" });
    } else {
      reveal?.(absolutePath);
    }
  };
  // `onPress` on a Text, as for a web link: a View mid sentence would break
  // the line box.
  return (
    <InteractiveLinkSpan
      selectable
      context={context}
      source={source}
      accessibilityRole="link"
      accessibilityLabel={absolutePath}
      accessibilityHint={openNative ? "Opens the file in Paseo" : copies ? "Copies the path" : "Reveals the file"}
      onPress={onPress}
      style={context.styles.link}
    >
      {children}
    </InteractiveLinkSpan>
  );
}
