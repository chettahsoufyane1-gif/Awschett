/**
 * نظام المفاتيح المتسلسلة — قلب المشروع.
 * 1) الترتيب صارم بترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin.
 * 2) تصنيف موحد لأخطاء المزودين يحدد سلوك التبديل.
 * 3) إخفاء المفاتيح إلزامي في كل الاستجابات.
 */
import {
  ensureSchema, getDb, type KeyRow, type AttemptEntry,
} from "./turso";

// ─────────────────────────── إخفاء المفاتيح ───────────────────────────

export function maskKey(key: string): string {
  if (key.length >= 16) return key.slice(0, 7) + "••••••••" + key.slice(-4);
  return key.slice(0, 3) + "••••";
}

// ─────────────────────────── تصنيف الأخطاء ───────────────────────────

export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

const AUTH_RE = /invalid api key|unauthorized|forbidden|authentication|invalid.{0,10}key|api key.{0,10}(invalid|incorrect)/i;
const BALANCE_RE = /insufficient|quota|balance|credit|out of credits|exhausted|充值|رصيد/i;
const MODEL_RE = /model not found|unsupported model|unknown model|model_not_found|does not exist/i;

/**
 * تصنيف خطأ المزود حسب جدول القواعد:
 * - disabled : 401/403 أو رسالة مصادقة → المفتاح مرفوض ويعلَّم disabled
 * - exhausted: 402 أو رسالة رصيد (تُفحص قبل 400 لأن بعض المزودين يرسلونها بحالة 400)
 * - provider : الموديل غير مدعوم لدى المزود
 * - params   : خطأ معطيات — توقف فورًا، تبديل المفاتيح لن يحل شيئًا
 * - temporary: 429/5xx/شبكة/انتهاء مهلة → المفتاح سليم، انتقل للتالي
 */
export function classifyProviderError(status: number | string, message: string): ErrorClass {
  const msg = message || "";
  const s = typeof status === "number" ? status : parseInt(String(status), 10) || 0;
  if (s === 401 || s === 403 || AUTH_RE.test(msg)) return "disabled";
  if (s === 402 || BALANCE_RE.test(msg)) return "exhausted";
  if (MODEL_RE.test(msg) && [400, 404, 422].includes(s)) return "provider";
  if (s === 400 || s === 422) return "params";
  return "temporary";
}

/** هل رسالة فشل المهمة (من المزود بعد الإنشاء) تطابق نمط مشكلات مفتاح/رصيد؟ */
export function isKeyOrBalanceFailure(message: string): boolean {
  return /insufficient|balance|credit|quota|402|401|unauthorized|forbidden|invalid api key|充值/i.test(message || "");
}

/** تصنيف رسالة فشل منتصف المهمة: تعطيل أم استنزاف؟ */
export function classifyMidTaskFailure(message: string): "disabled" | "exhausted" {
  return /unauthorized|401|invalid|forbidden/i.test(message || "") ? "disabled" : "exhausted";
}

// ─────────────────────────── تجمع المفاتيح ───────────────────────────

/**
 * تجلب كل المفاتيح غير المعطّلة لهذه المزودات بالترتيب التسلسلي الصارم:
 * أول مفتاح أُضيف يُجرَّب أولًا. المفتاح المستنزف (exhausted) يبقى في القائمة
 * عمدًا — الاستثناء الوحيد للخروج من القائمة هو التعطيل اليدوي (disabled).
 */
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  if (!providers.length) return [];
  const placeholders = providers.map(() => "?").join(",");
  const rs = await getDb().execute({
    sql: `SELECT * FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  return rs.rows.map((r) => ({
    id: String(r.id),
    provider: r.provider as KeyRow["provider"],
    label: (r.label as string) ?? "",
    api_key: String(r.api_key),
    status: (r.status as KeyRow["status"]) ?? "active",
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    created_at: String(r.created_at ?? ""),
  }));
}

/**
 * تحديث عدّادات وحالة مفتاح بعد كل محاولة (نجاح أو فشل).
 * يُستدعى دائمًا — العدّادات لا تُفقد أي محاولة أبدًا.
 */
export async function recordKeyAttempt(
  key: Pick<KeyRow, "id">,
  ok: boolean,
  errorClass?: ErrorClass,
  error?: string
): Promise<void> {
  await ensureSchema();
  await getDb().execute({
    sql: `UPDATE api_keys SET
            usage_count = usage_count + 1,
            success_count = success_count + ?,
            fail_count = fail_count + ?,
            last_used_at = datetime('now'),
            last_checked_at = datetime('now'),
            last_error = ?,
            status = CASE
              WHEN ? = 'disabled'  THEN 'disabled'
              WHEN ? = 'exhausted' THEN 'exhausted'
              ELSE status END
          WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, ok ? null : (error ?? "خطأ غير معروف"), errorClass ?? "", errorClass ?? "", key.id],
  });
}

/** إدخال محاولة في سجل المهمة (يُستخدم مع updateTask appendAttempt) */
export function attemptEntry(
  provider: string,
  key: Pick<KeyRow, "id" | "label">,
  ok: boolean,
  errorClass?: ErrorClass,
  error?: string
): AttemptEntry {
  return {
    provider,
    keyId: key.id,
    keyLabel: key.label || undefined,
    ok,
    errorClass,
    error: ok ? undefined : error,
    at: new Date().toISOString(),
  };
}
