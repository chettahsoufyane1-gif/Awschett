/**
 * عميل خدمة دمج الفيديو — Video Merger API v2 + تنسيق runMerge/refreshMergeTask.
 *
 * القواعد:
 * - بلا مفاتيح أو توثيق؛ عنوان الخدمة من MERGER_API_BASE.
 * - روابط فقط: لا ننزّل أي وسائط على سيرفرنا — الخدمة الخارجية هي من تجلب وتدمج.
 * - أي خطأ HTTP معلن من الخدمة (4xx/5xx بجسم error) = فشل حتمي فوري — لا إعادة محاولة.
 * - أخطاء شبكتنا نحن (مهلة/انقطاع) = مؤقتة وتستمر بالاستعلام.
 * - رد 404 عند الاستعلام = المهمة حُذفت أو انتهت صلاحيتها (24 ساعة) → فشل نهائي.
 */
import { randomUUID } from "crypto";
import {
  insertTask, getTask, updateTask, sqliteTimeToMs, type TaskRow,
} from "./turso";
import { formatCompleted, processingText, failedText, type ToolOutcome, type ProgressSink } from "./generator";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function base(): string {
  return (process.env.MERGER_API_BASE || "").replace(/\/+$/, "");
}

export function mergerBase(): string {
  return base() || "";
}

/** فحص جهوزية خدمة الدمج: GET /api/config بمهلة 4 ثوانٍ */
export async function mergerHealthy(): Promise<boolean> {
  const b = base();
  if (!b) return false;
  try {
    const res = await fetch(`${b}/api/config`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

// أقفال في الذاكرة — تمنع إطلاق process مرتين لنفس jobId (لكل نسخة دالة؛
// إعادة الإطلاق بعد إعادة تشغيل النسخة آمنة لأن الخدمة تعيد 202/409)
const processInFlight = new Set<string>();
const processFired = new Set<string>();

const DONE_RE = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAIL_RE = /^(error|failed|failure|cancelled|canceled)$/i;

interface FetchResult {
  networkError?: string;
  status: number;
  body: any;
}

/** نداء دفاعي لا يرمي — يعيد نتيجة مفصلة ليتقرر السلوك (حتمي/مؤقت) في مكان الاستدعاء */
async function mergerFetch(url: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: null, networkError: e instanceof Error ? e.message : String(e) };
  }
}

/** إطلاق POST /process مرة واحدة فقط لكل jobId (محمي بقفل في الذاكرة) */
function fireProcessOnce(jobId: string): void {
  if (processFired.has(jobId) || processInFlight.has(jobId)) return;
  processFired.add(jobId);
  processInFlight.add(jobId);
  void (async () => {
    try {
      // عملية الدمج نفسها تستغرق 10-15 ثانية عادةً وقد تطول — مهلة سخية
      await mergerFetch(`${base()}/api/jobs/${encodeURIComponent(jobId)}/process`, { method: "POST" }, 320_000);
    } catch { /* تُرصد الحالة عبر استعلام GET لاحقًا */ }
    finally { processInFlight.delete(jobId); }
  })();
}

interface PollOutcome {
  final?: boolean;
  state?: "done" | "failed";
  url?: string;
  reason?: string;
  progress?: number;
}

/**
 * استعلام واحد لحالة مهمة الدمج — تحليل دفاعي وفق 7.2:
 * progress قد يرد كسرًا 0..1 → يُضرب في 100، وحقل error بلا status يعني فشلًا.
 */
async function pollMergeJob(jobId: string): Promise<PollOutcome> {
  const r = await mergerFetch(`${base()}/api/jobs/${encodeURIComponent(jobId)}`);
  if (r.networkError) return {}; // خطأ شبكتنا — مؤقت، نستمر
  if (r.status === 404) {
    return { final: true, state: "failed", reason: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)" };
  }
  if (r.status >= 400) {
    return { final: true, state: "failed", reason: `فشلت خدمة الدمج: HTTP ${r.status} ${r.body?.error ?? ""}`.trim() };
  }
  const body = r.body ?? {};
  const status = String(body.status ?? "");
  if (!status && body.error) return { final: true, state: "failed", reason: String(body.error) };

  if (DONE_RE.test(status)) {
    // فضّل videoUrl ثم downloadUrl ثم رابط الفيديو المباشر المبني من jobId
    const url = body.videoUrl || body.downloadUrl || `${base()}/api/jobs/${encodeURIComponent(jobId)}/video`;
    return { final: true, state: "done", url: String(url) };
  }
  if (FAIL_RE.test(status)) {
    return { final: true, state: "failed", reason: body.error ? String(body.error) : "فشلت خدمة الدمج" };
  }
  let p = Number(body.progress);
  if (!Number.isFinite(p) || p < 0) p = 0;
  if (p > 0 && p < 1) p = p * 100; // يأتي أحيانًا كسرًا
  return { progress: clamp(Math.round(p), 0, 99) };
}

/** تنفيذ دمج مهمة موجودة (نفس task_id) — يُستخدم من runMerge ومن refresh */
async function runMergeWithId(taskId: string, args: Record<string, any>, sink?: ProgressSink): Promise<ToolOutcome> {
  // 1) جمع الروابط: روابط task_ids (المكتملة فقط وبالترتيب) ثم urls المباشرة
  const collected: string[] = [];
  const badTaskIds: { id: string; reason: string }[] = [];
  for (const id of (Array.isArray(args?.task_ids) ? args.task_ids : []).map(String)) {
    const t = await getTask(id.trim());
    const urls: string[] = [];
    if (t?.status === "completed") {
      try {
        const arr = JSON.parse(t.result_urls_json || "[]");
        if (Array.isArray(arr)) urls.push(...arr.map(String).filter(Boolean));
      } catch { /* بلا روابط */ }
    }
    if (urls.length) collected.push(...urls);
    else badTaskIds.push({ id, reason: !t ? "غير موجودة" : t.status !== "completed" ? "ليست مكتملة" : "بلا روابط نتائج" });
  }
  const direct = (Array.isArray(args?.urls) ? args.urls : []).map(String).filter(Boolean);
  const all = [...collected, ...direct];

  // 2) تحقق صارم قبل أي نداء خارجي
  if (all.length < 2) {
    let text = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
    if (badTaskIds.length) {
      text += "\n\nتفاصيل المعرّفات غير الصالحة:\n" + badTaskIds.map((b) => `- ${b.id}: ${b.reason}`).join("\n");
    }
    await updateTask(taskId, { status: "failed", error_message: "أقل من مقطعين" });
    return { text, isError: true };
  }
  if (all.length > 10) {
    await updateTask(taskId, { status: "failed", error_message: "أكثر من 10 مقاطع" });
    return { text: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).", isError: true };
  }
  if (all.some((u) => !/^https?:\/\//i.test(u))) {
    await updateTask(taskId, { status: "failed", error_message: "روابط غير صالحة" });
    return { text: "❌ كل الروابط يجب أن تكون روابط فيديو مباشرة عامة تبدأ بـ http/https.", isError: true };
  }
  if (!base()) {
    await updateTask(taskId, { status: "failed", error_message: "خدمة الدمج غير مهيأة" });
    return { text: "❌ خدمة الدمج غير مُهيأة — اضبط متغير البيئة MERGER_API_BASE على عنوان خدمة الدمج المنشورة.", isError: true };
  }

  // 3) إنشاء مهمة الدمج لدى الخدمة
  const cr = await mergerFetch(`${base()}/api/jobs`, {
    method: "POST",
    body: JSON.stringify({ videos: all }),
  });
  if (cr.networkError) {
    // خطأ شبكتنا نحن → مؤقت: تُعاد محاولة الإنشاء تلقائيًا مع get_task
    await updateTask(taskId, { error_message: "تعذر الاتصال بخدمة الدمج — ستُعاد المحاولة تلقائيًا" });
    return { text: processingText(taskId) };
  }
  if (cr.status >= 400 || !cr.body?.jobId) {
    // خطأ معلن من الخدمة = فشل حتمي فوري (لا إعادة محاولة)
    const reason = `فشلت خدمة الدمج: ${cr.body?.error ?? `HTTP ${cr.status}`}`;
    await updateTask(taskId, { status: "failed", error_message: reason });
    return failedText(reason);
  }
  const jobId = String(cr.body.jobId);
  await updateTask(taskId, { provider: "merger", provider_task_id: jobId });

  // 4) أطلق process خلفيًا وبمرة واحدة فقط
  fireProcessOnce(jobId);

  // 5) نافذة الانتظار (افتراضي 60 ثانية) — استعلام كل 3 ثوانٍ مع بث تقدم
  const waitSeconds = clamp(Number(args?.wait_seconds ?? 60) || 0, 0, 240);
  const deadline = Date.now() + waitSeconds * 1000;
  let lastNotify = 0;
  while (Date.now() < deadline) {
    const p = await pollMergeJob(jobId);
    if (p.final) {
      if (p.state === "done" && p.url) {
        const done = await updateTask(taskId, { status: "completed", result_urls: [p.url], progress: 100 });
        return { text: done ? formatCompleted(done) : `✅ تم دمج المقاطع بنجاح\n\nالرابط المباشر: ${p.url}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.` };
      }
      await updateTask(taskId, { status: "failed", error_message: p.reason ?? null });
      return failedText(p.reason);
    }
    const progress = p.progress ?? 0;
    await updateTask(taskId, { progress, status: "processing" });
    if (sink && Date.now() - lastNotify >= 2800) {
      lastNotify = Date.now();
      try { await sink(progress, `⏳ جارٍ الدمج… ${progress}%`); } catch { /* اختياري */ }
    }
    await sleep(3000);
  }
  return { text: processingText(taskId) };
}

/** أداة merge_videos — تسجّل مهمة type=merge ثم تنفذ التدفق كاملًا */
export async function runMerge(args: Record<string, any>, sink?: ProgressSink): Promise<ToolOutcome> {
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${(Array.isArray(args?.task_ids) ? args.task_ids.length : 0) + (Array.isArray(args?.urls) ? args.urls.length : 0)} مقاطع`,
    params_json: JSON.stringify(args ?? {}),
  });
  return runMergeWithId(taskId, args ?? {}, sink);
}

/** get_task لمهمة دمج جارية — يحدّث من الخدمة ويعيد المحاولة عند الحاجة */
export async function refreshMergeTask(t: TaskRow, sink?: ProgressSink): Promise<ToolOutcome> {
  const jobId = t.provider_task_id;

  // لم يُنشأ jobId بعد (شبكة سابقة) → هدئة قصيرة ثم إعادة الإنشاء بنفس task_id
  if (!jobId) {
    if (Date.now() - sqliteTimeToMs(t.updated_at) < 20_000) return { text: processingText(t.id) };
    const args = (() => { try { return JSON.parse(t.params_json || "{}"); } catch { return {}; } })();
    return runMergeWithId(t.id, args, sink);
  }

  const p = await pollMergeJob(jobId);
  if (p.final) {
    if (p.state === "done" && p.url) {
      const done = await updateTask(t.id, { status: "completed", result_urls: [p.url], progress: 100 });
      return { text: done ? formatCompleted(done) : formatCompleted(t) };
    }
    await updateTask(t.id, { status: "failed", error_message: p.reason ?? null });
    return failedText(p.reason);
  }

  // جارية — إن لم يُطلق process بعد (مثلاً بعد إعادة تشغيل النسخة) أطلقه الآن
  fireProcessOnce(jobId);
  const progress = p.progress ?? t.progress;
  if (progress > t.progress) await updateTask(t.id, { progress });
  return { text: processingText(t.id) };
}
