// قراءة .env يدويًا (بلا اعتماديات) — لا يطبع أي قيم أبدًا
const fs = require("fs");
const path = require("path");

let loaded = false;

function loadEnv() {
  if (loaded) return;
  loaded = true;
  try {
    const p = path.join(__dirname, "..", ".env");
    if (!fs.existsSync(p)) return;
    const lines = fs.readFileSync(p, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env) || process.env[key] === undefined || process.env[key] === "") {
        process.env[key] = val;
      }
    }
  } catch {
    // تجاهل — المتغيرات قد تأتي من بيئة الاستضافة مباشرة
  }
}

loadEnv();

module.exports = {
  TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL,
  TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN,
  MAX_SOURCES: Math.max(1, parseInt(process.env.MAX_SOURCES || "10", 10)),
  SOURCE_MAX_MB: Math.max(1, parseInt(process.env.SOURCE_MAX_MB || "200", 10)),
  OUTPUT_MAX_MB: Math.max(1, parseInt(process.env.OUTPUT_MAX_MB || "150", 10)),
  MAX_TOTAL_DURATION_SEC: Math.max(1, parseInt(process.env.MAX_TOTAL_DURATION_SEC || "600", 10)),
  FFMPEG_PRESET: process.env.FFMPEG_PRESET || "medium",
};
