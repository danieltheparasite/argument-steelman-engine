import { NextResponse } from "next/server";
import { RebutRequestSchema } from "@/lib/schema";
import { AppError, runRebut } from "@/lib/ai";

export const maxDuration = 120;

// Best-effort limiter, per server instance (same caveat as /api/steelman).
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const n = Date.now(), a = (hits.get(ip) ?? []).filter((t) => n - t < 60_000);
  a.push(n); hits.set(ip, a);
  if (hits.size > 500) hits.delete(hits.keys().next().value as string);
  return a.length > 8;
}
const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

export async function POST(req: Request) {
  let body: unknown;
  try { body = await req.json(); } catch { return fail("Malformed request.", 400); }
  const v = RebutRequestSchema.safeParse(body);
  if (!v.success) return fail(v.error.issues[0]?.message ?? "Invalid request.", 400);
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  if (limited(ip)) return fail("Too many requests. Wait a minute and try again.", 429);
  try {
    return NextResponse.json({ success: true, data: await runRebut(v.data.argument, v.data.attack, v.data.model) });
  } catch (e) {
    if (e instanceof AppError) return fail(e.message, e.status);
    console.error(e); return fail("Something went wrong on the server.", 500);
  }
}
