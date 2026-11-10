"use client";

/**
 * لوحة المهام — شرائح إحصائيات + قائمة أحدث المهام (تتحدث تلقائيًا كل ~5 ثوانٍ من الأب).
 */
import type { TaskDto, StatsDto } from "@/lib/types";

const TYPE_AR: Record<string, string> = { image: "🖼️ صورة", video: "🎬 فيديو", merge: "🔗 دمج" };
const STATUS_AR: Record<string, string> = {
  completed: "مكتملة", failed: "فاشلة", processing: "جارية", pending: "بالانتظار",
};
const STATUS_STYLE: Record<string, string> = {
  completed: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  processing: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
  pending: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

function fmtTime(s: string): string {
  if (!s) return "—";
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("ar", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function TasksPanel({ tasks, stats }: { tasks: TaskDto[]; stats: StatsDto | null }) {
  return (
    <section className="rounded-2xl border border-white/10 bg-night-900/70 backdrop-blur p-5 flex flex-col gap-4 shadow-xl shadow-black/20">
      <header className="flex items-center gap-2">
        <span className="text-xl">📋</span>
        <h2 className="text-lg font-bold">لوحة المهام</h2>
        <span className="text-[11px] text-slate-400 mr-auto">تحديث تلقائي كل 5 ثوانٍ</span>
      </header>

      <div className="grid grid-cols-4 gap-2">
        {[
          { label: "الإجمالي", v: stats?.total ?? 0, c: "text-slate-200" },
          { label: "مكتملة", v: stats?.completed ?? 0, c: "text-emerald-300" },
          { label: "فاشلة", v: stats?.failed ?? 0, c: "text-rose-300" },
          { label: "جارية", v: stats?.processing ?? 0, c: "text-cyan-300" },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-white/10 bg-night-850/80 px-2 py-3 text-center">
            <div className={`text-xl font-extrabold ${s.c}`}>{s.v}</div>
            <div className="text-[11px] text-slate-400 mt-1">{s.label}</div>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-3 max-h-[560px] overflow-y-auto pl-1">
        {!tasks.length && (
          <p className="text-sm text-slate-400 text-center py-6">
            لا توجد مهام بعد — أول عملية توليد ستظهر هنا مباشرة.
          </p>
        )}
        {tasks.map((t) => (
          <article key={t.id} className="rounded-xl border border-white/10 bg-night-850/80 p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold">{TYPE_AR[t.type] ?? t.type}</span>
              <span className={`text-[11px] rounded-full border px-2 py-0.5 ${STATUS_STYLE[t.status] ?? ""}`}>
                {STATUS_AR[t.status] ?? t.status}
              </span>
              <span className="text-[11px] text-slate-400" dir="ltr">{t.model}</span>
              {t.attempts > 0 && (
                <span className="text-[11px] text-amber-300/90" title="عدد المحاولات المسجلة">
                  محاولات: {t.attempts}
                </span>
              )}
              <span className="text-[11px] text-slate-500 mr-auto">{fmtTime(t.createdAt)}</span>
            </div>

            {t.prompt && (
              <p className="text-xs text-slate-300 leading-6 line-clamp-2" title={t.prompt}>{t.prompt}</p>
            )}

            {(t.status === "processing" || t.status === "pending") && (
              <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-l from-cyan-400 to-violet-400 transition-all duration-500"
                  style={{ width: `${Math.max(4, Math.min(100, t.progress))}%` }}
                />
              </div>
            )}

            {t.status === "failed" && t.errorMessage && (
              <p className="text-[11px] text-rose-300/90 leading-5" dir="auto">❌ {t.errorMessage}</p>
            )}

            {t.status === "completed" && t.resultUrls.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {t.resultUrls.slice(0, 3).map((u, i) => (
                  <a
                    key={i}
                    href={u}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs rounded-lg border border-cyan-500/30 text-cyan-200 bg-cyan-500/10 px-3 py-1.5 hover:bg-cyan-500/20 transition"
                  >
                    فتح النتيجة {t.resultUrls.length > 1 ? `#${i + 1}` : ""} ↗
                  </a>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
