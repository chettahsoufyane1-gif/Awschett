// POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا (متزامن؛ 10-15 ثانية عادةً)
const db = require("../../../lib/db");
const util = require("../../../lib/util");
const merge = require("../../../lib/merge");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return util.corsPreflight(res);
  if (req.method !== "POST") return util.errorJson(res, 405, "الطريقة غير مسموحة — استخدم POST");
  const id = String(req.query.id || "");
  if (!id) return util.errorJson(res, 400, "معرّف المهمة مطلوب");

  try {
    const job = await db.getJob(id);
    if (!job) return util.errorJson(res, 404, "المهمة غير موجودة (قد تكون حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

    // قيد المعالجة فعله → 202 (الأمان من الاستدعاءات المتزامنة)
    if (job.status === "processing") return util.json(res, 202, { status: "processing", progress: Number(job.progress || 0) });
    // مكتملة مسبقًا → نعيد النتيجة مباشرة (استدعاء آمن متكرر)
    if (job.status === "done") {
      globalThis.__MERGER_ORIGIN__ = util.getOrigin(req);
      return util.json(res, 200, merge.donePayload(id, job));
    }
    if (job.status === "failed") return util.errorJson(res, 500, job.error || "فشلت المهمة سابقًا");
    if (job.status === "uploading") return util.errorJson(res, 409, "ملفات المصادر لم تُرفع بالكامل — أكمل الرفع أولًا");

    globalThis.__MERGER_ORIGIN__ = util.getOrigin(req);
    const setProgress = async (p) => db.updateJob(id, { progress: Math.max(0, Math.min(100, p)) });
    const result = await merge.processJob(id, setProgress);
    if (result.processing) return util.json(res, 202, { status: "processing" });
    return util.json(res, 200, {
      status: "done",
      videoUrl: result.videoUrl,
      downloadUrl: result.downloadUrl,
      size: result.size,
      duration: result.duration,
      resolution: result.resolution,
      expiresAt: result.expiresAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "خطأ غير متوقع";
    // أخطاء معلنة من محرك الدمج = فشل نهائي واضح (لا إعادة محاولة)
    return util.errorJson(res, 500, msg);
  }
};
