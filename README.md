# ⚡ Awschett — خادم MCP لتوليد الوسائط + خدمة دمج الفيديو

مشروعان في مستودع واحد:

| المشروع | المسار | الوصف |
|---|---|---|
| **MCP Media Generator** | الجذر `/` | خادم MCP (Next.js) لتوليد الصور والفيديو بالذكاء الاصطناعي + لوحة إدارة عربية |
| **Video Merger API v2** | `merger/` | خدمة دمج فيديوهات مستقلة (Vercel Serverless + ffmpeg) بواجهة API عامة |

---

## 1) المشروع الرئيسي — MCP Media Generator

### القدرات
- **توليد صور** بـ `gpt-image-2-6/flare-text-to-image`
- **توليد فيديو بصوت متزامن أصلي** بـ `grok-imagine-video-1-5-preview`
- **دمج عدة مقاطع** في فيديو واحد عبر خدمة الدمج (`merger/`)
- **5 أدوات MCP** على مسار `/mcp`: `generate_image`, `generate_video`, `merge_videos`, `get_task`, `list_media`
- **لوحة إدارة عربية RTL**: مدير مفاتيح، لوحة مهام حية، بطاقة ربط جاهزة للنسخ (ChatGPT / Claude / Cursor)

### نظام المفاتيح المتسلسل (قلب المشروع)
- المفاتيح تُجرَّب **بترتيب إضافتها الصارم** (أول مفتاح أُضيف أولًا) — ليس round-robin.
- عند أي خطأ (مفتاح خاطئ / نفاد رصيد / حد معدل) يتم **التبديل فورًا للمفتاح التالي** واستئناف **نفس المهمة بنفس `task_id`** دون توقف.
- نموذج الذكاء الاصطناعي **لا يرى أخطاء المفاتيح أو الرصيد أبدًا**.
- مهمة فشلت على كل المفاتيح تبقى `processing` وتُعاد محاولتها تلقائيًا مع كل `get_task` (هدئة ~45 ثانية).
- المفاتيح مقنَّعة دائمًا في كل الاستجابات (`ABCD123••••••••WXYZ`).

### التشغيل محليًا
```bash
npm install
cp .env.example .env.local   # ثم املأ القيم
npm run dev                  # http://localhost:3000
```

### النشر على Vercel
1. ارفع المستودع إلى GitHub (موجود: `chettahsoufyane1-gif/Awschett`).
2. في Vercel: **Add New → Project** → اختر المستودع → الإعدادات تُكتشف تلقائيًا (Next.js).
3. أضف متغيرات البيئة (Settings → Environment Variables):
   - `TURSO_DATABASE_URL` — رابط قاعدة Turso
   - `TURSO_AUTH_TOKEN` — توكن قاعدة Turso بصلاحيات كتابة
   - `MERGER_API_BASE` — رابط مشروع خدمة الدمج بعد نشرها (مثل `https://awschett-merger.vercel.app`) — **بدون** شرطة مائلة في النهاية
   - اختياري: `MCP_ACCESS_TOKEN` (يطلب Bearer على `/mcp`)، `KIE_IMAGE_MODEL`، `KIE_VIDEO_MODEL`، `COMETAPI_IMAGE_MODEL`، `COMETAPI_VIDEO_MODEL`
4. Deploy.

### خدمة الدمج (merger/) — مشروع Vercel منفصل
1. في Vercel: **Add New → Project** → نفس المستودع.
2. **مهم:** في قسم Build & Output Settings فعّل **Root Directory** واكتب `merger`.
3. أضف `TURSO_DATABASE_URL` و`TURSO_AUTH_TOKEN` (نفس القاعدة تصلح).
4. Deploy — ثم خذ رابط المشروع وضعه في `MERGER_API_BASE` بمتغيرات المشروع الرئيسي.

### إنشاء قاعدة Turso مجانًا (إن لم تكن جاهزة)
```bash
turso db create awschett
turso db show awschett --url      # ← TURSO_DATABASE_URL
turso db tokens create awschett   # ← TURSO_AUTH_TOKEN
```
المخطط يُنشأ تلقائيًا عند أول استخدام (`CREATE TABLE IF NOT EXISTS`) — لا migrations.

### اختبار الـ MCP بـ curl بعد النشر
```bash
# 1) تهيئة
curl -s -X POST https://<نطاقك>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"1.0"}}}'

# 2) قائمة الأدوات
curl -s -X POST https://<نطاقك>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3) استدعاء أداة
curl -s -X POST https://<نطاقك>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_media","arguments":{}}}'
```
> الوضع stateless: لا حاجة لترويسة `mcp-session-id` إطلاقًا.

### ربط العملاء
- **ChatGPT**: Settings → Connectors → Create → Custom MCP server → ضع `https://<نطاقك>/mcp` في Server URL.
- **Claude Desktop** (`claude_desktop_config.json`):
```json
{ "mcpServers": { "media-generator": { "type": "http", "url": "https://<نطاقك>/mcp" } } }
```
- **Cursor / Windsurf / Cline** (`mcp.json`):
```json
{ "mcpServers": { "media-generator": { "url": "https://<نطاقك>/mcp" } } }
```

### نقاط API الإدارية
| النقطة | الوصف |
|---|---|
| `GET /api/health` | نبض النظام (قاعدة البيانات + الموديلات + خدمة الدمج) |
| `GET/POST /api/keys` | قائمة المفاتيح (مقنَّعة) / إضافة مفتاح `{provider, api_key, label?}` |
| `PATCH/DELETE /api/keys/{id}` | تعطيل/تنشيط `{status}` / حذف |
| `GET /api/tasks?limit=` | أحدث المهام + إحصائيات |

### ملاحظات
- الفيديو يحتاج دقائق: تعيد الأداة `task_id` فورًا ويُتابَع بـ `get_task` كل ~10 ثوانٍ (التقدم يُبث حيًا إن زوّد العميل بـ `progressToken`).
- ملفات الدمج تُحذف من خدمة الدمج بعد ~24 ساعة — نزّلها سريعًا.
- يُنصح بتشغيل حماية Vercel Deployment Protection أو إضافة `MCP_ACCESS_TOKEN` لأن لوحة الإدارة عامة بلا تسجيل دخول.

---

## 2) خدمة دمج الفيديو — merger/ (تفاصيل كاملة في [merger/README.md](merger/README.md))

- Node.js خالص (بلا خطوة بناء) + Turso لتخزين الأجزاء والناتج (Blobs مقسمة صفوفًا 2MB) + ffmpeg داخل الدالة.
- واجهة عربية RTL ثيم داكن: إضافة روابط أو رفع ملفات (أجزاء 4MB مع إعادة محاولة)، إعادة ترتيب بالسحب، شريط تقدم حقيقي، نتيجة بمشغل وعدّاد 24 ساعة، ووثائق API داخل الصفحة.
- الحدود: 10 مقاطع، 200MB للمصدر، 150MB للناتج، 600 ثانية مجموع المدد، الناتج MP4 (H.264 CRF 18 + AAC) حتى 1080p.

```bash
cd merger
npm install
npm run dev        # http://localhost:3020
npm run test:unit  # اختبارات الوحدات
npm run test:http  # اختبارات HTTP الكاملة
```

---

## بنية المستودع
```
├── src/                  # تطبيق Next.js الرئيسي (MCP + لوحة الإدارة)
│   ├── app/mcp/route.ts  # خادم MCP — الأدوات الخمس
│   ├── app/api/          # health / keys / tasks
│   ├── components/       # واجهة اللوحة العربية
│   └── lib/              # turso, keys, models, providers, generator, merger
└── merger/               # خدمة دمج الفيديو المستقلة (Vercel Serverless)
```

## الأمان
- `.env*` مستثنى من Git منذ أول commit — لا أسرار في المستودع إطلاقًا.
- المفاتيح تُخزَّن في قاعدة Turso وتُعاد **مقنَّعة فقط** في كل الاستجابات.
