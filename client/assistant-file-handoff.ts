import { Lexer, type Token, type Tokens } from "./vendor/marked";
import { LEXER_OPTIONS } from "./components/markdown/lex";

/**
 * The plugin SDK does not expose Paseo's workspace file-panel opener to
 * timeline renderers. Keep messages containing file hyperlinks on the host
 * renderer, where the assistant-file-links resolver opens the real file panel.
 * Other messages retain Better Paseo's streaming Markdown and turn footer.
 */
function isWorkspaceFileHref(href: string): boolean {
  const value = href.trim();
  if (!value || value.startsWith("#") || value.startsWith("?") || value.startsWith("//")) {
    return false;
  }

  // External URLs stay in Better Paseo's Markdown renderer. File URLs and
  // Windows drive paths must instead use the native workspace file handler.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return /^file:\/\//i.test(value) || /^[A-Za-z]:[\\/]/.test(value);
  }

  // Explicit relative/absolute Markdown hrefs are workspace targets even
  // without an extension ("README", "docs/", etc.). The host resolves them
  // against the workspace and supports line fragments and encoded names.
  return true;
}

function hasFileLinkToken(tokens: readonly Token[]): boolean {
  for (const token of tokens) {
    if (token.type === "link" && isWorkspaceFileHref(token.href)) return true;

    // Links written as examples must never steal a message's renderer.
    if (token.type === "code" || token.type === "codespan" || token.type === "html") {
      continue;
    }
    if (token.type === "list") {
      if (token.items.some((item) => hasFileLinkToken(item.tokens))) return true;
      continue;
    }
    if (token.type === "table") {
      if (token.header.some((cell) => hasFileLinkToken(cell.tokens)) ||
        token.rows.some((row) => row.some((cell) => hasFileLinkToken(cell.tokens)))) return true;
      continue;
    }
    const children = (token as Tokens.Generic).tokens;
    if (children && hasFileLinkToken(children)) return true;
  }
  return false;
}

/** An explicitly linked local file somewhere in the assistant's Markdown. */
export function hasNativeFileLinks(markdown: string): boolean {
  // Cheap check before parsing long or streaming replies. Includes reference
  // links and definitions, angle-bracket file URLs and standard inline links.
  if (!/\]\(|\]\[|\]:|file:\/\//i.test(markdown)) return false;
  return hasFileLinkToken(Lexer.lex(markdown, LEXER_OPTIONS));
}
