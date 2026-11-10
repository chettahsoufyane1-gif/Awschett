"use client";

/**
 * بطاقة مدير المفاتيح — إضافة (بترتيب تسلسلي صارم)، تعطيل/تنشيط، حذف.
 * المفاتيح مقنَّعة دائمًا ولا يظهر المفتاح الكامل في أي مكان.
 */
import { useState } from "react";
import type { KeyDto } from "@/lib/types";

const STATUS_STYLE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  exhausted: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  disabled: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};
const STATUS_AR: Record<string, string> = {
  active: "نشط",
  exhausted: "مستنزف",
  disabled: "معطَّل",
};
const PROVIDER_AR: Record<string, string> = { kie: "kie.ai", cometapi: "CometAPI" };

export default function KeysManager({
  keys, loading, onAdd, onToggle, onDelete,
}: {
  keys: KeyDto[];
  loading: boolean;
  onAdd: (provider: string, apiKey: string, label: string) => Promise<string | null>;
  onToggle: (k: KeyDto) => Promise<void>;
  onDelete: (k: KeyDto) => Promise<void>;
}) {
  const [provider, setProvider] = useState("kie");
  const [apiKey, setApiKey] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setBusy(true);
    setMsg(null);
    const err = await onAdd(provider, apiKey.trim(), label.trim());
    setBusy(false);
    if (err) setMsg({ ok: false, text: err });
    else {
      setMsg({ ok: true, text: "أُضيف المفتاح بنجاح — سيُجرَّب أولًا في المهمة القادمة (الترتيب تسلسلي)" });
      setApiKey("");
      setLabel("");
    }
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-night-900/70 backdrop-blur p-5 flex flex-col gap-4 shadow-xl shadow-black/20">
      <header className="flex items-center gap-2">
        <span className="text-xl">🔑</span>
        <h2 className="text-lg font-bold">مدير المفاتيح</h2>
        {loading && <span className="text-xs text-slate-400 mr-auto">جارٍ التحديث…</span>}
      </header>

      <p className="text-[13px] leading-6 text-cyan-200/90 bg-cyan-500/10 border border-cyan-500/20 rounded-lg px-3 py-2">
        أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي
        عند أي خطأ أو نفاد رصيد دون توقف.
      </p>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-300">
            المزود
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="rounded-lg bg-night-800 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:border-cyan-400/60"
            >
              <option value="kie">kie.ai</option>
              <option value="cometapi">CometAPI</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-300">
            تسمية (اختياري)
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="مثال: حساب رئيسي"
              className="rounded-lg bg-night-800 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:border-cyan-400/60"
            />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-xs text-slate-300">
          المفتاح
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="ألصق مفتاح API هنا"
            dir="ltr"
            className="ltr-code rounded-lg bg-night-800 border border-white/10 px-3 py-2 text-sm focus:outline-none focus:border-cyan-400/60"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !apiKey.trim()}
          className="rounded-lg bg-gradient-to-l from-cyan-500 to-violet-500 px-4 py-2 text-sm font-bold text-white disabled:opacity-40 hover:opacity-90 transition"
        >
          {busy ? "جارٍ الإضافة…" : "＋ إضافة المفتاح"}
        </button>
        {msg && (
          <p className={`text-xs rounded-lg px-3 py-2 border ${msg.ok ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10" : "text-rose-300 border-rose-500/30 bg-rose-500/10"}`}>
            {msg.text}
          </p>
        )}
      </form>

      <div className="flex flex-col gap-3">
        {!keys.length && (
          <p className="text-sm text-slate-400 text-center py-6">
            لا توجد مفاتيح بعد — أضف أول مفتاح لتبدأ التوليد.
          </p>
        )}
        {keys.map((k, i) => (
          <article key={k.id} className="rounded-xl border border-white/10 bg-night-850/80 p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] font-bold text-slate-400 bg-white/5 rounded px-1.5 py-0.5">#{i + 1}</span>
              <span className="text-sm font-bold">{PROVIDER_AR[k.provider] ?? k.provider}</span>
              {k.label && <span className="text-xs text-slate-400">· {k.label}</span>}
              <span className={`text-[11px] rounded-full border px-2 py-0.5 ${STATUS_STYLE[k.status] ?? ""}`}>
                {STATUS_AR[k.status] ?? k.status}
              </span>
              <span className="ltr-code text-xs text-slate-300 font-mono bg-black/30 rounded px-2 py-0.5">{k.maskedKey}</span>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-slate-400 flex-wrap">
              <span>استخدام: {k.usageCount}</span>
              <span className="text-emerald-400">نجاح: {k.successCount}</span>
              <span className="text-rose-400">فشل: {k.failCount}</span>
            </div>
            {k.lastError && (
              <p className="text-[11px] text-rose-300/80 truncate" title={k.lastError} dir="ltr">
                آخر خطأ: {k.lastError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => onToggle(k)}
                className="text-xs rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 hover:bg-white/10 transition"
              >
                {k.status === "disabled" ? "تنشيط" : "تعطيل"}
              </button>
              <button
                onClick={() => onDelete(k)}
                className="text-xs rounded-lg border border-rose-500/30 text-rose-300 bg-rose-500/10 px-3 py-1.5 hover:bg-rose-500/20 transition"
              >
                حذف
              </button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
