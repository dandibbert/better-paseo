import { describe, expect, it } from "vitest";
import { hasNativeFileLinks } from "../../client/assistant-file-handoff";

describe("native assistant file-link handoff", () => {
  it.each([
    "[report](./reports/result.md)",
    "[source](src/app/main.tsx#L42)",
    "[image file](file:///Users/test/Desktop/screenshot.png)",
    "[中文报告](../docs/%E5%8D%8F%E8%AE%AE.md)",
    "[README](README)",
    "[documentation](docs/)",
    "[absolute](/tmp/report.csv)",
    "[windows](C:/project/src/main.ts)",
    "[reference][artifact]\n\n[artifact]: ./reports/output.txt",
    "- Inspect [config](./configs/settings.json) first",
    "> Open [the report](./reports/output.md)",
    "| File | Status |\n| --- | --- |\n| [details](./details.md) | Done |",
  ])("preserves native workspace file handling for %s", (markdown) => {
    expect(hasNativeFileLinks(markdown)).toBe(true);
  });

  it.each([
    "Ordinary assistant reply with no links",
    "[Website](https://example.com/result.md)",
    "[Website](http://example.com/README)",
    "[Email](mailto:dev@example.com)",
    "[Jump to section](#introduction)",
    "[Query](?view=raw)",
    "[Remote](//example.com/file.md)",
    "[No action](javascript:alert(1))",
    "![Image](./screenshots/output.png)",
    "\`[not a link](./report.md)\`",
    "\`\`\`md\n[example](./report.md)\n\`\`\`",
    "An unfinished [file](./",
  ])("keeps Better Paseo's Markdown for %s", (markdown) => {
    expect(hasNativeFileLinks(markdown)).toBe(false);
  });

  it("does not mistake code-fenced Markdown for a real file link", () => {
    const markdown = [
      "This is only an example:",
      "",
      "\`\`\`markdown",
      "[local](file:///tmp/example.md)",
      "\`\`\`",
      "",
      "The real [link](https://example.com) is external.",
    ].join("\n");
    expect(hasNativeFileLinks(markdown)).toBe(false);
  });
});
