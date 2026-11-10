// POST /api/jobs — إنشاء مهمة دمج (+ تنظيف كسول للمهام المنتهية)
const db = require("../lib/db");
const util = require("../lib/util");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return util.corsPreflight(res);
  if (req.method !== "POST") return util.errorJson(res, 405, "الطريقة غير مسموحة — استخدم POST");

  try {
    // قراءة الجسم (قد يأتي مجرًى في Vercel)
    const raw = await readBody(req, 1024 * 1024);
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return util.errorJson(res, 400, "جسم الطلب يجب أن يكون JSON صالحًا");
    }

    // تطبيع وتحقق الحدود (2..MAX_SOURCES، أحجام الملفات، صلاحية الروابط)
    const norm = util.normalizeSources(body);
    if (norm.error) return util.errorJson(res, 400, norm.error);

    // تنظيف كسول للمهام المنتهية (أفضل جهد — لا يعطل الطلب)
    db.cleanupExpired().catch(() => {});

    const jobId = util.shortId();
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const hasFiles = norm.sources.some((s) => s.kind === "file");
    const status = hasFiles ? "uploading" : "queued";

    await db.insertJob({ id: jobId, status, expires_at: expiresAt });
    await db.insertSources(
      norm.sources.map((s, i) => ({
        job_id: jobId,
        seq: i,
        kind: s.kind,
        url: s.kind === "url" ? s.url : null,
        name: s.kind === "file" ? s.name : null,
        mime: s.kind === "file" ? s.mime : null,
        size_bytes: s.kind === "file" ? Math.round(s.size) : 0,
        chunks_total: s.kind === "file" ? Math.ceil(s.size / util.UPLOAD_CHUNK_BYTES) : null,
      }))
    );

    const origin = util.getOrigin(req);
    const payload = {
      jobId,
      status,
      statusUrl: `${origin}/api/jobs/${jobId}`,
      processUrl: `${origin}/api/jobs/${jobId}/process`,
      expiresAt,
    };

    // الملفات: نرجع روابط رفع جاهزة لكل مصدر
    if (hasFiles) {
      payload.uploads = [];
      for (let i = 0; i < norm.sources.length; i++) {
        const s = norm.sources[i];
        if (s.kind !== "file") continue;
        const chunks = Math.ceil(s.size / util.UPLOAD_CHUNK_BYTES);
        payload.uploads.push({
          seq: i,
          name: s.name,
          chunks,
          uploadChunkBytes: util.UPLOAD_CHUNK_BYTES,
          uploadUrl: `${origin}/api/upload?job=${jobId}&seq=${i}&chunk=<k>`,
        });
      }
    }
    return util.json(res, 201, payload);
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
        reject(new Error("جسم الطلب كبير جدًا"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
