import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { promisify } from "node:util";
import { z } from "zod";
import type {
  UsageAccount,
  UsageReport,
  UsageScope,
  UsageSourceRegistration,
  UsageWindow,
} from "@getpaseo/plugin/server/usage";

/**
 * AGY's own read-only slash command, not per-turn token usage.
 * Adding a Usage Source registers with Paseo's existing Usage UI.
 * No Paseo fork change, extra installation, or client-side feature is needed.
 */
const inputSchema = z.object({ key: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const execAsync = promisify(execFile);
const VERSION_TIMEOUT_MS = 2_500;
const QUERY_TIMEOUT_MS = 16_000; // Under Paseo's 20-second usage-source deadline, even with version check.
const MIN_AGY = [1, 1, 15] as const;
const SIGNED_OUT = /please sign in|not logged in|not logged into|authentication required/i;

// Keep these tiny transforms local: the plugin SDK is a development-only
// type dependency in Better Paseo, so importing its runtime helpers would
// break plugins installed with npm ci --omit=dev.
type UsageProblem = Extract<UsageReport, { status: "unavailable" }>["problem"];
function unavailable(problem: UsageProblem): UsageReport {
  return { status: "unavailable", problem };
}

function toneFromPercent(value: number): UsageWindow["tone"] {
  return value > 90 ? "danger" : value >= 70 ? "warning" : "ok";
}

type CliEnv = NodeJS.ProcessEnv;
export interface AgyRunner {
  (command: string, args: readonly string[], env: CliEnv, timeoutMs: number):
    Promise<{ stdout: string; stderr?: string }>;
}

async function runAgy(command: string, args: readonly string[], env: CliEnv, timeoutMs: number) {
  return execAsync(command, [...args], {
    env,
    cwd: tmpdir(),
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function nonempty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readJson(stdout: string): Record<string, unknown> | null {
  // Be tolerant of a CLI informational banner, but never treat prose as a quota report.
  for (const value of [stdout.trim(), ...stdout.split(/\r?\n/).map((line) => line.trim())]) {
    if (!value.startsWith("{")) continue;
    try {
      const json = record(JSON.parse(value));
      if (json) return json;
    } catch { /* Try the next line. */ }
  }
  return null;
}

export function versionSupportsQuota(value: string): boolean {
  const match = /^(?:agy\s+)?v?(\d+)\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/i.exec(value.trim());
  if (!match) return false;
  const [major = 0, minor = 0, patch = 0] = match.slice(1, 4).map(Number);
  return major > MIN_AGY[0] || (major === MIN_AGY[0] && (
    minor > MIN_AGY[1] || (minor === MIN_AGY[1] && patch >= MIN_AGY[2])
  ));
}

function resetTime(value: unknown): string | null {
  const raw = nonempty(value);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function windowName(value: string): { label: string; short: string } {
  switch (value.toLowerCase()) {
    case "5h": return { label: "5-hour", short: "5h" };
    case "weekly": return { label: "Weekly", short: "wk" };
    default: return { label: value || "Current window", short: value };
  }
}

function shortGroup(value: string): string {
  if (/gemini/i.test(value)) return "Gemini";
  if (/claude.*gpt/i.test(value)) return "Claude/GPT";
  return value;
}

function quotaWindow(value: unknown, group: string): UsageWindow | null {
  const bucket = record(value);
  if (!bucket) return null;
  const fraction = bucket.remaining_fraction;
  if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) return null;
  const id = nonempty(bucket.id) ?? nonempty(bucket.name);
  if (!id) return null;
  const kind = windowName(nonempty(bucket.window) ?? nonempty(bucket.name) ?? "");
  const usedPct = Math.round((1 - fraction) * 1000) / 10;
  return {
    id: group + "/" + id,
    label: group + " · " + kind.label,
    shortLabel: (shortGroup(group) + " " + kind.short).trim(),
    usedPct,
    remainingPct: Math.max(0, 100 - usedPct),
    resetsAt: resetTime(bucket.reset_time),
    tone: toneFromPercent(usedPct),
  };
}

function quotaGroups(value: unknown): UsageWindow[][] {
  if (!Array.isArray(value)) return [];
  const groups: UsageWindow[][] = [];
  for (const candidate of value) {
    const group = record(candidate);
    const name = nonempty(group?.name);
    if (!name || !Array.isArray(group?.buckets)) continue;
    const windows: UsageWindow[] = [];
    const ids = new Set<string>();
    for (const bucket of group.buckets) {
      const window = quotaWindow(bucket, name);
      if (window && !ids.has(window.id)) {
        ids.add(window.id);
        windows.push(window);
      }
    }
    if (windows.length) groups.push(windows);
  }
  return groups;
}

/** Reject an answer unless AGY explicitly says this is a zero-turn quota command. */
export function parseAgyQuota(stdout: string, stderr = ""): UsageReport {
  if (SIGNED_OUT.test(stdout + "\n" + stderr))
    return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });

  const payload = readJson(stdout);
  if (!payload) return { status: "error", error: "agy /usage did not return JSON" };
  if (payload.status === "ERROR") {
    const error = record(payload.error);
    return unavailable({
      kind: "no_quota",
      detail: nonempty(error?.message) ?? nonempty(payload.error) ??
        nonempty(payload.response) ?? "AGY did not provide a quota summary",
    });
  }
  if (payload.status !== "SUCCESS" || payload.num_turns !== 0)
    return { status: "error", error: "agy /usage was not a zero-turn command result" };

  const command = record(payload.command);
  if (!["usage", "quota"].includes(nonempty(command?.name)?.toLowerCase() ?? ""))
    return { status: "error", error: "AGY responded with a different command" };

  const groups = quotaGroups(record(command?.data)?.groups);
  if (!groups.length)
    return unavailable({ kind: "no_quota", detail: "AGY reported no usable quota windows" });

  return {
    status: "available",
    windows: groups.flatMap((windows, groupIndex) =>
      windows.map((window) => ({ ...window, summary: groupIndex === 0 }))),
  };
}

type Account = { command: string; env: CliEnv };
function credentials(scope: UsageScope): Account {
  const env = { ...process.env, ...(scope.kind === "session" ? scope.env : {}) };
  const command = env.PASEO_ANTIGRAVITY_BIN || "agy";
  return { command, env };
}

/**
 * The input passed through the host RPC is an opaque hash, not executable
 * paths or credentials. The plugin resolves that id against its own discoveries
 * so callers cannot pass arbitrary commands to execFile.
 */
export function createAgyUsageSource(run: AgyRunner = runAgy): UsageSourceRegistration {
  const accounts = new Map<string, Account>();
  const identify = (account: Account) => createHash("sha256")
    .update(account.command + "\0" + (account.env.HOME || homedir())).digest("hex");
  const safeVersion = async (account: Account) => {
    const result = await run(account.command, ["--version"], account.env, VERSION_TIMEOUT_MS);
    return versionSupportsQuota(result.stdout);
  };
  return {
    id: "better-paseo-agy",
    label: "Antigravity",
    input: inputSchema,
    async discover(scope): Promise<UsageAccount[]> {
      if (scope.kind === "session" && scope.provider !== "antigravity") return [];
      const account = credentials(scope);
      try {
        if (!(await safeVersion(account))) return [];
      } catch { return []; }
      const key = identify(account);
      accounts.set(key, account);
      return [{ key, label: "AGY CLI", harness: "Antigravity", input: { key } }];
    },
    async fetch(input: unknown): Promise<UsageReport> {
      const { key } = inputSchema.parse(input);
      const account = accounts.get(key);
      if (!account) return { status: "error", error: "AGY login must be rediscovered" };
      try {
        if (!(await safeVersion(account)))
          return unavailable({ kind: "no_quota", detail: "Upgrade agy to 1.1.15 or newer" });
        // No model, conversation id, stream-json or --disable-slash-commands.
        const { stdout, stderr } = await run(
          account.command, ["-p", "/usage", "--output-format", "json"], account.env, QUERY_TIMEOUT_MS,
        );
        return parseAgyQuota(stdout, stderr);
      } catch (error) {
        const failure = record(error);
        const output = [failure?.stdout, failure?.stderr, error instanceof Error ? error.message : ""]
          .filter((part): part is string => typeof part === "string").join("\n");
        if (SIGNED_OUT.test(output))
          return unavailable({ kind: "rejected", status: 401, refreshedBy: "agy" });
        return { status: "error", error: "Unable to read AGY quota on the Paseo daemon host" };
      }
    },
  };
}
