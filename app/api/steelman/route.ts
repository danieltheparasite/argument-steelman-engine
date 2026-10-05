import { NextResponse } from "next/server";
import { RequestSchema } from "@/lib/schema";
import { AppError, cached, finalize, modelFor, remember, runSteelman, streamSteelman, type Opts } from "@/lib/ai";

export const maxDuration = 120;

// Best-effort limiter: per server instance only (serverless instances don't share memory).
// For real abuse protection use a shared store (e.g. Upstash/Vercel KV).
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const n = Date.now(), a = (hits.get(ip) ?? []).filter((t) => n - t < 60_000);
  a.push(n); hits.set(ip, a);
  if (hits.size > 500) hits.delete(hits.keys().next().value as string);
  return a.length > 6;
}
const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return fail("Malformed request.", 400); }
  const v = RequestSchema.safeParse(body);
  if (!v.success) return fail(v.error.issues[0]?.message ?? "Invalid request.", 400);
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  if (limited(ip)) return fail("Too many requests. Wait a minute and try again.", 429);

  const { claim, stream } = v.data;
  const o: Opts = { mode: v.data.mode, model: modelFor(v.data.model), fresh: v.data.fresh };

  if (!stream) {
    try { return NextResponse.json({ success: true, data: await runSteelman(claim, o) }); }
    catch (e) {
      if (e instanceof AppError) return fail(e.message, e.status);
      console.error(e); return fail("Something went wrong on the server.", 500);
    }
  }

  const enc = new TextEncoder();
  const out = new ReadableStream({
    async start(ctrl) {
      const send = (x: unknown) => ctrl.enqueue(enc.encode(JSON.stringify(x) + "\n"));
      try {
        const hit = o.fresh ? null : cached(claim, o);
        if (hit) { send({ t: "done", data: hit }); return; }
        let acc = "", data = null as ReturnType<typeof finalize>;
        try {
          for await (const s of streamSteelman(claim, o)) { acc += s; send({ t: "chunk", s }); }
          data = finalize(claim, acc);
        } catch (e) { if (e instanceof AppError && (e.status === 429 || e.status === 502)) throw e; }
        if (data) remember(claim, o, data);
        else data = await runSteelman(claim, { ...o, fresh: true }); // non-streaming fallback with retries
        send({ t: "done", data });
      } catch (e) {
        if (!(e instanceof AppError)) console.error(e);
        send({ t: "error", error: e instanceof AppError ? e.message : "Something went wrong on the server." });
      } finally { ctrl.close(); }
    },
  });
  return new Response(out, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
