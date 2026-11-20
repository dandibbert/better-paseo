import { describe, expect, it } from "vitest";
import { SETTINGS_SCREEN_TITLES, resolveLanguage, systemLanguage } from "../../client/i18n/settings-strings";
import { SETTINGS_STRINGS } from "../../client/i18n/settings-page-strings";
import { copiedToast, toolbarLabel } from "../../client/i18n/toolbar-strings";
import { parsePreferences, DEFAULT_PREFERENCES } from "../../client/preferences";

describe("settings language", () => {
  it("follows the system by default and keeps an explicit choice", () => {
    expect(DEFAULT_PREFERENCES.language).toBe("system");
    expect(parsePreferences({ language: "zh" }).language).toBe("zh");
    expect(parsePreferences({ language: "fr" }).language).toBe("system");
    expect(resolveLanguage("en", "zh-CN")).toBe("en");
    expect(resolveLanguage("zh", "en-US")).toBe("zh");
  });

  it("reads any Chinese system locale as Chinese and anything else as English", () => {
    expect(resolveLanguage("system", "zh-CN")).toBe("zh");
    expect(resolveLanguage("system", "zh-Hant-TW")).toBe("zh");
    expect(resolveLanguage("system", "zh")).toBe("zh");
    expect(resolveLanguage("system", "en-GB")).toBe("en");
    expect(resolveLanguage("system", "ja-JP")).toBe("en");
    expect(resolveLanguage("system", null)).toBe("en");
  });

  it("titles the screen in the bundle as the page does in the chunk", () => {
    expect(SETTINGS_SCREEN_TITLES).toEqual({ en: SETTINGS_STRINGS.en.screenTitle, zh: SETTINGS_STRINGS.zh.screenTitle });
  });

  it("finds a system locale in the test runtime", () => {
    expect(typeof systemLanguage()).toBe("string");
  });

  it("has every English string in Chinese, with the same parameters", () => {
    const en = SETTINGS_STRINGS.en as Record<string, unknown>;
    const zh = SETTINGS_STRINGS.zh as Record<string, unknown>;
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      expect(typeof zh[key], key).toBe(typeof en[key]);
      if (typeof en[key] === "function") {
        expect((zh[key] as (...args: never[]) => unknown).length, key).toBe(
          (en[key] as (...args: never[]) => unknown).length,
        );
      } else {
        expect(zh[key], key).not.toBe("");
        // The two language names are written in their own language in both.
        if (key !== "languageEnglish" && key !== "languageChinese") expect(zh[key], key).not.toBe(en[key]);
      }
    }
  });

  it("translates turn telemetry and copy toasts into Chinese", () => {
    for (const label of [
      "Output TPS",
      "First token",
      "TPS",
      "TTFT",
      "API turns",
      "Tool calls",
      "API duration",
      "Generation",
      "Tool duration",
      "Approval wait",
      "Cache write",
      "Reported cost",
      "Stop reason",
      "Output tokens",
    ]) {
      expect(toolbarLabel(label, "zh")).not.toBe(label);
    }
    expect(copiedToast("Copy error", "zh")).toBe("已复制错误");
    expect(copiedToast("Copy sent message", "zh")).toBe("已复制发送消息");
    expect(copiedToast("Copy message", "zh")).toBe("已复制消息");
  });
});
