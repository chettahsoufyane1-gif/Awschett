/**
 * محوّل CometAPI — المزود الثاني.
 * الأشكال هنا مأخوذة من التوثيق الرسمي الحقيقي (apidoc.cometapi.com):
 *  - صور: POST /v1/images/generations (متوافقة مع OpenAI، تعيد النتيجة فورًا)
 *  - فيديو: POST /grok/v1/videos/generations → { request_id }
 *           ثم  GET /grok/v1/videos/{request_id}
 *           → { status: pending|done|failed|expired, progress, video: { url }, error }
 */
import {
  ProviderAdapter, ProviderError, ProviderInput, ImageInput, CheckResult, PROVIDER_TIMEOUT_MS,
} from "./types";

const BASE = "https://api.cometapi.com";

async function cometFetch(key: string, path: string, init?: RequestInit): Promise<any> {
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
    throw new ProviderError(0, `network: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* جسم غير JSON */ }
  if (!res.ok) {
    const msg = body?.error?.message ?? body?.error ?? body?.message ?? text.slice(0, 300) ?? `HTTP ${res.status}`;
    throw new ProviderError(res.status, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return body;
}

/** خريطة نسبة الأبعاد إلى أقرب حجم مدعوم في نقطة الصور المتوافقة مع OpenAI */
function mapSize(aspect: string): string {
  switch (aspect) {
    case "16:9": case "3:2": case "21:9": case "2:1": case "5:4": case "3:1":
      return "1536x1024";
    case "9:16": case "2:3": case "9:21": case "1:2": case "3:4": case "4:5": case "1:3":
      return "1024x1536";
    default:
      return "auto";
  }
}

export const cometAdapter: ProviderAdapter = {
  async createTask(key: string, providerModel: string, input: ProviderInput) {
    if (input.kind !== "video") {
      throw new ProviderError(400, "cometapi: هذا المحوّل يخدم الفيديو غير المتزامن فقط");
    }
    const body: Record<string, unknown> = {
      model: providerModel,
      prompt: input.prompt,
      duration: input.duration,
      aspect_ratio: input.aspect_ratio === "auto" ? "16:9" : input.aspect_ratio,
      resolution: input.resolution,
    };
    if (input.image_url) body.image = { url: input.image_url };
    const data = await cometFetch(key, "/grok/v1/videos/generations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const id = data?.request_id ?? data?.id ?? data?.taskId;
    if (!id) throw new ProviderError(500, "cometapi: لم يُعَد request_id في الاستجابة");
    return { providerTaskId: String(id) };
  },

  async checkTask(key: string, providerTaskId: string): Promise<CheckResult> {
    const data = await cometFetch(key, `/grok/v1/videos/${encodeURIComponent(providerTaskId)}`);
    const status = String(data?.status ?? "pending").toLowerCase();
    if (status === "done") {
      const url = data?.video?.url;
      if (!url) return { status: "failed", error: "cometapi: اكتملت المهمة دون رابط فيديو" };
      return { status: "completed", urls: [String(url)] };
    }
    if (status === "failed" || status === "expired") {
      const err = typeof data?.error === "string"
        ? data.error
        : data?.error?.message ?? `cometapi: فشلت المهمة (${status})`;
      return { status: "failed", error: String(err) };
    }
    const progress = typeof data?.progress === "number" ? Math.max(0, Math.min(100, data.progress)) : undefined;
    return { status: "processing", progress };
  },

  /**
   * صور متزامنة عبر نقطة images المتوافقة مع OpenAI — تعيد النتيجة فورًا.
   * ملاحظة: وسّعنا توقيع الواجهة بمعامل providerModel لأن نقطة الصور تحتاجه.
   */
  async createImageSync(key: string, providerModel: string, input: ImageInput) {
    const body: Record<string, unknown> = {
      model: providerModel,
      prompt: input.prompt,
      n: 1,
      size: mapSize(input.aspect_ratio),
    };
    const data = await cometFetch(key, "/v1/images/generations", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const item = data?.data?.[0];
    if (item?.url) return { urls: [String(item.url)] };
    // بعض المزودات تعيد base64 فقط — نحوّلها لرابط data URI إن كانت معقولة الحجم
    // (تُمرَّر للعميل ولا تُخزَّن كملف على سيرفرنا أبدًا)
    if (item?.b64_json && item.b64_json.length <= 500_000) {
      return { urls: [`data:image/png;base64,${item.b64_json}`] };
    }
    throw new ProviderError(500, "cometapi: استجابة الصور بلا رابط صالح");
  },
};
