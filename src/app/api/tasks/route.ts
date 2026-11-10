/**
 * GET /api/tasks — لوحة المهام: إحصائيات + أحدث المهام (تُحدَّث تلقائيًا من الواجهة).
 */
import { NextRequest, NextResponse } from "next/server";
import { listRecentTasks, taskStats } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const limit = Math.max(1, Math.min(50, Number(sp.get("limit") ?? 20) || 20));
    const type = sp.get("type") ?? undefined;
    const status = sp.get("status") ?? undefined;

    const [stats, tasks] = await Promise.all([
      taskStats(),
      listRecentTasks(limit, { type: type ?? undefined, status: status ?? undefined }),
    ]);

    return NextResponse.json({
      stats,
      tasks: tasks.map((t) => {
        let urls: string[] = [];
        let attempts = 0;
        try { const a = JSON.parse(t.result_urls_json || "[]"); if (Array.isArray(a)) urls = a.map(String); } catch {}
        try { const a = JSON.parse(t.attempts_json || "[]"); if (Array.isArray(a)) attempts = a.length; } catch {}
        return {
          id: t.id,
          type: t.type,
          model: t.model,
          status: t.status,
          progress: t.progress,
          prompt: t.prompt.slice(0, 140),
          resultUrls: urls,
          errorMessage: t.error_message,
          attempts,
          provider: t.provider,
          createdAt: t.created_at,
          updatedAt: t.updated_at,
        };
      }),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}
