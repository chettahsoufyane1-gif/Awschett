/**
 * واجهة إدارة المفاتيح — GET (قائمة مقنَّعة) و POST (إضافة مع رفض التكرار).
 * المفتاح الكامل لا يُعاد في أي استجابة إطلاقًا (قاعدة ذهبية 9).
 */
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { listKeys, insertKey, findDuplicateKey } from "@/lib/turso";
import { maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS = ["kie", "cometapi"] as const;

export async function GET() {
  try {
    const keys = await listKeys();
    return NextResponse.json({
      keys: keys.map((k) => ({
        id: k.id,
        provider: k.provider,
        label: k.label,
        maskedKey: maskKey(k.api_key),
        status: k.status,
        usageCount: k.usage_count,
        successCount: k.success_count,
        failCount: k.fail_count,
        lastUsedAt: k.last_used_at,
        lastCheckedAt: k.last_checked_at,
        lastError: k.last_error,
        createdAt: k.created_at,
      })),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "خطأ غير متوقع" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    let body: { provider?: string; api_key?: string; label?: string };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: "جسم الطلب يجب أن يكون JSON صالحًا" }, { status: 400 });
    }
    const provider = String(body.provider ?? "").trim();
    const apiKey = String(body.api_key ?? "").trim();
    const label = String(body.label ?? "").trim().slice(0, 100);

    if (!PROVIDERS.includes(provider as (typeof PROVIDERS)[number])) {
      return NextResponse.json({ error: "المزود غير مدعوم — استخدم kie أو cometapi" }, { status: 400 });
    }
    if (apiKey.length < 8) {
      return NextResponse.json({ error: "المفتاح قصير جدًا أو غير صالح" }, { status: 400 });
    }
    if (await findDuplicateKey(provider, apiKey)) {
      return NextResponse.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود" }, { status: 409 });
    }
    const k = await insertKey({ id: randomUUID(), provider: provider as "kie" | "cometapi", label, api_key: apiKey });
    return NextResponse.json(
      {
        key: {
          id: k.id,
          provider: k.provider,
          label: k.label,
          maskedKey: maskKey(k.api_key),
          status: k.status,
          usageCount: k.usage_count,
          successCount: k.success_count,
          failCount: k.fail_count,
          lastUsedAt: k.last_used_at,
          lastCheckedAt: k.last_checked_at,
          lastError: k.last_error,
          createdAt: k.created_at,
        },
      },
      { status: 201 }
    );
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "خطأ غير متوقع" },
      { status: 500 }
    );
  }
}
