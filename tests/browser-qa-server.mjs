// Isolated browser verification: no working data and no external notifications.
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:3001';
process.env.DATA_DIR = mkdtempSync(join(process.cwd(), 'data', 'browser-qa-'));
process.env.ADMIN_PASSWORD = 'BrowserTestOnly!';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;
delete process.env.AI_GATEWAY_API_KEY;
delete process.env.AI_GATEWAY_MODEL;
const { server } = await import('../server.mjs');
server.listen(3001, '127.0.0.1', () => console.log('Isolated browser QA: http://127.0.0.1:3001'));
