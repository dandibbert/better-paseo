import type { RecordedTurn } from "../shared/turn-usage-rpc";

interface Rates { input: number; output: number; cache_read?: number; cache_write?: number }
interface ModelRates { id: string; provider: string; cost: Rates }

let catalog: ModelRates[] = [];
let lastFetch = 0;
let inFlight: Promise<ModelRates[]> | null = null;
const TTL_MS = 24 * 60 * 60 * 1000;

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

async function loadCatalog(): Promise<ModelRates[]> {
  if (Date.now() - lastFetch < TTL_MS) return catalog;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error("Models.dev unavailable");
      const data: unknown = await response.json();
      const result: ModelRates[] = [];
      if (data && typeof data === "object") {
        for (const [provider, entry] of Object.entries(data)) {
          if (!entry || typeof entry !== "object" || !("models" in entry)) continue;
          const models = (entry as { models?: unknown }).models;
          if (!models || typeof models !== "object") continue;
          for (const [id, raw] of Object.entries(models)) {
            if (!raw || typeof raw !== "object" || !("cost" in raw)) continue;
            const cost = (raw as { cost?: unknown }).cost;
            if (!cost || typeof cost !== "object") continue;
            const rates = cost as Record<string, unknown>;
            const input = nonnegative(rates.input), output = nonnegative(rates.output);
            if (input === null || output === null) continue;
            result.push({ id: id.toLowerCase(), provider: provider.toLowerCase(), cost: {
              input, output,
              ...(nonnegative(rates.cache_read) !== null ? { cache_read: nonnegative(rates.cache_read)! } : {}),
              ...(nonnegative(rates.cache_write) !== null ? { cache_write: nonnegative(rates.cache_write)! } : {}),
            } });
          }
        }
      }
      if (result.length) { catalog = result; lastFetch = Date.now(); }
    } catch { lastFetch = Date.now() - TTL_MS + 60_000; }
    return catalog;
  })();
  try { return await inFlight; } finally { inFlight = null; }
}

function normalizeModel(value: string): string {
  return value.toLowerCase().replace(/^models\//, "").replace(/:[a-z0-9_-]+$/, "");
}

/** Exact model matching only; if multiple providers disagree, refuse to guess. */
export function findRates(models: readonly ModelRates[], model: string, provider?: string): Rates | null {
  const id = normalizeModel(model);
  const variants = [id, id.split("/").at(-1)!];
  const matches = models.filter((entry) => variants.includes(entry.id) || variants.includes(`${entry.provider}/${entry.id}`));
  if (!matches.length) return null;
  const preferred = provider ? matches.filter((entry) => entry.provider === provider || (provider === "codex" && entry.provider === "openai")) : [];
  const candidates = preferred.length ? preferred : matches;
  const unique = new Map(candidates.map((entry) => [JSON.stringify(entry.cost), entry.cost]));
  return unique.size === 1 ? candidates[0]!.cost : null;
}

/** Rates are USD per million tokens. Cached tokens are included in Codex input. */
export function estimateTurn(usage: NonNullable<RecordedTurn["usage"]>, rates: Rates, provider?: string): number | null {
  const input = nonnegative(usage.inputTokens);
  const output = nonnegative(usage.outputTokens);
  if (input === null || output === null) return null;
  const cached = nonnegative(usage.cachedInputTokens) ?? 0;
  const cacheWrite = nonnegative(usage.cacheCreationInputTokens) ?? 0;
  const included = provider === "codex" || provider === "openai";
  const uncached = included ? Math.max(0, input - cached) : input;
  const total = uncached * rates.input + cached * (rates.cache_read ?? rates.input) +
    cacheWrite * (rates.cache_write ?? rates.input) + output * rates.output;
  return total / 1_000_000;
}

export async function sessionSpend(turns: readonly RecordedTurn[], provider?: string) {
  const reported = turns.map((turn) => nonnegative(turn.usage?.totalCostUsd)).filter((n): n is number => n !== null);
  // Paseo providers can report cumulative session cost; never sum snapshots.
  if (reported.length) {
    return { usd: reported.at(-1)!, source: "reported" as const, pricedTurns: reported.length, totalTurns: turns.length, priceSource: null };
  }
  const prices = await loadCatalog();
  let total = 0, pricedTurns = 0;
  for (const turn of turns) {
    if (!turn.usage || !turn.model) continue;
    const rates = findRates(prices, turn.model, provider);
    if (!rates) continue;
    const amount = estimateTurn(turn.usage, rates, provider);
    if (amount === null) continue;
    total += amount;
    pricedTurns++;
  }
  return { usd: pricedTurns ? total : null, source: pricedTurns ? "estimated" as const : "unavailable" as const,
    pricedTurns, totalTurns: turns.length, priceSource: pricedTurns ? "models.dev" : null };
}
