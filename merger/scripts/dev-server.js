// خادم تطوير محلي يحاكي بيئة Vercel — يحلل المسارات الديناميكية ويضعها في req.query
// ويخدم الواجهة من public/ — المنفذ 3020
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const routes = {
  "POST /api/jobs": require("../api/jobs"),
  "POST /api/upload": require("../api/upload"),
  "GET /api/config": require("../api/config"),
  "GET /api/cron": require("../api/cron"),
  "GET|DELETE /api/jobs/<id>": require("../api/jobs/[id]/index.js"),
  "POST /api/jobs/<id>/process": require("../api/jobs/[id]/process.js"),
  "GET /api/jobs/<id>/video": require("../api/jobs/[id]/video.js"),
};

const PORT = Number(process.env.PORT || 3020);

function attachQuery(req, params) {
  // الدوال تقرأ المعاملات من req.query كما في Vercel
  req.query = { ...req.query, ...params };
}

async function handleApi(req, res, pathname, searchParams) {
  // إكمال req.query بالمعاملات البحثية أصلًا
  req.query = Object.fromEntries(searchParams.entries());

  // التوجيه حسب المسار فقط — المعالج نفسه يرفض الطرق الخاطئة بـ 405 (كسلوك Vercel)
  if (pathname === "/api/jobs") return routes["POST /api/jobs"](req, res);
  if (pathname === "/api/upload") return routes["POST /api/upload"](req, res);
  if (pathname === "/api/config") return routes["GET /api/config"](req, res);
  if (pathname === "/api/cron") return routes["GET /api/cron"](req, res);

  // /api/jobs/<id>[/process|/video]
  const m = /^\/api\/jobs\/([^/]+)(\/process|\/video)?$/.exec(pathname);
  if (m) {
    const params = { id: decodeURIComponent(m[1]) };
    attachQuery(req, params);
    if (!m[2]) return routes["GET|DELETE /api/jobs/<id>"](req, res);
    if (m[2] === "/process") return routes["POST /api/jobs/<id>/process"](req, res);
    if (m[2] === "/video") return routes["GET /api/jobs/<id>/video"](req, res);
  }
  return null; // غير مطابق
}

function serveStatic(res, pathname) {
  const file = pathname === "/" ? "/index.html" : pathname;
  const full = path.join(__dirname, "..", "public", path.normalize(file).replace(/^([.][.][/\\])+/, ""));
  if (!full.startsWith(path.join(__dirname, "..", "public"))) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (fs.existsSync(full) && fs.statSync(full).isFile()) {
    const ext = path.extname(full);
    const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    return res.end(fs.readFileSync(full));
  }
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("404 غير موجود");
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  try {
    const handled = await handleApi(req, res, u.pathname, u.searchParams);
    if (handled !== null) return;
    if (u.pathname.startsWith("/api/")) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: "النقطة غير موجودة" }));
    }
    serveStatic(res, u.pathname);
  } catch (e) {
    console.error("DEV SERVER ERROR:", e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n") : e);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "خطأ داخلي في خادم التطوير" }));
    } else {
      res.destroy();
    }
  }
});

server.listen(PORT, () => {
  console.log(`✅ خادم تطوير خدمة الدمج يعمل على http://localhost:${PORT}`);
});
