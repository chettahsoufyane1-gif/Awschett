// طبقة التخزين — Blobs مقسمة إلى صفوف 2MB في Turso (حد HTTP) مع قراءة تدفقية
const { getDb } = require("./db");

const ROW_CHUNK = 2 * 1024 * 1024; // 2MB لكل صف
const PAGE_ROWS = 8;               // صفوف لكل استعلام (قراءة مُصفحة)

function splitToRows(buffer) {
  const rows = [];
  for (let off = 0; off < buffer.length; off += ROW_CHUNK) {
    rows.push(buffer.subarray(off, Math.min(off + ROW_CHUNK, buffer.length)));
  }
  return rows.length ? rows : [Buffer.alloc(0)];
}

/**
 * تخزين جزء ملف مصدر مرفوع (≤4MB) — يُقسم داخليًا صفوف 2MB.
 * الترقيم العام داخل المصدر: chunkIndex*ROWS_PER_UPLOAD_CHUNK + rowIdx
 */
const ROWS_PER_UPLOAD_CHUNK = 2; // 4MB / 2MB

async function storeSourceChunk(jobId, seq, chunkIndex, buffer) {
  const rows = splitToRows(buffer);
  const stmts = rows.map((data, r) => ({
    sql: `INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk_index, data) VALUES (?, ?, ?, ?)`,
    args: [jobId, seq, chunkIndex * ROWS_PER_UPLOAD_CHUNK + r, data],
  }));
  await getDb().batch(stmts, "write");
}

/** قراءة ملف مصدر كامل من صفوفه — يعيد async iterator لبقع 2MB بالترتيب */
async function* iterateSourceBlob(jobId, seq) {
  const db = getDb();
  let offset = 0;
  for (;;) {
    const rs = await db.execute({
      sql: `SELECT chunk_index, data FROM source_chunks WHERE job_id = ? AND seq = ?
            ORDER BY chunk_index ASC LIMIT ${PAGE_ROWS} OFFSET ${offset}`,
      args: [jobId, seq],
    });
    if (!rs.rows.length) break;
    for (const r of rs.rows) yield r.data;
    if (rs.rows.length < PAGE_ROWS) break;
    offset += PAGE_ROWS;
  }
}

/** تخزين ملف الناتج من مجرى — يقسمه صفوف 2MB (دفعات batch) */
async function storeOutputBlob(jobId, readStream) {
  const db = getDb();
  let chunkIndex = 0;
  let buf = Buffer.alloc(0);
  let batch = [];
  let saved = false;

  const flushRow = async (data, idx) => {
    batch.push({
      sql: `INSERT OR REPLACE INTO output_chunks (job_id, chunk_index, data) VALUES (?, ?, ?)`,
      args: [jobId, idx, data],
    });
    if (batch.length >= 20) {
      await db.batch(batch, "write");
      batch = [];
    }
  };

  for await (const piece of readStream) {
    let chunk = Buffer.concat([buf, piece]);
    while (chunk.length >= ROW_CHUNK) {
      await flushRow(chunk.subarray(0, ROW_CHUNK), chunkIndex++);
      chunk = chunk.subarray(ROW_CHUNK);
      saved = true;
    }
    buf = chunk;
  }
  if (buf.length || !saved) {
    await flushRow(buf, chunkIndex++);
  }
  if (batch.length) await db.batch(batch, "write");
  return chunkIndex; // عدد الصفوف المخزنة
}

/**
 * قراءة نطاق من الناتج (لدعم Range في البث) — async iterator لبقع البيانات.
 * start: إزاحة البداية بالبايت، length: عدد البايتات المطلوبة.
 */
async function* iterateOutputRange(jobId, start, length) {
  if (length <= 0) return;
  const db = getDb();
  let remaining = length;
  let pos = start;
  // نبدأ من الصف الذي يحوي الإزاحة المطلوبة
  let chunkIndex = Math.floor(pos / ROW_CHUNK);
  let skipInRow = pos - chunkIndex * ROW_CHUNK;

  while (remaining > 0) {
    const rs = await db.execute({
      sql: `SELECT data FROM output_chunks WHERE job_id = ? AND chunk_index = ? LIMIT 1`,
      args: [jobId, chunkIndex],
    });
    if (!rs.rows.length) break; // نهاية البيانات فعلًا (تلف؟) — نوقف التدفق
    let row = Buffer.from(rs.rows[0].data);
    if (skipInRow > 0) {
      row = row.subarray(skipInRow);
      skipInRow = 0;
    }
    if (row.length > remaining) row = row.subarray(0, remaining);
    if (row.length) {
      yield row;
      remaining -= row.length;
    }
    chunkIndex++;
  }
}

module.exports = {
  ROW_CHUNK,
  storeSourceChunk,
  iterateSourceBlob,
  storeOutputBlob,
  iterateOutputRange,
};
