import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryBackend, createFileBackend, runTransaction } from '../store-backend.mjs';

test('concurrent transactions never lose an update', async () => {
  const backend = createMemoryBackend({ counter: 0, tags: [] });
  await Promise.all(Array.from({ length: 25 }, (_, i) => runTransaction(backend, ctx => { ctx.doc.counter++; ctx.doc.tags.push(i); ctx.dirty = true; }, { attempts: 40 })));
  assert.equal(backend.peek().counter, 25);
  assert.equal(new Set(backend.peek().tags).size, 25);
});

test('a stale snapshot cannot overwrite a newer save', async () => {
  const backend = createMemoryBackend({ a: 1, b: 1 });
  const first = await backend.load(); const second = await backend.load();
  first.doc.a = 2; assert.equal(await backend.save(first.doc, first.version), true);
  second.doc.b = 2; assert.equal(await backend.save(second.doc, second.version), false);
  assert.deepEqual(backend.peek(), { a: 2, b: 1 });
});

test('read-only transactions do not write and run after-commit tasks once', async () => {
  const backend = createMemoryBackend({ x: 1 }); let saves = 0; const original = backend.save; backend.save = (...args) => { saves++; return original(...args); };
  let ran = 0;
  await runTransaction(backend, ctx => { ctx.after.push(() => { ran++; }); });
  assert.equal(saves, 0); assert.equal(ran, 1);
});

test('file backend gives the same compare-and-set guarantee and rate limiting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stay-backend-')); try {
    const backend = createFileBackend({ dir, initial: () => ({ n: 0 }) });
    await Promise.all(Array.from({ length: 10 }, () => runTransaction(backend, ctx => { ctx.doc.n++; ctx.dirty = true; }, { attempts: 30 })));
    assert.equal((await backend.load()).doc.n, 10);
    const results = []; for (let i = 0; i < 4; i++) results.push(await backend.rate('ip:lead', 3, 60000));
    assert.deepEqual(results, [true, true, true, false]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Telegram outbox: one claim wins, delivery is recorded, sent leads are never re-claimed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stay-outbox-'));
  Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: dir, ADMIN_PASSWORD: 'Unit-Test-Password-1', PUBLIC_BASE_URL: 'http://127.0.0.1:3999' });
  const { backend, claimLead, deliverLead, signSession, readSession } = await import('../server.mjs');
  try {
    await runTransaction(backend, ctx => { ctx.doc.leads = [{ id: 'l1', type: 'service', name: 'Тест', contact: '+70000000', apartmentName: 'A', complexName: 'C', district: 'D', source: 's', createdAt: new Date().toISOString(), consent: true, telegramStatus: 'pending', attempts: 0 }, { id: 'l2', telegramStatus: 'sent', attempts: 1 }]; ctx.dirty = true; });
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimLead()));
    assert.equal(claims.filter(Boolean).length, 1);
    const lead = claims.find(Boolean); assert.equal(lead.id, 'l1'); assert.equal(lead.telegramStatus, 'sending'); assert.equal(await claimLead(), null);
    let requests = 0;
    await deliverLead(lead, { claimed: true, token: 'test-token', chat: 'test-chat', fetch: async () => { requests++; return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) }; } });
    const stored = (await backend.load()).doc.leads.find(l => l.id === 'l1');
    assert.equal(stored.telegramStatus, 'sent'); assert.equal(stored.telegramMessageId, 7); assert.equal(requests, 1);
    assert.equal(await claimLead(), null); assert.equal(await claimLead('l2', { force: true }), null);
    // A crashed worker leaves 'sending'; it is only re-claimable after the stale window.
    await runTransaction(backend, ctx => { ctx.doc.leads.push({ id: 'l3', telegramStatus: 'sending', claimedAt: Date.now() - 10000, attempts: 1 }, { id: 'l4', telegramStatus: 'sending', claimedAt: Date.now() - 600000, attempts: 1 }); ctx.dirty = true; });
    assert.equal((await claimLead())?.id, 'l4'); assert.equal(await claimLead(), null);
    // Sessions: signed, tamper-proof, expiring.
    const good = signSession('csrf-1', Date.now() + 60000); assert.equal(readSession(good).csrf, 'csrf-1');
    assert.equal(readSession(good.slice(0, -2) + 'xx'), null); assert.equal(readSession('a.b'), null); assert.equal(readSession(signSession('c', Date.now() - 1)), null);
    const [payload, signature] = good.split('.'); const forged = Buffer.from(JSON.stringify({ c: 'evil', e: Date.now() + 1e9, i: 'x' })).toString('base64url');
    assert.equal(readSession(`${forged}.${signature}`), null); assert.ok(payload);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Postgres backend: seed once, compare-and-set, concurrent updates, shared rate limit', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { createPgBackend } = await import('../store-backend.mjs');
  const db = new PGlite();
  const pool = { query: async (text, params) => { const result = await db.query(text, params); return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length }; } };
  let seeds = 0; const backend = createPgBackend({ pool, initial: () => { seeds++; return { counter: 0, leads: [] }; } });
  const [a, b] = await Promise.all([backend.load(), backend.load()]);
  assert.equal(a.version, 1); assert.equal(b.version, 1); assert.deepEqual(a.doc, { counter: 0, leads: [] });
  a.doc.counter = 5; assert.equal(await backend.save(a.doc, a.version), true);
  b.doc.counter = 99; assert.equal(await backend.save(b.doc, b.version), false);
  assert.equal((await backend.load()).doc.counter, 5);
  await Promise.all(Array.from({ length: 15 }, () => runTransaction(backend, ctx => { ctx.doc.counter++; ctx.dirty = true; }, { attempts: 40 })));
  const final = await backend.load(); assert.equal(final.doc.counter, 20); assert.equal(final.version, 17);
  const allowed = []; for (let i = 0; i < 5; i++) allowed.push(await backend.rate('1.2.3.4:lead', 3, 60000));
  assert.deepEqual(allowed, [true, true, true, false, false]);
  assert.equal(await backend.rate('5.6.7.8:lead', 3, 60000), true);
  await db.close();
});
