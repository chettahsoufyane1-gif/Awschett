// GET /api/jobs/<id> — الحالة والتقدم | DELETE — حذف فوري شامل
const db = require("../../../lib/db");
const util = require("../../../lib/util");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return util.corsPreflight(res);
  const id = String(req.query.id || "");
  if (!id) return util.errorJson(res, 400, "معرّف المهمة مطلوب");

  try {
    const job = await db.getJob(id);
    if (!job) return util.errorJson(res, 404, "المهمة غير موجودة (قد تكون حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");

    if (req.method === "GET") {
      const origin = util.getOrigin(req);
      const payload = {
        status: job.status,
        progress: Number(job.progress || 0),
      };
      if (job.status === "done") {
        payload.videoUrl = `${origin}/api/jobs/${id}/video`;
        payload.downloadUrl = `${origin}/api/jobs/${id}/video?download=1`;
        payload.size = Number(job.output_size || 0);
        payload.duration = Number(job.output_duration || 0);
        payload.resolution = job.output_resolution || "";
        payload.expiresAt = job.expires_at;
      }
      if (job.status === "failed") {
        payload.error = job.error || "فشل غير معروف";
      }
      return util.json(res, 200, payload);
    }

    if (req.method === "DELETE") {
      await db.deleteJobRows(id);
      return util.json(res, 200, { ok: true });
    }

    return util.errorJson(res, 405, "الطريقة غير مسموحة — استخدم GET أو DELETE");
  } catch (e) {
    return util.errorJson(res, 500, e instanceof Error ? e.message : "خطأ غير متوقع");
  }
};
