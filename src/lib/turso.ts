/**
 * طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP فقط.
 * قرار معماري: عميل واحد مُعاد استخدامه + إنشاء المخطط تلقائيًا عند أول وصول
 * حتى لا نحتاج أي أداة migrations، ونظل متوافقين تمامًا مع بيئة Vercel serverless.
 */
import { createClient, type Client, type InValue, type Row } from "@libsql/client";

let _client: Client | null = null;
let _schemaPromise: Promise<void> | null = null;

export function getDb(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;
    if (!url || !token) {
      throw new Error("متغيرا البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN إلزاميان");
    }
    _client = createClient({ url, authToken: token });
  }
  return _client;
}

/** ينشئ الجداول عند أول وصول فقط (CREATE TABLE IF NOT EXISTS) */
export async function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const db = getDb();
      await db.execute(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )
      `);
      await db.execute(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )
      `);
    })().catch((err) => {
      // فشل التهيئة لا يُخزَّن كوعد مُفضلف — نسمح بإعادة المحاولة لاحقًا
      _schemaPromise = null;
      throw err;
    });
  }
  return _schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await getDb().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────── أنواع الصفوف ───────────────────────────

export interface AttemptEntry {
  provider?: string;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface KeyRow {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

function mapTask(r: Row): TaskRow {
  return {
    id: String(r.id),
    provider: (r.provider as string) ?? null,
    provider_task_id: (r.provider_task_id as string) ?? null,
    key_id: (r.key_id as string) ?? null,
    model: String(r.model),
    type: r.type as TaskRow["type"],
    prompt: (r.prompt as string) ?? "",
    params_json: (r.params_json as string) ?? "{}",
    status: r.status as TaskRow["status"],
    progress: Number(r.progress ?? 0),
    result_urls_json: (r.result_urls_json as string) ?? null,
    error_message: (r.error_message as string) ?? null,
    attempts_json: (r.attempts_json as string) ?? "[]",
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    completed_at: (r.completed_at as string) ?? null,
  };
}

function mapKey(r: Row): KeyRow {
  return {
    id: String(r.id),
    provider: r.provider as KeyRow["provider"],
    label: (r.label as string) ?? "",
    api_key: String(r.api_key),
    status: (r.status as KeyRow["status"]) ?? "active",
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string) ?? null,
    last_checked_at: (r.last_checked_at as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    created_at: String(r.created_at ?? ""),
  };
}

/** تحويل توقيت SQLite «YYYY-MM-DD HH:MM:SS» (UTC دائمًا) إلى ميلي ثانية */
export function sqliteTimeToMs(s: string | null | undefined): number {
  if (!s) return 0;
  const iso = s.includes("T") ? s : s.replace(" ", "T") + (s.endsWith("Z") ? "" : "Z");
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

// ─────────────────────────── عمليات المهام ───────────────────────────

export async function insertTask(t: {
  id: string;
  model: string;
  type: TaskRow["type"];
  prompt: string;
  params_json: string;
  provider?: string;
  provider_task_id?: string;
  key_id?: string;
}): Promise<TaskRow> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', 0)`,
    args: [t.id, t.provider ?? null, t.provider_task_id ?? null, t.key_id ?? null, t.model, t.type, t.prompt, t.params_json],
  });
  return (await getTask(t.id))!;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const rs = await getDb().execute({ sql: "SELECT * FROM tasks WHERE id = ? LIMIT 1", args: [id] });
  return rs.rows.length ? mapTask(rs.rows[0]) : null;
}

export interface TaskPatch {
  provider?: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  status?: TaskRow["status"];
  progress?: number;
  result_urls?: string[];
  error_message?: string | null;
  /** إلحاق محاولة واحدة بسجل المحاولات (قراءة-تعديل-كتابة، التزامن منخفض في سياقنا) */
  appendAttempt?: AttemptEntry;
}

export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
  await ensureSchema();
  const current = await getTask(id);
  if (!current) return null;

  const sets: string[] = [];
  const args: InValue[] = [];

  if (patch.provider !== undefined) { sets.push("provider = ?"); args.push(patch.provider); }
  if (patch.provider_task_id !== undefined) { sets.push("provider_task_id = ?"); args.push(patch.provider_task_id); }
  if (patch.key_id !== undefined) { sets.push("key_id = ?"); args.push(patch.key_id); }
  if (patch.status !== undefined) { sets.push("status = ?"); args.push(patch.status); }
  if (patch.progress !== undefined) { sets.push("progress = ?"); args.push(Math.max(0, Math.min(100, Math.round(patch.progress)))); }
  if (patch.result_urls !== undefined) { sets.push("result_urls_json = ?"); args.push(JSON.stringify(patch.result_urls)); }
  if (patch.error_message !== undefined) { sets.push("error_message = ?"); args.push(patch.error_message); }
  if (patch.appendAttempt) {
    let attempts: AttemptEntry[] = [];
    try { attempts = JSON.parse(current.attempts_json || "[]"); } catch { attempts = []; }
    attempts.push(patch.appendAttempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(attempts.slice(-50))); // سقف معقول لتاريخ المحاولات
  }
  if (patch.status === "completed") {
    sets.push("completed_at = COALESCE(completed_at, datetime('now'))");
    if (patch.progress === undefined) { sets.push("progress = 100"); }
  }
  sets.push("updated_at = datetime('now')");

  args.push(id);
  await getDb().execute({ sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`, args });
  return getTask(id);
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: string; status?: string }
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters?.type) { where.push("type = ?"); args.push(filters.type); }
  if (filters?.status) { where.push("status = ?"); args.push(filters.status); }
  args.push(Math.max(1, Math.min(50, limit)));
  const rs = await getDb().execute({
    sql: `SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
          ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args,
  });
  return rs.rows.map(mapTask);
}

export async function taskStats(): Promise<{
  total: number; completed: number; failed: number; processing: number;
}> {
  await ensureSchema();
  const rs = await getDb().execute(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status IN ('processing','pending') THEN 1 ELSE 0 END) AS processing
     FROM tasks`
  );
  const r = rs.rows[0];
  return {
    total: Number(r?.total ?? 0),
    completed: Number(r?.completed ?? 0),
    failed: Number(r?.failed ?? 0),
    processing: Number(r?.processing ?? 0),
  };
}

// ─────────────────────────── عمليات المفاتيح ───────────────────────────

export async function insertKey(k: {
  id: string; provider: "kie" | "cometapi"; label: string; api_key: string;
}): Promise<KeyRow> {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [k.id, k.provider, k.label, k.api_key],
  });
  const rs = await getDb().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [k.id] });
  return mapKey(rs.rows[0]);
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<boolean> {
  await ensureSchema();
  const rs = await getDb().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return rs.rows.length > 0;
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const rs = await getDb().execute("SELECT * FROM api_keys ORDER BY created_at ASC, id ASC");
  return rs.rows.map(mapKey);
}

export async function getKeyById(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const rs = await getDb().execute({ sql: "SELECT * FROM api_keys WHERE id = ? LIMIT 1", args: [id] });
  return rs.rows.length ? mapKey(rs.rows[0]) : null;
}

export async function setKeyStatus(id: string, status: "active" | "disabled"): Promise<KeyRow | null> {
  await ensureSchema();
  // التنشيط اليدوي يمحو أي خطأ سابق (يشمل رفع تعطيل أو استنزاف سابق)
  await getDb().execute({
    sql: "UPDATE api_keys SET status = ?, last_error = NULL WHERE id = ?",
    args: [status, id],
  });
  return getKeyById(id);
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const rs = await getDb().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return rs.rowsAffected > 0;
}
