import { NextResponse } from "next/server";
import { ImageRequestSchema } from "@/lib/schema";
import { AppError, readImage } from "@/lib/ai";

export const maxDuration = 120;

// Best-effort limiter, per server instance (same caveat as the other routes).
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const n = Date.now(), a = (hits.get(ip) ?? []).filter((t) => n - t < 60_000);
  a.push(n); hits.set(ip, a);
  if (hits.size > 500) hits.delete(hits.keys().next().value as string);
  return a.length > 6;
}
const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });

/** The bytes must really be the image type the client claims (PNG, JPEG or WebP). */
function looksLike(b64: string, mime: string) {
  const b = Buffer.from(b64.slice(0, 24), "base64");
  if (mime === "image/png") return b.length > 4 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG";
  if (mime === "image/jpeg") return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  return b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";
}

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") ?? 0) > 4_500_000) return fail("That image is too large. Try a smaller screenshot.", 413);
  let body: unknown;
  try { body = await req.json(); } catch { return fail("Malformed request.", 400); }
  const v = ImageRequestSchema.safeParse(body);
  if (!v.success) return fail(v.error.issues[0]?.message ?? "Invalid request.", 400);
  if (!looksLike(v.data.image, v.data.mime)) return fail("That file isn't a valid image.", 400);
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  if (limited(ip)) return fail("Too many requests. Wait a minute and try again.", 429);
  try {
    return NextResponse.json({ success: true, data: await readImage(v.data.image, v.data.mime, v.data.model) });
  } catch (e) {
    if (e instanceof AppError) return fail(e.message, e.status);
    console.error(e); return fail("Something went wrong on the server.", 500);
  }
}
