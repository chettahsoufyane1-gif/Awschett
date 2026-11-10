"use client";

/**
 * لوحة الإدارة الرئيسية — هيدر بحالة النظام + ثلاث بطاقات:
 * مدير المفاتيح، لوحة المهام (تحديث كل 5 ثوانٍ)، ربط السيرفر.
 */
import { useCallback, useEffect, useState } from "react";
import KeysManager from "@/components/KeysManager";
import TasksPanel from "@/components/TasksPanel";
import ConnectPanel from "@/components/ConnectPanel";
import type { KeyDto, TaskDto, StatsDto, HealthDto } from "@/lib/types";

export default function Dashboard() {
  const [keys, setKeys] = useState<KeyDto[]>([]);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [stats, setStats] = useState<StatsDto | null>(null);
  const [health, setHealth] = useState<HealthDto | null>(null);
  const [keysLoading, setKeysLoading] = useState(true);

  const loadKeys = useCallback(async () => {
    try {
      setKeysLoading(true);
      const r = await fetch("/api/keys", { cache: "no-store" });
      const j = await r.json();
      if (Array.isArray(j.keys)) setKeys(j.keys);
    } catch { /* تعذر الجلب — نعيد لاحقًا */ }
    finally { setKeysLoading(false); }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      const j = await r.json();
      if (Array.isArray(j.tasks)) setTasks(j.tasks);
      if (j.stats) setStats(j.stats);
    } catch { /* تعذر الجلب */ }
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const r = await fetch("/api/health", { cache: "no-store" });
      setHealth(await r.json());
    } catch {
      setHealth({ ok: false, database: "turso-disconnected", mcpEndpoint: "/mcp", models: [], merger: { base: null, healthy: false }, authRequired: false });
    }
  }, []);

  useEffect(() => {
    loadKeys();
    loadTasks();
    loadHealth();
    const t1 = setInterval(loadTasks, 5000);   // لوحة المهام كل 5 ثوانٍ
    const t2 = setInterval(loadHealth, 30000); // الحالة كل 30 ثانية
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [loadKeys, loadTasks, loadHealth]);

  async function addKey(provider: string, apiKey: string, label: string): Promise<string | null> {
    try {
      const r = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey, label }),
      });
      const j = await r.json();
      if (!r.ok) return j.error ?? "فشلت الإضافة";
      await loadKeys();
      return null;
    } catch {
      return "تعذر الاتصال بالخادم";
    }
  }

  async function toggleKey(k: KeyDto) {
    const next = k.status === "disabled" ? "active" : "disabled";
    try {
      await fetch(`/api/keys/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      await loadKeys();
    } catch { /* تجاهل */ }
  }

  async function deleteKey(k: KeyDto) {
    if (!window.confirm("حذف هذا المفتاح نهائيًا؟")) return;
    try {
      await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
      await loadKeys();
    } catch { /* تجاهل */ }
  }

  const dbOk = health?.ok === true;

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 flex flex-col gap-6">
      {/* الهيدر — حالة النظام */}
      <header className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-gradient-to-br from-cyan-400 to-violet-500 flex items-center justify-center text-xl shadow-lg shadow-violet-500/30">
            ⚡
          </div>
          <div>
            <h1 className="text-2xl font-extrabold leading-tight">Awschett — مولّد الوسائط MCP</h1>
            <p className="text-xs text-slate-400">توليد الصور والفيديو ودمج المقاطع مع تبديل مفاتيح تسلسلي تلقائي</p>
          </div>
        </div>
        <div className="mr-auto flex items-center gap-2 flex-wrap">
          <span
            className={`text-xs rounded-full border px-3 py-1.5 font-bold ${
              dbOk
                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                : "bg-rose-500/15 text-rose-300 border-rose-500/30"
            }`}
          >
            {dbOk ? "● Turso متصل" : "● غير متصل"}
          </span>
          <span
            className={`text-xs rounded-full border px-3 py-1.5 ${
              health?.merger?.healthy
                ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                : "bg-amber-500/15 text-amber-300 border-amber-500/30"
            }`}
          >
            دمج: {health?.merger?.healthy ? "جاهزة" : health?.merger?.base ? "غير متاحة" : "غير مهيأة"}
          </span>
          {health?.authRequired && (
            <span className="text-xs rounded-full border border-violet-500/30 bg-violet-500/10 text-violet-200 px-3 py-1.5">
              🔒 /mcp محمي بـ Bearer
            </span>
          )}
        </div>
      </header>

      {/* البطاقات الثلاث */}
      <div className="grid gap-6 lg:grid-cols-3 items-start">
        <KeysManager keys={keys} loading={keysLoading} onAdd={addKey} onToggle={toggleKey} onDelete={deleteKey} />
        <TasksPanel tasks={tasks} stats={stats} />
        <ConnectPanel health={health} />
      </div>

      <footer className="text-center text-[11px] text-slate-500 py-4">
        Awschett MCP Media Generator v1.2.0 — الموديلان: gpt-image-2-6/flare-text-to-image · grok-imagine-video-1-5-preview
      </footer>
    </main>
  );
}
