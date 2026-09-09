// legs smoke drill: every configured leg attempts one tiny completion.
// Unconfigured legs (no key) fail with receipts and fall through — by design.
// Usage: node legs-smoke.ts
import { buildPool, completeWithFailover } from "./legs.ts";

const pool = buildPool("fam-gods-smoke-0001");
const results: string[] = [];
for (const l of pool.legs) {
  for (const mid of l.models) {
    const model = pool.models.getModel(l.id, mid);
    if (!model) {
      results.push(`${l.id}/${mid}: not-registered`);
      continue;
    }
    try {
      const r = await completeWithFailover(
        { models: pool.models, legs: [{ ...l, models: [mid] }] },
        [{ role: "user", content: "Reply with exactly: legs-ready", timestamp: Date.now() }],
      );
      results.push(`${l.id}/${mid}: OK cost=${r.cost} reply=${r.text.slice(0, 40)}`);
    } catch (e) {
      results.push(`${l.id}/${mid}: MISS ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
    }
  }
}
console.log(results.join("\n"));
