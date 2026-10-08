import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

// A backend holds ONE JSON document with an integer version.
//   load()               -> { doc, version }   (fresh copy, safe to mutate)
//   save(doc, version)   -> boolean            (compare-and-set; false = somebody else saved first)
//   rate(key, max, ms)   -> boolean            (true = allowed)
// Everything that mutates data goes through runTransaction, so a stale in-memory copy
// can never overwrite a newer one.

export function createFileBackend({ dir, initial }) {
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'store.json');
  let doc = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : initial();
  let version = 1;
  const flush = () => { writeFileSync(path + '.tmp', JSON.stringify(doc, null, 2)); renameSync(path + '.tmp', path); };
  flush();
  const limits = new Map();
  return {
    kind: 'file',
    async load() { return { doc: structuredClone(doc), version }; },
    async save(next, expected) { if (expected !== version) return false; doc = structuredClone(next); version++; flush(); return true; },
    async rate(key, max, windowMs) {
      const now = Date.now(); const entry = limits.get(key);
      const bucket = entry && entry.until > now ? entry : { count: 0, until: now + windowMs };
      bucket.count++; limits.set(key, bucket);
      if (limits.size > 5000) for (const [k, v] of limits) if (v.until < now) limits.delete(k);
      return bucket.count <= max;
    }
  };
}

export function createMemoryBackend(initialDoc) {
  let doc = structuredClone(initialDoc); let version = 1;
  return {
    kind: 'memory',
    async load() { await Promise.resolve(); return { doc: structuredClone(doc), version }; },
    async save(next, expected) { await Promise.resolve(); if (expected !== version) return false; doc = structuredClone(next); version++; return true; },
    async rate() { return true; },
    peek: () => doc
  };
}

export function createPgBackend({ url, initial, pool: given }) {
  let ready;
  const getPool = async () => {
    if (given) return given;
    const { default: pg } = await import('pg');
    return (getPool.pool ||= new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 8000 }));
  };
  const init = () => ready ||= (async () => {
    const pool = await getPool();
    await pool.query('CREATE TABLE IF NOT EXISTS app_state (id text PRIMARY KEY, doc jsonb NOT NULL, version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now())');
    await pool.query('CREATE TABLE IF NOT EXISTS rate_limits (key text PRIMARY KEY, count integer NOT NULL, until_ms bigint NOT NULL)');
    return pool;
  })().catch(error => { ready = null; throw error; });
  return {
    kind: 'postgres',
    async load() {
      const pool = await init();
      let result = await pool.query("SELECT doc, version FROM app_state WHERE id = 'main'");
      if (!result.rows.length) {
        // Seed once; a concurrent first start simply loses the race (DO NOTHING).
        await pool.query("INSERT INTO app_state (id, doc) VALUES ('main', $1) ON CONFLICT (id) DO NOTHING", [JSON.stringify(initial())]);
        result = await pool.query("SELECT doc, version FROM app_state WHERE id = 'main'");
      }
      return { doc: result.rows[0].doc, version: result.rows[0].version };
    },
    async save(next, expected) {
      const pool = await init();
      const result = await pool.query("UPDATE app_state SET doc = $1, version = version + 1, updated_at = now() WHERE id = 'main' AND version = $2", [JSON.stringify(next), expected]);
      return result.rowCount === 1;
    },
    async rate(key, max, windowMs) {
      const pool = await init(); const now = Date.now();
      const result = await pool.query(
        `INSERT INTO rate_limits (key, count, until_ms) VALUES ($1, 1, $2)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limits.until_ms < $3 THEN 1 ELSE rate_limits.count + 1 END,
           until_ms = CASE WHEN rate_limits.until_ms < $3 THEN $2 ELSE rate_limits.until_ms END
         RETURNING count`, [key, now + windowMs, now]);
      if (Math.random() < 0.02) void pool.query('DELETE FROM rate_limits WHERE until_ms < $1', [now]).catch(() => {});
      return result.rows[0].count <= max;
    },
    async close() { if (getPool.pool) await getPool.pool.end(); }
  };
}

// Load -> run fn(ctx) -> save only if ctx.dirty. On a version conflict the whole fn is re-run
// on a fresh copy, so fn must not have irreversible side effects (send those after the commit
// via ctx.after).
export async function runTransaction(backend, fn, { attempts = 6 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const { doc, version } = await backend.load();
    const ctx = { doc, dirty: false, after: [], attempt };
    const result = await fn(ctx);
    if (ctx.dirty && !(await backend.save(doc, version))) { await new Promise(r => setTimeout(r, 10 + Math.random() * 40 * (attempt + 1))); continue; }
    for (const task of ctx.after) { try { await task(); } catch {} }
    return result;
  }
  const error = new Error('Данные изменились одновременно. Повторите действие.'); error.status = 409; throw error;
}
