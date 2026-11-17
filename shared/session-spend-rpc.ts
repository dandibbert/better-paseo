import { z } from "zod";
import { defineRpc } from "@getpaseo/plugin";

/** API-equivalent USD spend, not a subscription billing statement. */
export const sessionSpendRpc = defineRpc({
  name: "turns.session-spend",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({
    usd: z.number().nullable(),
    source: z.enum(["reported", "estimated", "unavailable"]),
    pricedTurns: z.number(),
    totalTurns: z.number(),
    priceSource: z.string().nullable(),
  }),
});
