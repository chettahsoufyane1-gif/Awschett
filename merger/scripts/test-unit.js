// اختبارات الوحدات — توليد فيديوهين مختلفي الدقة بـ ffmpeg، دمجهما، تحقق الجودة والتخزين والحذف
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const env = require("../lib/env");
const db = require("../lib/db");
const storage = require("../lib/storage");
const merge = require("../lib/merge");
const util = require("../lib/util");

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? " — " + extra : ""}`); }
}

async function sha256Stream(asyncIter) {
  const h = crypto.createHash("sha256");
  for await (const piece of asyncIter) h.update(Buffer.from(piece));
  return h.digest("hex");
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "merger-unit-"));
  const a = path.join(tmp, "a.mp4"); // 640x360 مع صوت
  const b = path.join(tmp, "b.mp4"); // 1280x720 بلا صوت

  console.log("▶ توليد مقطعي اختبار بـ ffmpeg النظامي…");
  execSync(`ffmpeg -y -f lavfi -i testsrc2=size=640x360:rate=30 -t 3 -f lavfi -i sine=frequency=440:duration=3 -c:v libx264 -preset ultrafast -c:a aac -shortest "${a}"`, { stdio: "ignore" });
  execSync(`ffmpeg -y -f lavfi -i testsrc2=size=1280x720:rate=30 -t 2 -c:v libx264 -preset ultrafast -an "${b}"`, { stdio: "ignore" });
  check("توليد المقطعين", fs.existsSync(a) && fs.existsSync(b));

  console.log("▶ 1) مسار رفع الأجزاء + تطابق sha256");
  const bufA = fs.readFileSync(a);
  const uploadJob = "upl" + util.shortId().slice(3);
  const exp = new Date(Date.now() + 3600_000).toISOString();
  await db.insertJob({ id: uploadJob, status: "uploading", expires_at: exp });
  await db.insertSources([{ job_id: uploadJob, seq: 0, kind: "file", name: "a.mp4", mime: "video/mp4", size_bytes: bufA.length, chunks_total: Math.ceil(bufA.length / util.UPLOAD_CHUNK_BYTES) }]);
  const CHUNK = util.UPLOAD_CHUNK_BYTES;
  for (let k = 0; k * CHUNK < bufA.length; k++) {
    const part = bufA.subarray(k * CHUNK, Math.min((k + 1) * CHUNK, bufA.length));
    await storage.storeSourceChunk(uploadJob, 0, k, part);
    await db.bumpSourceUploaded(uploadJob, 0, part.length);
  }
  const backSha = await sha256Stream(storage.iterateSourceBlob(uploadJob, 0));
  const origSha = crypto.createHash("sha256").update(bufA).digest("hex");
  check("تطابق sha256 بعد رفع الأجزاء وقراءتها", backSha === origSha);

  console.log("▶ 2) الدمج الكامل (640x360 مع صوت + 1280x720 بلا صوت)");
  const job = "unt" + util.shortId().slice(3);
  const sizeB = fs.statSync(b).size;
  await db.insertJob({ id: job, status: "queued", expires_at: exp });
  await db.insertSources([
    { job_id: job, seq: 0, kind: "file", name: "a.mp4", mime: "video/mp4", size_bytes: bufA.length, chunks_total: Math.ceil(bufA.length / CHUNK) },
    { job_id: job, seq: 1, kind: "file", name: "b.mp4", mime: "video/mp4", size_bytes: sizeB, chunks_total: Math.ceil(sizeB / CHUNK) },
  ]);
  // رفع كلا المصدرين عبر مسار الأجزاء نفسه
  const srcBufs = [bufA, fs.readFileSync(b)];
  for (let seq = 0; seq < 2; seq++) {
    const buf = srcBufs[seq];
    for (let k = 0; k * CHUNK < buf.length; k++) {
      const part = buf.subarray(k * CHUNK, Math.min((k + 1) * CHUNK, buf.length));
      await storage.storeSourceChunk(job, seq, k, part);
      await db.bumpSourceUploaded(job, seq, part.length);
    }
  }

  const progresses = [];
  const result = await merge.processJob(job, async (p) => { progresses.push(p); });
  check("اكتمال الدمج", result && result.status === "done");
  check("الدقة = أكبر دقة مدخل (1280x720)", result.resolution === "1280x720", result.resolution);
  const dur = Number(result.duration || 0);
  check("المدة ≈ مجموع المدد (5s ±1.2)", Math.abs(dur - 5) <= 1.2, String(dur));
  check("حجم الناتج منطقي (> 10KB)", Number(result.size) > 10240, String(result.size));
  check("التقدم صاعد حتى 100", progresses.length > 2 && progresses[progresses.length - 1] >= 92, progresses.join(","));

  console.log("▶ 3) التخزين والاسترجاع بتطابق sha256");
  const blobSha = await sha256Stream(storage.iterateOutputRange(job, 0, Number(result.size)));
  check("sha256 للناتج المخزن في Turso = الناتج المرمّز", blobSha === result.sha256);

  console.log("▶ 4) وجود الصوت في الناتج (المصدر الثاني كان بلا صوت)");
  const outFile = path.join(tmp, "out.mp4");
  {
    const ws = fs.createWriteStream(outFile);
    for await (const piece of storage.iterateOutputRange(job, 0, Number(result.size))) {
      ws.write(Buffer.from(piece));
    }
    await new Promise((r) => ws.end(r));
  }
  const probe = await merge.probeFile(outFile);
  check("الناتج يحوي مسار صوت (anullsrc للمصدر الصامت)", probe.hasAudio === true);
  check("دقة الفحص المستقل 1280x720", probe.width === 1280 && probe.height === 720);

  console.log("▶ 5) حدود المدخلات (normalizeSources)");
  const urls11 = Array.from({ length: env.MAX_SOURCES + 1 }, (_, i) => `https://x.com/v${i}.mp4`);
  check("رفض أكثر من الحد", normalizeErr({ videos: urls11 }).includes("أقصى عدد"));
  check("رفض مصدر واحد", normalizeErr({ videos: ["https://x.com/v.mp4"] }).includes("مقطعَين"));
  check("رفض رابط غير صالح", normalizeErr({ videos: ["ftp://x.mp4", "https://x.com/v.mp4"] }).length > 0);

  console.log("▶ 6) الحذف الشامل");
  await db.deleteJobRows(job);
  await db.deleteJobRows(uploadJob);
  const { getDb } = require("../lib/db");
  for (const [name, table] of [["jobs", "jobs"], ["sources", "sources"], ["source_chunks", "source_chunks"], ["output_chunks", "output_chunks"]]) {
    const rs = await getDb().execute({ sql: `SELECT COUNT(*) AS c FROM ${table} WHERE ${table === "jobs" ? "id" : "job_id"} IN (?, ?)`, args: [job, uploadJob] });
    check(`حذف كل صفوف ${name}`, Number(rs.rows[0].c) === 0, String(rs.rows[0].c));
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n═══ نتيجة اختبارات الوحدات: ${pass} ناجح / ${fail} فاشل ═══`);
  process.exit(fail ? 1 : 0);
}

function normalizeErr(body) {
  const r = util.normalizeSources(body);
  return r.error || "";
}

main().catch((e) => {
  console.error("فشل غير متوقع:", e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n") : e);
  process.exit(1);
});
