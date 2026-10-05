// Provider code: one call per analysis, cached, de-duplicated, loop-guarded.
import { GoogleGenAI } from "@google/genai";
import { ModelOutputSchema, modelJsonSchema, RebutOutputSchema, rebutJsonSchema, MAX_CLAIM_LENGTH } from "./schema";
import { SYSTEM_PROMPT, buildPrompt, REBUT_SYSTEM, buildRebutPrompt, OCR_PROMPT, type AttackId } from "./prompts";
import type { Analysis } from "@/types/steelman";

export class AppError extends Error {
  constructor(message: string, public status = 500) { super(message); }
}

export type Opts = { mode: "mine" | "other"; model?: string; fresh?: boolean };
const MODELS: Record<string, string> = { "26b": "gemma-4-26b-a4b-it", "31b": "gemma-4-31b-it" };
export const modelFor = (k?: string) => (k ? MODELS[k] : undefined);
const SCHEMA = modelJsonSchema(); // built once
const TTL = 3600_000, MAX = 100;
const cache = new Map<string, { t: number; v: Analysis }>();
const inflight = new Map<string, Promise<Analysis>>();
let client: GoogleGenAI | null = null;
let startAt = 0, resolved: string | null = null;
const log = (...a: unknown[]) => console.error("[steelman]", ...a);
const looping = (s: string) => /(\b[\w'’-]+(?:\s+[\w'’-]+){0,4})(?:[\s,.;]+\1){3,}/i.test(s);

const extractJson = (t: string): unknown => {
  const s = t.replace(/```json|```/g, "").trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
};

export function finalize(claim: string, text: string): Analysis | null {
  if (looping(text)) return null;
  const p = ModelOutputSchema.safeParse(extractJson(text));
  if (!p.success) { log("schema mismatch:", JSON.stringify(p.error.issues.slice(0, 2))); return null; }
  const stages = p.data.stages.map((s) => ({ ...s, score: { ...s.score, total: s.score.logicalRigor.score + s.score.relevance.score + s.score.resistanceToRebuttal.score } }));
  return { ...p.data, claim, stages };
}

async function pickModel(ai: GoogleGenAI): Promise<string | null> {
  try {
    const names: string[] = [];
    for await (const m of await ai.models.list({ config: { pageSize: 100 } })) {
      const n = (m.name ?? "").replace(/^models\//, "");
      if (/gemma/i.test(n)) names.push(n);
    }
    log("Gemma models available to your key:", names.join(", ") || "none");
    return names.find((n) => /gemma-4.*26b.*it/i.test(n)) ?? names.find((n) => /gemma-4.*it/i.test(n)) ?? names.find((n) => /it$/i.test(n)) ?? names[0] ?? null;
  } catch (e) { log("could not list models:", String((e as Error)?.message ?? e).slice(0, 200)); return null; }
}

async function request(ai: GoogleGenAI, claim: string, retry: boolean, o: Opts): Promise<{ text: string; finish: string }> {
  let model = o.model ?? resolved ?? process.env.AI_MODEL!;
  const basePrompt = buildPrompt(claim, true, o.mode);
  const prompt = `${basePrompt}\n\nReturn ONLY raw JSON matching this schema:\n${JSON.stringify(SCHEMA)}`;
  const inline = `${SYSTEM_PROMPT}\n\n${prompt}`;
  const base = { temperature: retry ? 0.9 : 0.7, topP: 0.95, topK: 64, maxOutputTokens: 8192, httpOptions: { timeout: 100000 } };

  const attempts = [
    { contents: prompt, config: { ...base, systemInstruction: SYSTEM_PROMPT } },
    { contents: inline, config: base },
  ];

  let listed = false;
  for (let i = retry ? 1 : startAt; i < attempts.length; ) {
    try {
      const r = await ai.models.generateContent({ model, contents: attempts[i].contents, config: attempts[i].config as never });
      const text = r.text ?? "";
      if (text) { if (!retry) startAt = i; resolved = model; return { text, finish: String(r.candidates?.[0]?.finishReason ?? "") }; }
      log(`attempt ${i} empty:`, r.candidates?.[0]?.finishReason); i++;
    } catch (e) {
      const m = String((e as Error)?.message ?? e);
      log(`attempt ${i} failed (${model}):`, m.slice(0, 300));
      if (/429|quota|RESOURCE_EXHAUSTED/i.test(m)) throw new AppError("Rate limit reached. Wait a minute and try again.", 429);
      if (/API_KEY_INVALID|API key not valid|401|UNAUTHENTICATED/i.test(m)) throw new AppError("Google rejected the API key. Create a new key and update GEMINI_API_KEY.", 502);
      if (/404|NOT_FOUND|not found|not supported/i.test(m) && !listed) {
        listed = true;
        const alt = await pickModel(ai);
        if (alt && alt !== model) { log("switching model to", alt); model = alt; continue; }
        throw new AppError("AI_MODEL was not found. See the terminal for the models your key can use.", 502);
      }
      if (/403|PERMISSION/i.test(m)) throw new AppError("This key can't use that model. Check AI_MODEL and your key's access.", 502);
      if (/timeout|DEADLINE|aborted|fetch failed|ENOTFOUND/i.test(m)) throw new AppError("The AI service did not respond in time. Try again.", 504);
      i++;
    }
  }
  throw new AppError("The AI service returned no result. See the terminal for details.", 502);
}

async function generate(claim: string, o: Opts): Promise<Analysis> {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !(process.env.AI_MODEL || resolved)) throw new AppError("Server is missing GEMINI_API_KEY or AI_MODEL. See the README.", 500);
  client ??= new GoogleGenAI({ apiKey: key });
  for (let round = 0; round < 2; round++) {
    const { text, finish } = await request(client, claim, round === 1, o);
    if (/MAX_TOKENS/i.test(finish)) { log("truncation; retrying"); continue; }
    const a = finalize(claim, text);
    if (a) return a;
  }
  throw new AppError("The model couldn't produce a clean analysis. Try again.", 502);
}

const keyOf = (claim: string, o: Opts) => `${o.mode}|${o.model ?? ""}|` + claim.trim().toLowerCase().replace(/\s+/g, " ");
export function cached(claim: string, o: Opts): Analysis | null {
  const hit = cache.get(keyOf(claim, o));
  return hit && Date.now() - hit.t < TTL ? hit.v : null;
}
export function remember(claim: string, o: Opts, v: Analysis) {
  cache.set(keyOf(claim, o), { t: Date.now(), v });
  if (cache.size > MAX) cache.delete(cache.keys().next().value as string);
}

/** Yields raw JSON text chunks as Gemma writes them. Callers validate with finalize(). */
export async function* streamSteelman(claim: string, o: Opts): AsyncGenerator<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new AppError("Server is missing GEMINI_API_KEY. See the README.", 500);
  client ??= new GoogleGenAI({ apiKey: key });
  const model = o.model ?? resolved ?? process.env.AI_MODEL!;
  const prompt = `${buildPrompt(claim, true, o.mode)}\n\nReturn ONLY raw JSON matching this schema:\n${JSON.stringify(SCHEMA)}`;
  const config = {
    temperature: 0.7,
    topP: 0.95,
    topK: 64,
    maxOutputTokens: 8192,
    httpOptions: { timeout: 100000 },
    systemInstruction: SYSTEM_PROMPT
  };
  const stream = await client.models.generateContentStream({ model, contents: prompt, config: config as never });
  for await (const ch of stream) { const t = ch.text; if (t) yield t; }
}

export function runSteelman(claim: string, o: Opts): Promise<Analysis> {
  const k = keyOf(claim, o);
  if (!o.fresh) {
    const hit = cached(claim, o); if (hit) return Promise.resolve(hit);
    const pending = inflight.get(k); if (pending) return pending;
  }
  const p = generate(claim, o).then((v) => { remember(claim, o, v); return v; }).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

/* ===== Rebuttal range: one call, three rebuttals, radar stats for the argument and each rebuttal ===== */
const REBUT_SCHEMA = rebutJsonSchema();
const STAT_KEYS = ["logic", "evidence", "clarity", "relevance", "impact", "resilience"] as const;
type Stats = Record<(typeof STAT_KEYS)[number], number>;
export type RebutResult = {
  argument: string; attack: AttackId; argumentStats: Stats; weakestPoint: string;
  rebuttals: { title: string; attack: AttackId; aimedAt: string; text: string; likelyReply: string; stats: Stats }[];
};
const roundStats = (s: Stats): Stats => Object.fromEntries(STAT_KEYS.map((k) => [k, Math.round(Math.min(10, Math.max(0, s[k])))])) as Stats;

function fatal(e: unknown): AppError | null {
  const m = String((e as Error)?.message ?? e);
  if (/429|quota|RESOURCE_EXHAUSTED/i.test(m)) return new AppError("Rate limit reached. Wait a minute and try again.", 429);
  if (/API_KEY_INVALID|API key not valid|401|UNAUTHENTICATED/i.test(m)) return new AppError("Google rejected the API key. Create a new key and update GEMINI_API_KEY.", 502);
  if (/403|PERMISSION/i.test(m)) return new AppError("This key can't use that model. Check AI_MODEL and your key's access.", 502);
  if (/404|NOT_FOUND/i.test(m)) return new AppError("AI_MODEL was not found. Check the id in .env.local.", 502);
  if (/timeout|DEADLINE|aborted|fetch failed|ENOTFOUND/i.test(m)) return new AppError("The AI service did not respond in time. Try again.", 504);
  return null;
}

export async function runRebut(argument: string, attack: AttackId, modelKey?: string): Promise<RebutResult> {
  const key = process.env.GEMINI_API_KEY;
  const model = modelFor(modelKey) ?? resolved ?? process.env.AI_MODEL;
  if (!key || !model) throw new AppError("Server is missing GEMINI_API_KEY or AI_MODEL. See the README.", 500);
  client ??= new GoogleGenAI({ apiKey: key });
  const prompt = `${buildRebutPrompt(argument, attack)}\n\nReturn ONLY raw JSON matching this schema:\n${JSON.stringify(REBUT_SCHEMA)}`;
  const inline = `${REBUT_SYSTEM}\n\n${prompt}`;
  const base = { topP: 0.95, topK: 64, maxOutputTokens: 4096, httpOptions: { timeout: 100000 } };
  const tries = [
    { contents: prompt, config: { ...base, temperature: 0.8, systemInstruction: REBUT_SYSTEM } },
    { contents: inline, config: { ...base, temperature: 0.9 } },
  ];
  for (let i = startAt; i < tries.length; i++) {
    let text = "", finish = "";
    try {
      const r = await client.models.generateContent({ model, contents: tries[i].contents, config: tries[i].config as never });
      text = r.text ?? ""; finish = String(r.candidates?.[0]?.finishReason ?? "");
    } catch (e) {
      log(`rebut attempt ${i} failed (${model}):`, String((e as Error)?.message ?? e).slice(0, 300));
      const f = fatal(e); if (f) throw f;
      continue;
    }
    if (!text || /MAX_TOKENS/i.test(finish) || looping(text)) { log("rebut: empty, truncated or looping output"); continue; }
    const p = RebutOutputSchema.safeParse(extractJson(text));
    if (!p.success) { log("rebut schema mismatch:", JSON.stringify(p.error.issues.slice(0, 2))); continue; }
    resolved = model;
    const lower = argument.toLowerCase();
    return {
      argument, attack, weakestPoint: p.data.weakestPoint, argumentStats: roundStats(p.data.argumentStats),
      rebuttals: p.data.rebuttals.map((r) => {
        const at = lower.indexOf(r.aimedAt.trim().toLowerCase());
        return {
          title: r.title, text: r.text, likelyReply: r.likelyReply, stats: roundStats(r.stats),
          attack: r.attack === "mixed" ? (attack === "mixed" ? "logic" : attack) : r.attack,
          aimedAt: r.aimedAt.trim() && at >= 0 ? argument.slice(at, at + r.aimedAt.trim().length) : "", // only real excerpts
        };
      }),
    };
  }
  throw new AppError("The model couldn't produce clean rebuttals. Try again.", 502);
}


/* ===== Image -> argument text (Gemma 4 accepts image input through the Gemini API) ===== */
export async function readImage(image: string, mime: string, modelKey?: string): Promise<{ text: string; truncated: boolean }> {
  const key = process.env.GEMINI_API_KEY;
  const model = modelFor(modelKey) ?? resolved ?? process.env.AI_MODEL;
  if (!key || !model) throw new AppError("Server is missing GEMINI_API_KEY or AI_MODEL. See the README.", 500);
  client ??= new GoogleGenAI({ apiKey: key });
  let raw = "";
  try {
    const r = await client.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ inlineData: { mimeType: mime, data: image } }, { text: OCR_PROMPT }] }],
      config: { temperature: 0.1, maxOutputTokens: 2048, httpOptions: { timeout: 100000 } } as never,
    });
    raw = r.text ?? "";
  } catch (e) {
    log("image read failed:", String((e as Error)?.message ?? e).slice(0, 300));
    throw fatal(e) ?? new AppError("The model couldn't read that image. Try a clearer one.", 502);
  }
  const t = raw.replace(/^```\w*\n?/, "").replace(/```\s*$/, "").trim();
  if (!t || /^NO_ARGUMENT\b/i.test(t) || looping(t)) throw new AppError("No readable argument found in that image.", 422);
  return t.length > MAX_CLAIM_LENGTH ? { text: t.slice(0, MAX_CLAIM_LENGTH), truncated: true } : { text: t, truncated: false };
}
