/**
 * GET /api/health — نبض النظام: قاعدة البيانات + الموديلات + خدمة الدمج + المصادقة.
 */
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { getModels } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const dbOk = await dbHealthy();
  const merger = { base: mergerBase() || null, healthy: await mergerHealthy() };

  return NextResponse.json(
    {
      ok: dbOk,
      database: dbOk ? "turso-connected" : "turso-disconnected",
      mcpEndpoint: "/mcp",
      models: getModels().map((m) => ({
        canonical: m.canonical,
        type: m.type,
        providers: m.providers,
      })),
      merger,
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { status: dbOk ? 200 : 503 }
  );
}
