// GET /api/cron — حذف المهام المنتهية (مجدول يوميًا عبر vercel.json)
const db = require("../lib/db");
const util = require("../lib/util");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return util.corsPreflight(res);
  if (req.method !== "GET") return util.errorJson(res, 405, "الطريقة غير مسموحة — استخدم GET");
  try {
    const deleted = await db.cleanupExpired();
    return util.json(res, 200, { deleted });
  } catch (e) {
    return util.errorJson(res, 500, e instanceof Error ? e.message : "خطأ غير متوقع");
  }
};
