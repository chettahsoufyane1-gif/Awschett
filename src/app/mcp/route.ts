/**
 * خادم MCP — المسار /mcp (Streamable HTTP حسب مواصفات MCP).
 *
 * قرار معماري: نستخدم WebStandardStreamableHTTPServerTransport الرسمي من SDK
 * (يقبل Web Request ويعيد Web Response — وهو تمامًا ما تقدمه Next.js App Router
 * في route handlers، فلا حاجة لأي جسر Node↔Web).
 *
 * وضع بلا جلسة (sessionIdGenerator: undefined): الخيار الأنسب لبيئة Vercel
 * serverless بلا حالة مشتركة — ترانسپورت جديد لكل طلب كما تشترط المواصفة.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  runGeneration, getTaskStatus, listMedia, type ProgressSink,
} from "@/lib/generator";
import { runMerge } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الانتظار القصوى للأدوات (240 ثانية) + هامش
export const maxDuration = 300;

const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

const KNOWN_TOOLS = ["generate_image", "generate_video", "merge_videos", "get_task", "list_media"];

// ─────────────────── إشعارات التقدم (إن زوّد العميل بـ progressToken) ───────────────────

function sinkFrom(extra: unknown): ProgressSink | undefined {
  const meta = (extra as { _meta?: { progressToken?: unknown } })?._meta;
  const token = meta?.progressToken;
  const send = (extra as { sendNotification?: (n: unknown) => Promise<void> })?.sendNotification;
  if (token === undefined || token === null || typeof send !== "function") return undefined;
  return async (progress, message) => {
    await send({
      method: "notifications/progress",
      params: { progressToken: token, progress, total: 100, message },
    });
  };
}

function toolResult(text: string, isError?: boolean) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

// ─────────────────── تسجيل الأدوات الخمس ───────────────────

function registerTools(server: McpServer): void {
  // 1) generate_image
  server.registerTool(
    "generate_image",
    {
      description:
        "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential multi-key failover across all active keys). " +
        "Returns the finished image URL if ready within the wait window; otherwise returns a task_id — call get_task with that task_id every ~10 seconds until completed (show the URL) or failed (explain why).",
      inputSchema: {
        prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
        model: z.enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
          .default("gpt-image-2-6/flare-text-to-image"),
        aspect_ratio: z.enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
          .default("auto"),
        resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
        background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
        output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
        wait_seconds: z.number().int().min(0).max(240).default(90),
      },
    },
    async (args, extra) => {
      const out = await runGeneration(args as Record<string, any>, "image", sinkFrom(extra));
      return toolResult(out.text, out.isError);
    }
  );

  // 2) generate_video
  server.registerTool(
    "generate_video",
    {
      description:
        "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio; optional image-to-video). " +
        "Videos take minutes: short wait with live progress, then a task_id is returned — call get_task with it every ~10 seconds until completed (show the URL) or failed (explain why).",
      inputSchema: {
        prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
        image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
        model: z.enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
          .default("grok-imagine-video-1-5-preview"),
        aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
        enable_audio: z.boolean().default(true),
        duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
        wait_seconds: z.number().int().min(0).max(240).default(25),
      },
    },
    async (args, extra) => {
      const out = await runGeneration(args as Record<string, any>, "video", sinkFrom(extra));
      return toolResult(out.text, out.isError);
    }
  );

  // 3) merge_videos — بلا resolution/fps: خدمة الدمج تثبت المخرج (حد أقصى 10 مقاطع)
  server.registerTool(
    "merge_videos",
    {
      description:
        "Merge several finished clips into ONE final video in the given order. Pass 'urls' (public direct video URLs — e.g. links returned by generate_video) or 'task_ids' (COMPLETED video generation tasks — their result URLs are merged in this order; ideal after generating several clips). " +
        "Merging is usually fast: short wait with live progress, then the finished URL; otherwise a merge task_id is returned — track it with get_task. " +
        "the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
      inputSchema: {
        urls: z.array(z.string()).min(2).max(10).optional()
          .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
        task_ids: z.array(z.string()).min(2).max(10).optional()
          .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
        wait_seconds: z.number().int().min(0).max(240).default(60),
      },
    },
    async (args, extra) => {
      const out = await runMerge(args as Record<string, any>, sinkFrom(extra));
      return toolResult(out.text, out.isError);
    }
  );

  // 4) get_task
  server.registerTool(
    "get_task",
    {
      description:
        "Track any task by its id — image/video generation AND merging (reads the database and refreshes live from the provider/merging service while in progress). " +
        "Poll it every ~10 seconds; when completed you get the result URLs — show them to the user and stop polling.",
      inputSchema: {
        task_id: z.string().min(1),
      },
    },
    async (args, extra) => {
      const out = await getTaskStatus((args as { task_id: string }).task_id, sinkFrom(extra));
      return toolResult(out.text, out.isError);
    }
  );

  // 5) list_media
  server.registerTool(
    "list_media",
    {
      description:
        "Latest images / videos / merges stored in the database with their result URLs (no regeneration) — to recall previously generated media.",
      inputSchema: {
        type: z.enum(["image", "video", "merge"]).optional(),
        status: z.enum(["completed", "failed", "processing"]).optional(),
        limit: z.number().int().min(1).max(50).default(10),
      },
    },
    async (args) => {
      const out = await listMedia(args as Record<string, any>);
      return toolResult(out.text, out.isError);
    }
  );
}

// ─────────────────── المعالجة ───────────────────

function rpcError(id: unknown, code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toolResultResponse(id: unknown, text: string, isError = false): Response {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

async function handleMcp(req: Request): Promise<Response> {
  // حماية اختيارية: إن ضُبط MCP_ACCESS_TOKEN يُطلب Bearer token على /mcp
  const required = process.env.MCP_ACCESS_TOKEN;
  if (required) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${required}`) {
      return rpcError(null, -32001, "Unauthorized: Bearer token مطلوب على /mcp", 401);
    }
  }

  if (req.method === "POST") {
    let parsed: any;
    try {
      parsed = await req.clone().json();
    } catch {
      return rpcError(null, -32700, "Parse error: invalid JSON", 400);
    }
    // رد عربي واضح للأداة المجهولة (وفق صياغة المواصفة)
    if (parsed?.method === "tools/call" && parsed?.params?.name && !KNOWN_TOOLS.includes(parsed.params.name)) {
      return toolResultResponse(
        parsed.id,
        `❌ أداة غير معروفة: ${parsed.params.name}. المتاح: ${KNOWN_TOOLS.join("، ")}`,
        true
      );
    }
    // حدود الدمج برسائل عربية دقيقة (قبل رفض المخطط الإنجليزي)
    if (parsed?.method === "tools/call" && parsed?.params?.name === "merge_videos") {
      const a = parsed.params?.arguments ?? {};
      const nUrls = Array.isArray(a.urls) ? a.urls.length : 0;
      const nTasks = Array.isArray(a.task_ids) ? a.task_ids.length : 0;
      const maxSide = Math.max(nUrls, nTasks);
      if (maxSide > 10) {
        return toolResultResponse(parsed.id, "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).", true);
      }
      if (nUrls + nTasks < 2) {
        let text = "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.";
        if (Array.isArray(a.task_ids) && nTasks > 0) {
          text += "\n\nتفاصيل المعرّفات تُفحص عند التنفيذ — إن كانت مهام غير مكتملة ستُذكر تفاصيلها هنا.";
        }
        return toolResultResponse(parsed.id, text, true);
      }
    }
  }

  // وضع بلا جلسة: سيرفر وترانسپورت جديدان لكل طلب (متطلب المواصفة في stateless)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server);
  await server.connect(transport);

  try {
    // Web Request يدخل مباشرة وWeb Response يخرج منها (SSE/JSON حسب Accept)
    return await transport.handleRequest(req);
  } catch {
    return rpcError(null, -32603, "Internal error في مسار /mcp", 500);
  }
}

export async function POST(req: Request) { return handleMcp(req); }
export async function GET(req: Request) { return handleMcp(req); }
export async function DELETE(req: Request) { return handleMcp(req); }
