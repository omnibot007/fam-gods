// fam-gods legs — free-model pool with failover rotation + spend telemetry.
// Patterns owned by pi-ai (MIT (c) 2025 Mario Zechner): createProvider,
// openAICompletionsApi, envApiKeyAuth, per-message usage.cost, transformHeaders.
// Go key arrives via file (never chat): FAM_GO_KEY_FILE -> process env.
// Session contract (verified live 2026-09-09): stable x-opencode-session per
// conversation + real User-Agent, or the edge 403s / the gateway 400s.
import { readFileSync } from "node:fs";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const GO_BASE = "https://opencode.ai/zen/go/v1"; // impl appends /chat/completions

function fileKeyEnv(varName: string, filePath: string): void {
  if (!process.env[varName]) {
    try {
      process.env[varName] = readFileSync(filePath, "utf-8").trim();
    } catch {
      /* leg stays unconfigured; rotation skips it */
    }
  }
}

function leg(
  id: string,
  name: string,
  baseUrl: string,
  keyEnv: string | null,
  modelIds: string[],
  maxTokens = 4096, // free tiers cap output/min — groq on_demand allows 1000 OTPM
): { id: string; provider: ReturnType<typeof createProvider>; models: string[] } {
  const provider = createProvider({
    id,
    name,
    baseUrl,
    auth: keyEnv
      ? { apiKey: envApiKeyAuth(`${name} key`, [keyEnv]) }
      : { apiKey: { name, resolve: async () => ({ auth: {} }) } },
    models: modelIds.map(
      (mid): Model<"openai-completions"> => ({
        id: mid,
        name: `${name} ${mid}`,
        api: "openai-completions",
        provider: id,
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens,
      }),
    ),
    api: openAICompletionsApi(),
  });
  return { id, provider, models: modelIds };
}

export interface PoolLeg extends ReturnType<typeof leg> {
  session: string;
}

export function buildPool(sessionId: string) {
  const kf = (name: string) =>
    process.env[name.toUpperCase()] ??
    join(homedir(), ".config", "opencode", `.${name}-key`);
  fileKeyEnv("OPENCODE_GO_KEY", process.env.FAM_GO_KEY_FILE ?? kf("go"));
  for (const k of ["GROQ_API_KEY", "CEREBRAS_API_KEY", "TOKENROUTER_API_KEY", "OPENROUTER_API_KEY"]) {
    fileKeyEnv(k, process.env[`FAM_${k.replace("_API_KEY", "")}_KEY_FILE`] ?? kf(k.toLowerCase().replace("_api_key", "")));
  }
  const models = createModels();
  const legs: PoolLeg[] = [];
  const add = (l: ReturnType<typeof leg>) => {
    models.setProvider(l.provider);
    legs.push({ ...l, session: sessionId });
  };
  // Order = cheap-first. Failures fall through with receipts (rotation below).
  add(leg("openrouter-free", "OpenRouterFree", "https://openrouter.ai/api/v1", "OPENROUTER_API_KEY", [
    "nvidia/nemotron-3.5-lightning:free",
    "cohere/north-mini-code:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
  ]));
  // Pollinations now requires a (free) key: https://enter.pollinations.ai/keys
  add(leg("pollinations", "Pollinations", "https://gen.pollinations.ai/v1", "POLLINATIONS_API_KEY", ["openai/gpt-5.4-nano"]));
  add(leg("tokenrouter", "TokenRouter", "https://www.tokenrouter.com/api/v1", "TOKENROUTER_API_KEY", [
    "z-ai/glm-5.3-free",
  ]));
  add(leg("groq", "Groq", "https://api.groq.com/openai/v1", "GROQ_API_KEY", ["qwen/qwen3.8-27b"], 800));
  add(leg("cerebras", "Cerebras", "https://api.cerebras.ai/v1", "CEREBRAS_API_KEY", ["qwen-3.8-27b"], 800));
  add(leg("go", "GoFallback", GO_BASE, "OPENCODE_GO_KEY", ["deepseek-v4-flash", "glm-5.3-flash"]));
  return { models, legs };
}

export interface LegResult {
  leg: string;
  model: string;
  text: string;
  cost: number;
}

function tele(record: object): void {
  const dir = join(homedir(), ".commandcode", "fam-gods");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "legs.jsonl"), JSON.stringify({ ts: Date.now(), ...record }) + "\n");
}

/** Ordered failover across legs/models. First clean completion wins.
 *  Go-bound requests carry the session contract via transformHeaders. */
export async function completeWithFailover(
  pool: ReturnType<typeof buildPool>,
  messages: { role: "user"; content: string; timestamp: number }[],
  tried: string[] = [],
): Promise<LegResult> {
  const failures: string[] = [];
  for (const l of pool.legs) {
    for (const mid of l.models) {
      const tag = `${l.id}/${mid}`;
      const model = pool.models.getModel(l.id, mid);
      if (!model) {
        failures.push(`${tag}: not-registered`);
        continue;
      }
      const context: Context = { messages, tools: [] };
      try {
        const res = await pool.models.completeSimple(model, context, {
          transformHeaders: async (h) =>
            l.id === "go" ? { ...h, "x-opencode-session": l.session, "User-Agent": "fam-gods/1.0" } : h,
        });
        if (res.stopReason === "error" || res.stopReason === "aborted") {
          throw new Error(`stopReason=${res.stopReason}`);
        }
        const text = res.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join("");
        const cost = res.usage?.cost?.total ?? 0;
        tele({ leg: l.id, model: mid, ok: true, cost, tried });
        return { leg: l.id, model: mid, text, cost };
      } catch (e) {
        const msg = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
        failures.push(`${tag}: ${msg}`);
      }
    }
  }
  tele({ ok: false, failures, tried });
  throw new Error(`all legs failed: ${failures.join(" | ")}`);
}
