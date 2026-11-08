import { createContext } from "react";

/**
 * Paseo 0.14's published plugin SDK does not yet expose this optional host
 * action. The compatible Paseo host injects it into assistant timeline
 * renderers; older hosts simply keep Better Paseo's reveal/copy fallback.
 */
export interface NativeFileLinkSource {
  href: string;
  text?: string;
  sourceType?: "inline-code";
}

export interface NativeFileLinkActions {
  open(
    source: NativeFileLinkSource,
    disposition?: "main" | "preferred" | "side",
  ): void;
  /** Optional on Paseo hosts with the native Markdown link menu. */
  showMenu?(
    source: NativeFileLinkSource,
    point?: { x: number; y: number },
  ): void;
}

export const NativeLinkMenuContext = createContext<NativeFileLinkActions["showMenu"] | null>(null);

export const NativeFileLinkContext = createContext<NativeFileLinkActions["open"] | null>(null);
