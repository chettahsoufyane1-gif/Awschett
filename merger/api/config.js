// GET /api/config — الحدود العامة + version (يستخدمها فحص الجهوزية في التطبيق الرئيسي)
const env = require("../lib/env");
const util = require("../lib/util");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return util.corsPreflight(res);
  if (req.method !== "GET") return util.errorJson(res, 405, "الطريقة غير مسموحة — استخدم GET");
  return util.json(res, 200, {
    version: "1.0.0",
    maxSources: env.MAX_SOURCES,
    sourceMaxMB: env.SOURCE_MAX_MB,
    outputMaxMB: env.OUTPUT_MAX_MB,
    maxTotalDurationSec: env.MAX_TOTAL_DURATION_SEC,
    uploadChunkBytes: util.UPLOAD_CHUNK_BYTES,
    ffmpegPreset: env.FFMPEG_PRESET,
  });
};
