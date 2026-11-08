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
}

export const NativeFileLinkContext = createContext<NativeFileLinkActions["open"] | null>(null);
