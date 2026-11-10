// طبقة قاعدة البيانات — Turso (libSQL) عبر HTTP فقط، مخطط يُنشأ عند أول وصول
const { createClient } = require("@libsql/client");
const env = require("./env");

let _client = null;
let _schemaPromise = null;

function getDb() {
  if (!_client) {
    if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
      throw new Error("متغيرا البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN إلزاميان");
    }
    _client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_AUTH_TOKEN });
  }
  return _client;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'queued',
    progress INTEGER NOT NULL DEFAULT 0,
    output_size INTEGER,
    output_duration REAL,
    output_resolution TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    url TEXT,
    name TEXT,
    mime TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    uploaded_bytes INTEGER NOT NULL DEFAULT 0,
    chunks_total INTEGER,
    PRIMARY KEY (job_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS source_chunks (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (job_id, seq, chunk_index)
  )`,
  `CREATE TABLE IF NOT EXISTS output_chunks (
    job_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (job_id, chunk_index)
  )`,
];

function ensureSchema() {
  if (!_schemaPromise) {
    _schemaPromise = getDb()
      .batch(SCHEMA_STATEMENTS, "write")
      .catch((err) => {
        _schemaPromise = null;
        throw err;
      });
  }
  return _schemaPromise;
}

// ─────────────────────────── المهام ───────────────────────────

async function insertJob(job) {
  await ensureSchema();
  await getDb().execute({
    sql: `INSERT INTO jobs (id, status, progress, expires_at) VALUES (?, ?, 0, ?)`,
    args: [job.id, job.status, job.expires_at],
  });
}

async function getJob(id) {
  await ensureSchema();
  const rs = await getDb().execute({ sql: `SELECT * FROM jobs WHERE id = ? LIMIT 1`, args: [id] });
  return rs.rows[0] || null;
}

/** patch جزئي لحالة المهمة */
async function updateJob(id, patch) {
  await ensureSchema();
  const sets = [];
  const args = [];
  for (const k of ["status", "progress", "output_size", "output_duration", "output_resolution", "error"]) {
    if (patch[k] !== undefined) {
      sets.push(`${k} = ?`);
      args.push(patch[k]);
    }
  }
  if (!sets.length) return;
  args.push(id);
  await getDb().execute({ sql: `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`, args });
}

async function deleteJobRows(id) {
  await ensureSchema();
  await getDb().batch(
    [
      { sql: `DELETE FROM jobs WHERE id = ?`, args: [id] },
      { sql: `DELETE FROM sources WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM source_chunks WHERE job_id = ?`, args: [id] },
      { sql: `DELETE FROM output_chunks WHERE job_id = ?`, args: [id] },
    ],
    "write"
  );
}

async function jobExists(id) {
  const j = await getJob(id);
  return Boolean(j);
}

// ─────────────────────────── المصادر ───────────────────────────

async function insertSources(rows) {
  await ensureSchema();
  const stmts = rows.map((r) => ({
    sql: `INSERT INTO sources (job_id, seq, kind, url, name, mime, size_bytes, chunks_total)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [r.job_id, r.seq, r.kind, r.url ?? null, r.name ?? null, r.mime ?? null, r.size_bytes ?? 0, r.chunks_total ?? null],
  }));
  if (stmts.length) await getDb().batch(stmts, "write");
}

async function listSources(jobId) {
  await ensureSchema();
  const rs = await getDb().execute({
    sql: `SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC`,
    args: [jobId],
  });
  return rs.rows.map((r) => ({
    job_id: String(r.job_id),
    seq: Number(r.seq),
    kind: String(r.kind),
    url: r.url ? String(r.url) : null,
    name: r.name ? String(r.name) : null,
    mime: r.mime ? String(r.mime) : null,
    size_bytes: Number(r.size_bytes ?? 0),
    uploaded_bytes: Number(r.uploaded_bytes ?? 0),
    chunks_total: r.chunks_total != null ? Number(r.chunks_total) : null,
  }));
}

async function bumpSourceUploaded(jobId, seq, bytes) {
  await getDb().execute({
    sql: `UPDATE sources SET uploaded_bytes = uploaded_bytes + ? WHERE job_id = ? AND seq = ?`,
    args: [bytes, jobId, seq],
  });
}

// ─────────────────────────── التنظيف ───────────────────────────

/** حذف المهام المنتهية (يُستدعى كسولًا ومن /api/cron) — يعيد عدد المهام المحذوفة */
async function cleanupExpired() {
  await ensureSchema();
  const rs = await getDb().execute({
    sql: `SELECT id FROM jobs WHERE expires_at < datetime('now') LIMIT 50`,
  });
  let n = 0;
  for (const row of rs.rows) {
    await deleteJobRows(String(row.id));
    n++;
  }
  return n;
}

module.exports = {
  getDb,
  ensureSchema,
  insertJob,
  getJob,
  updateJob,
  deleteJobRows,
  jobExists,
  insertSources,
  listSources,
  bumpSourceUploaded,
  cleanupExpired,
};
