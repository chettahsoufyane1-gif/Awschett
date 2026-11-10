// GET /api/jobs/<id>/video — بث الناتج بدعم Range (206) ليعمل التقديم/الترجيع
const db = require("../../../lib/db");
const storage = require("../../../lib/storage");
const util = require("../../../lib/util");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return util.corsPreflight(res);
  if (req.method !== "GET" && req.method !== "HEAD") return util.errorJson(res, 405, "الطريقة غير مسموحة — استخدم GET");
  const id = String(req.query.id || "");
  if (!id) return util.errorJson(res, 400, "معرّف المهمة مطلوب");

  try {
    const job = await db.getJob(id);
    if (!job) return util.errorJson(res, 404, "المهمة غير موجودة (قد تكون حُذفت أو انتهت صلاحيتها بعد 24 ساعة)");
    if (job.status !== "done") {
      return util.errorJson(res, 409, `الناتج غير جاهز — حالة المهمة: ${job.status}`);
    }

    const size = Number(job.output_size || 0);
    if (!size) return util.errorJson(res, 500, "الناتج فارغ");

    const isDownload = req.query.download === "1";
    const headers = {
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    };
    if (isDownload) {
      headers["Content-Disposition"] = `attachment; filename="merged-${id}.mp4"`;
    }

    // تحليل المدى المطلوب
    const range = req.headers.range;
    let start = 0;
    let end = size - 1;
    let partial = false;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
      if (m && (m[1] !== "" || m[2] !== "")) {
        if (m[1] === "") {
          // لاحقة: آخر N بايت
          const n = Math.min(Number(m[2]), size);
          start = size - n;
          end = size - 1;
        } else {
          start = Number(m[1]);
          if (m[2] !== "") end = Math.min(Number(m[2]), size - 1);
        }
        if (start >= size || start > end) {
          res.writeHead(416, { "Content-Range": `bytes */${size}`, "Accept-Ranges": "bytes" });
          return res.end();
        }
        partial = true;
      }
    }

    const length = end - start + 1;
    headers["Content-Length"] = String(length);
    if (partial) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    res.writeHead(partial ? 206 : 200, headers);

    if (req.method === "HEAD") return res.end();

    // بث الصفوف المطلوبة فقط (تقليم أول/آخر جزء حسب المدى)
    for await (const piece of storage.iterateOutputRange(id, start, length)) {
      if (!res.write(Buffer.from(piece))) {
        await new Promise((r) => res.once("drain", r));
      }
    }
    res.end();
  } catch (e) {
    // إن فشل البث بعد إرسال الترويسات لا يمكن تغيير الحالة — نقطع الاتصال
    if (!res.headersSent) {
      return util.errorJson(res, 500, e instanceof Error ? e.message : "خطأ غير متوقع");
    }
    res.destroy();
  }
};
