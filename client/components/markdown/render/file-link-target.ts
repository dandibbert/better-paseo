/**
 * A Markdown href that Paseo should try as a workspace file rather than an
 * external address. The host still validates and resolves the target before
 * opening any panel; this predicate only selects which click handler to use.
 */
export function isWorkspaceFileHref(href: string): boolean {
  const value = href.trim();
  if (!value || value.startsWith("#") || value.startsWith("?") || value.startsWith("//")) {
    return false;
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return /^file:\/\//i.test(value);
  return true;
}
