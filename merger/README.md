# 🎬 خدمة دمج الفيديو — Video Merger API v2

خدمة مستقلة جاهزة للنشر على **Vercel**: واجهة عربية RTL + API عامة للمطورين. تدمج عدة مقاطع في فيديو واحد عالي الجودة **MP4 (H.264 ‏CRF 18 ‏+ AAC ‏192k + faststart)** بدقة أكبر مدخل (حتى 1080p).

- **بلا تسجيل دخول وبلا مفاتيح** — API مفتوحة مع CORS مفتوح.
- كل شيء مخزَّن في قاعدة **Turso** (المهام، أجزاء الملفات، الناتج) — بلا S3 وبلا ملفات محلية.
- المعالجة داخل دالة Vercel عبر **ffmpeg** (ffmpeg-static + ffprobe-static).
- **كل الملفات تُحذف تلقائيًا بعد 24 ساعة** (تنظيف كسول + نقطة cron يومية).

---

## النشر على Vercel خطوة بخطوة

### 1) إنشاء قاعدة Turso (مجانية)
```bash
# ثبت Turso CLI ثم:
turso db create awschett
turso db show awschett --url      # ← هذا TURSO_DATABASE_URL
turso db tokens create awschett   # ← هذا TURSO_AUTH_TOKEN
```
> يمكنك استخدام نفس قاعدة المشروع الرئيسي — الجداول منفصلة (`jobs`, `sources`, `source_chunks`, `output_chunks`) وتُنشأ تلقائيًا عند أول استخدام.

### 2) ربط المستودع بـ Vercel
1. Vercel → **Add New → Project** → اختر مستودع `Awschett`.
2. في **Root Directory** اختر `merger` (Framework Preset: **Other** — لا خطوة بناء).
3. في **Environment Variables** أضف:
   | المتغير | القيمة | إلزامي |
   |---|---|---|
   | `TURSO_DATABASE_URL` | `libsql://...turso.io` | ✅ |
   | `TURSO_AUTH_TOKEN` | توكن بصلاحيات كتابة | ✅ |
   | `MAX_SOURCES` | `10` | اختياري |
   | `SOURCE_MAX_MB` | `200` | اختياري |
   | `OUTPUT_MAX_MB` | `150` | اختياري |
   | `MAX_TOTAL_DURATION_SEC` | `600` | اختياري |
   | `FFMPEG_PRESET` | `medium` | اختياري |
4. **Deploy** — ثم انسخ رابط المشروع (مثل `https://awschett-merger.vercel.app`) وضعه في `MERGER_API_BASE` بمتغيرات المشروع الرئيسي.

---

## توثيق API (أمثلة curl جاهزة — استبدل DOMAIN بنطاقك)

### إنشاء مهمة من روابط
```bash
curl -X POST https://DOMAIN/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"videos":["https://example.com/clip1.mp4","https://example.com/clip2.mp4"]}'
```
استجابة `201`:
```json
{"jobId":"wkucdefoxwvd","status":"queued","statusUrl":"https://DOMAIN/api/jobs/wkucdefoxwvd","processUrl":"https://DOMAIN/api/jobs/wkucdefoxwvd/process","expiresAt":"2026-11-11T17:00:00.000Z"}
```

### إنشاء مهمة بملفات (رفع على أجزاء)
```bash
curl -X POST https://DOMAIN/api/jobs \
  -H 'Content-Type: application/json' \
  -d '{"sources":[{"kind":"url","url":"https://example.com/a.mp4"},{"kind":"file","name":"b.mp4","size":5242880,"mime":"video/mp4"}]}'
# الاستجابة تتضمن uploads[] برابط الرفع و uploadChunkBytes=4194304
curl -X POST 'https://DOMAIN/api/upload?job=ID&seq=1&chunk=0' \
  -H 'Content-Type: application/octet-stream' \
  --data-binary @part0.bin   # كل جزء ≤ 4MB
```

### تنفيذ الدمج (متزامن — 10-15 ثانية عادةً)
```bash
curl -X POST https://DOMAIN/api/jobs/ID/process
```
استجابة `200`:
```json
{"status":"done","videoUrl":"https://DOMAIN/api/jobs/ID/video","downloadUrl":"https://DOMAIN/api/jobs/ID/video?download=1","size":3466678,"duration":20.03,"resolution":"640x360","expiresAt":"..."}
```
- المهمة قيد المعالجة فعله → `202` مع `{"status":"processing"}`.
- الفشل → `500` مع `{"error":"رسالة عربية"}` (حتمي — لا إعادة محاولة).

### الحالة والتقدم
```bash
curl https://DOMAIN/api/jobs/ID
# {"status":"processing","progress":62}
# {"status":"done","progress":100,"videoUrl":"...","downloadUrl":"...","size":...,"duration":...,"resolution":"WxH","expiresAt":"..."}
# {"status":"failed","progress":...,"error":"..."}
```

### بث/تحميل الناتج (بدعم Range)
```bash
curl -OJ "https://DOMAIN/api/jobs/ID/video?download=1"      # تحميل مباشر
curl -H "Range: bytes=0-1023" "https://DOMAIN/api/jobs/ID/video"   # 206 + Content-Range
```

### الحذف الفوري
```bash
curl -X DELETE https://DOMAIN/api/jobs/ID   # يحذف كل صفوف المهمة
```

### الحدود والفحص
```bash
curl https://DOMAIN/api/config
# {"version":"1.0.0","maxSources":10,"sourceMaxMB":200,"outputMaxMB":150,"maxTotalDurationSec":600,"uploadChunkBytes":4194304,...}
curl https://DOMAIN/api/cron   # تنظيف المهام المنتهية (مجدول يوميًا في vercel.json)
```

### أكواد الأخطاء
| الكود | الحالة |
|---|---|
| `400` | مدخلات تالفة (JSON / روابط / عدد) |
| `404` | مهمة أو مصدر غير موجود (أو انتهت صلاحيته بعد 24 ساعة) |
| `405` | طريقة HTTP خاطئة |
| `409` | حالة غير مناسبة (رفع ناقص / ناتج غير جاهز) |
| `413` | تجاوز حدود الحجم |

---

## التشغيل والاختبار محليًا
```bash
cd merger
npm install
cp .env.example .env     # املأ متغيري Turso
npm run dev              # http://localhost:3020 (يحاكي بيئة Vercel)
npm run test:unit        # 17 اختبار: الدمج، الدقة، المدة، الصوت، sha256، الحدود، الحذف
npm run test:http        # 19 اختبار: الروابط، Range 206، مختلط، حذف، 404، 400، 405
```

## الحدود والقواعد
- **10 مقاطع** كحد أقصى، **200MB** لكل مصدر، **150MB** للناتج، **600 ثانية** مجموع المدد.
- الناتج ثابت الإعدادات: ‏30fps، ‏H.264 ‏CRF 18، ‏AAC ‏192k/44.1kHz، ‏faststart — لا توجد معاملات resolution/fps.
- مصدر بلا صوت يُضاف له مسار صامت `anullsrc` تلقائيًا بدل فشل الدمج.
- كل الملفات تُحذف بعد **24 ساعة** — لا تخزن دائم.
- التقدم يُخزَّن في القاعدة: 0-40 سحب المصادر، 40-90 ترميز، 100 اكتمال.

## حدود الخطة المجانية التي يجب معرفتها
- **مدة الدالة**: `maxDuration: 300` مضبوط في `vercel.json` — الخطة المجانية (Hobby) مع Fluid Compute تسمح حتى 300 ثانية؛ الفيديوهات الطويلة جدًا قد تحتاج خطة Pro.
- **حجم الطلب**: ≈4.5MB — لذلك الرفع أجزاءً 4MB ثنائية.
- **حجم Turso المجاني**: 5GB — الناتج يُحذف خلال 24 ساعة فلا يتراكم، لكن راقب الاستخدام مع الملفات الكبيرة المتزامنة.
- **ffmpeg داخل الدالة**: يُنسخ تلقائيًا إلى `/tmp` بصلاحيات تنفيذ (`ensureExecutable`) — `/tmp` فقط أثناء المعالجة ويُنظف دائمًا.
