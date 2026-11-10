"use client";

/**
 * بطاقة ربط السيرفر — رابط /mcp جاهز للنسخ + JSON الربط لكل عميل
 * (ChatGPT / Claude Desktop / Cursor وWindsurf وCline) + رقائق الأدوات الخمس.
 */
import { useEffect, useState } from "react";
import type { HealthDto } from "@/lib/types";

const TOOLS: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي بـ gpt-image-2-6/flare-text-to-image" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن أصلي بـ grok-imagine-video-1-5-preview" },
  { name: "merge_videos", desc: "دمج عدة مقاطع في فيديو واحد بالترتيب المطلوب" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال وعرض الروابط" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها" },
];

const TABS = [
  { id: "chatgpt", label: "ChatGPT / GPT Agents" },
  { id: "claude", label: "Claude Desktop" },
  { id: "cursor", label: "Cursor / Windsurf / Cline" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function ConnectPanel({ health }: { health: HealthDto | null }) {
  const [origin, setOrigin] = useState("");
  const [tab, setTab] = useState<TabId>("chatgpt");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const mcpUrl = `${origin}/mcp`;
  const auth = health?.authRequired;
  const headersBlock = auth
    ? `,
        "headers": {
          "Authorization": "Bearer <MCP_ACCESS_TOKEN>"
        }`
    : "";

  const jsonByTab: Record<TabId, string> = {
    chatgpt: `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${headersBlock}
    }
  }
}`,
    claude: `{
  "mcpServers": {
    "media-generator": {
      "type": "http",
      "url": "${mcpUrl}"${headersBlock}
    }
  }
}`,
    cursor: `{
  "mcpServers": {
    "media-generator": {
      "url": "${mcpUrl}"${headersBlock}
    }
  }
}`,
  };

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 1800);
    } catch { /* المتصفح منع النسخ */ }
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-night-900/70 backdrop-blur p-5 flex flex-col gap-4 shadow-xl shadow-black/20">
      <header className="flex items-center gap-2">
        <span className="text-xl">🔗</span>
        <h2 className="text-lg font-bold">ربط السيرفر</h2>
      </header>

      <div className="flex items-center gap-2">
        <input
          readOnly
          value={mcpUrl || "…"}
          dir="ltr"
          className="ltr-code flex-1 rounded-lg bg-night-800 border border-white/10 px-3 py-2 text-sm text-cyan-200"
        />
        <button
          onClick={() => copy(mcpUrl, "url")}
          className="rounded-lg bg-white/5 border border-white/10 px-3 py-2 text-xs hover:bg-white/10 transition"
        >
          {copied === "url" ? "تم النسخ ✓" : "نسخ"}
        </button>
      </div>

      <div className="flex gap-1 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`text-xs rounded-lg px-3 py-1.5 border transition ${
              tab === t.id
                ? "border-cyan-500/40 bg-cyan-500/15 text-cyan-200"
                : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="relative">
        <pre className="ltr-code rounded-xl bg-black/40 border border-white/10 p-3 text-[11px] leading-5 overflow-x-auto font-mono text-violet-200">
          {jsonByTab[tab]}
        </pre>
        <button
          onClick={() => copy(jsonByTab[tab], "json")}
          className="absolute top-2 left-2 text-[11px] rounded-md bg-white/10 border border-white/10 px-2 py-1 hover:bg-white/20 transition"
        >
          {copied === "json" ? "تم ✓" : "نسخ JSON"}
        </button>
      </div>

      {tab === "chatgpt" && (
        <p className="text-xs text-slate-300 leading-6 bg-white/5 border border-white/10 rounded-lg px-3 py-2">
          في ChatGPT: <span className="font-bold">Settings → Connectors → Create → Custom MCP server</span> وضع
          الرابط في «Server URL».
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {TOOLS.map((t) => (
          <span
            key={t.name}
            title={t.desc}
            className="text-[11px] rounded-full border border-violet-500/30 bg-violet-500/10 text-violet-200 px-3 py-1 cursor-help"
          >
            {t.name}
          </span>
        ))}
      </div>
      <ul className="text-[11px] text-slate-400 leading-5 list-disc pr-4 space-y-1">
        {TOOLS.map((t) => (
          <li key={t.name}>
            <span className="font-mono text-slate-300" dir="ltr">{t.name}</span> — {t.desc}
          </li>
        ))}
      </ul>

      <p className="text-xs leading-6 text-amber-200 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2">
        ⚠️ الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند
        اكتمال المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications)
        حتى لا تنقطع العملية.
      </p>
    </section>
  );
}
