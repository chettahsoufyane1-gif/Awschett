// محرك الدمج — ffprobe + ffmpeg داخل الدالة، جودة عالية إلزامية
// الناتج: MP4 (H.264 CRF 18 + AAC 192k/44.1kHz + faststart) بدقة أكبر مدخل (حد أقصى 1080p)
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const env = require("./env");
const db = require("./db");
const storage = require("./storage");

// ─────────────────────────── الثنائيات ───────────────────────────

/** يضمن صلاحية التنفيذ — ينسخ إلى /tmp بصلاحية 755 عند الحاجة (مطلوب في الاستضافة) */
async function ensureExecutable(srcPath, name) {
  try {
    fs.accessSync(srcPath, fs.constants.X_OK);
    return srcPath;
  } catch {
    const dst = path.join(os.tmpdir(), `merger-${name}`);
    fs.copyFileSync(srcPath, dst);
    fs.chmodSync(dst, 0o755);
    return dst;
  }
}

function ffmpegPath() {
  try { return require("ffmpeg-static"); } catch { return "ffmpeg"; }
}

function ffprobePath() {
  try { return require("ffprobe-static").path || "ffprobe"; } catch { return "ffprobe"; }
}

function run(bin, args, timeoutMs = 570_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error("انتهت مهلة تنفيذ ffmpeg"));
    }, timeoutMs);
    p.stdout.on("data", (d) => { stdout += d.toString(); });
    p.stderr.on("data", (d) => { if (stderr.length < 20000) stderr += d.toString(); });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg خرج بكود ${code}: ${stderr.slice(-600)}`));
    });
  });
}

// ─────────────────────────── الفحص ───────────────────────────

/** فحص ملف: الدقة، المدة، وجود الصوت، معدل الإطارات */
async function probeFile(file) {
  const bin = await ensureExecutable(ffprobePath(), "ffprobe");
  const { stdout } = await run(bin, [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
  ], 60_000);
  const info = JSON.parse(stdout);
  const v = (info.streams || []).find((s) => s.codec_type === "video");
  const a = (info.streams || []).find((s) => s.codec_type === "audio");
  if (!v) throw new Error("ملف بلا مسار فيديو صالح");
  let fps = 30;
  if (v.r_frame_rate && v.r_frame_rate.includes("/")) {
    const [num, den] = v.r_frame_rate.split("/").map(Number);
    if (den > 0 && Number.isFinite(num)) fps = num / den;
  }
  return {
    width: v.width,
    height: v.height,
    fps: fps || 30,
    duration: Number(info.format?.duration || v.duration || 0),
    hasAudio: Boolean(a),
  };
}

// ─────────────────────────── سحب المصادر ───────────────────────────

/** تنزيل رابط مصدر إلى ملف مع عدّ البايتات وحد الحجم — يبث التقدم */
async function downloadSource(url, dst, onBytes) {
  const limit = env.SOURCE_MAX_MB * 1024 * 1024;
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`تعذر تنزيل المصدر (${res.status}): ${url.slice(0, 120)}`);
  if (!res.body) throw new Error("استجابة التنزيل بلا جسم");
  const out = fs.createWriteStream(dst);
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > limit) {
      out.destroy();
      fs.rmSync(dst, { force: true });
      throw new Error(`حجم المصدر يتجاوز الحد المسموح (${env.SOURCE_MAX_MB}MB لكل مصدر)`);
    }
    if (!out.write(chunk)) {
      await new Promise((r) => out.once("drain", r));
    }
    if (onBytes) onBytes(total);
  }
  await new Promise((resolve, reject) => {
    out.end(resolve);
    out.on("error", reject);
  });
  return total;
}

/** تجميع ملف مصدر مرفوع من صفوف Blobs إلى /tmp */
async function assembleSource(jobId, seq, dst) {
  const out = fs.createWriteStream(dst);
  for await (const piece of storage.iterateSourceBlob(jobId, seq)) {
    if (!out.write(Buffer.from(piece))) {
      await new Promise((r) => out.once("drain", r));
    }
  }
  await new Promise((resolve, reject) => {
    out.end(resolve);
    out.on("error", reject);
  });
}

// ─────────────────────────── بناء الفلتر ───────────────────────────

const even = (n) => Math.max(2, Math.floor(n / 2) * 2);

/** خطة التوحيد: أكبر دقة بين المدخلات مع حد أقصى 1920×1080 وأبعاد زوجية */
function buildFilterPlan(probes) {
  const maxW = even(Math.min(1920, Math.max(...probes.map((p) => p.width))));
  const maxH = even(Math.min(1080, Math.max(...probes.map((p) => p.height))));
  return { width: maxW, height: maxH };
}

// ─────────────────────────── التنفيذ الكامل ───────────────────────────

/**
 * تنفيذ مهمة الدمج كاملة (متزامن): سحب المصادر → توحيد → ترميز → تخزين الناتج.
 * يعيد حمولة done (العقد الثابت) أو يرمي خطأ عربي واضح.
 */
async function processJob(jobId, setProgress) {
  const job = await db.getJob(jobId);
  if (!job) throw new Error("المهمة غير موجودة");
  if (job.status === "processing") return { processing: true };
  if (job.status === "done") {
    return donePayload(jobId, job);
  }
  if (job.status === "failed") {
    throw new Error(job.error || "فشلت المهمة سابقًا");
  }

  const sources = await db.listSources(jobId);
  if (sources.length < 2) throw new Error("الدمج يحتاج مقطعَين على الأقل");

  // الملفات المرفوعة يجب أن تكون مكتملة
  for (const s of sources) {
    if (s.kind === "file") {
      if (s.chunks_total && (s.uploaded_bytes || 0) !== s.size_bytes) {
        throw new Error(`الملف «${s.name || s.seq}» لم يُرفع بالكامل — أكمل رفع الأجزاء أولًا`);
      }
    }
  }

  await db.updateJob(jobId, { status: "processing", progress: 3, error: null });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `merger-${jobId.slice(0, 8)}-`));
  const files = [];
  let stored = false;

  try {
    // (أ) سحب المصادر — التقدم 5→40
    const probePer = 35 / sources.length;
    const probes = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      const f = path.join(tmp, `in-${i}.mp4`);
      if (s.kind === "url") {
        await downloadSource(s.url, f);
      } else {
        await assembleSource(jobId, s.seq, f);
        const size = fs.statSync(f).size;
        if (s.size_bytes && size !== s.size_bytes) {
          throw new Error(`حجم الملف «${s.name || ""}» المرفوع (${size}) لا يطابق المعلن (${s.size_bytes})`);
        }
      }
      files.push(f);
      const p = await probeFile(f);
      probes.push(p);
      await setProgress(Math.round(5 + probePer * (i + 1)));
    }

    // (ب) فحص الحدود
    const totalDuration = probes.reduce((a, p) => a + p.duration, 0);
    if (totalDuration > env.MAX_TOTAL_DURATION_SEC) {
      throw new Error(`مجموع مدد المقاطع (${totalDuration.toFixed(1)}s) يتجاوز الحد (${env.MAX_TOTAL_DURATION_SEC}s)`);
    }

    // (ج) بناء مدخلات ffmpeg: مصادر + مدخلات صوت صامت لمن بلا صوت
    const plan = buildFilterPlan(probes);
    const inputArgs = [];
    const inputMeta = []; // { kind: "file"|"silent", index }
    for (const f of files) inputArgs.push("-i", f);
    let nextInput = files.length;
    for (const p of probes) {
      if (p.hasAudio) {
        inputMeta.push({ kind: "file" });
      } else {
        // مصدر بلا صوت → مسار صامت بنفس مدته بدل فشل الدمج
        inputArgs.push("-f", "lavfi", "-t", p.duration.toFixed(3), "-i", "anullsrc=r=44100:cl=stereo");
        inputMeta.push({ kind: "silent", index: nextInput++ });
      }
    }

    // (د) filter_complex: scale+pad لكل فيديو + aformat لكل صوت ثم concat
    const parts = [];
    const concatLabels = [];
    for (let i = 0; i < sources.length; i++) {
      parts.push(
        `[${i}:v]scale=${plan.width}:${plan.height}:force_original_aspect_ratio=decrease,` +
        `pad=${plan.width}:${plan.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`
      );
      if (inputMeta[i].kind === "file") {
        parts.push(`[${i}:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      } else {
        parts.push(`[${inputMeta[i].index}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      }
      concatLabels.push(`[v${i}][a${i}]`);
    }
    parts.push(`${concatLabels.join("")}concat=n=${sources.length}:v=1:a=1[vout][aout]`);
    const filter = parts.join(";");

    const outFile = path.join(tmp, "out.mp4");
    const ffbin = await ensureExecutable(ffmpegPath(), "ffmpeg");
    const args = [
      "-y",
      ...inputArgs,
      "-filter_complex", filter,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-crf", "18", "-preset", env.FFMPEG_PRESET,
      "-c:a", "aac", "-b:a", "192k", "-ar", "44100",
      "-movflags", "+faststart",
      "-progress", "pipe:1", "-nostats",
      outFile,
    ];

    // (هـ) ترميز مع قراءة التقدم من -progress pipe:1 — التقدم 40→90
    const totalUs = Math.max(1, totalDuration * 1_000_000);
    let lastWrite = 0;
    await new Promise((resolve, reject) => {
      const p = spawn(ffbin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stderr = "";
      let buf = "";
      const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("انتهت مهلة الترميز")); }, 570_000);
      p.stdout.on("data", (d) => {
        buf += d.toString();
        const m = buf.match(/out_time_us=(\d+)/);
        if (m) {
          const pct = Math.min(99, 40 + Math.round((Number(m[1]) / totalUs) * 50));
          const now = Date.now();
          if (now - lastWrite > 1500) {
            lastWrite = now;
            setProgress(pct).catch(() => {});
          }
        }
        if (buf.length > 4096) buf = buf.slice(-1024);
      });
      p.stderr.on("data", (d) => { if (stderr.length < 20000) stderr += d.toString(); });
      p.on("error", (e) => { clearTimeout(timer); reject(e); });
      p.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`فشل الترميز (كود ${code}): ${stderr.slice(-500)}`));
      });
    });

    // (و) فحص الناتج وحدوده
    const outSize = fs.statSync(outFile).size;
    if (outSize > env.OUTPUT_MAX_MB * 1024 * 1024) {
      throw new Error(`حجم الناتج (${(outSize / 1048576).toFixed(1)}MB) يتجاوز الحد (${env.OUTPUT_MAX_MB}MB)`);
    }
    const outProbe = await probeFile(outFile);

    // (ز) تخزين الناتج في Turso صفوفًا 2MB
    await setProgress(92);
    const stream = fs.createReadStream(outFile, { highWaterMark: 1024 * 512 });
    await storage.storeOutputBlob(jobId, stream);
    stored = true;

    // (ح) بعد النجاح: الناتج فقط هو المطلوب — احذف أجزاء المصادر
    const { getDb } = require("./db");
    await getDb().execute({ sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [jobId] });

    const resolution = `${outProbe.width}x${outProbe.height}`;
    await db.updateJob(jobId, {
      status: "done",
      progress: 100,
      output_size: outSize,
      output_duration: outProbe.duration,
      output_resolution: resolution,
    });
    const fresh = await db.getJob(jobId);
    return { ...donePayload(jobId, fresh), sha256: await sha256File(outFile) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await db.updateJob(jobId, { status: "failed", error: msg }).catch(() => {});
    throw e;
  } finally {
    // تنظيف /tmp دائمًا — لا نعتمد نظام ملفات دائم
    // (لو فشل التخزين قبل الاكتمال نحذف صفوف الناتج الجزئية أيضًا)
    if (!stored) {
      const { getDb } = require("./db");
      await getDb().execute({ sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [jobId] }).catch(() => {});
    }
    for (const f of files) { try { fs.rmSync(f, { force: true }); } catch {} }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function donePayload(jobId, job) {
  const origin = globalThis.__MERGER_ORIGIN__ || "";
  return {
    status: "done",
    videoUrl: `${origin}/api/jobs/${jobId}/video`,
    downloadUrl: `${origin}/api/jobs/${jobId}/video?download=1`,
    size: Number(job.output_size || 0),
    duration: Number(job.output_duration || 0),
    resolution: job.output_resolution || "",
    expiresAt: job.expires_at,
  };
}

function sha256File(file) {
  const crypto = require("crypto");
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

module.exports = { processJob, probeFile, buildFilterPlan, downloadSource, ensureExecutable, sha256File, donePayload };
