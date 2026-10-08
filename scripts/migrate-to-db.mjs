// One-time, non-destructive import of a local store.json into Postgres.
//   DATABASE_URL=... node scripts/migrate-to-db.mjs [path/to/store.json]          (dry run)
//   DATABASE_URL=... node scripts/migrate-to-db.mjs [path/to/store.json] --apply
// Never writes to the local file and never overwrites an existing cloud document:
// if the database already has data, it stops. Tokens (QR links) and delivery statuses are copied as they are.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPgBackend } from '../store-backend.mjs';

const apply = process.argv.includes('--apply');
const file = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) || 'data/store.json');
const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) { console.error('Set DATABASE_URL.'); process.exit(1); }
const doc = JSON.parse(readFileSync(file, 'utf8'));
const counts = Object.fromEntries(Object.entries(doc).map(([key, value]) => [key, Array.isArray(value) ? value.length : typeof value]));
const statuses = {}; for (const lead of doc.leads || []) statuses[lead.telegramStatus] = (statuses[lead.telegramStatus] || 0) + 1;
console.log('Source:', file, counts, 'lead statuses:', statuses);
const backend = createPgBackend({ url, initial: () => { throw new Error('unexpected seed'); } });
const pool = await (async () => { const { default: pg } = await import('pg'); return new pg.Pool({ connectionString: url, max: 1 }); })();
try {
  await pool.query('CREATE TABLE IF NOT EXISTS app_state (id text PRIMARY KEY, doc jsonb NOT NULL, version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now())');
  const existing = await pool.query("SELECT version, jsonb_array_length(doc->'leads') AS leads FROM app_state WHERE id = 'main'");
  if (existing.rows.length) { console.error(`Database already has data (version ${existing.rows[0].version}, ${existing.rows[0].leads} leads). Nothing changed.`); process.exitCode = 2; }
  else if (!apply) console.log('Dry run: nothing written. Re-run with --apply.');
  else { const result = await pool.query("INSERT INTO app_state (id, doc) VALUES ('main', $1) ON CONFLICT (id) DO NOTHING", [JSON.stringify(doc)]); console.log(result.rowCount ? 'Imported.' : 'Lost a race: data appeared meanwhile, nothing changed.'); }
} finally { await pool.end(); await backend.close?.(); }
