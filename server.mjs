import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';
import { seed } from './seed.mjs';
import { createAssistant } from './assistant-service.mjs';

const root = dirname(fileURLToPath(import.meta.url));
if (process.env.NODE_ENV !== 'test' && existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
if (!local && (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD === 'StayDemo2026!')) throw new Error('Set a unique ADMIN_PASSWORD before listening outside localhost.');
const baseUrl = (process.env.PUBLIC_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : `http://localhost:${port}`)).replace(/\/$/, '');
const dataDir = resolve(process.env.DATA_DIR || resolve(root, 'data'));
mkdirSync(dataDir, { recursive: true });
const dataPath = resolve(dataDir, 'store.json');
let store = existsSync(dataPath) ? JSON.parse(readFileSync(dataPath, 'utf8')) : structuredClone(seed);
store.stays ||= [];
store.placeDrafts ||= {};
function save() { writeFileSync(dataPath + '.tmp', JSON.stringify(store, null, 2)); renameSync(dataPath + '.tmp', dataPath); }
save();
const assistant = createAssistant({ getStore: () => store, save, dataDir });
const sessions = new Map();
const limits = new Map();
const passwordHash = scryptSync(process.env.ADMIN_PASSWORD || 'StayDemo2026!', 'stay-admin-v1', 64);
const username = process.env.ADMIN_USER || 'admin';
const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
const telegramEnabled = Boolean(token && chat);
const allowedOrigin = new URL(baseUrl).origin;
const clean = (value, max = 300) => String(value ?? '').trim().slice(0, max);
function fail(message, status = 400) { const e = new Error(message); e.status = status; throw e; }
function rate(ip, name, max, window = 60000) {
  const key = `${ip}:${name}`; const now = Date.now(); const entry = limits.get(key);
  const bucket = entry && entry.until > now ? entry : { count: 0, until: now + window };
  if (++bucket.count > max) fail('Слишком много запросов. Попробуйте немного позже.', 429);
  limits.set(key, bucket);
}
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
  const id = /(?:^|;\s*)stay_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const record = sessions.get(id);
  if (!record || record.expires < Date.now()) { if (id) sessions.delete(id); fail('Войдите в панель управления.', 401); }
  return record;
}
async function body(req) {
  let value = ''; for await (const part of req) { value += part; if (value.length > 65536) fail('Слишком большой запрос.', 413); }
  try { const result = JSON.parse(value || '{}'); if (!result || typeof result !== 'object' || Array.isArray(result)) fail('Некорректный запрос.'); return result; } catch { fail('Некорректный JSON.'); }
}
function json(res, value, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
export async function deliverLead(lead, options = {}) {
  if (lead.telegramStatus === 'sent' || lead.telegramStatus === 'sending') return;
  const botToken = options.token || token; const chatId = options.chat || chat;
  if (!botToken || !chatId) { lead.telegramStatus = 'not_configured'; save(); return; }
  delete lead.retryAt; lead.telegramStatus = 'sending'; lead.attempts = (lead.attempts || 0) + 1; save();
  try {
    const text = [lead.type === 'service' ? '🏠 Обращение гостя' : '🏡 Заявка на подбор квартиры', `ID: ${lead.id}`, `Имя: ${lead.name}`, `Контакт: ${lead.contact}`, `Квартира: ${lead.apartmentName}`, `Комплекс: ${lead.complexName}`, `Район: ${lead.district}`, `Менеджер: ${lead.managerName || 'Не назначен'}`, `Цель: ${lead.goal || '—'}`, `Бюджет: ${lead.budget || 'Не указан'}`, `Сообщение: ${lead.message || '—'}`, `Источник: ${lead.source}`, `Дата: ${lead.createdAt}`, `Согласие: ${lead.consent ? 'да' : 'нет'}`].join('\n');
    const response = await (options.fetch || fetch)(`https://api.telegram.org/bot${botToken}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok || !result.ok) { lead.retryAt = Date.now() + Math.max(60, Number(result.parameters?.retry_after) || 0) * 1000; throw new Error('delivery'); }
    lead.telegramStatus = 'sent'; lead.telegramMessageId = result.result.message_id; lead.telegramError = ''; lead.sentAt = new Date().toISOString();
  } catch { lead.telegramStatus = 'failed'; lead.telegramError = 'Telegram не подтвердил доставку. Проверьте настройки бота и чата.'; lead.retryAt ||= Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(lead.attempts, 5)); }
  save();
}
for (const lead of store.leads) if (lead.telegramStatus === 'sending') { lead.telegramStatus = 'failed'; lead.retryAt = Date.now(); }
save();
let draining = false;
async function drain() {
  if (draining || !telegramEnabled) return; draining = true;
  try { for (const lead of store.leads.filter(l => ['pending', 'not_configured', 'failed'].includes(l.telegramStatus) && (!l.retryAt || l.retryAt <= Date.now())).slice(0, 10)) await deliverLead(lead); } finally { draining = false; }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' https: data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const url = new URL(req.url, `http://${req.headers.host}`); const path = url.pathname; const ip = req.socket.remoteAddress;
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && ![allowedOrigin, `http://127.0.0.1:${port}`].includes(req.headers.origin)) fail('Недопустимый источник запроса.', 403);
    if (path === '/api/health') return json(res, { ok: true });
    if (path === '/api/guest' && req.method === 'GET') {
      const { apartment, stay } = resolveGuest(url.searchParams.get('token'));
      return json(res, guest(apartment, stay));
    }
    if (path === '/api/leads' && req.method === 'POST') {
      rate(ip, 'lead', 6, 600000); const input = await body(req);
      if (input.website) fail('Не удалось отправить заявку.');
      const { apartment, stay } = resolveGuest(input.token);
      const name = clean(input.name, 100); const contact = clean(input.contact, 100);
      if (name.length < 2) fail('Укажите ваше имя.');
      if (!/^(?:\+?[\d\s()\-]{7,30}|@[A-Za-z][A-Za-z0-9_]{4,31})$/.test(contact)) fail('Укажите телефон или Telegram в формате @username.');
      if (input.consent !== true) fail('Подтвердите согласие на обработку данных и связь по заявке.');
      const type = input.type === 'service' ? 'service' : 'sales'; const complex = store.complexes.find(c => c.id === apartment.complexId);
      const lead = { id: randomUUID(), type, name, contact, goal: clean(input.goal, 100), budget: clean(input.budget, 100), message: clean(input.message, 2000), consent: true, consentVersion: '2026-10-demo-v1', apartmentId: apartment.id, stayId: stay?.id || '', guestName: stay?.name || '', apartmentName: apartment.name, complexName: complex.name, district: complex.district, managerName: store.contacts.find(c => c.id === (stay?.managerId || apartment.managerId || apartment.hostId))?.name || '', source: type === 'sales' ? store.banner.title : 'Помощь по проживанию', createdAt: new Date().toISOString(), status: 'new', telegramStatus: telegramEnabled ? 'pending' : 'not_configured', attempts: 0 };
      if (type === 'service' && !lead.message) fail('Опишите ваш вопрос.');
      store.leads.unshift(lead); save(); void drain(); return json(res, { ok: true, id: lead.id }, 201);
    }
    if (path === '/api/admin/login' && req.method === 'POST') {
      rate(ip, 'login', 10, 600000); const input = await body(req);
      const hash = scryptSync(clean(input.password, 500), 'stay-admin-v1', 64);
      if (clean(input.username) !== username || !timingSafeEqual(hash, passwordHash)) fail('Неверный логин или пароль.', 401);
      const id = randomBytes(32).toString('hex'); const csrf = randomBytes(24).toString('hex'); sessions.set(id, { csrf, expires: Date.now() + 8 * 3600000 });
      res.setHeader('Set-Cookie', `stay_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${allowedOrigin.startsWith('https:') ? '; Secure' : ''}`); return json(res, { ok: true, csrf });
    }
    if (path.startsWith('/api/admin/')) {
      const auth = session(req);
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== auth.csrf) fail('Обновите страницу и повторите действие.', 403);
      if (path === '/api/admin/data' && req.method === 'GET') return json(res, { ...store, csrf: auth.csrf, settings: { baseUrl, telegramEnabled, crmEnabled: false, assistant: assistant.settings() } });
      if (path.startsWith('/api/admin/assistant/') && req.method === 'POST') {
        const action = path.slice('/api/admin/assistant/'.length);
        const actions = { geocode: input => assistant.geocode(input.query), search: assistant.search, enhance: assistant.enhance, publish: assistant.publish, 'templates/preview': assistant.templatePreview, 'templates/apply': assistant.applyTemplates };
        if (!actions[action]) fail('Неизвестный запрос.', 404);
        rate(ip, `assistant:${action}`, action === 'enhance' ? 3 : 15);
        return json(res, await actions[action](await body(req)));
      }
      if (path === '/api/admin/logout' && req.method === 'POST') { const id = /stay_session=([^;]+)/.exec(req.headers.cookie || '')?.[1]; sessions.delete(id); res.setHeader('Set-Cookie', 'stay_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, { ok: true }); }
      if (path === '/api/admin/banner' && req.method === 'PUT') { store.banner = validate('banner', await body(req)); save(); return json(res, { ok: true }); }
      const qr = /^\/api\/admin\/(qr|stay-qr)\/([^/]+)$/.exec(path);
      if (qr && req.method === 'GET') {
        const a = store[qr[1] === 'qr' ? 'apartments' : 'stays'].find(a => a.id === qr[2]); if (!a) fail('Запись не найдена.', 404);
        const svg = await QRCode.toString(`${baseUrl}/g/${a.token}`, { type: 'svg', margin: 3, width: 600, errorCorrectionLevel: 'M' });
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }); return res.end(svg);
      }
      const leadRoute = /^\/api\/admin\/leads\/([^/]+)(?:\/(retry))?$/.exec(path);
      if (leadRoute) {
        const lead = store.leads.find(l => l.id === leadRoute[1]); if (!lead) fail('Заявка не найдена.', 404);
        if (req.method === 'POST' && leadRoute[2]) { if (!telegramEnabled) fail('Сначала подключите Telegram в .env.'); if (lead.telegramStatus === 'sending') fail('Отправка уже выполняется.', 409); delete lead.retryAt; await deliverLead(lead); return json(res, { ok: lead.telegramStatus === 'sent', status: lead.telegramStatus }); }
        if (req.method === 'PATCH') { const input = await body(req); if (!['new', 'in_progress', 'done'].includes(input.status)) fail('Неверный статус.'); lead.status = input.status; save(); return json(res, { ok: true }); }
        if (req.method === 'DELETE') { store.leads = store.leads.filter(l => l.id !== lead.id); save(); return json(res, { ok: true }); }
      }
      const route = /^\/api\/admin\/(apartments|complexes|contacts|places|stays)(?:\/([^/]+))?$/.exec(path);
      if (route) {
        const [, collection, id] = route; const previous = store[collection].find(r => r.id === id);
        if (req.method === 'POST' && !id) { const row = validate(collection, await body(req)); store[collection].push(row); save(); return json(res, row, 201); }
        if (!previous) fail('Запись не найдена.', 404);
        if (req.method === 'PUT') { const row = validate(collection, await body(req), previous); store[collection] = store[collection].map(r => r.id === id ? row : r); save(); return json(res, row); }
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
});
if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  server.listen(port, host, () => { console.log(`Stay Property demo: http://localhost:${port}\nAdmin: http://localhost:${port}/admin\nTelegram: ${telegramEnabled ? 'configured' : 'not configured — leads are saved locally'}`); void drain(); });
  setInterval(() => { void drain(); const now = Date.now(); for (const [key, value] of limits) if (value.until < now) limits.delete(key); for (const [key, value] of sessions) if (value.expires < now) sessions.delete(key); }, 30000).unref();
}
export { server };
