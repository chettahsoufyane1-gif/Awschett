// أدوات مشتركة: استجابات JSON، الأصل المطلق، معرفات قصيرة، تحقق الحدود
const env = require("./env");

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function errorJson(res, status, message) {
  json(res, status, { error: message });
}

function corsPreflight(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Range",
    "Access-Control-Max-Age": "86400",
  });
  res.end();
}

/** الأصل المطلق من ترويسات Vercel أو المحلي */
function getOrigin(req) {
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3020";
  return `${proto}://${host}`;
}

/** معرف قصير مطابق لشكل خدمة الدمج (11 حرفًا base36) */
function shortId() {
  let s = "";
  for (let i = 0; i < 11; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

function isValidHttpUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * تطبيع مدخلات إنشاء المهمة — يعيد { sources } أو { error } بالعربية.
 * يقبل {"videos":[...]} أو {"sources":[{"kind":"url","url":...} | {"kind":"file","name":...,"size":...,"mime":...}]}
 */
function normalizeSources(body) {
  const out = [];
  const videos = Array.isArray(body?.videos) ? body.videos : null;
  const rawSources = Array.isArray(body?.sources) ? body.sources : null;

  if (!videos && !rawSources) {
    return { error: "مرّر مصادر الدمج في videos أو sources" };
  }
  if (videos) {
    for (const v of videos) {
      if (typeof v !== "string" || !isValidHttpUrl(v.trim())) {
        return { error: "كل العناصر في videos يجب أن تكون روابط مباشرة عامة تبدأ بـ http/https" };
      }
      out.push({ kind: "url", url: v.trim() });
    }
  }
  if (rawSources) {
    for (const s of rawSources) {
      if (!s || typeof s !== "object") return { error: "عنصر مصدر غير صالح" };
      if (s.kind === "url") {
        if (!isValidHttpUrl(String(s.url || ""))) return { error: "رابط مصدر غير صالح — يجب أن يكون http/https مباشرًا وعامًا" };
        out.push({ kind: "url", url: String(s.url) });
      } else if (s.kind === "file") {
        const size = Number(s.size || 0);
        if (!s.name) return { error: "مصدر الملف يحتاج name" };
        if (!Number.isFinite(size) || size <= 0) return { error: "حجم الملف غير صالح" };
        if (size > env.SOURCE_MAX_MB * 1024 * 1024) {
          return { error: `حجم الملف «${s.name}» يتجاوز الحد المسموح (${env.SOURCE_MAX_MB}MB لكل مصدر)` };
        }
        out.push({ kind: "file", name: String(s.name).slice(0, 200), mime: String(s.mime || "video/mp4").slice(0, 100), size });
      } else {
        return { error: "نوع المصدر غير مدعوم — استخدم kind: url أو file" };
      }
    }
  }
  if (out.length < 2) return { error: "الدمج يحتاج مقطعَين على الأقل" };
  if (out.length > env.MAX_SOURCES) return { error: `أقصى عدد مقاطع للدمج هو ${env.MAX_SOURCES}` };
  return { sources: out };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  json,
  errorJson,
  corsPreflight,
  getOrigin,
  shortId,
  isValidHttpUrl,
  normalizeSources,
  sleep,
  UPLOAD_CHUNK_BYTES: 4 * 1024 * 1024, // حد حجم الطلب في Vercel ≈ 4.5MB
};
