/**
 * Yield Paseo's GenUI tool calls to the host renderer instead of replacing
 * them with Better Paseo's compact tool-call rows.
 *
 * Keep this in sync with isRenderUiToolName in Paseo's
 * packages/protocol/src/tool-name-normalization.ts. This local check avoids
 * depending on the GenUI helper being exported by a released Paseo SDK:
 * installations may use a host fork with GenUI on top of the stock SDK.
 */
function matchesPaseoToolName(name: string, targetTool: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized === targetTool || normalized === `paseo_${targetTool}`) return true;

  if (normalized.includes("__")) {
    const segments = normalized.split("__").filter(Boolean);
    return segments.length >= 3 &&
      segments[0] === "mcp" &&
      (segments[1] === "paseo" || segments[1]?.startsWith("paseo_") === true) &&
      segments.slice(2).join("__") === targetTool;
  }

  if (normalized.includes(".")) {
    const parts = normalized.split(".");
    const namespace = parts[0] ?? "";
    return (namespace === "paseo" || namespace.startsWith("paseo_")) &&
      parts.slice(1).join(".") === targetTool;
  }

  return false;
}

export function isNativeGenUiToolName(name: string): boolean {
  return matchesPaseoToolName(name, "render_ui");
}

export function isNativeTerminalControlToolName(name: string): boolean {
  return matchesPaseoToolName(name, "request_terminal_control");
}

export function isNativeUserShellToolCall(detail: unknown): boolean {
  return (
    typeof detail === "object" &&
    detail !== null &&
    (detail as { type?: unknown }).type === "shell" &&
    (detail as { origin?: unknown }).origin === "user"
  );
}
