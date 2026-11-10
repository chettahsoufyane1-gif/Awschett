/**
 * محوّل kie.ai — المزود الأساسي عبر Jobs API الموحد.
 * الأشكال هنا مأخوذة من التوثيق الرسمي (docs.kie.ai):
 *  POST /api/v1/jobs/createTask  → { code, data: { taskId } }
 *  GET  /api/v1/jobs/recordInfo  → { code, data: { state, resultJson, failMsg, failCode } }
 * ملاحظة مهمة: resultJson نص JSON داخل JSON ويحتاج JSON.parse ثانيًا.
 */
import {
  ProviderAdapter, ProviderError, ProviderInput, CheckResult, PROVIDER_TIMEOUT_MS,
} from "./types";

const BASE = "https://api.kie.ai";

/** نداء موحد يغلف أخطاء HTTP/الشبكة في ProviderError ليُصنَّف لاحقًا */
async function kieFetch(key: string, path: string, init?: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (e) {
    // انقطاع شبكة/مهلة → temporary
    throw new ProviderError(0, `network: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* جسم غير JSON */ }

  // kie يغلّف الاستجابة بـ {code, msg, data} — نعتبر code>=400 خطأ مزود
  const code = typeof body?.code === "number" ? body.code : res.status;
  if (res.status >= 400 || code >= 400) {
    const status = code >= 400 ? code : res.status;
    const msg = body?.msg || body?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    throw new ProviderError(status, String(msg));
  }
  return body?.data ?? body;
}

/** استخراج روابط النتائج من resultJson (نص JSON داخل JSON) بشكل دفاعي */
function extractResultUrls(data: any): string[] | undefined {
  if (!data) return undefined;
  if (Array.isArray(data.resultUrls) && data.resultUrls.length) return data.resultUrls.map(String);
  if (typeof data.resultJson === "string") {
    try {
      const parsed = JSON.parse(data.resultJson);
      const urls = parsed?.resultUrls ?? parsed?.resultUrl;
      if (Array.isArray(urls) && urls.length) return urls.map(String);
      if (typeof urls === "string") return [urls];
    } catch { /* نتجاهل النصوص غير الصالحة */ }
  }
  if (typeof data.resultUrl === "string") return [data.resultUrl];
  return undefined;
}

export const kieAdapter: ProviderAdapter = {
  async createTask(key: string, providerModel: string, input: ProviderInput) {
    const data = await kieFetch(key, "/api/v1/jobs/createTask", {
      method: "POST",
      body: JSON.stringify({ model: providerModel, input }),
    });
    const taskId = data?.taskId ?? data?.data?.taskId;
    if (!taskId) throw new ProviderError(500, "kie: لم يُعَد taskId في الاستجابة");
    return { providerTaskId: String(taskId) };
  },

  async checkTask(key: string, providerTaskId: string): Promise<CheckResult> {
    let data: any;
    try {
      data = await kieFetch(key, `/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`);
    } catch (e) {
      // حالة معروفة: المهمة قد لا تكون مرئية لحظيًا → نعاملها معالجة مستمرة
      const msg = e instanceof Error ? e.message : String(e);
      if (/recordInfo is null|not found/i.test(msg)) return { status: "processing" };
      throw e;
    }
    const state = String(data?.state ?? "").toLowerCase();

    if (state === "success") {
      const urls = extractResultUrls(data);
      if (urls?.length) return { status: "completed", urls };
      // نجاح بلا روابط — نعتبره فشلًا حقيقيًا مع رسالة واضحة
      return { status: "failed", error: "kie: اكتملت المهمة دون روابط نتائج" };
    }
    if (state === "fail") {
      // نضمّن failCode في الرسالة حتى يلتقطها مصنف الأخطاء (402/401...)
      const parts = [data?.failCode != null ? String(data.failCode) : "", data?.failMsg ?? data?.errMsg ?? ""]
        .filter(Boolean).join(" ");
      return { status: "failed", error: parts || "kie: فشل غير محدد" };
    }
    // waiting | queuing | generating
    const progress = typeof data?.progress === "number" ? Math.max(0, Math.min(100, data.progress)) : undefined;
    return { status: "processing", progress };
  },
};
