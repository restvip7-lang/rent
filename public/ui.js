export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const paths = {
  wifi: '<path d="M3 8a15 15 0 0 1 18 0M6 12a10 10 0 0 1 12 0M9 16a5 5 0 0 1 6 0"/><circle cx="12" cy="20" r=".5"/>',
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  home: '<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
  person: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-3a8 8 0 0 1 16 0v3"/>',
  arrow: '<path d="m9 5 7 7-7 7"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  phone: '<path d="M5 3h4l2 5-3 2a15 15 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2C10 21 3 14 3 5a2 2 0 0 1 2-2Z"/>',
  chat: '<path d="M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 0 1 19 0Z"/><path d="M7 10h10M7 14h6"/>',
  document: '<path d="M14 2H5v20h14V7Z"/><path d="M14 2v5h5M8 12h8M8 16h6"/>',
  rules: '<path d="M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1"/>',
  exit: '<path d="M10 3H3v18h7M10 12h11m-4-4 4 4-4 4"/>',
  headset: '<path d="M4 13v-3a8 8 0 0 1 16 0v8a4 4 0 0 1-4 4h-3"/><rect x="2" y="11" width="5" height="8" rx="2"/><rect x="17" y="11" width="5" height="8" rx="2"/>',
  shop: '<path d="M2 3h3l3 13h11l3-10H6M9 21h.01M18 21h.01"/>',
  market: '<path d="M3 10V6l2-4h14l2 4v4M3 10h18M5 10v12h14V10M9 22v-8h6v8"/>',
  health: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6Z"/>',
  beach: '<path d="M3 20h18M12 17V3M4 10c0-10 16-10 16 0-4-2-12-2-16 0ZM15 20l2-5h3"/>',
  food: '<path d="M4 2v6c0 4 6 4 6 0V2M7 2v20M20 2v20M20 2c-5 2-5 12 0 12"/>',
  shield: '<path d="m12 2 9 4v6c0 6-9 10-9 10S3 18 3 12V6Z"/><path d="m8 12 3 3 5-6"/>',
  check: '<path d="m5 12 4 4L20 5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  plus: '<path d="M12 3v18M3 12h18"/>',
  qr: '<path d="M3 3h6v6H3ZM15 3h6v6h-6ZM3 15h6v6H3ZM15 15h2v2h-2ZM19 17h2v4h-4v-2h-2"/>',
  settings: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  building: '<path d="M4 22V3h11v19M15 9h5v13M8 7h3M8 11h3M8 15h3M8 19h3"/>',
  edit: '<path d="m4 16 12-12 4 4L8 20H4ZM14 6l4 4"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 16h12l1-16M10 10v8M14 10v8"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M3 16v5h18v-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1 1M18 18l1 1M5 19l1-1M18 6l1-1"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 5 10 8L22 5"/>',
  other: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 17h.01"/>'
};
export const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.other}</svg>`;
export function toast(message) { const el = document.getElementById('toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(globalThis.toastTimer); globalThis.toastTimer = setTimeout(() => el.classList.remove('visible'), 3500); }
export async function api(path, options = {}) { const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); const result = await response.json(); if (!response.ok) { const error = new Error(result.error || 'Ошибка запроса.'); error.status = response.status; throw error; } return result; }
export function modal(content, title = '') {
  document.getElementById('modal')?.remove(); const previous = document.activeElement;
  const el = document.createElement('dialog'); el.id = 'modal'; el.className = 'modal'; el.innerHTML = `<button class="modal-close icon-button" aria-label="Закрыть">${icon('close')}</button>${title ? `<h2>${esc(title)}</h2>` : ''}${content}`; document.body.append(el);
  el.querySelector('.modal-close').onclick = () => el.close(); el.addEventListener('click', event => { if (event.target === el) { const r = el.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) el.close(); } });
  el.addEventListener('close', () => { el.remove(); previous?.focus(); }); el.showModal(); return el;
}
