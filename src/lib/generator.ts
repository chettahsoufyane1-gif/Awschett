/**
 * منسّق التوليد — runGeneration + get_task (refreshTask) + الصياغة العربية.
 *
 * القواعد الجوهرية المنفَّذة هنا:
 * 1) المفاتيح تُجرَّب بالترتيب التسلسلي الصارم (أول مفتاح أُضيف أولًا).
 * 2) أي خطأ مفتاح/رصيد → تبديل صامت للمفتاح التالي مع استئناف نفس المهمة
 *    بنفس task_id — نموذج الذكاء الاصطناعي لا يرى هذه الأخطاء أبدًا.
 * 3) مهمة فشلت على كل المفاتيح تبقى processing وتُعاد محاولتها تلقائيًا
 *    مع كل get_task بعد هدئة ~45 ثانية.
 */
import { randomUUID } from "crypto";
import { resolveModel, type ModelDef } from "./models";
import {
  getKeyPool, recordKeyAttempt, attemptEntry,
  classifyProviderError, classifyMidTaskFailure, type ErrorClass,
} from "./keys";
import {
  insertTask, getTask, updateTask, listRecentTasks, sqliteTimeToMs,
  getKeyById, type TaskRow,
} from "./turso";
import { kieAdapter } from "./providers/kie";
import { cometAdapter } from "./providers/cometapi";
import type { ProviderAdapter, ProviderInput, CheckResult } from "./providers/types";

export const ADAPTERS: Record<string, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometAdapter,
};

export interface ToolOutcome {
  text: string;
  isError?: boolean;
}

/** بث التقدم: نسبة 0..100 + رسالة عربية (يُستخدم لإشعارات progress) */
export type ProgressSink = (progress: number, message: string) => void | Promise<void>;

const KEY_ERR_RE = /insufficient|balance|credit|quota|402|401|unauthorized|invalid api key|forbidden|充值/i;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function safeUrls(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function safeArgs(json: string): Record<string, unknown> {
  try { return JSON.parse(json || "{}"); } catch { return {}; }
}

function toClassified(e: unknown): { cls: ErrorClass; msg: string } {
  const status = (e as { status?: number })?.status;
  const msg = e instanceof Error ? e.message : String(e);
  const cls = classifyProviderError(typeof status === "number" ? status : 0, msg);
  return { cls, msg };
}

// ─────────────────────────── الصياغة العربية ───────────────────────────

export function formatCompleted(t: TaskRow): string {
  const urls = safeUrls(t.result_urls_json);
  if (!urls.length) return `✅ اكتملت المهمة (معرّف: ${t.id})`;
  const links = urls.map((u) => `- ${u}`).join("\n");
  if (t.type === "image") {
    return `✅ تم توليد الصورة بنجاح\n\n![image](${urls[0]})\n\nالرابط المباشر: ${urls[0]}`;
  }
  if (t.type === "merge") {
    return `✅ تم دمج المقاطع بنجاح\n\n${links}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
  }
  return `✅ تم توليد الفيديو بنجاح\n\n${links}\n\nالروابط المباشرة أعلاه.`;
}

export function processingText(taskId: string): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${taskId}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

export function failedText(reason?: string): ToolOutcome {
  return { text: `❌ فشلت المهمة: ${reason || "سبب غير معروف"}`, isError: true };
}

// ─────────────────────────── بناء معطيات المزود ───────────────────────────

function buildProviderInput(def: ModelDef, args: Record<string, any>): ProviderInput {
  if (def.type === "image") {
    return {
      kind: "image",
      prompt: String(args.prompt ?? ""),
      aspect_ratio: String(args.aspect_ratio ?? "auto"),
      resolution: String(args.resolution ?? "1K"),
      background: String(args.background ?? "auto"),
      output_format: String(args.output_format ?? "png"),
    };
  }
  return {
    kind: "video",
    prompt: String(args.prompt ?? ""),
    image_url: args.image_url ? String(args.image_url) : undefined,
    aspect_ratio: String(args.aspect_ratio ?? "auto"),
    resolution: String(args.resolution ?? "480p"),
    enable_audio: args.enable_audio !== false,
    duration: clamp(Number(args.duration ?? 8) || 8, 1, 15),
  };
}

// ─────────────────────────── نافذة الانتظار ───────────────────────────

interface WindowResult {
  state: "done" | "failed" | "timeout" | "keyfail";
  urls?: string[];
  reason?: string;
}

/**
 * تستعلم checkTask كل 3 ثوانٍ حتى انتهاء نافذة الانتظار، وتبث تقدمًا عربيًا.
 * فشل مفتاح/رصيد أثناء النافذة → keyfail (يُبدَّل للمفتاح التالي بصمت).
 */
async function waitWindow(
  adapter: ProviderAdapter,
  key: string,
  providerTaskId: string,
  taskType: "image" | "video",
  sink: ProgressSink | undefined,
  seconds: number
): Promise<WindowResult> {
  const deadline = Date.now() + seconds * 1000;
  const started = Date.now();
  const expected = taskType === "image" ? 60_000 : 180_000; // تقدير التقدم الزمني
  let lastNotify = 0;

  while (Date.now() < deadline) {
    let st: CheckResult | null = null;
    try {
      st = await adapter.checkTask(key, providerTaskId);
    } catch {
      // خطأ مؤقت أثناء الاستعلام (شبكة/مهلة) — نستمر بالاستعلام حتى انتهاء النافذة
    }
    if (st) {
      if (st.status === "completed" && st.urls?.length) return { state: "done", urls: st.urls };
      if (st.status === "failed") {
        const msg = st.error ?? "";
        return KEY_ERR_RE.test(msg) ? { state: "keyfail", reason: msg } : { state: "failed", reason: msg };
      }
    }
    const elapsed = Date.now() - started;
    const p = clamp(st?.progress ?? Math.round((elapsed / expected) * 100), 0, 95);
    if (sink && Date.now() - lastNotify >= 2800) {
      lastNotify = Date.now();
      try { await sink(p, `⏳ قيد التوليد… ${p}%`); } catch { /* الإشعارات اختيارية */ }
    }
    await sleep(3000);
  }
  return { state: "timeout" };
}

// ─────────────────────────── الحلقة التسلسلية ───────────────────────────

/**
 * تجرب مرشّحي المفاتيح بالترتيب بدءًا من startIndex.
 * أول نجاح يربط المهمة بالمزود والمفتاح ويدخل نافذة الانتظار.
 */
async function runPoolLoop(opts: {
  taskId: string;
  def: ModelDef;
  input: ProviderInput;
  pool: Awaited<ReturnType<typeof getKeyPool>>;
  startIndex: number;
  sink?: ProgressSink;
  waitSeconds: number;
}): Promise<ToolOutcome> {
  const { taskId, def, input, pool, startIndex, sink, waitSeconds } = opts;

  for (let i = startIndex; i < pool.length; i++) {
    const key = pool[i];
    const adapter = ADAPTERS[key.provider] ?? kieAdapter;
    const providerModel = def.providerModel[key.provider] ?? Object.values(def.providerModel)[0];

    // (أ) محاولة الإنشاء
    let providerTaskId: string | null = null;
    let syncUrls: string[] | null = null;
    try {
      if (input.kind === "image" && adapter.createImageSync) {
        const r = await adapter.createImageSync(key.api_key, providerModel, input);
        syncUrls = r.urls;
      } else {
        providerTaskId = (await adapter.createTask(key.api_key, providerModel, input)).providerTaskId;
      }
    } catch (e) {
      const { cls, msg } = toClassified(e);
      await recordKeyAttempt(key, false, cls, msg);
      await updateTask(taskId, { appendAttempt: attemptEntry(key.provider, key, false, cls, msg) });
      if (cls === "params") {
        // خطأ معطيات — توقف فورًا، تبديل المفاتيح لن يحل شيئًا
        await updateTask(taskId, { status: "failed", error_message: msg });
        return failedText(msg);
      }
      // disabled / exhausted / provider / temporary → المفتاح التالي فورًا
      continue;
    }

    await recordKeyAttempt(key, true);
    await updateTask(taskId, {
      provider: key.provider,
      provider_task_id: providerTaskId,
      key_id: key.id,
      appendAttempt: attemptEntry(key.provider, key, true),
    });

    // (ب) صور متزامنة — اكتملت فورًا
    if (syncUrls?.length) {
      const t = await updateTask(taskId, { status: "completed", result_urls: syncUrls, progress: 100 });
      return { text: t ? formatCompleted(t) : `✅ تم توليد الصورة بنجاح\n\nالرابط المباشر: ${syncUrls[0]}` };
    }

    // (ج) نافذة الانتظار مع بث التقدم
    const w = await waitWindow(adapter, key.api_key, providerTaskId!, def.type === "merge" ? "video" : def.type, sink, waitSeconds);

    if (w.state === "done") {
      const t = await updateTask(taskId, { status: "completed", result_urls: w.urls!, progress: 100 });
      return { text: t ? formatCompleted(t) : `✅ اكتملت المهمة\n\n${w.urls!.map((u) => `- ${u}`).join("\n")}` };
    }
    if (w.state === "failed") {
      await updateTask(taskId, { status: "failed", error_message: w.reason ?? null });
      return failedText(w.reason);
    }
    if (w.state === "keyfail") {
      // فشل مفتاح/رصيد في منتصف المهمة → علّم المفتاح ثم أعد إنشاء نفس المهمة
      // على المفتاح التالي بنفس task_id — العميل يرى «قيد المعالجة» فقط
      const cls = classifyMidTaskFailure(w.reason!);
      await recordKeyAttempt(key, false, cls, w.reason!);
      await updateTask(taskId, {
        appendAttempt: attemptEntry(key.provider, key, false, cls, w.reason!),
        provider: null,
        provider_task_id: null,
        key_id: null,
      });
      continue;
    }
    // (د) انتهت النافذة والنتيجة لم تظهر → processing وtask_id للعميل
    return { text: processingText(taskId) };
  }

  // فشل الإنشاء على كل المفاتيح → تبقى processing وتُعاد المحاولة مع كل get_task
  await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" });
  return { text: processingText(taskId) };
}

// ─────────────────────────── توليد صورة/فيديو ───────────────────────────

export async function runGeneration(
  args: Record<string, any>,
  type: "image" | "video",
  sink?: ProgressSink
): Promise<ToolOutcome> {
  // 1) توحيد اسم الموديل — مجهول → خطأ معطيات فوري
  const def = resolveModel(args?.model);
  if (!def || def.type !== type) {
    return {
      text: `❌ موديل غير مدعوم: ${args?.model ?? "(فارغ)"} — المتاح: gpt-image-2-6/flare-text-to-image للصور، وgrok-imagine-video-1-5-preview للفيديو.`,
      isError: true,
    };
  }

  // 2) تجمع المفاتيح بالترتيب — فارغ → رد no_keys واضح
  const pool = await getKeyPool(def.providers);
  if (!pool.length) {
    return {
      text: `❌ لا توجد مفاتيح نشطة لخدمة ${def.canonical}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
      isError: true,
    };
  }

  // 3) سجّل المهمة في قاعدة البيانات قبل أي نداء خارجي
  const taskId = randomUUID();
  await insertTask({
    id: taskId,
    model: def.canonical,
    type,
    prompt: String(args?.prompt ?? ""),
    params_json: JSON.stringify(args ?? {}),
  });

  // 4-6) جرّب المرشحين بالترتيب مع نافذة الانتظار (90 ثانية للصور، 25 للفيديو)
  const waitSeconds = clamp(Number(args?.wait_seconds ?? (type === "image" ? 90 : 25)) || 0, 0, 240);
  return runPoolLoop({
    taskId,
    def,
    input: buildProviderInput(def, args ?? {}),
    pool,
    startIndex: 0,
    sink,
    waitSeconds,
  });
}

// ─────────────────────────── get_task / refreshTask ───────────────────────────

/** إعادة إنشاء نفس المهمة (نفس task_id) على المفاتيح المتبقية بعد المفتاح الفاشل */
async function recreateOnNextKeys(t: TaskRow, failedKeyId: string | null, sink?: ProgressSink): Promise<ToolOutcome> {
  const def = resolveModel(t.model);
  if (!def) {
    await updateTask(t.id, { status: "failed", error_message: "موديل المهمة غير معروف في السجل الحالي" });
    return failedText("موديل المهمة غير معروف في السجل الحالي");
  }
  const args = safeArgs(t.params_json);
  const pool = await getKeyPool(def.providers);
  const idx = failedKeyId ? pool.findIndex((k) => k.id === failedKeyId) : -1;
  const startIndex = idx >= 0 ? idx + 1 : 0;
  if (startIndex >= pool.length) {
    // لا بقية مفاتيح صالحة → هدئة 45 ثانية قبل أي محاولة جديدة (تُطبق في get_task القادم)
    await updateTask(t.id, { error_message: "بانتظار توفر مفتاح صالح…" });
    return { text: processingText(t.id) };
  }
  const waitSeconds = Math.min(20, clamp(Number(args.wait_seconds ?? (def.type === "image" ? 90 : 25)) || 20, 0, 240));
  return runPoolLoop({
    taskId: t.id,
    def,
    input: buildProviderInput(def, args),
    pool,
    startIndex,
    sink,
    waitSeconds,
  });
}

/** استعلام حالة مهمة توليد جارية من المزود مع نفس منطق التبديل */
async function refreshGenerationTask(t: TaskRow, sink?: ProgressSink): Promise<ToolOutcome> {
  if (t.provider_task_id && t.key_id) {
    const key = await getKeyById(t.key_id);
    if (key && key.status !== "disabled") {
      const adapter = ADAPTERS[key.provider] ?? kieAdapter;
      try {
        const st = await adapter.checkTask(key.api_key, t.provider_task_id);
        if (st.status === "completed" && st.urls?.length) {
          const done = await updateTask(t.id, { status: "completed", result_urls: st.urls, progress: 100 });
          return done ? { text: formatCompleted(done) } : { text: formatCompleted(t) };
        }
        if (st.status === "failed") {
          const msg = st.error ?? "";
          if (KEY_ERR_RE.test(msg)) {
            const cls = classifyMidTaskFailure(msg);
            await recordKeyAttempt(key, false, cls, msg);
            await updateTask(t.id, { appendAttempt: attemptEntry(key.provider, key, false, cls, msg) });
            return recreateOnNextKeys(await getTask(t.id) ?? t, key.id, sink);
          }
          await updateTask(t.id, { status: "failed", error_message: msg });
          return failedText(msg);
        }
        const p = clamp(st.progress ?? t.progress, 0, 95);
        if (p > t.progress) await updateTask(t.id, { progress: p });
        return { text: processingText(t.id) };
      } catch {
        // خطأ مؤقت — نظل في حالة معالجة
        return { text: processingText(t.id) };
      }
    }
    // المفتاح محذوف أو معطل → أعِد الإنشاء على بقية المفاتيح فورًا
    return recreateOnNextKeys(t, t.key_id, sink);
  }

  // لا رابط مزود صالح (بانتظار مفتاح) → هدئة 45 ثانية بين المحاولات
  const since = Date.now() - sqliteTimeToMs(t.updated_at);
  if (since < 45_000) return { text: processingText(t.id) };
  return recreateOnNextKeys(t, null, sink);
}

/** أداة get_task — تتبع أي مهمة (توليد أو دمج) وتحدّثها حية */
export async function getTaskStatus(taskId: string, sink?: ProgressSink): Promise<ToolOutcome> {
  const t = await getTask(taskId.trim());
  if (!t) return { text: `❌ لا توجد مهمة بالمعرّف: ${taskId}`, isError: true };
  if (t.status === "completed") return { text: formatCompleted(t) };
  if (t.status === "failed") return failedText(t.error_message ?? undefined);
  if (t.type === "merge") {
    const { refreshMergeTask } = await import("./merger"); // تجنب الدوران الاستيرادي
    return refreshMergeTask(t, sink);
  }
  return refreshGenerationTask(t, sink);
}

// ─────────────────────────── list_media ───────────────────────────

const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_AR: Record<string, string> = {
  completed: "مكتملة", failed: "فاشلة", processing: "جارية", pending: "بالانتظار",
};

export async function listMedia(args: Record<string, any>): Promise<ToolOutcome> {
  const limit = clamp(Number(args?.limit ?? 10) || 10, 1, 50);
  const filters: { type?: string; status?: string } = {};
  if (args?.type) filters.type = String(args.type);
  if (args?.status) filters.status = String(args.status);
  const rows = await listRecentTasks(limit, filters);

  if (!rows.length) {
    return { text: "لا توجد مهام مخزنة بعد — كل صورة أو فيديو تولّده يُحفظ هنا بروابطه." };
  }
  const lines = rows.map((t, i) => {
    const head = `${i + 1}. [${TYPE_AR[t.type] ?? t.type}] ${STATUS_AR[t.status] ?? t.status} — ${t.model} — ${t.created_at}`;
    const urls = safeUrls(t.result_urls_json);
    if (t.status === "completed" && urls.length) return `${head}\n   الرابط: ${urls[0]}${urls.length > 1 ? ` (+${urls.length - 1})` : ""}`;
    if (t.status === "failed") return `${head}\n   السبب: ${t.error_message ?? "غير معروف"}`;
    return head;
  });
  return { text: `أحدث الوسائط المخزنة (${rows.length}):\n\n${lines.join("\n")}` };
}
