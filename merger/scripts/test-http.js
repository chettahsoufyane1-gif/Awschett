// اختبار HTTP كامل ضد خادم التطوير (3020): روابط → دمج → Range → مختلط → حذف → أخطاء
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const BASE = "http://localhost:3020";
const util = require("../lib/util");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}

async function jfetch(pathname, opts = {}) {
  const res = await fetch(BASE + pathname, opts);
  let body = null;
  const text = await res.text();
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: res.status, headers: res.headers, body };
}

async function main() {
  const createdJobs = [];

  console.log("▶ 1) إنشاء مهمة من روابط عامة");
  const cr = await jfetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      videos: [
        "https://www.w3schools.com/html/mov_bbb.mp4",
        "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4",
      ],
    }),
  });
  check("201 + jobId + statusUrl + processUrl + expiresAt",
    cr.status === 201 && cr.body.jobId && cr.body.statusUrl && cr.body.processUrl && cr.body.expiresAt,
    JSON.stringify(cr.body).slice(0, 150));
  createdJobs.push(cr.body.jobId);
  const job1 = cr.body.jobId;

  console.log("▶ 2) تنفيذ الدمج (متزامن — قد يستغرق نصف دقيقة)");
  const pr = await jfetch(`/api/jobs/${job1}/process`, { method: "POST" });
  check("200 + status=done + videoUrl + downloadUrl + size + duration + resolution",
    pr.status === 200 && pr.body.status === "done" && pr.body.videoUrl && pr.body.downloadUrl
      && pr.body.size > 0 && pr.body.duration > 0 && /\d+x\d+/.test(pr.body.resolution || ""),
    JSON.stringify(pr.body).slice(0, 200));

  console.log("▶ 3) الحالة + البث مع Range");
  const st = await jfetch(`/api/jobs/${job1}`);
  check("GET الحالة: done + progress=100 + videoUrl", st.status === 200 && st.body.status === "done" && st.body.progress === 100 && !!st.body.videoUrl);
  const size = Number(st.body.size);

  const rangeRes = await fetch(BASE + `/api/jobs/${job1}/video`, { headers: { Range: "bytes=0-1023" } });
  const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
  check("Range → 206 + Content-Range + 1024 بايت",
    rangeRes.status === 206 && rangeRes.headers.get("content-range") === `bytes 0-1023/${size}` && rangeBuf.length === 1024,
    `${rangeRes.status} ${rangeRes.headers.get("content-range")}`);
  const midRes = await fetch(BASE + `/api/jobs/${job1}/video`, { headers: { Range: `bytes=${size - 500}-` } });
  const midBuf = Buffer.from(await midRes.arrayBuffer());
  check("Range لاحقي → 206 وآخر 500 بايت", midRes.status === 206 && midBuf.length === 500);
  const fullRes = await fetch(BASE + `/api/jobs/${job1}/video`);
  const fullBuf = Buffer.from(await fullRes.arrayBuffer());
  check("بث كامل → 200 بطول مطابق", fullRes.status === 200 && fullBuf.length === size, `${fullBuf.length}/${size}`);
  check("Content-Type: video/mp4 + Accept-Ranges", fullRes.headers.get("content-type") === "video/mp4" && fullRes.headers.get("accept-ranges") === "bytes");

  console.log("▶ 4) مهمة مختلطة (رابط + ملف مرفوع)");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-http-"));
  const clip = path.join(tmp, "clip.mp4");
  execSync(`ffmpeg -y -f lavfi -i testsrc2=size=320x240:rate=24 -t 2 -c:v libx264 -preset ultrafast -an "${clip}"`, { stdio: "ignore" });
  const clipBuf = fs.readFileSync(clip);
  const mr = await jfetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sources: [
        { kind: "url", url: "https://www.w3schools.com/html/mov_bbb.mp4" },
        { kind: "file", name: "clip.mp4", size: clipBuf.length, mime: "video/mp4" },
      ],
    }),
  });
  check("201 + status=uploading + uploads[]", mr.status === 201 && mr.body.status === "uploading" && Array.isArray(mr.body.uploads) && mr.body.uploads.length === 1,
    JSON.stringify(mr.body).slice(0, 200));
  createdJobs.push(mr.body.jobId);
  const job2 = mr.body.jobId;
  const CHUNK = util.UPLOAD_CHUNK_BYTES;
  let okUpload = true;
  for (let k = 0; k * CHUNK < clipBuf.length; k++) {
    const part = clipBuf.subarray(k * CHUNK, Math.min((k + 1) * CHUNK, clipBuf.length));
    const up = await jfetch(`/api/upload?job=${job2}&seq=1&chunk=${k}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: part,
    });
    if (up.status !== 200) { okUpload = false; break; }
  }
  check("رفع كل الأجزاء 200", okUpload);
  const pr2 = await jfetch(`/api/jobs/${job2}/process`, { method: "POST" });
  check("دمج المهمة المختلطة → done", pr2.status === 200 && pr2.body.status === "done", JSON.stringify(pr2.body).slice(0, 160));

  console.log("▶ 5) الحذف + 404 بعده");
  const del = await jfetch(`/api/jobs/${job1}`, { method: "DELETE" });
  check("DELETE → ok", del.status === 200 && del.body.ok === true);
  const gone = await jfetch(`/api/jobs/${job1}`);
  check("GET بعد الحذف → 404", gone.status === 404);
  const vidGone = await fetch(BASE + `/api/jobs/${job1}/video`);
  check("video بعد الحذف → 404", vidGone.status === 404);

  console.log("▶ 6) الأخطاء: JSON تالف، قائمة فارغة، طرق خاطئة، 404");
  const bad = await jfetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{تالف" });
  check("JSON تالف → 400", bad.status === 400);
  const empty = await jfetch("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ videos: [] }) });
  check("قائمة فارغة → 400 برسالة عربية", empty.status === 400 && /مقطعَين/.test(empty.body.error || ""));
  const wrongMethod = await jfetch("/api/config", { method: "POST" });
  check("طريقة خاطئة → 405", wrongMethod.status === 405);
  const missing = await jfetch("/api/jobs/nonexistent1");
  check("مهمة غير موجودة → 404", missing.status === 404);

  console.log("▶ 7) /api/config");
  const cfg = await jfetch("/api/config");
  check("config: maxSources=10 وuploadChunkBytes", cfg.status === 200 && cfg.body.maxSources === 10 && cfg.body.uploadChunkBytes === util.UPLOAD_CHUNK_BYTES);

  console.log("▶ 8) تنظيف مهام الاختبار");
  for (const j of createdJobs) await jfetch(`/api/jobs/${j}`, { method: "DELETE" });
  check("تنظيف كل مهام الاختبار", true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n═══ نتيجة اختبارات HTTP: ${pass} ناجح / ${fail} فاشل ═══`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("فشل غير متوقع:", e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n") : e);
  process.exit(1);
});
