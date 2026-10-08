import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import QRCode from 'qrcode';
import { seed } from './seed.mjs';
import { populateDemo } from './demo-data.mjs';
import { createAssistant } from './assistant-service.mjs';
import { createFileBackend, createPgBackend, runTransaction } from './store-backend.mjs';

const root = dirname(fileURLToPath(import.meta.url));
if (process.env.NODE_ENV !== 'test' && existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const onVercel = Boolean(process.env.VERCEL);
const local = !onVercel && ['127.0.0.1', 'localhost', '::1'].includes(host);
if (!local && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'StayDemo2026!')) throw new Error('Set a unique ADMIN_PASSWORD before listening outside localhost.');
const baseUrl = (process.env.PUBLIC_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${port}`)).replace(/\/$/, '');
const dataDir = resolve(process.env.DATA_DIR || (onVercel ? '/tmp/stay-data' : resolve(root, 'data')));
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const initialStore = () => { const fresh = structuredClone(seed); try { return populateDemo(fresh) || fresh; } catch { return fresh; } };
// Postgres when DATABASE_URL is set (cloud); a local JSON file otherwise (dev, tests, previews without a DB).
const backend = databaseUrl ? createPgBackend({ url: databaseUrl, initial: initialStore }) : createFileBackend({ dir: dataDir, initial: () => structuredClone(seed) });
// Each request works on its own fresh copy of the data (AsyncLocalStorage), so concurrent requests
// on one instance never share or overwrite a stale snapshot. `store` keeps the old name for the handlers.
const requestContext = new AsyncLocalStorage();
const currentDoc = () => { const ctx = requestContext.getStore(); if (!ctx) throw new Error('store used outside a request'); return ctx.doc; };
const store = new Proxy({}, {
  get: (_, key) => currentDoc()[key], set: (_, key, value) => { currentDoc()[key] = value; return true; },
  has: (_, key) => key in currentDoc(), ownKeys: () => Reflect.ownKeys(currentDoc()),
  getOwnPropertyDescriptor: (_, key) => Reflect.getOwnPropertyDescriptor(currentDoc(), key), deleteProperty: (_, key) => delete currentDoc()[key]
});
function save() { const ctx = requestContext.getStore(); if (ctx) ctx.dirty = true; }
const assistant = createAssistant({ getStore: () => store, save, dataDir });
const sessionKey = scryptSync(process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'StayDemo2026!', 'stay-session-v1', 32);
const passwordHash = scryptSync(process.env.ADMIN_PASSWORD || 'StayDemo2026!', 'stay-admin-v1', 64);
const username = process.env.ADMIN_USER || 'admin';
const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
// Preview/development deployments must never post into the working Telegram group.
const telegramEnabled = Boolean(token && chat) && (!process.env.VERCEL_ENV || process.env.VERCEL_ENV === 'production');
const allowedOrigin = new URL(baseUrl).origin;
const clean = (value, max = 300) => String(value ?? '').trim().slice(0, max);
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
async function rate(ip, name, max, window = 60000) {
  if (!(await backend.rate(`${ip}:${name}`, max, window))) fail('Слишком много запросов. Попробуйте немного позже.', 429);
}
// Signed session cookie: valid on any instance and across cold starts. Logout adds its id to a shared revocation list.
function signSession(csrf, expires) { const payload = Buffer.from(JSON.stringify({ c: csrf, e: expires, i: randomBytes(12).toString('hex') })).toString('base64url'); return `${payload}.${createHmac('sha256', sessionKey).update(payload).digest('base64url')}`; }
function readSession(value) {
  const [payload, signature] = String(value || '').split('.'); if (!payload || !signature) return null;
  const expected = createHmac('sha256', sessionKey).update(payload).digest(); const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString()); return data.e > Date.now() ? { csrf: data.c, expires: data.e, id: data.i } : null; } catch { return null; }
}
function clientIp(req) { return onVercel ? String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown' : req.socket.remoteAddress; }
function safeUrl(value) {
  const text = clean(value, 1500); if (!text) return '';
  if (text.startsWith('/assets/') && !text.includes('..')) return text;
  try { const u = new URL(text); if (u.protocol === 'https:') return text; } catch {}
  fail('Укажите безопасную ссылку https://.');
}
function validate(collection, input, previous) {
  const row = { id: previous?.id || randomUUID() };
  const fields = {
    apartments: ['name', 'complexId', 'managerId', 'hostId', 'wifiName', 'wifiPassword', 'checkout', 'instructions'],
    complexes: ['name', 'district', 'address', 'addressTaxi', 'rules', 'facilities'],
    contacts: ['name', 'role', 'phone', 'whatsapp', 'note'],
    places: ['name', 'complexId', 'category', 'description', 'detail'],
    stays: ['name', 'apartmentId', 'managerId', 'arrival', 'departure'],
    banner: ['title', 'text', 'button']
  };
  for (const key of fields[collection]) row[key] = clean(input[key], ['checkout', 'instructions', 'rules', 'facilities', 'detail'].includes(key) ? 5000 : 300);
  if (collection === 'apartments') {
    row.token = previous?.token || randomBytes(18).toString('hex');
    row.photo = safeUrl(input.photo); row.isDemo = Boolean(input.isDemo);
    if (!store.complexes.some(c => c.id === row.complexId)) fail('Выберите существующий комплекс.');
    for (const key of ['hostId', 'managerId']) if (row[key] && !store.contacts.some(c => c.id === row[key])) fail('Выберите существующий контакт.');
  }
  if (['complexes', 'places'].includes(collection)) row.mapUrl = safeUrl(input.mapUrl);
  if (collection === 'places') {
    if (!store.complexes.some(c => c.id === row.complexId)) fail('Выберите существующий комплекс.');
    if (!['shop', 'market', 'health', 'beach', 'food', 'other'].includes(row.category)) fail('Выберите категорию места.');
  }
  if (collection === 'contacts') {
    row.photo = safeUrl(input.photo);
    for (const key of ['phone', 'whatsapp']) if (row[key] && !/^\+?[\d\s()\-]{7,30}$/.test(row[key])) fail('Проверьте номер телефона.');
  }
  if (collection === 'stays') {
    row.token = previous?.token || randomBytes(18).toString('hex');
    if (!store.apartments.some(a => a.id === row.apartmentId)) fail('Выберите квартиру.');
    if (!store.contacts.some(c => c.id === row.managerId)) fail('Назначьте персонального менеджера.');
    for (const field of ['arrival', 'departure']) if (row[field] && !/^\d{4}-\d{2}-\d{2}$/.test(row[field])) fail('Проверьте дату заезда или выезда.');
    if (row.arrival && row.departure && row.departure < row.arrival) fail('Выезд не может быть раньше заезда.');
  }
  if (collection === 'banner') { delete row.id; row.photo = safeUrl(input.photo); row.enabled = Boolean(input.enabled); if (!row.title || !row.button) fail('Заполните заголовок и кнопку.'); }
  else if (!row.name) fail('Введите название или имя.');
  if (previous) {
    for (const key of ['latitude','longitude','instructionTemplate','sourceId','source','sourceUrl','retrievedAt','distanceMeters','kind','openingHours','address','publishedAt']) if (previous[key] !== undefined && row[key] === undefined) row[key] = previous[key];
    row.translations = structuredClone(previous.translations || {});
    for (const key of Object.keys(row.translations.en || {})) if (row[key] !== previous[key]) delete row.translations.en[key];
  }
  if (collection === 'apartments' && !previous) {
    const defaults = store.complexes.find(c => c.id === row.complexId)?.instructionTemplate;
    if (defaults) for (const key of ['instructions','checkout']) if (!row[key]) { row[key] = defaults[key]; row.translations ||= { en: {} }; row.translations.en[key] = defaults.translations?.en?.[key] || ''; }
  }
  return row;
}
function resolveGuest(guestToken) {
  const stay = store.stays.find(s => s.token === guestToken);
  const apartment = stay ? store.apartments.find(a => a.id === stay.apartmentId) : store.apartments.find(a => a.token === guestToken);
  if (!apartment) fail('Эта гостевая страница не найдена.', 404);
  return { apartment, stay };
}
function guest(apartment, stay) {
  const complex = store.complexes.find(c => c.id === apartment.complexId);
  return { apartment, complex, stay: stay ? { id: stay.id, name: stay.name, arrival: stay.arrival, departure: stay.departure } : null, host: store.contacts.find(c => c.id === apartment.hostId) || null, manager: store.contacts.find(c => c.id === (stay?.managerId || apartment.managerId)) || null, places: store.places.filter(p => p.complexId === complex.id), banner: store.banner };
}
function session(req) {
  const record = readSession(/(?:^|;\s*)stay_session=([^;]+)/.exec(req.headers.cookie || '')?.[1]);
  if (!record || store.revokedSessions?.[record.id]) fail('Войдите в панель управления.', 401);
  return record;
}
async function readRaw(req) {
  let value = ''; for await (const part of req) { value += part; if (value.length > 65536) fail('Слишком большой запрос.', 413); }
  return value;
}
async function body() {
  const value = requestContext.getStore()?.raw || '';
  try { const result = JSON.parse(value || '{}'); if (!result || typeof result !== 'object' || Array.isArray(result)) fail('Некорректный запрос.'); return result; } catch { fail('Некорректный JSON.'); }
}
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
async function tx(fn) { return runTransaction(backend, ctx => { normalize(ctx.doc); return requestContext.run(ctx, () => fn(ctx)); }); }
function normalize(doc) { doc.stays ||= []; doc.placeDrafts ||= {}; doc.leads ||= []; return doc; }
const deliveryFields = ['telegramStatus', 'telegramMessageId', 'telegramError', 'sentAt', 'retryAt', 'attempts', 'claimedAt'];
// Copy delivery results onto the stored lead (by id). Only these fields, so admin edits made meanwhile survive.
async function persistLead(lead) {
  await tx(() => {
    const row = store.leads.find(l => l.id === lead.id); if (!row) return;
    for (const key of deliveryFields) { if (lead[key] === undefined) delete row[key]; else row[key] = lead[key]; }
    save();
  });
}
const STALE_SENDING_MS = 120000;
const claimable = (lead, now, force) => (['demo', 'pending', 'not_configured', 'failed'].includes(lead.telegramStatus) && (force || !lead.retryAt || lead.retryAt <= now)) || (lead.telegramStatus === 'sending' && now - (lead.claimedAt || 0) > STALE_SENDING_MS);
// Atomic claim: the compare-and-set save means only one worker can move a lead to 'sending'.
// A worker that dies mid-send leaves 'sending'; after STALE_SENDING_MS it may be re-claimed, so delivery is
// at-least-once in that rare case (Telegram gives no way to know whether the lost request got through).
export async function claimLead(id, { force = false } = {}) {
  return tx(() => {
    const now = Date.now(); const lead = store.leads.find(l => (id ? l.id === id : true) && claimable(l, now, force));
    if (!lead) return null;
    lead.telegramStatus = 'sending'; lead.claimedAt = now; lead.attempts = (lead.attempts || 0) + 1; delete lead.retryAt; save();
    return structuredClone(lead);
  });
}
export async function deliverLead(lead, options = {}) {
  if (lead.telegramStatus === 'sent') return;
  if (lead.telegramStatus === 'sending' && !options.claimed) return;
  const botToken = options.token || token; const chatId = options.chat || chat;
  if (!botToken || !chatId) { lead.telegramStatus = 'not_configured'; await persistLead(lead); return; }
  if (!options.claimed) { delete lead.retryAt; lead.telegramStatus = 'sending'; lead.claimedAt = Date.now(); lead.attempts = (lead.attempts || 0) + 1; }
  try {
    const text = [...(lead.isDemo ? ['🧪 ДЕМО · пример заявки для презентации'] : []), lead.type === 'service' ? '🏠 Обращение гостя' : '🏡 Заявка на подбор квартиры', `ID: ${lead.id}`, `Имя: ${lead.name}`, `Контакт: ${lead.contact}`, `Квартира: ${lead.apartmentName}`, `Комплекс: ${lead.complexName}`, `Район: ${lead.district}`, `Менеджер: ${lead.managerName || 'Не назначен'}`, `Цель: ${lead.goal || '—'}`, `Бюджет: ${lead.budget || 'Не указан'}`, `Сообщение: ${lead.message || '—'}`, `Источник: ${lead.source}`, `Дата: ${lead.createdAt}`, `Согласие: ${lead.isDemo ? 'демонстрационные данные' : lead.consent ? 'да' : 'нет'}`].join('\n').slice(0, 4000);
    const response = await (options.fetch || fetch)(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok || !result.ok) { lead.retryAt = Date.now() + Math.max(60, Number(result.parameters?.retry_after) || 0) * 1000; throw new Error('delivery'); }
    lead.telegramStatus = 'sent'; lead.telegramMessageId = result.result.message_id; lead.telegramError = ''; lead.sentAt = new Date().toISOString(); delete lead.retryAt;
  } catch { lead.telegramStatus = 'failed'; lead.telegramError = 'Telegram не подтвердил доставку. Проверьте настройки бота и чата.'; lead.retryAt ||= Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(lead.attempts, 5)); }
  await persistLead(lead);
}
let draining = false;
export async function drain(limit = 20) {
  if (draining || !telegramEnabled) return; draining = true;
  try { for (let i = 0; i < limit; i++) { const lead = await claimLead(); if (!lead) break; await deliverLead(lead, { claimed: true }); await new Promise(resolve => setTimeout(resolve, 1100)); } } finally { draining = false; }
}
// Keep work running after the response is sent (Vercel would otherwise freeze the function).
function background(task) {
  const promise = Promise.resolve().then(task).catch(() => {});
  if (onVercel) import('@vercel/functions').then(({ waitUntil }) => waitUntil(promise)).catch(() => {});
  return promise;
}
class BufferedResponse {
  headers = {}; status = 200; chunks = []; headersSent = false;
  setHeader(key, value) { this.headers[key] = value; }
  writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); this.headersSent = true; return this; }
  end(data) { if (data !== undefined) this.chunks.push(Buffer.from(data)); }
  flushTo(res) { res.writeHead(this.status, this.headers); res.end(Buffer.concat(this.chunks)); }
}
function secure(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}
function checkOrigin(req) { if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && ![allowedOrigin, `http://127.0.0.1:${port}`].includes(req.headers.origin)) fail('Недопустимый источник запроса.', 403); }
async function handle(req, res) {
  try {
    const path = new URL(req.url, `http://${req.headers.host}`).pathname;
    if (!path.startsWith('/api/') || path === '/api/health') return await route(req, res);
    const readOnly = ['GET', 'HEAD'].includes(req.method);
    const raw = readOnly ? '' : await readRaw(req);
    if (path === '/api/cron/drain') {
      secure(res); if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) fail('Нет доступа.', 401);
      await drain(); return json(res, { ok: true });
    }
    const retry = /^\/api\/admin\/leads\/([^/]+)\/retry$/.exec(path);
    if (retry && req.method === 'POST') {
      // Network call: kept outside the data transaction so a conflict-retry can never send twice.
      secure(res); checkOrigin(req); const auth = session(req);
      if (req.headers['x-csrf-token'] !== auth.csrf) fail('Обновите страницу и повторите действие.', 403);
      if (!telegramEnabled) fail('Telegram не подключён в этом окружении.');
      const lead = await claimLead(retry[1], { force: true });
      if (!lead) fail('Заявка уже отправляется или доставлена.', 409);
      await deliverLead(lead, { claimed: true }); return json(res, { ok: lead.telegramStatus === 'sent', status: lead.telegramStatus });
    }
    const result = await runTransaction(backend, async ctx => {
      normalize(ctx.doc); ctx.raw = raw; const out = new BufferedResponse();
      await requestContext.run(ctx, () => route(req, out));
      if (out.status >= 400) ctx.dirty = false;
      return { out, after: ctx.after.splice(0) };
    });
    result.out.flushTo(res); for (const task of result.after) background(task);
  } catch (error) { if (!res.headersSent) { secure(res); json(res, { error: error.status ? error.message : 'Ошибка сервера. Попробуйте ещё раз.' }, error.status || 500); } else res.end(); }
}
async function route(req, res) {
  secure(res);
  try {
    const url = new URL(req.url, `http://${req.headers.host}`); const path = url.pathname; const ip = clientIp(req);
    checkOrigin(req);
    if (path === '/api/health') return json(res, { ok: true });
    if (path === '/api/guest' && req.method === 'GET') {
      const { apartment, stay } = resolveGuest(url.searchParams.get('token'));
      return json(res, guest(apartment, stay));
    }
    if (path === '/api/leads' && req.method === 'POST') {
      await rate(ip, 'lead', 6, 600000); const input = await body();
      if (input.website) fail('Не удалось отправить заявку.');
      const { apartment, stay } = resolveGuest(input.token);
      const name = clean(input.name, 100); const contact = clean(input.contact, 100);
      if (name.length < 2) fail('Укажите ваше имя.');
      if (!/^(?:\+?[\d\s()\-]{7,30}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(contact)) fail('Укажите телефон или Telegram в формате @username.');
      if (input.consent !== true) fail('Подтвердите согласие на обработку данных и связь по заявке.');
      const type = input.type === 'service' ? 'service' : 'sales'; const complex = store.complexes.find(c => c.id === apartment.complexId);
      const lead = { id: randomUUID(), type, name, contact, goal: clean(input.goal, 100), budget: clean(input.budget, 100), message: clean(input.message, 2000), consent: true, consentVersion: '2026-10-demo-v1', apartmentId: apartment.id, stayId: stay?.id || '', guestName: stay?.name || '', apartmentName: apartment.name, complexName: complex.name, district: complex.district, managerName: store.contacts.find(c => c.id === (stay?.managerId || apartment.managerId || apartment.hostId))?.name || '', source: type === 'sales' ? store.banner.title : 'Помощь по проживанию', createdAt: new Date().toISOString(), status: 'new', telegramStatus: telegramEnabled ? 'pending' : 'not_configured', attempts: 0 };
      if (type === 'service' && !lead.message) fail('Опишите ваш вопрос.');
      store.leads.unshift(lead); save(); requestContext.getStore().after.push(() => drain()); return json(res, { ok: true, id: lead.id }, 201);
    }
    if (path === '/api/admin/login' && req.method === 'POST') {
      await rate(ip, 'login', 10, 600000); const input = await body();
      const hash = scryptSync(clean(input.password, 500), 'stay-admin-v1', 64);
      if (clean(input.username) !== username || !timingSafeEqual(hash, passwordHash)) fail('Неверный логин или пароль.', 401);
      const csrf = randomBytes(24).toString('hex'); const id = signSession(csrf, Date.now() + 8 * 3600000);
      res.setHeader('Set-Cookie', `stay_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${allowedOrigin.startsWith('https:') ? '; Secure' : ''}`); return json(res, { ok: true, csrf });
    }
    if (path.startsWith('/api/admin/')) {
      const auth = session(req);
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== auth.csrf) fail('Обновите страницу и повторите действие.', 403);
      if (path === '/api/admin/data' && req.method === 'GET') return json(res, { ...store, revokedSessions: undefined, csrf: auth.csrf, settings: { baseUrl, telegramEnabled, crmEnabled: false, assistant: assistant.settings() } });
      if (path.startsWith('/api/admin/assistant/') && req.method === 'POST') {
        const action = path.slice('/api/admin/assistant/'.length);
        const actions = { geocode: input => assistant.geocode(input.query), search: assistant.search, enhance: assistant.enhance, publish: assistant.publish, 'templates/preview': assistant.templatePreview, 'templates/apply': assistant.applyTemplates };
        if (!actions[action]) fail('Неизвестный запрос.', 404);
        await rate(ip, `assistant:${action}`, action === 'enhance' ? 3 : 15);
        return json(res, await actions[action](await body()));
      }
      if (path === '/api/admin/logout' && req.method === 'POST') { const now = Date.now(); store.revokedSessions = Object.fromEntries(Object.entries(store.revokedSessions || {}).filter(([, expires]) => expires > now)); store.revokedSessions[auth.id] = auth.expires; save(); res.setHeader('Set-Cookie', 'stay_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, { ok: true }); }
      if (path === '/api/admin/banner' && req.method === 'PUT') { store.banner = validate('banner', await body()); save(); return json(res, { ok: true }); }
      const qr = /^\/api\/admin\/(qr|stay-qr)\/([^/]+)$/.exec(path);
      if (qr && req.method === 'GET') {
        const a = store[qr[1] === 'qr' ? 'apartments' : 'stays'].find(a => a.id === qr[2]); if (!a) fail('Запись не найдена.', 404);
        const svg = await QRCode.toString(`${baseUrl}/g/${a.token}`, { type: 'svg', margin: 3, width: 600, errorCorrectionLevel: 'M' });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }); return res.end(svg);
      }
      const leadRoute = /^\/api\/admin\/leads\/([^/]+)$/.exec(path);
      if (leadRoute) {
        const lead = store.leads.find(l => l.id === leadRoute[1]); if (!lead) fail('Заявка не найдена.', 404);
        if (req.method === 'PATCH') { const input = await body(); if (!['new', 'in_progress', 'done'].includes(input.status)) fail('Неверный статус.'); lead.status = input.status; save(); return json(res, { ok: true }); }
        if (req.method === 'DELETE') { store.leads = store.leads.filter(l => l.id !== lead.id); save(); return json(res, { ok: true }); }
      }
      const route = /^\/api\/admin\/(apartments|complexes|contacts|places|stays)(?:\/([^/]+))?$/.exec(path);
      if (route) {
        const [, collection, id] = route; const previous = store[collection].find(r => r.id === id);
        if (req.method === 'POST' && !id) { const row = validate(collection, await body()); store[collection].push(row); save(); return json(res, row, 201); }
        if (!previous) fail('Запись не найдена.', 404);
        if (req.method === 'PUT') { const row = validate(collection, await body(), previous); store[collection] = store[collection].map(r => r.id === id ? row : r); save(); return json(res, row); }
        if (req.method === 'DELETE') {
          if (collection === 'complexes' && (store.apartments.some(a => a.complexId === id) || store.places.some(p => p.complexId === id))) fail('Сначала перенесите или удалите квартиры и места этого комплекса.');
          if (collection === 'contacts' && (store.apartments.some(a => a.hostId === id || a.managerId === id) || store.stays.some(s => s.managerId === id))) fail('Сначала измените назначения этого контакта в квартирах и карточках гостей.');
          if (collection === 'apartments' && store.stays.some(s => s.apartmentId === id)) fail('Сначала перенесите или удалите карточки гостей этой квартиры.');
          if (collection === 'apartments' && store.apartments.length === 1) fail('Оставьте хотя бы одну квартиру для демо.');
          store[collection] = store[collection].filter(r => r.id !== id); save(); return json(res, { ok: true });
        }
      }
      fail('Неизвестный запрос.', 404);
    }
    if (path.startsWith('/api/')) fail('Неизвестный запрос.', 404);
    if (!['GET', 'HEAD'].includes(req.method)) fail('Метод не поддерживается.', 405);
    let file = path === '/' || /^\/g\/[^/]+$/.test(path) ? 'index.html' : ['/admin', '/admin/'].includes(path) ? 'admin.html' : path.slice(1);
    file = decodeURIComponent(file); const full = resolve(root, 'public', file);
    if (!full.startsWith(resolve(root, 'public') + '\\') && !full.startsWith(resolve(root, 'public') + '/')) fail('Не найдено.', 404);
    if (!existsSync(full)) fail('Не найдено.', 404);
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': mime[extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : readFileSync(full));
  } catch (error) { if (!res.headersSent) json(res, { error: error.status ? error.message : 'Ошибка сервера. Попробуйте ещё раз.' }, error.status || 500); else res.end(); }
}
const server = http.createServer((req, res) => { void handle(req, res); });
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  server.listen(port, host, () => { console.log(`Stay Property demo: http://localhost:${port}\nAdmin: http://localhost:${port}/admin\nTelegram: ${telegramEnabled ? 'configured' : 'not configured — leads are saved locally'}`); void drain(); });
  setInterval(() => void drain(), 30000).unref();
}
export { server, backend, signSession, readSession };
export default server;
