// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء ثنائية ≤4MB (octet-stream)
const db = require("../lib/db");
const storage = require("../lib/storage");
const util = require("../lib/util");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return util.corsPreflight(res);
  if (req.method !== "POST") return util.errorJson(res, 405, "الطريقة غير مسموحة — استخدم POST");

  const jobId = String(req.query.job || "");
  const seq = Number(req.query.seq);
  const chunk = Number(req.query.chunk);
  if (!jobId || !Number.isInteger(seq) || !Number.isInteger(chunk) || chunk < 0) {
    return util.errorJson(res, 400, "المعاملات المطلوبة: job و seq و chunk");
  }

  try {
    const job = await db.getJob(jobId);
    if (!job) return util.errorJson(res, 404, "المهمة غير موجودة");
    if (job.status !== "uploading") {
      return util.errorJson(res, 409, `حالة المهمة (${job.status}) لا تسمح بالرفع`);
    }
    const sources = await db.listSources(jobId);
    const src = sources.find((s) => s.seq === seq);
    if (!src) return util.errorJson(res, 404, "المصدر غير موجود في هذه المهمة");
    if (src.kind !== "file") return util.errorJson(res, 400, "هذا المصدر رابط — لا يقبل رفع أجزاء");

    // قراءة الجسم الثنائي بحد صارم
    const data = await readBody(req, util.UPLOAD_CHUNK_BYTES + 512 * 1024);
    if (!data.length) return util.errorJson(res, 400, "الجزء فارغ");
    if (data.length > util.UPLOAD_CHUNK_BYTES) {
      return util.errorJson(res, 413, `حجم الجزء يتجاوز ${util.UPLOAD_CHUNK_BYTES} بايت`);
    }

    // التحقق من الحجم التراكمي المعلن
    const newTotal = (src.uploaded_bytes || 0) + data.length;
    if (src.size_bytes && newTotal > src.size_bytes) {
      return util.errorJson(res, 413, "الحجم المرفوع يتجاوز حجم الملف المعلن");
    }

    // فهرسة الصفوف العالمية: chunkIndex*2 + subrow (صفوف 2MB داخل جزء 4MB)
    await storage.storeSourceChunk(jobId, seq, chunk, data);
    await db.bumpSourceUploaded(jobId, seq, data.length);

    // هل اكتمل رفع كل المصادر؟ → تتحول المهمة إلى queued
    const fresh = await db.listSources(jobId);
    const allDone = fresh.every((s) => s.kind !== "file" || (s.size_bytes ? s.uploaded_bytes >= s.size_bytes : false));
    if (allDone && job.status === "uploading") {
      await db.updateJob(jobId, { status: "queued" });
    }

    return util.json(res, 200, {
      ok: true,
      seq,
      chunk,
      uploadedBytes: newTotal,
      totalBytes: src.size_bytes,
    });
  } catch (e) {
    return util.errorJson(res, 500, e instanceof Error ? e.message : "خطأ غير متوقع");
  }
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("حجم الجزء كبير جدًا"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
