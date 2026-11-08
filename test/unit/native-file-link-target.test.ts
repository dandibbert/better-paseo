import { describe, expect, it } from "vitest";
import { isWorkspaceFileHref } from "../../client/components/markdown/render/file-link-target";
import { Lexer } from "../../client/vendor/marked";
import { nativeProseSource } from "../../client/components/markdown/render/native-prose-source";

describe("native file link targets", () => {
  it.each([
    "./docs/readme.md",
    "../specs/output.md#L40",
    "README",
    "docs/",
    "/tmp/report.txt",
    "file:///Users/me/My%20Notes/report.md",
    "C:/project/main.ts",
    "C:\\project\\main.ts",
    "目录/报告.md",
  ])("uses the native workspace file handler for %s", (href) => {
    expect(isWorkspaceFileHref(href)).toBe(true);
  });

  it.each([
    "", "#section", "?raw=1", "//cdn.example.com/file.md",
    "https://example.com/file.md", "mailto:dev@example.com",
    "javascript:alert(1)", "data:text/html,hello",
  ])("does not hand non-file links to the workspace for %s", (href) => {
    expect(isWorkspaceFileHref(href)).toBe(false);
  });

  it("preserves encoded hrefs, extensionless files, and line anchors for iOS click forwarding", () => {
    const source = nativeProseSource(Lexer.lexInline(
      "[report](docs/My%20Plan.md#L42) [README](README) [website](https://example.com)",
      { gfm: true },
    ));
    expect(source.links).toEqual([
      { kind: "file", target: "docs/My Plan.md#L42", href: "docs/My%20Plan.md#L42" },
      { kind: "file", target: "README", href: "README" },
      { kind: "url", target: "https://example.com" },
    ]);
  });
});
