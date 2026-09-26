/*
 * Ping Point — общий слой данных и элементы интерфейса.
 * Подключается на главной (index.html), в кабинете игрока (cabinet.html) и в админке (admin.html).
 *
 * ДЕМО-РЕЖИМ. Все данные живут в браузере: localStorage (если он недоступен — в памяти вкладки).
 * Для боевой версии асинхронные методы CommunityAPI / BookingAPI / AdminAPI заменяются
 * запросами к серверу; имена методов, аргументы и формат ответов остаются прежними,
 * поэтому страницы переписывать не придётся.
 *
 * Нужные серверные эндпоинты:
 *   Авторизация
 *     POST   /api/auth/code                 {phone}                 отправить СМС-код
 *     POST   /api/auth/register             {phone, code, name}     создать игрока, выдать сессию (httpOnly cookie)
 *     POST   /api/auth/login                {phone, code}
 *     POST   /api/auth/logout
 *     GET    /api/me   PATCH /api/me                                  профиль
 *     POST   /api/me/photo                  multipart               фото (сервер режет в квадрат и сжимает)
 *   Сообщество «Найди партнёра»
 *     GET    /api/posts?level=&format=&time=&q=&sort=               лента (без контактов авторов)
 *     POST   /api/posts   PATCH /api/posts/:id   DELETE /api/posts/:id
 *     POST   /api/posts/:id/close                                   «Партнёр найден»
 *     POST   /api/posts/:id/responses       {message, when}         отклик
 *     POST   /api/posts/:id/report          {reason}                жалоба
 *     GET    /api/responses/my   GET /api/responses/incoming
 *     POST   /api/responses/:id/accept | /decline | /played
 *     GET    /api/notifications/unread
 *   Бронирование и оплата
 *     GET    /api/availability?date=YYYY-MM-DD                      занятость по получасам
 *     POST   /api/promo/check               {code, amount}
 *     POST   /api/bookings                  {date,start,dur,players,rackets,promo,name,phone}  → pending, держим 15 мин
 *     POST   /api/bookings/:id/payments     {method}                сервер создаёт платёж в ЮKassa, отдаёт confirmation_url / данные для виджета
 *     POST   /api/yookassa/webhook                                  payment.succeeded / payment.canceled / refund.succeeded
 *     GET    /api/bookings/my   POST /api/bookings/:id/cancel
 *   Админка
 *     POST   /api/admin/login   GET /api/admin/dashboard
 *     GET    /api/admin/bookings?date=&status=&q=   PATCH /api/admin/bookings/:id   POST /api/admin/bookings
 *     POST   /api/admin/bookings/:id/refund | /noshow | /move
 *     GET/POST/DELETE /api/admin/blocks     GET /api/admin/payments?from=&to=   GET /api/admin/payments.csv
 *     GET    /api/admin/clients   GET /api/admin/clients/:phone
 *     GET    /api/admin/posts   POST /api/admin/posts/:id/hide | /unhide   DELETE /api/admin/posts/:id
 *     GET    /api/admin/reports   POST /api/admin/reports/:id/resolve
 *     GET/PUT /api/admin/settings   GET/POST/PATCH /api/admin/promos
 *
 * Схема боевой оплаты (ЮKassa):
 *   1. Клиент создаёт бронь → сервер ставит слот в статус pending на 15 минут.
 *   2. Сервер создаёт платёж через API ЮKassa (shopId и секретный ключ хранятся ТОЛЬКО на сервере,
 *      Idempotence-Key = id брони), передаёт в receipt данные для чека по 54-ФЗ (услуга «Аренда стола»,
 *      НДС по режиму ИП, телефон клиента) и отдаёт браузеру confirmation_url или токен виджета.
 *   3. Факт оплаты сервер узнаёт только из вебхука payment.succeeded (проверка IP/подписи и повторный
 *      GET /v3/payments/{id}), после чего бронь → paid, генерируется код доступа (его выдаёт контроллер замка).
 *   4. Не оплачено за 15 минут → бронь expired, платёж отменяется, слот освобождается.
 *   5. Отмена клиентом не позже чем за 3 часа или админом → POST /v3/refunds (чек возврата формирует ЮKassa),
 *      по вебхуку refund.succeeded бронь → refunded.
 *
 * Сид-данные (игроки сообщества, история броней за ~60 дней, клиенты) — ДЕМО, генерируются один раз
 * детерминированно. Аватары демо-игроков — нарисованные SVG, не фотографии людей.
 */
(function (global) {
'use strict';

/* =====================================================================
   Справочники
   ===================================================================== */
const LEVELS = [['novice', 'Новичок'], ['amateur', 'Любитель'], ['confident', 'Уверенный'], ['pro', 'Разрядник']];
const LEVEL_COLOR = { novice: '#3dffa8', amateur: '#37d5ff', confident: '#8f9bff', pro: '#ffb938' };
const FORMATS = [
  ['once', 'Партнёр на разовую игру', 'Разовая игра'],
  ['regular', 'Регулярный партнёр', 'Регулярно'],
  ['double', 'Компания 2×2', 'Пара на пару'],
  ['sparring', 'Спарринг перед турниром', 'Спарринг']
];
const TIMES = [['morning', 'Утро', '10:00–13:00'], ['day', 'День', '13:00–17:00'], ['evening', 'Вечер', '17:00–20:30']];
const HANDS = [['right', 'Правая'], ['left', 'Левая']];
const STYLES = [['attack', 'Атакующий'], ['defense', 'Защитный'], ['universal', 'Универсальный']];
const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const DAY_LONG = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const MONTH_G = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTH_S = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const BOOKING_STATUS = {
  pending: 'Ожидает оплаты', paid: 'Оплачено', expired: 'Не оплачено вовремя',
  cancelled: 'Отменено', refunded: 'Возврат 100%', refund_partial: 'Отмена, частичный возврат', noshow: 'Не пришёл'
};
const PAYMENT_STATUS = { pending: 'Ожидает', succeeded: 'Оплачен', failed: 'Отказ', canceled: 'Отменён', refunded: 'Возвращён', partially_refunded: 'Частичный возврат' };
const PAY_METHOD = { card: 'Карта', sbp: 'СБП', cash: 'Наличные', terminal: 'Карта на месте' };
const DEMO_CODE = '1234';
const ADMIN_LOGIN = 'admin', ADMIN_PASS = 'pingpoint'; // демо-доступ, в боевой версии — учётки на сервере
const DEFAULT_SETTINGS = {
  open: 600, close: 1230, border: 780, priceAm: 400, pricePm: 500, racket: 100,
  minLeadMin: 60, cancelHours: 3, holdMin: 15, maxPlayers: 4,
  rules: [
    'Бронь минимум за 1 час до начала игры',
    'Отмена не позднее чем за 3 часа — возврат 100%',
    'Дети до 14 лет — только вместе со взрослым',
    'Сменная или не скользящая обувь',
    'Без еды и алкоголя, вода из кулера — можно'
  ]
};

/* =====================================================================
   Реестр документов (152-ФЗ) — ЕДИНСТВЕННОЕ место, где заводится новая редакция.
   Новая версия документа = поменять version и date в его строке (и сам файл в docs/).
   Кто подтверждал старую редакцию, при входе увидит окно «Документ обновлён»,
   а связанная функция будет заблокирована до повторного подтверждения.
   for — для каких действий документ обязателен.
   ===================================================================== */
const DOCS = [
  { id: 'policy',          file: 'docs/politika.html',                 version: '1.0', date: '2026-09-26', kind: 'ack',     revocable: false, for: ['registration', 'booking'], title: 'Политика обработки персональных данных', check: 'Ознакомлен(а) с {Политикой обработки персональных данных}' },
  { id: 'consent_pd',      file: 'docs/soglasie-pd.html',              version: '1.0', date: '2026-09-26', kind: 'consent', revocable: true,  for: ['registration', 'booking'], title: 'Согласие на обработку персональных данных', check: 'Даю {согласие на обработку персональных данных}' },
  { id: 'consent_public',  file: 'docs/soglasie-rasprostranenie.html', version: '1.0', date: '2026-09-26', kind: 'consent', revocable: true,  for: ['post'],                    title: 'Согласие на распространение персональных данных', check: 'Даю {согласие на распространение} моих данных в объявлениях — на условиях, отмеченных ниже' },
  { id: 'community_rules', file: 'docs/pravila-soobshchestva.html',    version: '1.0', date: '2026-09-26', kind: 'accept',  revocable: false, for: ['registration'],            title: 'Правила сообщества «Найди партнёра»', check: 'Принимаю {Правила сообщества}' },
  { id: 'offer',           file: 'docs/oferta.html',                   version: '2.0', date: '2026-09-26', kind: 'accept',  revocable: false, for: ['booking'],                 title: 'Публичная оферта и Правила посещения', check: 'Ознакомлен(а) с {Публичной офертой и Правилами посещения}' },
  { id: 'cookies',         file: 'docs/cookies.html',                  version: '1.0', date: '2026-09-26', kind: 'ack',     revocable: false, for: ['cookie_banner'],           title: 'Политика использования cookie', check: 'Ознакомлен(а) с {Политикой cookie}' }
];
const REG_DOCS = ['consent_pd', 'community_rules', 'policy'];
const BOOKING_DOCS = ['consent_pd', 'policy']; // для гостя без кабинета; оферта — при каждой брони
const OFFER_URL = 'docs/oferta.html';
const CONSENT_ACTION = { accepted: 'Подтверждено', revoked: 'Отозвано', conditions_changed: 'Изменены условия' };
const CONSENT_CONTEXT = { registration: 'Регистрация', booking: 'Бронирование', post: 'Объявление', reply: 'Отклик', cookie_banner: 'Cookie-баннер', doc_update: 'Обновление документа', cabinet: 'Кабинет' };
const REQUEST_TYPES = {
  stop_distribution: { title: 'Прекращение распространения', days: 3, business: true },
  access: { title: 'Запрос сведений об обработке', days: 10, business: true },
  revoke_pd: { title: 'Отзыв согласия — уничтожение данных', days: 30, business: false },
  delete: { title: 'Удаление профиля', days: 30, business: false }
};
const PUBLIC_COND_DEFAULT = { photo: true, age: true, prefs: true };

/* =====================================================================
   Утилиты
   ===================================================================== */
const pad2 = n => (n < 10 ? '0' : '') + n;
const hhmm = m => pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
const ymd = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const parseYmd = s => { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const dayIdx = d => (d.getDay() + 6) % 7;
const tsAt = (ds, min) => { const d = parseYmd(ds); d.setMinutes(min); return d.getTime(); };
const today = () => ymd(new Date());
const clone = o => JSON.parse(JSON.stringify(o));
const wait = (ms) => new Promise(r => setTimeout(r, ms == null ? 120 : ms));
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function plural(n, a, b, c) { n = Math.abs(n) % 100; const n1 = n % 10; if (n > 10 && n < 20) return c; if (n1 > 1 && n1 < 5) return b; if (n1 === 1) return a; return c; }
function money(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' ₽'; }
function normPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
  return d.length === 10 ? '7' + d : null;
}
function fmtPhone(p) { if (!p) return ''; const d = String(p).replace(/\D/g, '').slice(-10); return '+7 ' + d.slice(0, 3) + ' ' + d.slice(3, 6) + '-' + d.slice(6, 8) + '-' + d.slice(8, 10); }
function hash(str) { let h = 2166136261; str = String(str); for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function uid(p) { return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function label(list, key) { const r = list.find(x => x[0] === key); return r ? r[1] : ''; }
function dateLabel(ds) {
  const d = parseYmd(ds), t = parseYmd(today());
  const diff = Math.round((d - t) / 864e5);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  if (diff === -1) return 'Вчера';
  return DAY_SHORT[dayIdx(d)] + ', ' + d.getDate() + ' ' + MONTH_S[d.getMonth()];
}
function dateLong(ds) { const d = parseYmd(ds); return d.getDate() + ' ' + MONTH_G[d.getMonth()] + ', ' + DAY_LONG[dayIdx(d)]; }
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'только что';
  const m = Math.floor(s / 60); if (m < 60) return m + ' ' + plural(m, 'минуту', 'минуты', 'минут') + ' назад';
  const h = Math.floor(m / 60); if (h < 24) return h + ' ' + plural(h, 'час', 'часа', 'часов') + ' назад';
  const d = Math.floor(h / 24); if (d === 1) return 'вчера';
  if (d < 7) return d + ' ' + plural(d, 'день', 'дня', 'дней') + ' назад';
  const dt = new Date(ts); return dt.getDate() + ' ' + MONTH_G[dt.getMonth()];
}
function goal(name) { try { if (global.ym) global.ym(104197137, 'reachGoal', name); } catch (e) {} }
/* Яндекс Метрика грузится ТОЛЬКО после согласия на аналитические cookie (баннер или «Настройки cookie»).
   До этого window.ym не существует и цели просто не отправляются. */
let ymLoaded = false;
function loadMetrika() {
  if (ymLoaded || !global.document) return; ymLoaded = true;
  if (location.protocol === 'file:') return; // локальный просмотр макета — счётчик не подключаем
  (function (m, e, t, r, i, k, a) { m[i] = m[i] || function () { (m[i].a = m[i].a || []).push(arguments); }; m[i].l = 1 * new Date(); k = e.createElement(t); a = e.getElementsByTagName(t)[0]; k.async = 1; k.src = r; a.parentNode.insertBefore(k, a); })(global, document, 'script', 'https://mc.yandex.ru/metrika/tag.js', 'ym');
  global.ym(104197137, 'init', { clickmap: true, trackLinks: true, accurateTrackBounce: true, webvisor: true });
}

/* SHA-256 (синхронная реализация, чтобы хешировать и в сиде, и там, где нет crypto.subtle) */
const SHA_K = [], SHA_H = [];
(function () { let n = 2, c = 0; const isP = x => { for (let i = 2; i * i <= x; i++) if (x % i === 0) return false; return true; };
  while (c < 64) { if (isP(n)) { if (c < 8) SHA_H[c] = (Math.pow(n, 0.5) * 4294967296) | 0; SHA_K[c++] = (Math.pow(n, 1 / 3) * 4294967296) | 0; } n++; } })();
function sha256(str) {
  const bytes = new TextEncoder().encode(String(str)), l = bytes.length;
  const nW = (((l + 8) >> 6) + 1) * 16, words = new Array(nW).fill(0);
  for (let i = 0; i < l; i++) words[i >> 2] |= bytes[i] << ((3 - i % 4) * 8);
  words[l >> 2] |= 0x80 << ((3 - l % 4) * 8);
  words[nW - 2] = Math.floor(l * 8 / 4294967296); words[nW - 1] = (l * 8) | 0;
  let h = SHA_H.slice(); const w = new Array(64);
  for (let j = 0; j < nW; j += 16) {
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 64; i++) {
      if (i < 16) w[i] = words[j + i] | 0;
      else { const x = w[i - 15], y = w[i - 2]; w[i] = (w[i - 16] + ((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ (x >>> 3)) + w[i - 7] + ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ (y >>> 10))) | 0; }
      const t1 = (hh + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + ((e & f) ^ (~e & g)) + SHA_K[i] + w[i]) | 0;
      const t2 = (((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h = [(h[0] + a) | 0, (h[1] + b) | 0, (h[2] + c) | 0, (h[3] + d) | 0, (h[4] + e) | 0, (h[5] + f) | 0, (h[6] + g) | 0, (h[7] + hh) | 0];
  }
  return h.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
function addBusinessDays(ts, n) { // выходные пропускаем; праздники — по производственному календарю на сервере
  const d = new Date(ts); let k = 0;
  while (k < n) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) k++; }
  return d.getTime();
}
function verCmp(a, b) { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; }
const docById = id => DOCS.find(d => d.id === id);

class PPError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const QUOTA_MSG = 'Не хватает места в памяти браузера. Попробуйте фото поменьше или удалите старые объявления.';

/* =====================================================================
   Хранилище: localStorage с запасным вариантом в памяти
   ===================================================================== */
const KEY = 'pp_data_v1', SKEY = 'pp_session_v1', AKEY = 'pp_admin_v1', ANONKEY = 'pp_anon_v1', COOKIE_KEY = 'pp_cookie_v1';
const mem = Object.create(null);
let persistent = true;
try { const t = '__pp_probe'; localStorage.setItem(t, t); localStorage.removeItem(t); } catch (e) { persistent = false; }
function isQuota(e) { return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014); }
function sget(k) { if (persistent) { try { return localStorage.getItem(k); } catch (e) { persistent = false; } } return k in mem ? mem[k] : null; }
function sset(k, v) {
  if (persistent) {
    try { localStorage.setItem(k, v); return; } catch (e) { if (isQuota(e)) throw new PPError('QUOTA', QUOTA_MSG); persistent = false; }
  }
  mem[k] = v;
}
function sdel(k) { if (persistent) { try { localStorage.removeItem(k); return; } catch (e) { persistent = false; } } delete mem[k]; }

let cacheRaw = null, cacheDb = null;
function load() {
  const raw = sget(KEY);
  if (raw && raw === cacheRaw && cacheDb) return housekeeping(cacheDb);
  let db = null;
  if (raw) { try { db = JSON.parse(raw); } catch (e) { db = null; } }
  if (!db || db.v !== 1) { db = seed(); cacheDb = db; cacheRaw = null; persist(db, true); }
  cacheDb = db; cacheRaw = raw;
  return housekeeping(db);
}
function persist(db, quiet) {
  const raw = JSON.stringify(db);
  try { sset(KEY, raw); } catch (e) { cacheRaw = null; cacheDb = null; throw e; }
  cacheRaw = raw; cacheDb = db;
  if (!quiet) emit();
}
function mutate(fn) { const db = load(); const res = fn(db); persist(db); return res; }

let emitTimer = 0;
function emit() { clearTimeout(emitTimer); emitTimer = setTimeout(() => { global.dispatchEvent(new CustomEvent('pp:change')); scheduleSims(); }, 0); }
function notify(detail) { global.dispatchEvent(new CustomEvent('pp:notify', { detail: detail })); }
global.addEventListener('storage', e => {
  if (e.key === null || e.key === KEY || e.key === SKEY || e.key === AKEY) { cacheRaw = null; cacheDb = null; emit(); }
});

/* Служебное обслуживание данных при каждом чтении */
function housekeeping(db) {
  let changed = false;
  const now = Date.now();
  // демо-объявления «не стареют»: сдвигаем их даты вслед за временем
  if (now - db.seededAt > 6 * 3600e3) {
    const shift = now - db.seededAt;
    db.posts.forEach(p => { if (p.demo) p.createdAt += shift; });
    db.responses.forEach(r => { if (r.demo) r.createdAt += shift; });
    db.seededAt = now; changed = true;
  }
  if (ensureDemoFuture(db)) changed = true;
  if (sweepExpired(db, now)) changed = true;
  // срок «можно передумать» истёк — уничтожаем данные профиля (журнал согласий хранится отдельно по закону)
  Object.keys(db.users).forEach(k => {
    const u = db.users[k];
    if (u.deletion && u.deletion.until < now) {
      db.posts = db.posts.filter(p => p.authorId !== u.id);
      db.responses = db.responses.filter(r => r.fromId !== u.id && r.toId !== u.id);
      db.requests.forEach(q => { if (q.subjectId === u.id && q.status === 'new' && (q.type === 'revoke_pd' || q.type === 'delete')) { q.status = 'done'; q.doneAt = now; q.note = (q.note ? q.note + '. ' : '') + 'Данные уничтожены автоматически'; } });
      delete db.users[k];
      if (sget(SKEY) === k) sdel(SKEY);
      changed = true;
    }
  });
  // демо-игроки «подтверждают» новые редакции сами, чтобы демо-лента не пустела при обновлении документа
  Object.keys(db.users).forEach(k => {
    const u = db.users[k]; if (!u.demo) return;
    outdatedDocs(u).forEach(d => { db.consents.push(consentEntry({ subjectId: u.id, name: u.name, phone: u.phone, docId: d.id, action: 'accepted', conditions: d.id === 'consent_public' ? publicCond(u) : null, context: 'doc_update' })); setUserConsent(u, d.id, now, d.id === 'consent_public' ? publicCond(u) : null); changed = true; });
  });
  if (changed) { try { persist(db, true); } catch (e) {} }
  return db;
}
function sweepExpired(db, now) {
  let ch = false;
  db.bookings.forEach(b => {
    if (b.status === 'pending' && b.expiresAt && b.expiresAt < now) {
      b.status = 'expired'; b.history.push({ at: b.expiresAt, s: 'expired', by: 'system', note: 'Не оплачено за ' + db.settings.holdMin + ' минут, слот освобождён' });
      db.payments.forEach(p => { if (p.bookingId === b.id && p.status === 'pending') p.status = 'canceled'; });
      ch = true;
    }
  });
  return ch;
}

/* =====================================================================
   Демо-данные
   ===================================================================== */
// ДЕМО: игроки сообщества. Телефоны и ники — заведомо несуществующие, аватары рисуются в SVG.
const SEED_USERS = [
  { id: 'd1', g: 'm', name: 'Алексей', age: 34, level: 'confident', hand: 'right', style: 'attack', tg: 'alexey_pp_demo', about: 'Играл за институт, сейчас возвращаю форму. Люблю длинные розыгрыши.', pitch: 'Привет! Как раз ищу, с кем поиграть в это время. Уровень примерно такой же — давай попробуем? Стол пополам.' },
  { id: 'd2', g: 'f', name: 'Марина', age: 27, level: 'amateur', hand: 'right', style: 'universal', tg: 'marina_pp_demo', about: 'Играю для настроения. Счёт веду, но не обижаюсь.', pitch: 'Добрый день! Могу подойти, ракетку возьму на месте. Если время подходит — договоримся.' },
  { id: 'd3', g: 'm', name: 'Игорь', age: 46, level: 'pro', hand: 'left', style: 'attack', tg: 'igor_pp_demo', about: 'КМС в прошлом, готовлюсь к турнирам ветеранов.', pitch: 'Здравствуйте! Готов сыграть, могу показать пару упражнений на подачу.' },
  { id: 'd4', g: 'f', name: 'Даша', age: 21, level: 'novice', hand: 'right', style: 'universal', tg: 'dasha_pp_demo', about: 'Начинаю, учусь не бояться быстрых мячей.', pitch: 'Привет! Я новичок, но очень хочу играть регулярно. Если не против — давай встретимся.' },
  { id: 'd5', g: 'm', name: 'Сергей', age: 38, level: 'amateur', hand: 'right', style: 'defense', tg: 'sergey_pp_demo', about: 'Защитник, режу всё, что летит.', pitch: 'Привет! Подходит, могу в это время. Играю спокойно, без нервов.' },
  { id: 'd6', g: 'm', name: 'Никита', age: 19, level: 'confident', hand: 'right', style: 'attack', tg: 'nikita_pp_demo', about: 'Студент, топспин с обеих сторон.', pitch: 'Привет! Могу после пар. Играю атакующе — будет весело.' },
  { id: 'd7', g: 'f', name: 'Ольга', age: 52, level: 'amateur', hand: 'right', style: 'defense', tg: 'olga_pp_demo', about: 'Играла в школе, теперь — для здоровья.', pitch: 'Здравствуйте! С удовольствием составлю компанию, время подходит.' },
  { id: 'd8', g: 'm', name: 'Тимур', age: null, level: 'novice', hand: 'left', style: 'universal', tg: 'timur_pp_demo', about: 'Недавно в Брянске.', pitch: 'Привет! Тоже ищу, с кем поиграть. Давай попробуем.' }
];
// ДЕМО: объявления брянских игроков
const SEED_POSTS = [
  { id: 'pd1', a: 'd1', format: 'regular', pl: 'confident', days: [1, 3], times: ['evening'], ago: 40, sr: 2, text: 'Хочу вернуть форму после долгого перерыва. Ищу постоянного соперника на вторник и четверг после работы — с длинными розыгрышами, а не «на вылет». Стол пополам.' },
  { id: 'pd2', a: 'd2', format: 'once', pl: 'any', days: [5], times: ['day'], ago: 150, sr: 1, text: 'В субботу днём хочу поиграть пару часов — подруга не смогла. Играю для себя, без фанатизма. Буду рада любому уровню.' },
  { id: 'pd3', a: 'd3', format: 'sparring', pl: 'confident', days: [0, 2, 4], times: ['morning'], ago: 300, sr: 3, text: 'Готовлюсь к областному турниру ветеранов. Нужен спарринг утром в будни: подачи, приём, игра на счёт. Подскажу по технике, если интересно.' },
  { id: 'pd4', a: 'd4', format: 'double', pl: 'novice', days: [5, 6], times: ['day', 'evening'], ago: 540, sr: 0, text: 'Нас двое, обе только начинаем. Ищем ещё пару таких же новичков для игры 2×2 в выходные — чтобы не стесняться промахов.' },
  { id: 'pd5', a: 'd5', format: 'double', pl: 'amateur', days: [4], times: ['evening'], ago: 1320, sr: 2, text: 'Играем с коллегой по пятницам вечером, хотим парные игры. Ищем двоих любителей на регулярную пятничную «пару на пару». Час-полтора, без напряга.' },
  { id: 'pd6', a: 'd6', format: 'once', pl: 'any', days: [0, 1, 2, 3, 4], times: ['day'], timeFrom: 840, ago: 1680, sr: 4, text: 'После пар свободен почти в любой будний день с 14:00. Играю атакующе, люблю топспин. Ищу того, кто не боится проиграть пару сетов.' },
  { id: 'pd7', a: 'd7', format: 'regular', pl: 'amateur', days: [1, 3], times: ['morning'], ago: 2820, sr: 1, text: 'Утром в будни свободна, хочу играть регулярно — для здоровья и настроения. Восстанавливаю навыки со школы. До 13:00 и час дешевле.' },
  { id: 'pd8', a: 'd8', format: 'once', pl: 'novice', days: [2, 4], times: ['evening'], ago: 4200, sr: 0, text: 'Недавно переехал в Брянск, ищу, с кем поиграть и просто познакомиться. Уровень — новичок. Среда или пятница вечером.' }
];
// ДЕМО: клиенты для истории броней
const CLIENT_NAMES = ['Андрей Ковалёв', 'Екатерина Соколова', 'Дмитрий Морозов', 'Анна Лебедева', 'Максим Новиков', 'Ирина Фёдорова', 'Павел Волков', 'Юлия Зайцева', 'Артём Павлов', 'Наталья Семёнова', 'Кирилл Голубев', 'Ольга Виноградова', 'Роман Богданов', 'Татьяна Воробьёва', 'Евгений Фролов', 'Светлана Никитина', 'Владимир Орлов', 'Мария Андреева', 'Илья Макаров', 'Алина Кузнецова', 'Денис Захаров', 'Ксения Борисова', 'Олег Королёв', 'Виктория Герасимова', 'Антон Пономарёв', 'Елена Григорьева', 'Глеб Титов', 'Полина Калинина', 'Степан Ершов', 'Дарья Жукова', 'Никита Белов', 'Валерия Тарасова', 'Григорий Комаров', 'Софья Киселёва', 'Михаил Ильин', 'Вероника Медведева', 'Константин Гусев', 'Анастасия Щербакова', 'Фёдор Сорокин', 'Любовь Мельникова'];

function seed() {
  const now = Date.now();
  const db = {
    v: 1, seededAt: now, seq: 24000, demoUntil: null,
    users: {}, posts: [], responses: [], reports: [], sims: [],
    bookings: [], payments: [], blocks: [],
    promos: [
      { code: 'PONG10', type: 'pct', value: 10, limit: 0, used: 0, active: true, note: 'Скидка 10% на любую бронь' },
      { code: 'FRIEND', type: 'rub', value: 100, limit: 0, used: 0, active: true, note: 'Минус 100 ₽ по приглашению друга' }
    ],
    settings: clone(DEFAULT_SETTINGS),
    demoClients: [], consents: [], requests: []
  };
  SEED_USERS.forEach((u, i) => {
    db.users[u.id] = Object.assign({ phone: '790000000' + pad2(i + 1), showPhone: true, photo: null, createdAt: now - (30 + i * 9) * 864e5, demo: true, ageGroup: 'adult', consents: {} }, u);
  });
  SEED_POSTS.forEach(p => {
    db.posts.push({ id: p.id, authorId: p.a, format: p.format, partnerLevel: p.pl, days: p.days, times: p.times, timeFrom: p.timeFrom || null, text: p.text, photo: null, createdAt: now - p.ago * 60e3, status: 'open', seedResponses: p.sr, demo: true });
  });
  // клиенты: первые 8 — постоянные, дальше реже
  const rnd = mulberry(20260926);
  db.demoClients = CLIENT_NAMES.map((n, i) => ({ name: n, phone: '7900' + String(1000000 + Math.floor(rnd() * 8999999)), w: i < 8 ? 7 : i < 20 ? 2.4 : 1 }));
  // одна техническая блокировка через 5 дней — чтобы было видно, как это выглядит
  const bd = ymd(addDays(new Date(), 5));
  db.blocks.push({ id: 'blk1', date: bd, start: 600, end: 720, reason: 'Техническое обслуживание стола', createdAt: now, demo: true });
  ensureDemoFuture(db, 60);
  seedConsents(db, now);
  return db;
}

/* ДЕМО: журнал согласий — регистрации игроков сообщества, согласия при бронях, пара отзывов и запросов */
const DEMO_UA = ['Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 YaBrowser/24.10 Safari/537.36', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'];
function seedConsents(db, now) {
  const rnd = mulberry(4242);
  const ua = () => DEMO_UA[Math.floor(rnd() * DEMO_UA.length)];
  const add = (o) => { db.consents.push(consentEntry(Object.assign({ ua: o.ua || ua() }, o))); };
  SEED_USERS.forEach(su => {
    const u = db.users[su.id], t = u.createdAt, agent = ua();
    REG_DOCS.forEach(id => { add({ subjectId: u.id, name: u.name, phone: u.phone, docId: id, action: 'accepted', context: 'registration', at: t, ua: agent }); setUserConsent(u, id, t); });
    const post = db.posts.find(p => p.authorId === u.id);
    const cond = su.id === 'd7' ? { photo: true, age: false, prefs: true } : clone(PUBLIC_COND_DEFAULT);
    const pt = post ? Math.min(post.createdAt, t + 864e5) : t + 864e5;
    add({ subjectId: u.id, name: u.name, phone: u.phone, docId: 'consent_public', action: 'accepted', conditions: cond, context: 'post', at: pt, ua: agent });
    setUserConsent(u, 'consent_public', pt, cond);
  });
  db.demoClients.forEach(c => {
    const first = db.bookings.filter(b => b.phone === c.phone && b.createdAt < now).sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!first) return;
    const agent = ua();
    BOOKING_DOCS.concat('offer').forEach(id => add({ subjectId: 'guest:' + first.id, name: c.name, phone: c.phone, docId: id, action: 'accepted', context: 'booking', at: first.createdAt, ua: agent }));
  });
  const req = (ci, type, daysAgo, status, note) => {
    const c = db.demoClients[ci]; if (!c) return;
    const at = now - daysAgo * 864e5;
    if (type === 'revoke_pd') add({ subjectId: 'phone:' + c.phone, name: c.name, phone: c.phone, docId: 'consent_pd', action: 'revoked', context: 'cabinet', at: at });
    db.requests.push(makeRequest({ subjectId: 'phone:' + c.phone, name: c.name, phone: c.phone, type: type, at: at, status: status, note: note, demo: true }));
  };
  req(11, 'revoke_pd', 35, 'new', 'Письмо на pingp-inf@bk.ru');
  req(19, 'access', 16, 'new', 'Просит сведения об обработке своих данных');
  req(5, 'revoke_pd', 2, 'new', 'Звонок администратору');
  req(30, 'access', 40, 'done', 'Ответ отправлен на e-mail');
}

/* Детерминированная генерация демо-броней на день (история + ближайшие 2 недели).
   Вечер и выходные — спрос выше. Итоговая загрузка ~25–40%. */
function genDay(db, ds, now) {
  const s = db.settings, rnd = mulberry(hash('pp-day-' + ds));
  const d = parseYmd(ds), we = dayIdx(d) >= 5;
  const dist = Math.round((d - parseYmd(ymd(new Date(now)))) / 864e5);
  const ahead = dist > 0 ? Math.max(0.1, 0.85 - dist * 0.06) : 1;
  const totalW = db.demoClients.reduce((a, c) => a + c.w, 0);
  const pickClient = () => { let r = rnd() * totalW; for (const c of db.demoClients) { r -= c.w; if (r <= 0) return c; } return db.demoClients[0]; };
  let m = s.open;
  while (m <= s.close - 60) {
    let p = m < 780 ? 0.1 : m < 1020 ? 0.14 : 0.3;
    if (we) p *= 1.55;
    p *= ahead;
    const busy = db.blocks.some(b => b.date === ds && m < b.end && m + 60 > b.start);
    if (!busy && rnd() < p) {
      const r = rnd();
      let dur = r < 0.5 ? 60 : r < 0.72 ? 90 : r < 0.95 ? 120 : 180;
      if (m + dur > s.close) dur = s.close - m;
      const c = pickClient();
      const start = tsAt(ds, m), end = start + dur * 60e3;
      let created = start - (2 + rnd() * 70) * 3600e3;
      if (created > now) created = now - rnd() * 48 * 3600e3;
      const players = [2, 2, 2, 2, 2, 4, 4, 4, 3, 1][Math.floor(rnd() * 10)];
      const rackets = rnd() < 0.12 ? 1 + Math.floor(rnd() * Math.min(2, players)) : 0;
      const pr = rnd(); const promo = pr < 0.06 ? 'PONG10' : pr < 0.09 ? 'FRIEND' : null;
      const q = quoteRaw(s, m, dur, rackets, promo ? db.promos.find(x => x.code === promo) : null);
      const b = {
        id: 'bk' + hash(ds + '-' + m).toString(36), number: 'PP-' + (++db.seq), userId: null, name: c.name, phone: c.phone,
        date: ds, start: m, dur: dur, players: players, rackets: rackets, promo: promo, discount: q.discount, amount: q.total,
        status: 'paid', code: String(100000 + Math.floor(rnd() * 900000)), createdAt: created, expiresAt: null,
        source: rnd() < 0.08 ? 'admin' : 'site', paymentId: null, demo: true,
        history: [{ at: created, s: 'pending', by: 'client' }]
      };
      const x = rnd();
      if (end < now) {
        if (x < 0.06) b.status = 'refunded';
        else if (x < 0.09) b.status = 'noshow';
        else if (x < 0.11) b.status = 'expired';
      } else if (x < 0.05) b.status = 'refunded';
      if (b.status === 'expired') {
        b.history.push({ at: created + 15 * 60e3, s: 'expired', by: 'system', note: 'Не оплачено вовремя' });
        b.code = null;
      } else {
        const method = b.source === 'admin' ? (rnd() < 0.6 ? 'cash' : 'terminal') : (rnd() < 0.72 ? 'card' : 'sbp');
        const pay = { id: 'pay' + hash('p' + b.id).toString(36), bookingId: b.id, amount: b.amount, method: method, status: 'succeeded', createdAt: created + 30e3, paidAt: created + 90e3, cardMask: method === 'card' ? '•• ' + String(1000 + Math.floor(rnd() * 8999)) : null, refundedAt: null, demo: true };
        b.paymentId = pay.id;
        b.history.push({ at: pay.paidAt, s: 'paid', by: 'payment', note: PAY_METHOD[method] });
        if (b.status === 'refunded') {
          const rAt = Math.min(now - 60e3, start - (4 + rnd() * 20) * 3600e3);
          pay.status = 'refunded'; pay.refunded = pay.amount; pay.refundedAt = Math.max(pay.paidAt + 60e3, rAt); b.refundAmount = b.amount;
          b.history.push({ at: pay.refundedAt, s: 'refunded', by: 'client', note: 'Отмена заранее, возврат 100%' });
        }
        if (b.status === 'noshow') b.history.push({ at: end + 600e3, s: 'noshow', by: 'admin' });
        if (promo && b.status !== 'expired') { const pp = db.promos.find(x2 => x2.code === promo); if (pp) pp.used++; }
        db.payments.push(pay);
      }
      db.bookings.push(b);
      m += dur;
      if (rnd() < 0.5) m += 30;
    } else m += 30;
  }
}
function ensureDemoFuture(db, backDays) {
  const now = Date.now(), t = parseYmd(ymd(new Date(now)));
  const target = ymd(addDays(t, 13));
  if (db.demoUntil && db.demoUntil >= target) return false;
  let from = db.demoUntil ? addDays(parseYmd(db.demoUntil), 1) : addDays(t, -(backDays || 60));
  const minFrom = addDays(t, -60); if (from < minFrom) from = minFrom;
  for (let d = from; ymd(d) <= target; d = addDays(d, 1)) genDay(db, ymd(d), now);
  db.demoUntil = target;
  return true;
}

/* =====================================================================
   Цены
   ===================================================================== */
function rateAt(s, min) { return min < s.border ? s.priceAm : s.pricePm; }
function rentFor(s, start, dur) { let t = 0; for (let m = start; m < start + dur; m += 30) t += rateAt(s, m) / 2; return t; }
function promoDiscount(p, subtotal) { if (!p) return 0; return p.type === 'pct' ? Math.round(subtotal * p.value / 100) : Math.min(p.value, subtotal); }
function quoteRaw(s, start, dur, rackets, promo) {
  const rent = rentFor(s, start, dur);
  const rk = (rackets || 0) * s.racket * dur / 60;
  const subtotal = rent + rk;
  const discount = promoDiscount(promo, subtotal);
  return { rent: rent, rackets: rk, subtotal: subtotal, discount: discount, total: subtotal - discount };
}
function findPromo(db, code) {
  code = String(code || '').trim().toUpperCase(); if (!code) return null;
  const p = db.promos.find(x => x.code === code);
  if (!p || !p.active) throw new PPError('PROMO', 'Такого промокода нет или он выключен');
  if (p.limit && p.used >= p.limit) throw new PPError('PROMO', 'Лимит использований промокода исчерпан');
  return p;
}

/* =====================================================================
   Согласия и журнал (записи только добавляются — методов изменения/удаления нет)
   ===================================================================== */
const docHashes = {};
/* Хеш текста редакции документа. С сервера/https — SHA-256 от самого файла.
   С file:// браузер не даёт прочитать файл, поэтому хешируем «id@версия»; в журнале это видно по hashSource. */
function docHash(d) {
  const k = d.id + '@' + d.version;
  if (!docHashes[k]) {
    docHashes[k] = (async () => {
      if (global.location && /^https?:$/.test(location.protocol) && global.fetch) {
        try { const r = await fetch(d.file, { cache: 'no-store' }); if (r.ok) return { hash: sha256(await r.text()), src: 'file' }; } catch (e) {}
      }
      return { hash: sha256(k), src: 'id+version' };
    })();
  }
  return docHashes[k];
}
async function hashesFor(ids) { const out = {}; for (const id of ids) out[id] = await docHash(docById(id)); return out; }
function consentEntry(o) {
  const d = docById(o.docId);
  const k = d.id + '@' + (o.version || d.version);
  return {
    id: uid('c'), subjectId: o.subjectId, name: o.name || '', phone: o.phone || '',
    docId: d.id, docVersion: o.version || d.version, action: o.action || 'accepted',
    conditions: o.conditions ? clone(o.conditions) : null, context: o.context || 'cabinet',
    ts: new Date(o.at || Date.now()).toISOString(),
    userAgent: o.ua || (global.navigator ? navigator.userAgent : ''),
    ip: null, // IP-адрес записывает сервер при приёме запроса
    docHash: o.hash ? o.hash.hash : sha256(k), hashSource: o.hash ? o.hash.src : 'id+version',
    guardian: o.guardian ? clone(o.guardian) : null
  };
}
function setUserConsent(u, id, at, conditions, active) {
  u.consents = u.consents || {};
  u.consents[id] = { version: docById(id).version, at: at || Date.now(), active: active !== false, conditions: conditions ? clone(conditions) : (u.consents[id] && u.consents[id].conditions) || null };
}
function makeRequest(o) {
  const t = REQUEST_TYPES[o.type], at = o.at || Date.now();
  return { id: uid('rq'), subjectId: o.subjectId, name: o.name || '', phone: o.phone || '', type: o.type, title: t.title, createdAt: at,
    deadline: t.business ? addBusinessDays(at, t.days) : at + t.days * 864e5, status: o.status || 'new', doneAt: o.status === 'done' ? at + 864e5 : null, note: o.note || '', demo: !!o.demo };
}
function hasCurrent(u, id) { const c = u && u.consents && u.consents[id]; return !!c && c.active && verCmp(c.version, docById(id).version) >= 0; }
function regOk(u) { return REG_DOCS.every(id => hasCurrent(u, id)); }
function publicCond(u) { const c = u && u.consents && u.consents.consent_public; return Object.assign({}, PUBLIC_COND_DEFAULT, (c && c.conditions) || {}); }
function outdatedDocs(u) { return DOCS.filter(d => d.id !== 'cookies').filter(d => { const c = u.consents && u.consents[d.id]; return c && c.active && verCmp(c.version, d.version) < 0; }); }
function isVisibleAuthor(u) { return !!u && !u.deletion && hasCurrent(u, 'consent_public') && (u.demo || regOk(u)); }

/* =====================================================================
   Сессия и представления
   ===================================================================== */
function sessionId() { return sget(SKEY) || null; }
function currentUser(db) { const id = sessionId(); const u = id && db.users[id]; return u && !u.demo ? u : null; }
function needUser(db, soft) {
  const u = currentUser(db);
  if (!u) throw new PPError('AUTH', 'Войдите в кабинет');
  if (!soft && u.deletion) throw new PPError('DELETION', 'Профиль ожидает удаления — восстановите его в кабинете, чтобы продолжить');
  if (!soft && !regOk(u)) throw new PPError('DOCS', 'Документы обновились — подтвердите новую редакцию в кабинете');
  return u;
}
function anonId() { let a = sget(ANONKEY); if (!a) { a = uid('a'); try { sset(ANONKEY, a); } catch (e) {} } return a; }

const PALETTE = [['#ff2e63', '#ffb938'], ['#8f9bff', '#37d5ff'], ['#3dffa8', '#37d5ff'], ['#ffb938', '#ff7a45'], ['#c77dff', '#ff2e63'], ['#37d5ff', '#8f9bff'], ['#ff7a45', '#ff2e63'], ['#f5e663', '#3dffa8']];
function initials(name) { const p = String(name || '?').trim().split(/\s+/); return ((p[0] || '?')[0] + (p[1] ? p[1][0] : '')).toUpperCase(); }
/* Стилизованный неоновый аватар по имени (для демо-игроков и тех, кто ещё не загрузил фото) */
function avatarSVG(name, key) {
  const h = hash(key || name), c = PALETTE[h % PALETTE.length], v = (h >> 4) % 3, rot = (h >> 7) % 360;
  const ini = esc(initials(name));
  let deco = '';
  if (v === 0) { for (let i = -120; i < 240; i += 14) deco += '<line x1="' + i + '" y1="0" x2="' + (i + 120) + '" y2="120"/>'; deco = '<g stroke="' + c[0] + '" stroke-width="1.2" opacity=".18">' + deco + '</g>'; }
  else if (v === 1) { deco = '<g fill="none" stroke="' + c[1] + '" stroke-width="1.4" opacity=".22">' + [18, 30, 42, 54, 66].map(r => '<circle cx="104" cy="16" r="' + r + '"/>').join('') + '</g>'; }
  else { for (let y = 10; y < 120; y += 14) for (let x = 10; x < 120; x += 14) deco += '<circle cx="' + x + '" cy="' + y + '" r="1.4"/>'; deco = '<g fill="' + c[0] + '" opacity=".25">' + deco + '</g>'; }
  const bx = 60 + Math.cos(rot * Math.PI / 180) * 43, by = 60 + Math.sin(rot * Math.PI / 180) * 43;
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="' + c[0] + '"/><stop offset="1" stop-color="' + c[1] + '"/></linearGradient><radialGradient id="b" cx=".3" cy=".2" r="1"><stop offset="0" stop-color="#232740"/><stop offset="1" stop-color="#090a14"/></radialGradient></defs><rect width="120" height="120" fill="url(#b)"/>' + deco + '<circle cx="60" cy="60" r="43" fill="none" stroke="url(#g)" stroke-width="2.5" opacity=".85"/><text x="60" y="62" text-anchor="middle" dominant-baseline="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="' + (ini.length > 1 ? 34 : 42) + '" fill="url(#g)">' + ini + '</text><circle cx="' + bx.toFixed(1) + '" cy="' + by.toFixed(1) + '" r="6.5" fill="#ffb938"/><circle cx="' + (bx - 2).toFixed(1) + '" cy="' + (by - 2).toFixed(1) + '" r="2.2" fill="#fff6dd"/></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
function photoOf(u) { return (u && u.photo) || avatarSVG(u ? u.name : '?', u ? u.id : '?'); }
/* Автор в ленте — только те категории данных, которые он разрешил в согласии на распространение */
function authorView(u, cond) {
  const v = pubUser(u); if (!v || !cond) return v;
  if (!cond.photo) { v.photo = avatarSVG(u.name, u.id); v.hasPhoto = false; }
  if (!cond.age) v.age = null;
  if (!cond.prefs) { v.level = null; v.hand = null; v.style = null; v.about = ''; }
  return v;
}
function pubUser(u) { return u ? { id: u.id, name: u.name, age: u.age || null, level: u.level || null, hand: u.hand || null, style: u.style || null, about: u.about || '', photo: photoOf(u), hasPhoto: !!u.photo, demo: !!u.demo } : null; }
function contactsOf(u) { return { phone: u.showPhone !== false ? fmtPhone(u.phone) : null, tg: u.tg || null }; }
function meView(u) {
  const v = pubUser(u);
  return Object.assign(v, {
    phone: fmtPhone(u.phone), phoneRaw: u.phone, tg: u.tg || '', showPhone: !!u.showPhone, createdAt: u.createdAt, completeness: completeness(u),
    ageGroup: u.ageGroup || 'adult', guardian: u.guardian ? clone(u.guardian) : null,
    deletion: u.deletion ? clone(u.deletion) : null, docsOk: regOk(u), publicOk: hasCurrent(u, 'consent_public'), publicCond: publicCond(u),
    outdated: outdatedDocs(u).map(d => d.id)
  });
}
function completeness(u) {
  const items = [['photo', 'Фото', 25, !!u.photo], ['name', 'Имя', 10, !!u.name], ['age', 'Возраст', 10, !!u.age], ['level', 'Уровень', 15, !!u.level], ['hand', 'Игровая рука', 10, !!u.hand], ['style', 'Стиль игры', 10, !!u.style], ['about', 'О себе', 10, !!(u.about && u.about.length >= 10)], ['tg', 'Telegram', 10, !!u.tg]];
  return { pct: items.reduce((a, x) => a + (x[3] ? x[2] : 0), 0), missing: items.filter(x => !x[3]).map(x => ({ key: x[0], title: x[1], add: x[2] })) };
}
function postSummary(p) {
  const t = (p.times || []).map(x => label(TIMES, x).toLowerCase());
  if (p.timeFrom != null) t.push('с ' + hhmm(p.timeFrom));
  return label(FORMATS, p.format) + ' · ' + (p.days || []).map(d => DAY_SHORT[d]).join(', ') + (t.length ? ' · ' + t.join(', ') : '');
}
function postView(db, p, me, pub) {
  const a = db.users[p.authorId];
  const cond = publicCond(a), own = !!me && p.authorId === me.id, hide = pub && !own;
  const rs = db.responses.filter(r => r.postId === p.id);
  const mine = me ? rs.find(r => r.fromId === me.id) : null;
  const reporter = me ? me.id : 'anon:' + anonId();
  const v = {
    id: p.id, format: p.format, partnerLevel: p.partnerLevel, days: p.days.slice(), times: (p.times || []).slice(), timeFrom: p.timeFrom,
    text: p.text, createdAt: p.createdAt, status: p.status, hidden: !!p.hidden, demo: !!p.demo, revoked: !!p.revoked,
    photo: hide && !cond.photo ? avatarSVG(a.name, a.id) : (p.photo || photoOf(a)), ownPhoto: !!p.photo, author: authorView(a, hide ? cond : null),
    cond: cond, prefsHidden: !!hide && !cond.prefs,
    responsesCount: (p.seedResponses || 0) + rs.length, newResponses: rs.filter(r => !r.seenByAuthor).length,
    isMine: !!me && p.authorId === me.id,
    myResponse: mine ? { id: mine.id, status: mine.status, whenAt: mine.whenAt || null } : null,
    reported: db.reports.some(r => r.postId === p.id && r.by === reporter),
    summary: postSummary(p)
  };
  if (v.prefsHidden) { v.days = []; v.times = []; v.timeFrom = null; v.partnerLevel = 'any'; v.summary = label(FORMATS, p.format); }
  return v;
}
function responseView(db, r, me) {
  const p = db.posts.find(x => x.id === r.postId);
  const other = db.users[me.id === r.fromId ? r.toId : r.fromId];
  const v = {
    id: r.id, postId: r.postId, status: r.status, message: r.message, when: r.when, whenAt: r.whenAt || null,
    createdAt: r.createdAt, decidedAt: r.decidedAt || null,
    post: p ? { id: p.id, format: p.format, summary: postSummary(p), status: p.status, text: p.text } : { id: r.postId, summary: 'Объявление удалено', status: 'deleted' },
    user: pubUser(other), contacts: null,
    played: (r.playedBy || []).indexOf(me.id) >= 0,
    unseen: me.id === r.toId ? !r.seenByAuthor : !r.seenByFrom
  };
  if (r.status === 'accepted' && other) v.contacts = contactsOf(other);
  return v;
}

/* Ближайшие подходящие слоты по дням/времени объявления */
function nextSlots(post, count, settings) {
  const s = settings || (cacheDb ? cacheDb.settings : DEFAULT_SETTINGS);
  const out = [], now = Date.now(), t = parseYmd(today());
  const starts = [];
  (post.times || []).forEach(x => { if (x === 'morning') starts.push(600, 690); if (x === 'day') starts.push(840, 930); if (x === 'evening') starts.push(1080, 1140); });
  if (post.timeFrom != null) starts.push(post.timeFrom);
  const uniq = Array.from(new Set(starts)).filter(m => m >= s.open && m + 60 <= s.close).sort((a, b) => a - b);
  for (let i = 0; i < 14 && out.length < (count || 6); i++) {
    const d = addDays(t, i);
    if ((post.days || []).indexOf(dayIdx(d)) < 0) continue;
    for (const m of uniq) {
      if (tsAt(ymd(d), m) - now < s.minLeadMin * 60e3) continue;
      out.push({ date: ymd(d), start: m, label: dateLabel(ymd(d)) + ' · ' + hhmm(m), rate: rateAt(s, m) });
      if (out.length >= (count || 6)) break;
    }
  }
  return out;
}

/* =====================================================================
   Имитация активности для показа (демо): входящие отклики и принятие откликов
   ===================================================================== */
let simTimer = 0;
function scheduleSims() {
  clearTimeout(simTimer);
  let db; try { db = load(); } catch (e) { return; }
  if (!db.sims.length) return;
  const next = Math.min.apply(null, db.sims.map(s => s.dueAt));
  simTimer = setTimeout(processSims, Math.max(300, next - Date.now()));
}
function processSims() {
  const out = [];
  try {
    mutate(db => {
      const now = Date.now();
      const due = db.sims.filter(s => s.dueAt <= now);
      db.sims = db.sims.filter(s => s.dueAt > now);
      due.forEach(s => {
        if (s.type === 'incoming') {
          const p = db.posts.find(x => x.id === s.postId);
          if (!p || p.status !== 'open' || p.hidden) return;
          const taken = db.responses.filter(r => r.postId === p.id).map(r => r.fromId);
          const cands = SEED_USERS.filter(u => taken.indexOf(u.id) < 0 && (p.partnerLevel === 'any' || u.level === p.partnerLevel || true));
          const pick = cands[Math.floor(Math.random() * cands.length)]; if (!pick) return;
          const slot = nextSlots(p, 1, db.settings)[0];
          db.responses.push({ id: uid('r'), postId: p.id, fromId: pick.id, toId: p.authorId, message: pick.pitch, when: slot ? slot.label : 'Любое время на неделе', whenAt: slot ? { date: slot.date, start: slot.start } : null, status: 'pending', createdAt: now, seenByAuthor: false, seenByFrom: true, playedBy: [], simulated: true });
          out.push({ text: pick.name + ' ' + (pick.g === 'f' ? 'откликнулась' : 'откликнулся') + ' на ваше объявление', href: 'cabinet.html#incoming', action: 'Посмотреть', kind: 'response' });
        } else if (s.type === 'accept') {
          const r = db.responses.find(x => x.id === s.responseId);
          if (!r || r.status !== 'pending') return;
          r.status = 'accepted'; r.decidedAt = now; r.seenByFrom = false;
          const a = db.users[r.toId];
          out.push({ text: a.name + ' ' + (a.g === 'f' ? 'приняла' : 'принял') + ' ваш отклик — контакты открыты', href: 'cabinet.html#mine', action: 'Открыть', kind: 'accept' });
        }
      });
    });
  } catch (e) {}
  out.forEach(notify);
  scheduleSims();
}

/* =====================================================================
   CommunityAPI
   ===================================================================== */
function validatePost(data) {
  const fmt = FORMATS.some(f => f[0] === data.format) ? data.format : null;
  if (!fmt) throw new PPError('VALID', 'Выберите формат игры');
  const pl = data.partnerLevel === 'any' || LEVELS.some(l => l[0] === data.partnerLevel) ? data.partnerLevel : 'any';
  const days = (data.days || []).map(Number).filter(d => d >= 0 && d < 7);
  if (!days.length) throw new PPError('VALID', 'Отметьте хотя бы один день');
  const times = (data.times || []).filter(t => TIMES.some(x => x[0] === t));
  const timeFrom = data.timeFrom != null && data.timeFrom !== '' ? Number(data.timeFrom) : null;
  if (!times.length && timeFrom == null) throw new PPError('VALID', 'Укажите удобное время');
  const text = String(data.text || '').trim();
  if (text.length < 20) throw new PPError('VALID', 'Расскажите чуть подробнее — хотя бы 20 символов');
  if (text.length > 300) throw new PPError('VALID', 'Не больше 300 символов');
  const photo = typeof data.photo === 'string' && /^data:image\//.test(data.photo) ? data.photo : null;
  return { format: fmt, partnerLevel: pl, days: Array.from(new Set(days)).sort(), times: times, timeFrom: timeFrom, text: text, photo: photo };
}
function matchTime(p, t) {
  if (!t) return true;
  if (t === 'am') return (p.times || []).indexOf('morning') >= 0 || (p.timeFrom != null && p.timeFrom < 780);
  if (t === 'pm') return (p.times || []).some(x => x === 'day' || x === 'evening') || (p.timeFrom != null && p.timeFrom >= 780);
  if (t === 'we') return p.days.indexOf(5) >= 0 || p.days.indexOf(6) >= 0;
  return true;
}
const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е');

const CommunityAPI = {
  isPersistent: () => persistent,
  async requestCode(phone) {
    await wait();
    const p = normPhone(phone);
    if (!p) throw new PPError('PHONE', 'Введите номер полностью: +7 и 10 цифр');
    const db = load();
    const exists = Object.keys(db.users).some(k => db.users[k].phone === p && !db.users[k].demo);
    return { sent: true, exists: exists, demoCode: DEMO_CODE };
  },
  /* o: {phone, code, name, ageGroup:'adult'|'minor', guardian:{fio, phone}, consents:{consent_pd, community_rules, policy}, context} */
  async register(o) {
    await wait();
    const p = normPhone(o.phone); if (!p) throw new PPError('PHONE', 'Проверьте номер телефона');
    if (String(o.code || '').trim() !== DEMO_CODE) throw new PPError('CODE', 'Неверный код. В демо-режиме код — ' + DEMO_CODE);
    const name = String(o.name || '').trim().slice(0, 40);
    if (name.length < 2) throw new PPError('NAME', 'Как вас зовут?');
    const c = o.consents || {};
    const miss = REG_DOCS.filter(id => !c[id]);
    if (miss.length) throw new PPError('CONSENT', 'Отметьте: ' + miss.map(id => docById(id).title).join(', '));
    const ageGroup = o.ageGroup === 'minor' ? 'minor' : o.ageGroup === 'adult' ? 'adult' : null;
    if (!ageGroup) throw new PPError('AGE', 'Укажите возраст: 18+ или 14–17 с согласия законного представителя');
    let guardian = null;
    if (ageGroup === 'minor') {
      const fio = String((o.guardian || {}).fio || '').trim().replace(/\s+/g, ' ');
      const gp = normPhone((o.guardian || {}).phone);
      if (fio.split(' ').length < 2 || fio.length < 5) throw new PPError('GUARDIAN', 'Укажите ФИО законного представителя полностью');
      if (!gp) throw new PPError('GUARDIAN', 'Проверьте телефон законного представителя');
      if (gp === p) throw new PPError('GUARDIAN', 'Телефон представителя должен отличаться от вашего');
      guardian = { fio: fio.slice(0, 80), phone: gp };
    }
    const H = await hashesFor(REG_DOCS);
    const ctx = CONSENT_CONTEXT[o.context] ? o.context : 'registration';
    const u = mutate(db => {
      if (Object.keys(db.users).some(k => db.users[k].phone === p && !db.users[k].demo)) throw new PPError('EXISTS', 'Этот номер уже зарегистрирован — просто войдите');
      const nu = { id: uid('u'), phone: p, name: name, age: null, level: null, hand: null, style: null, about: '', tg: '', showPhone: false, photo: null, createdAt: Date.now(), ageGroup: ageGroup, guardian: guardian, consents: {} };
      db.users[nu.id] = nu;
      REG_DOCS.forEach(id => { db.consents.push(consentEntry({ subjectId: nu.id, name: name, phone: p, docId: id, action: 'accepted', context: ctx, hash: H[id], guardian: guardian })); setUserConsent(nu, id); });
      db.bookings.forEach(b => { if (!b.userId && b.phone === p) b.userId = nu.id; });
      return nu;
    });
    sset(SKEY, u.id); emit(); goal('cabinet_register');
    return meView(u);
  },
  async login(o) {
    await wait();
    const p = normPhone(o.phone); if (!p) throw new PPError('PHONE', 'Проверьте номер телефона');
    if (String(o.code || '').trim() !== DEMO_CODE) throw new PPError('CODE', 'Неверный код. В демо-режиме код — ' + DEMO_CODE);
    const db = load();
    const id = Object.keys(db.users).find(k => db.users[k].phone === p && !db.users[k].demo);
    if (!id) throw new PPError('NOUSER', 'Такого номера ещё нет — зарегистрируйтесь');
    sset(SKEY, id); emit(); goal('cabinet_login');
    return meView(db.users[id]);
  },
  async logout() { await wait(60); sdel(SKEY); emit(); return true; },
  async me() { const db = load(); const u = currentUser(db); return u ? meView(u) : null; },
  meSync() { try { const db = load(); const u = currentUser(db); return u ? meView(u) : null; } catch (e) { return null; } },
  async updateProfile(patch) {
    await wait();
    const u = mutate(db => {
      const me = needUser(db);
      const P = patch || {};
      if ('name' in P) { const n = String(P.name || '').trim().slice(0, 40); if (n.length < 2) throw new PPError('NAME', 'Имя — хотя бы 2 буквы'); me.name = n; }
      if ('age' in P) {
        const a = P.age === '' || P.age == null ? null : parseInt(P.age, 10);
        if (a != null && (isNaN(a) || a < 14 || a > 99)) throw new PPError('AGE', 'Укажите возраст от 14 до 99');
        if (a != null && me.ageGroup !== 'minor' && a < 18) throw new PPError('AGE', 'При регистрации вы указали 18+. Если вам 14–17, нужна регистрация с согласия законного представителя');
        if (a != null && me.ageGroup === 'minor' && a >= 18) me.ageGroup = 'adult';
        me.age = a;
      }
      if ('level' in P) me.level = LEVELS.some(l => l[0] === P.level) ? P.level : null;
      if ('hand' in P) me.hand = HANDS.some(l => l[0] === P.hand) ? P.hand : null;
      if ('style' in P) me.style = STYLES.some(l => l[0] === P.style) ? P.style : null;
      if ('about' in P) me.about = String(P.about || '').trim().slice(0, 300);
      if ('tg' in P) {
        let t = String(P.tg || '').trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');
        if (t && !/^[a-zA-Z0-9_]{5,32}$/.test(t)) throw new PPError('TG', 'Ник в Telegram: латиница, цифры и «_», от 5 символов');
        me.tg = t;
      }
      if ('showPhone' in P) me.showPhone = !!P.showPhone;
      if ('photo' in P) {
        if (P.photo && !/^data:image\/(jpeg|png|webp);base64,/.test(P.photo)) throw new PPError('PHOTO', 'Не получилось прочитать фото');
        me.photo = P.photo || null;
      }
      return me;
    });
    return meView(u);
  },
  async listPosts(f) {
    await wait(60);
    f = f || {};
    const db = load(), me = currentUser(db), q = norm(f.q).trim();
    let list = db.posts.filter(p => p.status === 'open' && !p.hidden && isVisibleAuthor(db.users[p.authorId]));
    // скрытые автором категории (уровень, дни и время) не участвуют в фильтрах — иначе они «утекут» через выдачу
    const prefs = p => publicCond(db.users[p.authorId]).prefs;
    if (f.level) list = list.filter(p => prefs(p) && db.users[p.authorId].level === f.level);
    if (f.format) list = list.filter(p => p.format === f.format);
    if (f.time) list = list.filter(p => prefs(p) && matchTime(p, f.time));
    if (q) list = list.filter(p => { const a = db.users[p.authorId]; return norm([p.text, a.name, label(FORMATS, p.format)].concat(prefs(p) ? [label(LEVELS, a.level), postSummary(p)] : []).join(' ')).indexOf(q) >= 0; });
    const views = list.map(p => postView(db, p, me, true));
    if (f.sort === 'popular') views.sort((a, b) => b.responsesCount - a.responsesCount || b.createdAt - a.createdAt);
    else views.sort((a, b) => b.createdAt - a.createdAt);
    return views;
  },
  async countOpenPosts() { const db = load(); return db.posts.filter(p => p.status === 'open' && !p.hidden && isVisibleAuthor(db.users[p.authorId])).length; },
  async getPost(id) { const db = load(); const p = db.posts.find(x => x.id === id); return p ? postView(db, p, currentUser(db), true) : null; },
  async listMyPosts() {
    await wait(60);
    const db = load(), me = needUser(db);
    return db.posts.filter(p => p.authorId === me.id).sort((a, b) => b.createdAt - a.createdAt).map(p => postView(db, p, me));
  },
  async createPost(data) {
    await wait();
    const v = validatePost(data || {});
    const p = mutate(db => {
      const me = needUser(db);
      if (!hasCurrent(me, 'consent_public')) throw new PPError('CONSENT_PUBLIC', 'Для публикации нужно согласие на распространение персональных данных');
      if (db.posts.filter(x => x.authorId === me.id && x.status === 'open').length >= 3) throw new PPError('LIMIT', 'Можно держать не больше 3 активных объявлений — закройте одно из старых');
      const np = Object.assign({ id: uid('p'), authorId: me.id, createdAt: Date.now(), status: 'open' }, v);
      db.posts.push(np);
      // ИМИТАЦИЯ ДЛЯ ПОКАЗА: через 8–15 секунд «приходит» отклик от демо-игрока
      db.sims.push({ id: uid('s'), type: 'incoming', postId: np.id, dueAt: Date.now() + 8000 + Math.random() * 7000 });
      return np;
    });
    goal('partner_post_create');
    const db = load(); return postView(db, db.posts.find(x => x.id === p.id), currentUser(db));
  },
  async updatePost(id, data) {
    await wait();
    const v = validatePost(data || {});
    mutate(db => {
      const me = needUser(db); const p = db.posts.find(x => x.id === id);
      if (!p || p.authorId !== me.id) throw new PPError('NOTFOUND', 'Объявление не найдено');
      Object.assign(p, v, { updatedAt: Date.now() });
    });
    return this.getPost(id);
  },
  async closePost(id) {
    await wait(80);
    mutate(db => { const me = needUser(db); const p = db.posts.find(x => x.id === id); if (!p || p.authorId !== me.id) throw new PPError('NOTFOUND', 'Объявление не найдено'); p.status = 'closed'; p.closedAt = Date.now(); db.sims = db.sims.filter(s => s.postId !== id); });
    return true;
  },
  async reopenPost(id) {
    await wait(80);
    mutate(db => { const me = needUser(db); if (!hasCurrent(me, 'consent_public')) throw new PPError('CONSENT_PUBLIC', 'Сначала дайте согласие на распространение — без него объявления не публикуются'); const p = db.posts.find(x => x.id === id); if (!p || p.authorId !== me.id) throw new PPError('NOTFOUND', 'Объявление не найдено');
      if (db.posts.filter(x => x.authorId === me.id && x.status === 'open').length >= 3) throw new PPError('LIMIT', 'Уже есть 3 активных объявления'); p.status = 'open'; });
    return true;
  },
  async deletePost(id) {
    await wait(80);
    mutate(db => { const me = needUser(db); const p = db.posts.find(x => x.id === id); if (!p || p.authorId !== me.id) throw new PPError('NOTFOUND', 'Объявление не найдено');
      db.posts = db.posts.filter(x => x.id !== id); db.responses = db.responses.filter(r => r.postId !== id || r.status === 'accepted'); db.sims = db.sims.filter(s => s.postId !== id); });
    return true;
  },
  async respond(postId, o) {
    await wait();
    o = o || {};
    const msg = String(o.message || '').trim();
    if (msg.length < 2) throw new PPError('VALID', 'Напишите пару слов автору');
    if (msg.length > 300) throw new PPError('VALID', 'Не больше 300 символов');
    const when = String(o.when || '').trim().slice(0, 80);
    if (!when) throw new PPError('VALID', 'Предложите время');
    const r = mutate(db => {
      const me = needUser(db);
      const p = db.posts.find(x => x.id === postId);
      if (!p || p.status !== 'open' || p.hidden) throw new PPError('NOTFOUND', 'Объявление уже закрыто');
      if (p.authorId === me.id) throw new PPError('OWN', 'Это ваше объявление — откликнуться на него нельзя');
      if (db.responses.some(x => x.postId === postId && x.fromId === me.id)) throw new PPError('DUP', 'Вы уже откликнулись на это объявление');
      const nr = { id: uid('r'), postId: postId, fromId: me.id, toId: p.authorId, message: msg, when: when, whenAt: o.whenAt && o.whenAt.date ? { date: String(o.whenAt.date), start: Number(o.whenAt.start) } : null, status: 'pending', createdAt: Date.now(), seenByAuthor: false, seenByFrom: true, playedBy: [] };
      db.responses.push(nr);
      // ИМИТАЦИЯ ДЛЯ ПОКАЗА: демо-автор принимает отклик через 10–18 секунд
      if (db.users[p.authorId] && db.users[p.authorId].demo) db.sims.push({ id: uid('s'), type: 'accept', responseId: nr.id, dueAt: Date.now() + 10000 + Math.random() * 8000 });
      return nr;
    });
    goal('partner_respond');
    return { id: r.id, status: r.status };
  },
  async listMyResponses() { await wait(60); const db = load(), me = needUser(db); return db.responses.filter(r => r.fromId === me.id).sort((a, b) => b.createdAt - a.createdAt).map(r => responseView(db, r, me)); },
  async listResponsesToMe() { await wait(60); const db = load(), me = needUser(db); return db.responses.filter(r => r.toId === me.id).sort((a, b) => b.createdAt - a.createdAt).map(r => responseView(db, r, me)); },
  async acceptResponse(id) {
    await wait();
    const v = mutate(db => { const me = needUser(db); const r = db.responses.find(x => x.id === id);
      if (!r || r.toId !== me.id) throw new PPError('NOTFOUND', 'Отклик не найден');
      if (r.status === 'pending') { r.status = 'accepted'; r.decidedAt = Date.now(); r.seenByFrom = false; r.seenByAuthor = true; }
      return responseView(db, r, me); });
    goal('partner_accept');
    return v;
  },
  async declineResponse(id) {
    await wait();
    return mutate(db => { const me = needUser(db); const r = db.responses.find(x => x.id === id);
      if (!r || r.toId !== me.id) throw new PPError('NOTFOUND', 'Отклик не найден');
      if (r.status === 'pending') { r.status = 'declined'; r.decidedAt = Date.now(); r.seenByFrom = false; r.seenByAuthor = true; }
      return responseView(db, r, me); });
  },
  async report(postId, reason) {
    await wait(80);
    mutate(db => {
      const me = currentUser(db); const by = me ? me.id : 'anon:' + anonId();
      if (!db.posts.some(p => p.id === postId)) throw new PPError('NOTFOUND', 'Объявление не найдено');
      if (!db.reports.some(r => r.postId === postId && r.by === by)) db.reports.push({ id: uid('rp'), postId: postId, by: by, reason: String(reason || 'Неуместное объявление').slice(0, 200), at: Date.now(), status: 'new' });
    });
    goal('partner_report');
    return true;
  },
  async markPlayed(responseId) {
    await wait(80);
    mutate(db => { const me = needUser(db); const r = db.responses.find(x => x.id === responseId);
      if (!r || (r.fromId !== me.id && r.toId !== me.id) || r.status !== 'accepted') throw new PPError('NOTFOUND', 'Отметить можно только принятый отклик');
      r.playedBy = r.playedBy || []; if (r.playedBy.indexOf(me.id) < 0) r.playedBy.push(me.id); });
    return this.stats();
  },
  async stats() {
    const db = load(), me = needUser(db);
    const mine = db.responses.filter(r => r.fromId === me.id || r.toId === me.id);
    const played = mine.filter(r => (r.playedBy || []).indexOf(me.id) >= 0).length;
    const sent = db.responses.filter(r => r.fromId === me.id).length;
    const found = mine.filter(r => r.status === 'accepted').length;
    const posts = db.posts.filter(p => p.authorId === me.id).length;
    return {
      played: played, sent: sent, found: found, posts: posts,
      badges: [
        { id: 'post', title: 'Первое объявление', desc: 'Разместить объявление о поиске партнёра', got: posts > 0 },
        { id: 'resp', title: 'Первый отклик', desc: 'Откликнуться на чужое объявление', got: sent > 0 },
        { id: 'found', title: 'Нашёл партнёра', desc: 'Принять отклик или получить согласие', got: found > 0 },
        { id: 'five', title: '5 игр', desc: 'Отметить пять сыгранных встреч', got: played >= 5, progress: Math.min(played, 5) + ' из 5' }
      ]
    };
  },
  async unreadCount() {
    const db = load(), me = currentUser(db); if (!me) return 0;
    return db.responses.filter(r => (r.toId === me.id && !r.seenByAuthor) || (r.fromId === me.id && !r.seenByFrom)).length;
  },
  async markSeen(kind) {
    const db = load(), me = currentUser(db); if (!me) return;
    const has = db.responses.some(r => kind === 'incoming' ? (r.toId === me.id && !r.seenByAuthor) : (r.fromId === me.id && !r.seenByFrom));
    if (!has) return;
    mutate(d => d.responses.forEach(r => { if (kind === 'incoming' && r.toId === me.id) r.seenByAuthor = true; if (kind === 'mine' && r.fromId === me.id) r.seenByFrom = true; }));
  },

  /* ---------- документы и согласия ---------- */
  /* Реестр с моим статусом по каждому документу */
  async docs() {
    const db = load(), me = currentUser(db);
    const cookie = this.getCookieConsent();
    return DOCS.map(d => {
      const v = Object.assign({}, d, { forLabel: d.for.map(x => CONSENT_CONTEXT[x] || x) });
      let mine = null;
      if (me) {
        const c = me.consents && me.consents[d.id];
        if (c) mine = { version: c.version, at: c.at, active: c.active, conditions: c.conditions || null };
        if (d.id === 'offer') { const last = db.consents.filter(e => e.docId === 'offer' && (e.subjectId === me.id || e.phone === me.phone) && e.action === 'accepted').sort((a, b) => b.ts.localeCompare(a.ts))[0]; if (last) mine = { version: last.docVersion, at: Date.parse(last.ts), active: true }; }
      }
      if (d.id === 'cookies' && cookie) mine = { version: cookie.version, at: cookie.at, active: true, conditions: { analytics: cookie.analytics, ads: cookie.ads } };
      v.my = mine;
      v.status = !mine ? 'none' : !mine.active ? 'revoked' : verCmp(mine.version, d.version) < 0 ? 'outdated' : 'ok';
      return v;
    });
  },
  outdatedDocsSync() { try { const db = load(), me = currentUser(db); return me ? outdatedDocs(me).map(d => Object.assign({}, d)) : []; } catch (e) { return []; } },
  /* Подтвердить документы (новая редакция, повторное согласие). o: {context, conditions} */
  async acceptDocs(ids, o) {
    o = o || {};
    ids = (ids || []).filter(id => docById(id) && id !== 'cookies');
    const H = await hashesFor(ids);
    return mutate(db => {
      const me = needUser(db, true);
      ids.forEach(id => {
        const cond = id === 'consent_public' ? Object.assign({}, PUBLIC_COND_DEFAULT, o.conditions || publicCond(me)) : null;
        db.consents.push(consentEntry({ subjectId: me.id, name: me.name, phone: me.phone, docId: id, action: 'accepted', conditions: cond, context: CONSENT_CONTEXT[o.context] ? o.context : 'doc_update', hash: H[id], guardian: me.guardian }));
        setUserConsent(me, id, Date.now(), cond);
      });
      return meView(me);
    });
  },
  /* Условия согласия на распространение (что показывать в ленте): первое согласие — accepted, дальше — conditions_changed */
  async setPublicConditions(cond, context) {
    const c = { photo: !!cond.photo, age: !!cond.age, prefs: !!cond.prefs };
    const H = await hashesFor(['consent_public']);
    return mutate(db => {
      const me = needUser(db);
      if (!hasCurrent(me, 'consent_public')) {
        db.consents.push(consentEntry({ subjectId: me.id, name: me.name, phone: me.phone, docId: 'consent_public', action: 'accepted', conditions: c, context: CONSENT_CONTEXT[context] ? context : 'post', hash: H.consent_public, guardian: me.guardian }));
        setUserConsent(me, 'consent_public', Date.now(), c);
      } else {
        const prev = publicCond(me);
        if (prev.photo !== c.photo || prev.age !== c.age || prev.prefs !== c.prefs) {
          db.consents.push(consentEntry({ subjectId: me.id, name: me.name, phone: me.phone, docId: 'consent_public', action: 'conditions_changed', conditions: c, context: CONSENT_CONTEXT[context] ? context : 'cabinet', hash: H.consent_public, guardian: me.guardian }));
          me.consents.consent_public.conditions = c;
        }
      }
      return meView(me);
    });
  },
  /* Отзыв согласия. consent_public — объявления снимаются, профиль пропадает из ленты.
     consent_pd — профиль уходит в удаление через 30 дней (можно передумать), кабинет блокируется. */
  async revokeConsent(docId) {
    const d = docById(docId);
    if (!d || !d.revocable) throw new PPError('VALID', 'Этот документ нельзя отозвать');
    const H = await hashesFor([docId]);
    return mutate(db => {
      const me = needUser(db, true);
      const c = me.consents && me.consents[docId];
      if (!c || !c.active) throw new PPError('STATE', 'Согласие уже не действует');
      db.consents.push(consentEntry({ subjectId: me.id, name: me.name, phone: me.phone, docId: docId, action: 'revoked', conditions: c.conditions, context: 'cabinet', hash: H[docId], version: c.version, guardian: me.guardian }));
      c.active = false; c.revokedAt = Date.now();
      const mineIds = db.posts.filter(p => p.authorId === me.id).map(p => p.id);
      let closed = 0;
      db.posts.forEach(p => { if (p.authorId === me.id && p.status === 'open') { p.status = 'closed'; p.revoked = true; p.closedAt = Date.now(); closed++; } });
      db.sims = db.sims.filter(x => mineIds.indexOf(x.postId) < 0);
      if (docId === 'consent_public') {
        db.requests.push(makeRequest({ subjectId: me.id, name: me.name, phone: me.phone, type: 'stop_distribution', note: 'Отзыв в кабинете. Снято объявлений автоматически: ' + closed }));
      } else {
        me.deletion = { requestedAt: Date.now(), until: Date.now() + 30 * 864e5, reason: 'revoke_pd' };
        db.requests.push(makeRequest({ subjectId: me.id, name: me.name, phone: me.phone, type: 'revoke_pd', note: 'Отзыв в кабинете. Профиль заблокирован до удаления' }));
      }
      return { closedPosts: closed, me: meView(me) };
    });
  },
  /* Передумал в течение 30 дней: снова даёт согласие на обработку и возвращает профиль */
  async restoreProfile() {
    const H = await hashesFor(['consent_pd']);
    return mutate(db => {
      const me = needUser(db, true);
      if (!me.deletion) return meView(me);
      db.consents.push(consentEntry({ subjectId: me.id, name: me.name, phone: me.phone, docId: 'consent_pd', action: 'accepted', context: 'cabinet', hash: H.consent_pd, guardian: me.guardian }));
      setUserConsent(me, 'consent_pd');
      db.requests.forEach(q => { if (q.subjectId === me.id && (q.type === 'revoke_pd' || q.type === 'delete') && q.status === 'new') { q.status = 'done'; q.doneAt = Date.now(); q.note = (q.note ? q.note + '. ' : '') + 'Пользователь передумал и восстановил профиль'; } });
      me.deletion = null;
      return meView(me);
    });
  },
  /* Удалить профиль: запрос на удаление (уничтожение в течение 30 дней), вход блокируется, до срока можно передумать */
  async deleteProfile() {
    const H = await hashesFor(['consent_pd']);
    mutate(db => {
      const me = needUser(db, true);
      if (me.consents && me.consents.consent_pd && me.consents.consent_pd.active) {
        db.consents.push(consentEntry({ subjectId: me.id, name: me.name, phone: me.phone, docId: 'consent_pd', action: 'revoked', context: 'cabinet', hash: H.consent_pd, guardian: me.guardian }));
        me.consents.consent_pd.active = false;
      }
      db.posts.forEach(p => { if (p.authorId === me.id && p.status === 'open') { p.status = 'closed'; p.revoked = true; } });
      me.deletion = { requestedAt: Date.now(), until: Date.now() + 30 * 864e5, reason: 'delete' };
      db.requests.push(makeRequest({ subjectId: me.id, name: me.name, phone: me.phone, type: 'delete', note: 'Удаление профиля из кабинета' }));
    });
    sdel(SKEY); emit();
    return true;
  },
  /* Все мои данные одним файлом */
  async exportMyData() {
    const db = load(), me = needUser(db, true);
    const mine = db.responses.filter(r => r.fromId === me.id || r.toId === me.id);
    return {
      exportedAt: new Date().toISOString(), operator: 'ИП Исаков Игорь Константинович, ИНН 323407837462',
      profile: { id: me.id, name: me.name, phone: fmtPhone(me.phone), age: me.age, ageGroup: me.ageGroup, guardian: me.guardian || null, level: label(LEVELS, me.level) || null, hand: label(HANDS, me.hand) || null, style: label(STYLES, me.style) || null, about: me.about, telegram: me.tg || null, showPhoneToPartners: !!me.showPhone, hasPhoto: !!me.photo, registeredAt: new Date(me.createdAt).toISOString(), deletion: me.deletion || null },
      photo: me.photo || null,
      posts: db.posts.filter(p => p.authorId === me.id).map(p => ({ id: p.id, createdAt: new Date(p.createdAt).toISOString(), status: p.status, format: label(FORMATS, p.format), days: p.days.map(d => DAY_SHORT[d]), text: p.text })),
      responses: mine.map(r => ({ id: r.id, direction: r.fromId === me.id ? 'отправлен' : 'получен', status: r.status, message: r.message, when: r.when, createdAt: new Date(r.createdAt).toISOString() })),
      bookings: db.bookings.filter(b => ownsBooking(me, b)).map(b => ({ number: b.number, date: b.date, time: hhmm(b.start) + '–' + hhmm(b.start + b.dur), players: b.players, amount: b.amount, status: BOOKING_STATUS[b.status] })),
      consents: db.consents.filter(e => e.subjectId === me.id || e.phone === me.phone).map(clone)
    };
  },
  /* Cookie: {necessary:true, analytics, ads, version, at}. Выбор хранится в браузере, факт выбора — в журнале. */
  getCookieConsent() { try { const c = JSON.parse(sget(COOKIE_KEY) || 'null'); return c && verCmp(c.version, docById('cookies').version) >= 0 ? c : null; } catch (e) { return null; } },
  async setCookieConsent(o, context) {
    const c = { necessary: true, analytics: !!(o && o.analytics), ads: !!(o && o.ads), version: docById('cookies').version, at: Date.now() };
    try { sset(COOKIE_KEY, JSON.stringify(c)); } catch (e) {}
    const H = await hashesFor(['cookies']);
    try {
      mutate(db => { const me = currentUser(db); db.consents.push(consentEntry({ subjectId: me ? me.id : 'anon:' + anonId(), name: me ? me.name : '', phone: me ? me.phone : '', docId: 'cookies', action: 'accepted', conditions: { necessary: true, analytics: c.analytics, ads: c.ads }, context: CONSENT_CONTEXT[context] ? context : 'cookie_banner', hash: H.cookies })); });
    } catch (e) {}
    if (c.analytics) loadMetrika();
    return c;
  }
};

/* =====================================================================
   BookingAPI
   ===================================================================== */
const OCCUPY = { pending: 1, paid: 1, noshow: 1 };
function occupied(db, ds, excludeId) {
  const now = Date.now();
  const list = [];
  db.bookings.forEach(b => { if (b.date === ds && b.id !== excludeId && OCCUPY[b.status] && !(b.status === 'pending' && b.expiresAt && b.expiresAt < now)) list.push([b.start, b.start + b.dur, 'busy', b]); });
  db.blocks.forEach(k => { if (k.date === ds) list.push([k.start, k.end, 'blocked', k]); });
  return list;
}
function availability(db, ds, excludeId) {
  const s = db.settings, now = Date.now(), occ = occupied(db, ds, excludeId), slots = [];
  for (let m = s.open; m < s.close; m += 30) {
    const o = occ.find(x => m < x[1] && m + 30 > x[0]);
    let state = 'free';
    if (tsAt(ds, m) - now < s.minLeadMin * 60e3) state = 'past';
    else if (o) state = o[2];
    slots.push({ start: m, state: state, rate: rateAt(s, m) });
  }
  return slots;
}
function checkRange(db, ds, start, dur, excludeId, ignoreLead) {
  const s = db.settings;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) throw new PPError('VALID', 'Выберите дату');
  if (start % 30 || dur % 30 || dur < 60 || dur > 240) throw new PPError('VALID', 'Длительность — от 1 до 4 часов');
  if (start < s.open || start + dur > s.close) throw new PPError('VALID', 'Комната работает ' + hhmm(s.open) + '–' + hhmm(s.close));
  if (!ignoreLead && tsAt(ds, start) - Date.now() < s.minLeadMin * 60e3) throw new PPError('LEAD', 'Бронь — не позднее чем за ' + s.minLeadMin / 60 + ' ч до начала');
  const occ = occupied(db, ds, excludeId).find(x => start < x[1] && start + dur > x[0]);
  if (occ) throw new PPError('BUSY', 'Это время уже занято — выберите другое');
}
function bookingView(db, b) {
  const v = clone(b);
  const s = db.settings, startTs = tsAt(b.date, b.start);
  v.startTs = startTs; v.endTs = startTs + b.dur * 60e3;
  v.isPast = v.endTs < Date.now();
  v.statusLabel = BOOKING_STATUS[b.status] || b.status;
  const left = startTs - Date.now();
  v.cancelFree = b.status === 'paid' && left >= s.cancelHours * 3600e3;         // возврат 100%
  v.cancelLate = b.status === 'paid' && left < s.cancelHours * 3600e3 && left > 0; // возврат за вычетом расходов
  v.canCancel = v.cancelFree || v.cancelLate || b.status === 'pending';
  v.canReschedule = b.status === 'paid' && !b.rescheduled && left >= s.cancelHours * 3600e3;
  v.refundAmount = b.refundAmount != null ? b.refundAmount : null;
  v.payment = b.paymentId ? clone(db.payments.find(p => p.id === b.paymentId) || null) : null;
  v.timeLabel = hhmm(b.start) + '–' + hhmm(b.start + b.dur);
  v.dateLabel = dateLabel(b.date);
  v.phoneFmt = fmtPhone(b.phone);
  return v;
}
function bookingPayments(db, b) { return db.payments.filter(x => x.bookingId === b.id && (x.status === 'succeeded' || x.status === 'partially_refunded')); }
/* Возврат суммы amount по платежам брони (в боевой версии — POST /v3/refunds в ЮKassa по каждому платежу) */
function refundAmount(db, b, amount) {
  let left = amount;
  bookingPayments(db, b).sort((x, y) => y.createdAt - x.createdAt).forEach(p => {
    if (left <= 0) return;
    const can = p.amount - (p.refunded || 0), take = Math.min(can, left);
    p.refunded = (p.refunded || 0) + take; left -= take; p.refundedAt = Date.now();
    p.status = p.refunded >= p.amount ? 'refunded' : 'partially_refunded';
  });
  return amount - left;
}
function refund(db, b, by, note) {
  const paid = bookingPayments(db, b).reduce((a, p) => a + p.amount - (p.refunded || 0), 0);
  refundAmount(db, b, paid);
  b.refundAmount = paid;
  b.status = 'refunded'; b.history.push({ at: Date.now(), s: 'refunded', by: by, note: (note || 'Возврат 100%') + (paid ? ' · ' + money(paid) : '') });
}
function paidTotal(b) { return b.status === 'refunded' ? 0 : b.status === 'refund_partial' ? b.amount - (b.refundAmount || 0) : (b.status === 'paid' || b.status === 'noshow') ? b.amount : 0; }
function ownsBooking(me, b) { return !!me && (b.userId === me.id || b.phone === me.phone); }
const MY_BOOKINGS = 'pp_my_bookings_v1';
function rememberBooking(id) { try { const a = JSON.parse(sget(MY_BOOKINGS) || '[]'); if (a.indexOf(id) < 0) a.push(id); sset(MY_BOOKINGS, JSON.stringify(a.slice(-20))); } catch (e) {} }
function isRemembered(id) { try { return JSON.parse(sget(MY_BOOKINGS) || '[]').indexOf(id) >= 0; } catch (e) { return false; } }

const BookingAPI = {
  settings() { try { return clone(load().settings); } catch (e) { return clone(DEFAULT_SETTINGS); } },
  quote(o, promo) { const db = load(); return quoteRaw(db.settings, o.start, o.dur, o.rackets, promo ? findPromo(db, promo) : null); },
  async getAvailability(ds) { await wait(40); const db = load(); return { date: ds, settings: clone(db.settings), slots: availability(db, ds) }; },
  availabilitySync(ds, excludeId) { const db = load(); return availability(db, ds, excludeId); },
  async applyPromo(code, o) {
    await wait();
    const db = load(); const p = findPromo(db, code);
    if (!p) throw new PPError('PROMO', 'Введите промокод');
    const q = quoteRaw(db.settings, o.start, o.dur, o.rackets, p);
    return { code: p.code, type: p.type, value: p.value, discount: q.discount, total: q.total, note: p.type === 'pct' ? '−' + p.value + '%' : '−' + money(p.value) };
  },
  async createBooking(o) {
    await wait(200);
    o = o || {};
    const phone = normPhone(o.phone); if (!phone) throw new PPError('PHONE', 'Проверьте номер телефона');
    const name = String(o.name || '').trim().slice(0, 60); if (name.length < 2) throw new PPError('NAME', 'Укажите имя');
    const c = o.consents || {};
    if (!c.offer) throw new PPError('CONSENT', 'Отметьте, что ознакомились с Публичной офертой и Правилами посещения');
    const db0 = load(), me0 = currentUser(db0);
    const needDocs = me0 && regOk(me0) && !me0.deletion ? ['offer'] : BOOKING_DOCS.concat('offer');
    const miss = needDocs.filter(id => !c[id]);
    if (miss.length) throw new PPError('CONSENT', 'Отметьте: ' + miss.map(id => docById(id).title).join(', '));
    const H = await hashesFor(needDocs);
    const b = mutate(db => {
      const s = db.settings, start = Number(o.start), dur = Number(o.dur);
      checkRange(db, o.date, start, dur);
      const players = Math.max(1, Math.min(s.maxPlayers, parseInt(o.players, 10) || 1));
      const rackets = Math.max(0, Math.min(players, parseInt(o.rackets, 10) || 0));
      const promo = o.promo ? findPromo(db, o.promo) : null;
      const q = quoteRaw(s, start, dur, rackets, promo);
      const me = currentUser(db);
      const nb = { id: uid('bk'), number: 'PP-' + (++db.seq), userId: me && me.phone === phone ? me.id : null, name: name, phone: phone, date: o.date, start: start, dur: dur, players: players, rackets: rackets, promo: promo ? promo.code : null, discount: q.discount, amount: q.total, status: 'pending', code: null, createdAt: Date.now(), expiresAt: Date.now() + s.holdMin * 60e3, source: 'site', paymentId: null, partnerResponseId: o.partnerResponseId || null, history: [{ at: Date.now(), s: 'pending', by: 'client', note: 'Слот удерживается ' + s.holdMin + ' минут' }] };
      db.bookings.push(nb);
      const subj = nb.userId || 'guest:' + nb.id;
      needDocs.forEach(id => db.consents.push(consentEntry({ subjectId: subj, name: name, phone: phone, docId: id, action: 'accepted', context: 'booking', hash: H[id], guardian: me && me.guardian })));
      return bookingView(db, nb);
    });
    rememberBooking(b.id);
    return b;
  },
  async createPayment(bookingId, method) {
    await wait(200);
    const r = mutate(db => {
      const b = db.bookings.find(x => x.id === bookingId);
      if (!b) throw new PPError('NOTFOUND', 'Бронь не найдена');
      if (b.status !== 'pending') throw new PPError(b.status === 'expired' ? 'EXPIRED' : 'STATE', b.status === 'expired' ? 'Время на оплату вышло — слот освобождён' : 'Бронь уже ' + BOOKING_STATUS[b.status].toLowerCase());
      db.payments.forEach(p => { if (p.bookingId === b.id && p.status === 'pending') p.status = 'canceled'; });
      const pay = { id: uid('pay'), bookingId: b.id, amount: b.amount, method: method === 'sbp' ? 'sbp' : 'card', status: 'pending', createdAt: Date.now(), paidAt: null, cardMask: null, refundedAt: null, test: true };
      db.payments.push(pay); b.paymentId = pay.id;
      return clone(pay);
    });
    goal('booking_payment_start');
    return r;
  },
  /* Тестовый режим: 5555 5555 5555 4444 — успех, 4000 0000 0000 0002 — отказ банка. СБП — «Я оплатил». */
  async confirmPayment(paymentId, o) {
    await wait(1100);
    o = o || {};
    let result;
    mutate(db => {
      sweepExpired(db, Date.now());
      const pay = db.payments.find(p => p.id === paymentId);
      if (!pay) throw new PPError('NOTFOUND', 'Платёж не найден');
      const b = db.bookings.find(x => x.id === pay.bookingId);
      if (!b || b.status === 'expired') throw new PPError('EXPIRED', 'Время на оплату вышло — слот освобождён. Выберите время заново.');
      if (b.status !== 'pending') throw new PPError('STATE', 'Бронь уже ' + BOOKING_STATUS[b.status].toLowerCase());
      if (pay.method === 'card') {
        const num = String(o.card || '').replace(/\D/g, '');
        if (num === '4000000000000002') { pay.status = 'failed'; pay.failReason = 'Банк отклонил операцию'; b.history.push({ at: Date.now(), s: 'pending', by: 'payment', note: 'Отказ банка по карте •• 0002' }); result = { ok: false, reason: 'Банк отклонил операцию. Попробуйте другую карту или СБП.' }; return; }
        if (num !== '5555555555554444') { pay.status = 'failed'; pay.failReason = 'Карта не принята в тестовом режиме'; result = { ok: false, reason: 'В тестовом режиме проходит только карта 5555 5555 5555 4444.' }; return; }
        pay.cardMask = '•• ' + num.slice(-4);
      }
      pay.status = 'succeeded'; pay.paidAt = Date.now();
      b.status = 'paid'; b.expiresAt = null;
      // Код доступа: в боевой версии его выдаёт контроллер замка по вебхуку об оплате
      b.code = String(100000 + Math.floor(Math.random() * 900000));
      b.history.push({ at: Date.now(), s: 'paid', by: 'payment', note: PAY_METHOD[pay.method] + (pay.cardMask ? ' ' + pay.cardMask : '') });
      if (b.promo) { const pr = db.promos.find(x => x.code === b.promo); if (pr) pr.used++; }
      result = { ok: true, booking: bookingView(db, b) };
    });
    if (result.ok) goal('booking_paid');
    return result;
  },
  async getBooking(id) {
    const db = load(); const b = db.bookings.find(x => x.id === id);
    if (!b) return null;
    const me = currentUser(db);
    if (!ownsBooking(me, b) && !isRemembered(id)) throw new PPError('AUTH', 'Нет доступа к брони');
    return bookingView(db, b);
  },
  async listMyBookings() {
    await wait(60);
    const db = load(), me = needUser(db);
    const list = db.bookings.filter(b => ownsBooking(me, b) && b.status !== 'expired').map(b => bookingView(db, b));
    const now = Date.now();
    return {
      upcoming: list.filter(b => b.endTs >= now && (b.status === 'paid' || b.status === 'pending')).sort((a, b) => a.startTs - b.startTs),
      past: list.filter(b => !(b.endTs >= now && (b.status === 'paid' || b.status === 'pending'))).sort((a, b) => b.startTs - a.startTs)
    };
  },
  async cancelBooking(id) {
    await wait(300);
    const v = mutate(db => {
      const me = currentUser(db); const b = db.bookings.find(x => x.id === id);
      if (!b || (!ownsBooking(me, b) && !isRemembered(id))) throw new PPError('NOTFOUND', 'Бронь не найдена');
      const s = db.settings;
      if (b.status === 'pending') { b.status = 'cancelled'; b.history.push({ at: Date.now(), s: 'cancelled', by: 'client' }); db.payments.forEach(p => { if (p.bookingId === b.id && p.status === 'pending') p.status = 'canceled'; }); }
      else if (b.status === 'paid') {
        const left = tsAt(b.date, b.start) - Date.now();
        if (left <= 0) throw new PPError('STARTED', 'Время брони уже началось — отменить её нельзя. Если комната была недоступна, позвоните: +7 903 644-76-53.');
        if (left >= s.cancelHours * 3600e3) refund(db, b, 'client', 'Отмена клиентом не позднее чем за ' + s.cancelHours + ' ч, возврат 100%');
        else {
          // по оферте: позже чем за 3 часа — возврат за вычетом фактических расходов; сумму определяет администратор
          b.status = 'refund_partial'; b.refundAmount = null;
          b.history.push({ at: Date.now(), s: 'refund_partial', by: 'client', note: 'Отмена менее чем за ' + s.cancelHours + ' ч: возврат за вычетом фактических расходов, сумму рассчитает администратор' });
        }
      } else throw new PPError('STATE', 'Эту бронь отменить нельзя');
      return bookingView(db, b);
    });
    goal('booking_cancel');
    return v;
  },
  /* Перенос клиентом: бесплатно один раз, не позднее чем за 3 часа; разница в цене — доплата или возврат */
  async quoteReschedule(id, o) {
    const db = load(); const b = db.bookings.find(x => x.id === id);
    if (!b) throw new PPError('NOTFOUND', 'Бронь не найдена');
    const q = quoteRaw(db.settings, Number(o.start), Number(o.dur || b.dur), b.rackets, b.promo ? db.promos.find(x => x.code === b.promo) : null);
    return { oldAmount: b.amount, newAmount: q.total, diff: q.total - b.amount };
  },
  async rescheduleBooking(id, o) {
    await wait(300);
    const r = mutate(db => {
      const me = currentUser(db); const b = db.bookings.find(x => x.id === id);
      if (!b || (!ownsBooking(me, b) && !isRemembered(id))) throw new PPError('NOTFOUND', 'Бронь не найдена');
      const s = db.settings;
      if (b.status !== 'paid') throw new PPError('STATE', 'Перенести можно только оплаченную бронь');
      if (b.rescheduled) throw new PPError('STATE', 'Бесплатный перенос уже использован — по оферте он возможен один раз');
      if (tsAt(b.date, b.start) - Date.now() < s.cancelHours * 3600e3) throw new PPError('LATE', 'Перенос возможен не позднее чем за ' + s.cancelHours + ' ч до начала');
      const date = o.date, start = Number(o.start), dur = Number(o.dur || b.dur);
      checkRange(db, date, start, dur, b.id);
      const promo = b.promo ? db.promos.find(x => x.code === b.promo) : null;
      const q = quoteRaw(s, start, dur, b.rackets, promo);
      const diff = q.total - b.amount;
      const from = dateLabel(b.date) + ' ' + hhmm(b.start) + '–' + hhmm(b.start + b.dur);
      if (diff > 0) {
        // тестовый режим: доплата проходит сразу; в боевой версии — отдельный платёж ЮKassa до подтверждения переноса
        const orig = db.payments.find(x => x.id === b.paymentId);
        db.payments.push({ id: uid('pay'), bookingId: b.id, amount: diff, method: orig ? orig.method : 'card', status: 'succeeded', createdAt: Date.now(), paidAt: Date.now(), cardMask: orig ? orig.cardMask : null, refundedAt: null, kind: 'surcharge', test: true });
      } else if (diff < 0) refundAmount(db, b, -diff);
      b.date = date; b.start = start; b.dur = dur; b.amount = q.total; b.discount = q.discount; b.rescheduled = true;
      b.history.push({ at: Date.now(), s: 'paid', by: 'client', note: 'Перенос: ' + from + ' → ' + dateLabel(date) + ' ' + hhmm(start) + '–' + hhmm(start + dur) + (diff > 0 ? ' · доплата ' + money(diff) : diff < 0 ? ' · возврат разницы ' + money(-diff) : '') });
      return { booking: bookingView(db, b), diff: diff };
    });
    return r;
  }
};

/* =====================================================================
   AdminAPI (демо-доступ admin / pingpoint)
   ===================================================================== */
function needAdmin() { if (sget(AKEY) !== '1') throw new PPError('AUTH', 'Войдите в админку'); }
const ADMIN_BY = 'admin';
function clientKey(b) { return b.phone; }
const AdminAPI = {
  demoCredentials: { login: ADMIN_LOGIN, password: ADMIN_PASS },
  isLogged() { return sget(AKEY) === '1'; },
  async login(l, p) { await wait(250); if (String(l).trim() !== ADMIN_LOGIN || String(p) !== ADMIN_PASS) throw new PPError('AUTH', 'Неверный логин или пароль'); sset(AKEY, '1'); emit(); return true; },
  async logout() { sdel(AKEY); emit(); return true; },
  async dashboard() {
    needAdmin(); await wait(60);
    const db = load(), s = db.settings, now = Date.now(), t = parseYmd(today()), td = today();
    const earn = b => b.status === 'paid' || b.status === 'noshow' || b.status === 'refund_partial';
    const inRange = (b, from, to) => b.date >= from && b.date <= to;
    const wFrom = ymd(addDays(t, -6)), mFrom = ymd(addDays(t, -29));
    const sum = (from, to) => db.bookings.filter(b => earn(b) && inRange(b, from, to)).reduce((a, b) => a + paidTotal(b), 0);
    const cnt = (from, to) => db.bookings.filter(b => earn(b) && inRange(b, from, to)).length;
    const openMin = s.close - s.open;
    const loadDays = [];
    for (let i = -20; i <= 6; i++) {
      const ds = ymd(addDays(t, i));
      const mins = db.bookings.filter(b => b.date === ds && (b.status === 'paid' || b.status === 'noshow')).reduce((a, b) => a + b.dur, 0);
      loadDays.push({ date: ds, label: DAY_SHORT[dayIdx(parseYmd(ds))] + ' ' + parseYmd(ds).getDate(), pct: Math.round(mins / openMin * 100), future: i > 0, today: i === 0, weekend: dayIdx(parseYmd(ds)) >= 5 });
    }
    const heat = []; for (let d = 0; d < 7; d++) { heat.push([]); for (let h = Math.floor(s.open / 60); h < Math.ceil(s.close / 60); h++) heat[d].push(0); }
    const dayCount = [0, 0, 0, 0, 0, 0, 0];
    for (let i = -59; i <= 0; i++) dayCount[dayIdx(addDays(t, i))]++;
    const hist = db.bookings.filter(b => (b.status === 'paid' || b.status === 'noshow') && b.date >= ymd(addDays(t, -59)) && b.date <= td);
    hist.forEach(b => { const d = dayIdx(parseYmd(b.date)); for (let m = b.start; m < b.start + b.dur; m += 30) { const h = Math.floor(m / 60) - Math.floor(s.open / 60); if (heat[d][h] != null) heat[d][h] += 0.5; } });
    const heatPct = heat.map((row, d) => row.map(v => Math.round(v / dayCount[d] * 100)));
    const mList = db.bookings.filter(b => earn(b) && inRange(b, mFrom, td));
    const byClient = {}; db.bookings.filter(b => earn(b) && b.date <= td).forEach(b => { byClient[clientKey(b)] = (byClient[clientKey(b)] || 0) + 1; });
    const clients = Object.keys(byClient);
    const monthMins = mList.reduce((a, b) => a + b.dur, 0);
    const refunds = db.bookings.filter(b => (b.status === 'refunded' || b.status === 'refund_partial') && inRange(b, mFrom, ymd(addDays(t, 14)))).length;
    return {
      revenue: { today: sum(td, td), week: sum(wFrom, td), month: sum(mFrom, td) },
      partialPending: db.bookings.filter(b => b.status === 'refund_partial' && b.refundAmount == null).map(b => bookingView(db, b)),
      bookings: { today: cnt(td, td), week: cnt(wFrom, td), month: cnt(mFrom, td), upcoming: db.bookings.filter(b => b.status === 'paid' && tsAt(b.date, b.start) > now).length, pending: db.bookings.filter(b => b.status === 'pending').length, refundsMonth: refunds },
      avgCheck: mList.length ? Math.round(mList.reduce((a, b) => a + paidTotal(b), 0) / mList.length) : 0,
      loadMonth: Math.round(monthMins / (openMin * 30) * 100),
      repeatShare: clients.length ? Math.round(clients.filter(c => byClient[c] > 1).length / clients.length * 100) : 0,
      clientsTotal: clients.length,
      loadDays: loadDays,
      heat: heatPct, heatHours: heat[0].map((_, i) => Math.floor(s.open / 60) + i),
      todayList: db.bookings.filter(b => b.date === td && (b.status === 'paid' || b.status === 'pending' || b.status === 'noshow')).sort((a, b) => a.start - b.start).map(b => bookingView(db, b)),
      blocksToday: db.blocks.filter(k => k.date === td).map(clone),
      newReports: db.reports.filter(r => r.status === 'new').length
    };
  },
  async listBookings(f) {
    needAdmin(); await wait(60); f = f || {};
    const db = load(), q = norm(f.q).replace(/[\s()+-]/g, '');
    let list = db.bookings.slice();
    if (f.date) list = list.filter(b => b.date === f.date);
    if (f.from) list = list.filter(b => b.date >= f.from);
    if (f.to) list = list.filter(b => b.date <= f.to);
    if (f.status) list = list.filter(b => b.status === f.status);
    if (q) list = list.filter(b => norm(b.name).replace(/\s/g, '').indexOf(q) >= 0 || b.phone.indexOf(q.replace(/^8/, '7')) >= 0 || norm(b.number).replace('-', '').indexOf(q) >= 0);
    list.sort((a, b) => f.asc ? (a.date.localeCompare(b.date) || a.start - b.start) : (b.date.localeCompare(a.date) || b.start - a.start));
    return list.map(b => bookingView(db, b));
  },
  async getBooking(id) { needAdmin(); const db = load(); const b = db.bookings.find(x => x.id === id); if (!b) throw new PPError('NOTFOUND', 'Бронь не найдена'); const v = bookingView(db, b); v.payments = db.payments.filter(p => p.bookingId === id).map(clone); return v; },
  async cancelBooking(id, withRefund) {
    needAdmin(); await wait(150);
    const v = mutate(db => { const b = db.bookings.find(x => x.id === id); if (!b) throw new PPError('NOTFOUND', 'Бронь не найдена');
      if (b.status === 'paid' && withRefund) refund(db, b, ADMIN_BY, 'Отмена администратором, возврат 100%');
      else if (b.status === 'paid' || b.status === 'pending') { b.status = 'cancelled'; b.history.push({ at: Date.now(), s: 'cancelled', by: ADMIN_BY, note: withRefund ? '' : 'Без возврата' }); db.payments.forEach(p => { if (p.bookingId === b.id && p.status === 'pending') p.status = 'canceled'; }); }
      else throw new PPError('STATE', 'Эту бронь уже нельзя отменить');
      return bookingView(db, b); });
    return v;
  },
  async moveBooking(id, o) {
    needAdmin(); await wait(150);
    return mutate(db => { const b = db.bookings.find(x => x.id === id); if (!b) throw new PPError('NOTFOUND', 'Бронь не найдена');
      if (b.status !== 'paid' && b.status !== 'pending') throw new PPError('STATE', 'Перенести можно только активную бронь');
      const date = o.date || b.date, start = Number(o.start != null ? o.start : b.start), dur = Number(o.dur || b.dur);
      checkRange(db, date, start, dur, b.id, true);
      const from = dateLabel(b.date) + ' ' + hhmm(b.start) + '–' + hhmm(b.start + b.dur);
      b.date = date; b.start = start; b.dur = dur;
      b.history.push({ at: Date.now(), s: b.status, by: ADMIN_BY, note: 'Перенос: ' + from + ' → ' + dateLabel(date) + ' ' + hhmm(start) + '–' + hhmm(start + dur) });
      return bookingView(db, b); });
  },
  async markNoShow(id) {
    needAdmin(); await wait(100);
    return mutate(db => { const b = db.bookings.find(x => x.id === id); if (!b || b.status !== 'paid') throw new PPError('STATE', 'Отметить можно только оплаченную бронь');
      if (tsAt(b.date, b.start) > Date.now()) throw new PPError('STATE', 'Игра ещё не началась');
      b.status = 'noshow'; b.history.push({ at: Date.now(), s: 'noshow', by: ADMIN_BY }); return bookingView(db, b); });
  },
  /* Отмена позже чем за 3 часа: админ вводит сумму возврата (оплата минус фактические расходы) */
  async setPartialRefund(id, amount, note) {
    needAdmin(); await wait(120);
    return mutate(db => { const b = db.bookings.find(x => x.id === id);
      if (!b || b.status !== 'refund_partial') throw new PPError('STATE', 'Бронь не ожидает расчёта возврата');
      if (b.refundAmount != null) throw new PPError('STATE', 'Возврат уже рассчитан');
      const a = Math.round(Number(amount));
      if (!(a >= 0 && a <= b.amount)) throw new PPError('VALID', 'Сумма возврата — от 0 до ' + money(b.amount));
      b.refundAmount = refundAmount(db, b, a);
      b.history.push({ at: Date.now(), s: 'refund_partial', by: ADMIN_BY, note: 'Возврат ' + money(b.refundAmount) + ', удержано ' + money(b.amount - b.refundAmount) + (note ? ' — ' + note : '') });
      return bookingView(db, b); });
  },
  /* Услуга не оказана по вине Исполнителя — возврат 100% в любой момент */
  async refundFault(id, note) {
    needAdmin(); await wait(120);
    return mutate(db => { const b = db.bookings.find(x => x.id === id);
      if (!b || !(b.status === 'paid' || b.status === 'noshow' || b.status === 'refund_partial')) throw new PPError('STATE', 'Для этой брони возврат недоступен');
      if (b.status === 'refund_partial') { const left = b.amount - (b.refundAmount || 0); if (left > 0) refundAmount(db, b, left); b.refundAmount = b.amount; b.status = 'refunded'; b.history.push({ at: Date.now(), s: 'refunded', by: ADMIN_BY, note: 'Возврат 100% (вина Исполнителя)' + (note ? ': ' + note : '') }); }
      else refund(db, b, ADMIN_BY, 'Возврат 100% (вина Исполнителя)' + (note ? ': ' + note : ''));
      return bookingView(db, b); });
  },
  async createManualBooking(o) {
    needAdmin(); await wait(150); o = o || {};
    const phone = normPhone(o.phone); if (!phone) throw new PPError('PHONE', 'Проверьте номер телефона');
    const name = String(o.name || '').trim(); if (name.length < 2) throw new PPError('NAME', 'Укажите имя клиента');
    return mutate(db => {
      const s = db.settings, start = Number(o.start), dur = Number(o.dur);
      checkRange(db, o.date, start, dur, null, true);
      const players = Math.max(1, Math.min(s.maxPlayers, parseInt(o.players, 10) || 2));
      const rackets = Math.max(0, Math.min(players, parseInt(o.rackets, 10) || 0));
      const promo = o.promo ? findPromo(db, o.promo) : null;
      const q = quoteRaw(s, start, dur, rackets, promo);
      const amount = o.amount != null && o.amount !== '' ? Math.max(0, Math.round(Number(o.amount))) : q.total;
      const paid = o.pay === 'cash' || o.pay === 'terminal';
      const nb = { id: uid('bk'), number: 'PP-' + (++db.seq), userId: null, name: name, phone: phone, date: o.date, start: start, dur: dur, players: players, rackets: rackets, promo: promo ? promo.code : null, discount: q.discount, amount: amount, status: paid ? 'paid' : 'pending', code: paid ? String(100000 + Math.floor(Math.random() * 900000)) : null, createdAt: Date.now(), expiresAt: null, source: 'admin', paymentId: null, note: String(o.note || '').slice(0, 200), history: [{ at: Date.now(), s: 'pending', by: ADMIN_BY, note: 'Создано вручную' + (o.note ? ': ' + o.note : '') }] };
      const u = Object.keys(db.users).map(k => db.users[k]).find(x => x.phone === phone && !x.demo); if (u) nb.userId = u.id;
      if (paid) {
        const pay = { id: uid('pay'), bookingId: nb.id, amount: amount, method: o.pay, status: 'succeeded', createdAt: Date.now(), paidAt: Date.now(), cardMask: null, refundedAt: null };
        db.payments.push(pay); nb.paymentId = pay.id; nb.history.push({ at: Date.now(), s: 'paid', by: ADMIN_BY, note: PAY_METHOD[o.pay] });
        if (promo) promo.used++;
      }
      db.bookings.push(nb);
      return bookingView(db, nb);
    });
  },
  async confirmManualPayment(id, method) {
    needAdmin(); await wait(100);
    return mutate(db => { const b = db.bookings.find(x => x.id === id); if (!b || b.status !== 'pending') throw new PPError('STATE', 'Бронь не ожидает оплаты');
      const pay = { id: uid('pay'), bookingId: b.id, amount: b.amount, method: method === 'terminal' ? 'terminal' : 'cash', status: 'succeeded', createdAt: Date.now(), paidAt: Date.now(), cardMask: null, refundedAt: null };
      db.payments.push(pay); b.paymentId = pay.id; b.status = 'paid'; b.expiresAt = null; b.code = String(100000 + Math.floor(Math.random() * 900000));
      b.history.push({ at: Date.now(), s: 'paid', by: ADMIN_BY, note: PAY_METHOD[pay.method] }); return bookingView(db, b); });
  },
  async listBlocks() { needAdmin(); const db = load(); return db.blocks.filter(k => k.date >= ymd(addDays(new Date(), -1))).sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start).map(clone); },
  async createBlock(o) {
    needAdmin(); await wait(100);
    return mutate(db => { const s = db.settings, start = Number(o.start), end = Number(o.end);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date || '')) throw new PPError('VALID', 'Выберите дату');
      if (!(end > start) || start < s.open || end > s.close) throw new PPError('VALID', 'Проверьте интервал: ' + hhmm(s.open) + '–' + hhmm(s.close));
      const clash = db.bookings.filter(b => b.date === o.date && (b.status === 'paid' || b.status === 'pending') && start < b.start + b.dur && end > b.start);
      const k = { id: uid('blk'), date: o.date, start: start, end: end, reason: String(o.reason || 'Закрыто').slice(0, 80), createdAt: Date.now() };
      db.blocks.push(k); return { block: clone(k), clashes: clash.map(b => bookingView(db, b)) }; });
  },
  async deleteBlock(id) { needAdmin(); await wait(80); mutate(db => { db.blocks = db.blocks.filter(k => k.id !== id); }); return true; },
  async listPayments(f) {
    needAdmin(); await wait(60); f = f || {};
    const db = load();
    let list = db.payments.filter(p => p.status !== 'pending' || true).map(p => { const b = db.bookings.find(x => x.id === p.bookingId); const v = clone(p); v.booking = b ? { id: b.id, number: b.number, name: b.name, date: b.date, start: b.start, dur: b.dur } : null; return v; });
    if (f.from) list = list.filter(p => ymd(new Date(p.createdAt)) >= f.from);
    if (f.to) list = list.filter(p => ymd(new Date(p.createdAt)) <= f.to);
    if (f.status) list = list.filter(p => p.status === f.status);
    if (f.method) list = list.filter(p => p.method === f.method);
    list.sort((a, b) => b.createdAt - a.createdAt);
    const paid2 = list.filter(p => p.status === 'succeeded' || p.status === 'refunded' || p.status === 'partially_refunded');
    const refundedSum = p => p.refunded != null ? p.refunded : (p.status === 'refunded' ? p.amount : 0);
    const totals = { count: list.length, gross: paid2.reduce((a, p) => a + p.amount, 0), refunds: paid2.reduce((a, p) => a + refundedSum(p), 0), refundsCount: paid2.filter(p => refundedSum(p) > 0).length };
    totals.net = totals.gross - totals.refunds;
    totals.byMethod = {}; paid2.forEach(p => { totals.byMethod[p.method] = (totals.byMethod[p.method] || 0) + p.amount; });
    return { list: list, totals: totals };
  },
  async listClients(q) {
    needAdmin(); await wait(60);
    const db = load(), map = {}, td = today();
    db.bookings.forEach(b => {
      const k = clientKey(b); const c = map[k] || (map[k] = { phone: b.phone, phoneFmt: fmtPhone(b.phone), name: b.name, visits: 0, bookings: 0, sum: 0, last: null, next: null, cancels: 0, noshow: 0, hasCabinet: false });
      c.bookings++;
      if ((b.status === 'paid' || b.status === 'noshow' || b.status === 'refund_partial') && b.date <= td) { c.sum += paidTotal(b); if (b.status === 'paid') c.visits++; if (!c.last || b.date > c.last) c.last = b.date; }
      if (b.status === 'paid' && b.date >= td && (!c.next || b.date < c.next)) c.next = b.date;
      if (b.status === 'refunded' || b.status === 'cancelled') c.cancels++;
      if (b.status === 'noshow') c.noshow++;
    });
    Object.keys(db.users).forEach(k => { const u = db.users[k]; if (!u.demo && map[u.phone]) { map[u.phone].hasCabinet = true; map[u.phone].name = u.name || map[u.phone].name; } });
    let list = Object.keys(map).map(k => map[k]);
    const qq = norm(q).replace(/[\s()+-]/g, '');
    if (qq) list = list.filter(c => norm(c.name).replace(/\s/g, '').indexOf(qq) >= 0 || c.phone.indexOf(qq.replace(/^8/, '7')) >= 0);
    return list.sort((a, b) => b.sum - a.sum);
  },
  async getClient(phone) {
    needAdmin();
    const db = load(); const p = normPhone(phone) || phone;
    const all = await this.listClients('');
    const c = all.find(x => x.phone === p); if (!c) throw new PPError('NOTFOUND', 'Клиент не найден');
    c.history = db.bookings.filter(b => b.phone === p).sort((a, b) => b.date.localeCompare(a.date) || b.start - a.start).map(b => bookingView(db, b));
    const u = Object.keys(db.users).map(k => db.users[k]).find(x => x.phone === p && !x.demo);
    c.profile = u ? pubUser(u) : null;
    return c;
  },
  async listAllPosts() {
    needAdmin(); await wait(60);
    const db = load();
    return db.posts.slice().sort((a, b) => b.createdAt - a.createdAt).map(p => { const v = postView(db, p, null); v.reports = db.reports.filter(r => r.postId === p.id && r.status === 'new').length; v.responses = db.responses.filter(r => r.postId === p.id).length; return v; });
  },
  async hidePost(id, hidden) { needAdmin(); await wait(80); mutate(db => { const p = db.posts.find(x => x.id === id); if (!p) throw new PPError('NOTFOUND', 'Объявление не найдено'); p.hidden = !!hidden; if (hidden) db.reports.forEach(r => { if (r.postId === id && r.status === 'new') r.status = 'resolved'; }); }); return true; },
  async deletePost(id) { needAdmin(); await wait(80); mutate(db => { db.posts = db.posts.filter(x => x.id !== id); db.reports.forEach(r => { if (r.postId === id) r.status = 'resolved'; }); db.sims = db.sims.filter(s => s.postId !== id); }); return true; },
  async listReports() {
    needAdmin(); const db = load();
    return db.reports.slice().sort((a, b) => b.at - a.at).map(r => { const p = db.posts.find(x => x.id === r.postId); const by = r.by.indexOf('anon:') === 0 ? null : db.users[r.by]; return Object.assign(clone(r), { post: p ? postView(db, p, null) : null, byName: by ? by.name : 'Гость' }); });
  },
  async resolveReport(id) { needAdmin(); mutate(db => { const r = db.reports.find(x => x.id === id); if (r) r.status = 'resolved'; }); return true; },
  async listAllResponses() {
    needAdmin(); const db = load();
    return db.responses.slice().sort((a, b) => b.createdAt - a.createdAt).map(r => ({ id: r.id, status: r.status, message: r.message, when: r.when, createdAt: r.createdAt, from: pubUser(db.users[r.fromId]), to: pubUser(db.users[r.toId]), post: (db.posts.find(p => p.id === r.postId) || {}).text || '(удалено)' }));
  },
  async getSettings() { needAdmin(); const db = load(); return clone(db.settings); },
  async saveSettings(o) {
    needAdmin(); await wait(120);
    return mutate(db => {
      const s = db.settings, n = Object.assign({}, s);
      ['open', 'close', 'border', 'priceAm', 'pricePm', 'racket', 'minLeadMin', 'cancelHours', 'holdMin'].forEach(k => { if (o[k] != null && o[k] !== '') n[k] = Math.round(Number(o[k])); });
      if (!(n.open >= 0 && n.close <= 1440 && n.close - n.open >= 120)) throw new PPError('VALID', 'Проверьте часы работы');
      if (n.open % 30 || n.close % 30 || n.border % 30) throw new PPError('VALID', 'Время — с шагом 30 минут');
      if (!(n.border >= n.open && n.border <= n.close)) throw new PPError('VALID', 'Граница тарифа должна быть внутри часов работы');
      if (!(n.priceAm > 0 && n.pricePm > 0 && n.priceAm % 2 === 0 && n.pricePm % 2 === 0)) throw new PPError('VALID', 'Цены — положительные и чётные (считаем по получасам)');
      if (Array.isArray(o.rules)) n.rules = o.rules.map(x => String(x).trim()).filter(Boolean).slice(0, 12);
      db.settings = n; return clone(n);
    });
  },
  async listPromos() { needAdmin(); return clone(load().promos); },
  async savePromo(o) {
    needAdmin(); await wait(100);
    return mutate(db => {
      const code = String(o.code || '').trim().toUpperCase();
      if (!/^[A-ZА-Я0-9_-]{3,20}$/.test(code)) throw new PPError('VALID', 'Код: 3–20 символов, буквы и цифры');
      const type = o.type === 'rub' ? 'rub' : 'pct', value = Math.round(Number(o.value));
      if (!(value > 0) || (type === 'pct' && value > 90)) throw new PPError('VALID', 'Проверьте размер скидки');
      let p = db.promos.find(x => x.code === code);
      if (p && o.isNew) throw new PPError('VALID', 'Такой промокод уже есть');
      if (!p) { p = { code: code, used: 0, active: true }; db.promos.push(p); }
      p.type = type; p.value = value; p.limit = Math.max(0, parseInt(o.limit, 10) || 0); p.note = String(o.note || '').slice(0, 80);
      if ('active' in o) p.active = !!o.active;
      return clone(p);
    });
  },
  async togglePromo(code, active) { needAdmin(); mutate(db => { const p = db.promos.find(x => x.code === code); if (p) p.active = !!active; }); return true; },
  /* ---------- 152-ФЗ: журнал согласий, запросы субъектов, реестр документов ---------- */
  async listConsents(f) {
    needAdmin(); await wait(60); f = f || {};
    const db = load(); const q = norm(f.q).replace(/[\s()+-]/g, '');
    let list = db.consents.slice();
    if (f.docId) list = list.filter(e => e.docId === f.docId);
    if (f.version) list = list.filter(e => e.docVersion === f.version);
    if (f.action) list = list.filter(e => e.action === f.action);
    if (f.context) list = list.filter(e => e.context === f.context);
    if (f.from) list = list.filter(e => e.ts.slice(0, 10) >= f.from);
    if (f.to) list = list.filter(e => e.ts.slice(0, 10) <= f.to);
    if (f.subject) list = list.filter(e => e.subjectId === f.subject || (f.phone && e.phone === f.phone));
    if (q) list = list.filter(e => norm(e.name).replace(/\s/g, '').indexOf(q) >= 0 || String(e.phone).indexOf(q.replace(/^8/, '7')) >= 0 || norm(e.subjectId).indexOf(q) >= 0);
    return list.sort((a, b) => b.ts.localeCompare(a.ts)).map(e => Object.assign(clone(e), { docTitle: docById(e.docId) ? docById(e.docId).title : e.docId, actionLabel: CONSENT_ACTION[e.action], contextLabel: CONSENT_CONTEXT[e.context] || e.context, phoneFmt: e.phone ? fmtPhone(e.phone) : '' }));
  },
  async consentStats() {
    needAdmin(); const db = load();
    const users = Object.keys(db.users).map(k => db.users[k]).filter(u => !u.deletion);
    const outdatedUsers = users.filter(u => REG_DOCS.some(id => !hasCurrent(u, id)) || outdatedDocs(u).length);
    return {
      total: db.consents.length,
      accepted: db.consents.filter(e => e.action === 'accepted').length,
      revoked: db.consents.filter(e => e.action === 'revoked').length,
      changed: db.consents.filter(e => e.action === 'conditions_changed').length,
      usersOutdated: outdatedUsers.length, usersTotal: users.length,
      outdatedList: outdatedUsers.map(u => ({ id: u.id, name: u.name, phone: fmtPhone(u.phone), docs: DOCS.filter(d => REG_DOCS.indexOf(d.id) >= 0 && !hasCurrent(u, d.id)).map(d => d.title) })),
      requestsOpen: db.requests.filter(r => r.status === 'new').length,
      requestsOverdue: db.requests.filter(r => r.status === 'new' && r.deadline < Date.now()).length
    };
  },
  /* Все согласия одного субъекта: по id кабинета, гостевому id или телефону */
  async consentSubject(key) {
    needAdmin(); const db = load();
    const u = db.users[key] || Object.keys(db.users).map(k => db.users[k]).find(x => x.phone === normPhone(key));
    const phone = u ? u.phone : (normPhone(key) || (db.consents.find(e => e.subjectId === key) || {}).phone || '');
    const list = db.consents.filter(e => e.subjectId === key || (u && e.subjectId === u.id) || (phone && e.phone === phone)).sort((a, b) => b.ts.localeCompare(a.ts));
    return {
      user: u ? Object.assign(pubUser(u), { phone: fmtPhone(u.phone), ageGroup: u.ageGroup || 'adult', guardian: u.guardian || null, deletion: u.deletion || null, consents: clone(u.consents || {}) }) : null,
      name: u ? u.name : (list[0] || {}).name || '', phone: phone ? fmtPhone(phone) : '',
      entries: list.map(e => Object.assign(clone(e), { docTitle: docById(e.docId) ? docById(e.docId).title : e.docId, actionLabel: CONSENT_ACTION[e.action], contextLabel: CONSENT_CONTEXT[e.context] || e.context })),
      requests: db.requests.filter(r => r.subjectId === key || (phone && r.phone === phone)).map(clone)
    };
  },
  async listSubjectRequests() {
    needAdmin(); const db = load(), now = Date.now();
    return db.requests.slice().sort((a, b) => (a.status === b.status ? a.deadline - b.deadline : a.status === 'new' ? -1 : 1)).map(r => Object.assign(clone(r), { overdue: r.status === 'new' && r.deadline < now, daysLeft: Math.ceil((r.deadline - now) / 864e5), rule: REQUEST_TYPES[r.type] ? REQUEST_TYPES[r.type].days + (REQUEST_TYPES[r.type].business ? ' раб. дн.' : ' дн.') : '' }));
  },
  async resolveSubjectRequest(id, note) {
    needAdmin(); await wait(80);
    mutate(db => { const r = db.requests.find(x => x.id === id); if (!r) throw new PPError('NOTFOUND', 'Запрос не найден'); r.status = 'done'; r.doneAt = Date.now(); if (note) r.note = (r.note ? r.note + '. ' : '') + String(note).slice(0, 200); });
    return true;
  },
  /* Реестр документов: текущая редакция и сколько субъектов её подтвердили (последняя запись по субъекту — не отзыв) */
  async docRegistry() {
    needAdmin(); const db = load();
    return DOCS.map(d => {
      const last = {};
      db.consents.filter(e => e.docId === d.id).sort((a, b) => a.ts.localeCompare(b.ts)).forEach(e => { last[e.subjectId] = e; });
      const subs = Object.keys(last).map(k => last[k]);
      return Object.assign({}, d, { forLabel: d.for.map(x => CONSENT_CONTEXT[x] || x), confirmedCurrent: subs.filter(e => e.action !== 'revoked' && e.docVersion === d.version).length, confirmedOld: subs.filter(e => e.action !== 'revoked' && e.docVersion !== d.version).length, revoked: subs.filter(e => e.action === 'revoked').length });
    });
  },
  async resetDemo() { needAdmin(); sdel(KEY); cacheRaw = null; cacheDb = null; load(); emit(); return true; }
};

/* =====================================================================
   Общие элементы интерфейса
   ===================================================================== */
const CSS = `
.pp-sheet{position:fixed;inset:0;z-index:110;display:grid;place-items:center;padding:24px;background:rgba(3,4,10,.8);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);opacity:0;transition:opacity .25s}
.pp-sheet.open{opacity:1}
.pp-sheet-box{position:relative;width:min(var(--w,540px),100%);max-height:calc(100vh - 48px);max-height:calc(100dvh - 48px);display:flex;flex-direction:column;border-radius:26px;background:radial-gradient(90% 50% at 100% 0%,rgba(255,46,99,.12),transparent 60%),#0f1124;box-shadow:0 0 0 1.5px rgba(255,46,99,.7),0 0 70px -12px rgba(255,46,99,.5);transform:translateY(16px) scale(.98);transition:transform .3s cubic-bezier(.2,.8,.2,1)}
.pp-sheet.open .pp-sheet-box{transform:none}
.pp-sheet-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:22px 20px 16px 26px;border-bottom:1px solid var(--line)}
.pp-sheet-head b{display:block;font-family:var(--display);font-weight:700;font-size:19px;line-height:1.2}
.pp-sheet-head span{display:block;font-size:14px;color:var(--muted);margin-top:4px;line-height:1.45}
.pp-x{flex-shrink:0;width:42px;height:42px;border-radius:50%;border:0;background:rgba(255,255,255,.07);cursor:pointer;font-size:24px;line-height:1;color:var(--ink)}
.pp-x:hover{background:var(--neon)}
.pp-sheet-body{padding:22px 26px 26px;overflow:auto;overscroll-behavior:contain}
.pp-f{display:grid;gap:8px;margin-bottom:18px}
.pp-l{font-size:12.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.pp-l small{text-transform:none;letter-spacing:0;font-weight:600;color:var(--dim)}
.pp-i{width:100%;padding:14px 16px;border-radius:14px;border:0;background:rgba(255,255,255,.045);box-shadow:inset 0 0 0 1px var(--line);color:var(--ink);font:600 16px/1.4 var(--text);transition:box-shadow .2s,background .2s}
.pp-i::placeholder{color:#5f648a;font-weight:500}
.pp-i:focus{outline:none;background:rgba(255,255,255,.06);box-shadow:inset 0 0 0 1.5px var(--violet),0 0 0 4px rgba(143,155,255,.14)}
.pp-i[aria-invalid=true]{box-shadow:inset 0 0 0 1.5px var(--neon)}
textarea.pp-i{resize:vertical;min-height:108px}
select.pp-i{appearance:none;-webkit-appearance:none;cursor:pointer;padding-right:40px;background-image:linear-gradient(45deg,transparent 50%,var(--muted) 50%),linear-gradient(135deg,var(--muted) 50%,transparent 50%);background-position:calc(100% - 20px) 50%,calc(100% - 15px) 50%;background-size:5px 5px;background-repeat:no-repeat}
select.pp-i option{background:#12152a;color:var(--ink)}
.pp-h{font-size:13px;color:var(--dim);line-height:1.45}
.pp-h b{color:var(--ball-hot)}
.pp-row{display:flex;justify-content:space-between;align-items:center;gap:10px}
.pp-cnt{font-size:12.5px;color:var(--dim);font-variant-numeric:tabular-nums}
.pp-cnt.over{color:var(--neon)}
.pp-e{padding:11px 14px;border-radius:12px;background:rgba(255,46,99,.1);box-shadow:inset 0 0 0 1px rgba(255,46,99,.4);color:#ffc2d1;font-size:14px;line-height:1.45;margin-bottom:16px}
.pp-e:empty{display:none}
.pp-ok{padding:12px 14px;border-radius:12px;background:rgba(61,255,168,.08);box-shadow:inset 0 0 0 1px rgba(61,255,168,.35);color:#c9ffe6;font-size:14.5px;line-height:1.5}
.pp-chips{display:flex;flex-wrap:wrap;gap:8px}
.pp-chip{position:relative;display:inline-flex}
.pp-chip input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.pp-chip span{display:inline-flex;align-items:center;gap:6px;padding:10px 15px;border-radius:999px;background:rgba(255,255,255,.035);box-shadow:inset 0 0 0 1px var(--line);font-weight:700;font-size:14px;line-height:1.1;color:var(--muted);cursor:pointer;transition:background .2s,box-shadow .2s,color .2s;user-select:none}
.pp-chip span small{font-weight:600;font-size:12px;opacity:.75}
.pp-chip:hover span{color:var(--ink)}
.pp-chip input:checked+span{background:rgba(255,46,99,.12);color:#fff;box-shadow:inset 0 0 0 1.5px var(--neon),0 0 16px -6px var(--neon)}
.pp-chip input:focus-visible+span{outline:2px solid var(--ball-hot);outline-offset:2px}
.pp-chip input:disabled+span{opacity:.35;cursor:not-allowed}
.pp-chips.days .pp-chip span{min-width:48px;justify-content:center;padding:10px 0}
.pp-check{display:flex;gap:12px;align-items:flex-start;font-size:14.5px;color:#c6c8e2;line-height:1.45;cursor:pointer}
.pp-check input{flex-shrink:0;width:20px;height:20px;margin:1px 0 0;accent-color:var(--neon)}
.pp-check a{color:var(--ball-hot)}
.pp-ava{--c:#8f9bff;--s:56px;position:relative;flex-shrink:0;width:var(--s);height:var(--s);border-radius:32%;padding:2px;background:linear-gradient(140deg,var(--c),rgba(255,255,255,.08) 55%,var(--c));box-shadow:0 0 20px -5px var(--c)}
.pp-ava img{width:100%;height:100%;object-fit:cover;border-radius:30%;border:2px solid #0b0c18;background:#0b0c18;display:block}
.pp-ava.round,.pp-ava.round img{border-radius:50%}
.pp-lv{--c:#8f9bff;display:inline-flex;align-items:center;gap:7px;font-size:11.5px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--c);white-space:nowrap}
.pp-lv::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--c);box-shadow:0 0 8px var(--c)}
.pp-badge{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 6px;border-radius:99px;background:var(--neon);color:#fff;font:800 11.5px/1 var(--text);box-shadow:0 0 12px rgba(255,46,99,.8),0 0 0 2px var(--bg)}
.pp-badge[hidden]{display:none}
.pp-link{border:0;background:none;padding:0;cursor:pointer;font:600 13px var(--text);color:var(--dim);text-decoration:underline;text-decoration-color:rgba(255,255,255,.2);text-underline-offset:3px}
.pp-link:hover{color:var(--ink)}
.pp-link.danger:hover{color:var(--neon)}
.btn.calm{animation:none}
.btn[disabled]{opacity:.5;cursor:not-allowed;transform:none}
.btn.loading{pointer-events:none;opacity:.75}
.btn.loading::after{content:"";width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:ppspin .7s linear infinite}
@keyframes ppspin{to{transform:rotate(360deg)}}
.pp-contacts{display:flex;flex-wrap:wrap;gap:8px}
.pp-contacts a{display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:99px;text-decoration:none;font-weight:700;font-size:14px;background:rgba(61,255,168,.08);box-shadow:inset 0 0 0 1px rgba(61,255,168,.4);color:#c9ffe6}
.pp-contacts a:hover{background:rgba(61,255,168,.16)}
.pp-contacts svg{width:16px;height:16px}
.pp-toasts{position:fixed;right:24px;bottom:24px;z-index:130;display:grid;gap:10px;width:min(380px,calc(100vw - 24px));pointer-events:none}
.pp-toast{pointer-events:auto;display:flex;gap:12px;align-items:center;padding:14px 14px 14px 18px;border-radius:18px;background:rgba(20,22,44,.96);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),0 0 0 1px rgba(255,46,99,.35),0 20px 50px -12px rgba(0,0,0,.8),0 0 30px -10px rgba(255,46,99,.6);font-size:14.5px;line-height:1.4;animation:pptin .4s cubic-bezier(.2,.8,.2,1)}
.pp-toast.ok{box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),0 0 0 1px rgba(61,255,168,.4),0 20px 50px -12px rgba(0,0,0,.8)}
.pp-toast.err{box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),0 0 0 1.5px rgba(255,46,99,.7),0 20px 50px -12px rgba(0,0,0,.8)}
.pp-toast i{flex-shrink:0;width:10px;height:10px;border-radius:50%;background:var(--neon);box-shadow:0 0 10px var(--neon)}
.pp-toast.ok i{background:#3dffa8;box-shadow:0 0 10px #3dffa8}
.pp-toast p{margin:0;flex:1}
.pp-toast a,.pp-toast button{flex-shrink:0;border:0;background:rgba(255,255,255,.08);color:var(--ball-hot);font:700 13px var(--text);padding:8px 12px;border-radius:99px;text-decoration:none;cursor:pointer}
.pp-toast.out{opacity:0;transform:translateY(10px);transition:opacity .3s,transform .3s}
@keyframes pptin{from{opacity:0;transform:translateY(14px)}}
.cab-btn{position:relative;display:inline-flex;align-items:center;gap:10px;height:44px;padding:0 16px 0 6px;border-radius:999px;text-decoration:none;font-weight:700;font-size:14px;background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px var(--line);white-space:nowrap;flex-shrink:0;transition:box-shadow .2s,color .2s;color:var(--ink)}
.cab-btn:hover{box-shadow:inset 0 0 0 1px var(--ball-hot);color:var(--ball-hot)}
.cab-btn .cab-ico{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:rgba(255,46,99,.14);color:var(--neon)}
.cab-btn .cab-ico svg{width:17px;height:17px}
.cab-btn img{width:32px;height:32px;border-radius:50%;object-fit:cover;box-shadow:0 0 0 2px var(--neon),0 0 12px -2px var(--neon)}
.cab-btn .cab-name{max-width:110px;overflow:hidden;text-overflow:ellipsis}
.cab-btn .pp-badge{position:absolute;top:-5px;right:-5px}
.pp-auth-step[hidden]{display:none}
.pp-demo{display:flex;gap:10px;align-items:center;padding:11px 14px;border-radius:12px;background:rgba(245,166,35,.08);box-shadow:inset 0 0 0 1px rgba(245,166,35,.35);color:#ffe2b0;font-size:13.5px;line-height:1.4;margin-bottom:16px}
.pp-demo b{font-family:var(--display);letter-spacing:.2em;color:var(--ball-hot)}
.pp-code{font-family:var(--display);font-size:24px;letter-spacing:.5em;text-align:center;padding-left:.5em}
.pp-sheet-foot{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.pp-sheet-foot .btn{flex:1 1 auto}
.pp-fs{border:0;padding:0;margin:0 0 14px;gap:10px}
.pp-fs legend{margin-bottom:10px;padding:0}
.pp-guard{padding:16px 16px 2px;border-radius:16px;background:rgba(143,155,255,.06);box-shadow:inset 0 0 0 1px rgba(143,155,255,.25);margin-bottom:16px}
.pp-consents{display:grid;gap:12px;margin:4px 0 14px;padding:16px;border-radius:16px;background:rgba(255,255,255,.025);box-shadow:inset 0 0 0 1px var(--line)}
.pp-consents .pp-check{font-size:14px}
.pp-ver{color:var(--dim);font-size:12px;white-space:nowrap}
.pp-miss{margin:0 0 12px;color:#ffc2d1}
.pp-miss:empty{display:none}
.pp-docview iframe{display:block;width:100%;height:min(68vh,760px);border:0;border-radius:14px;background:#0d0f1c;box-shadow:inset 0 0 0 1px var(--line)}
.pp-docupd{list-style:none;margin:0 0 16px;padding:0;display:grid;gap:8px}
.pp-docupd li{display:grid;gap:2px;padding:12px 14px;border-radius:12px;background:rgba(245,166,35,.07);box-shadow:inset 0 0 0 1px rgba(245,166,35,.3)}
.pp-docupd span{font-size:13px;color:var(--muted)}
.pp-docupd a{color:var(--ball-hot)}
.pp-cset{display:grid;gap:10px}
.pp-tog{display:flex;gap:14px;align-items:flex-start;padding:14px 16px;border-radius:14px;background:rgba(255,255,255,.03);box-shadow:inset 0 0 0 1px var(--line);cursor:pointer}
.pp-tog input{flex-shrink:0;width:20px;height:20px;margin:2px 0 0;accent-color:var(--neon)}
.pp-tog b{display:block;font-size:15px}
.pp-tog small{display:block;color:var(--muted);font-size:13px;line-height:1.45;margin-top:2px}
.pp-cookie{position:fixed;left:24px;bottom:24px;z-index:120;width:min(460px,calc(100vw - 48px));padding:18px 18px 16px;border-radius:20px;background:rgba(15,17,36,.97);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:inset 0 0 0 1px rgba(255,255,255,.12),0 0 0 1px rgba(143,155,255,.3),0 24px 60px -16px rgba(0,0,0,.9);animation:pptin .4s cubic-bezier(.2,.8,.2,1)}
.pp-cookie p{margin:0 0 14px;font-size:14px;line-height:1.5;color:#c6c8e2}
.pp-cookie p a{color:var(--ball-hot)}
.pp-cookie-b{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
@media (max-width:640px){
  .pp-cookie{left:12px;right:12px;width:auto;bottom:calc(84px + env(safe-area-inset-bottom));padding:16px}
  .pp-cookie-b .btn{flex:1 1 auto}
  .pp-sheet{padding:0;place-items:end stretch}
  .pp-sheet-box{width:100%;max-height:94vh;max-height:94dvh;border-radius:24px 24px 0 0;box-shadow:0 -1px 0 rgba(255,46,99,.7),0 -20px 60px -20px rgba(255,46,99,.4);transform:translateY(40px)}
  .pp-sheet-head{padding:18px 16px 14px 20px}
  .pp-sheet-body{padding:18px 20px calc(22px + env(safe-area-inset-bottom))}
  .pp-toasts{right:12px;left:12px;width:auto;bottom:calc(84px + env(safe-area-inset-bottom))}
  .cab-btn{padding:0;width:44px;justify-content:center}
  .cab-btn .cab-name{display:none}
  .cab-btn .cab-ico{background:none}
}
@media (prefers-reduced-motion:reduce){.pp-sheet,.pp-sheet-box,.pp-toast{transition:none;animation:none}}
`;
function injectCSS() {
  if (document.getElementById('pp-shared-css')) return;
  const st = document.createElement('style'); st.id = 'pp-shared-css'; st.textContent = CSS;
  (document.head || document.documentElement).appendChild(st);
}
injectCSS();

const ICON = {
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>',
  tg: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21.9 4.3 18.7 19.4c-.2 1.1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.3-5 9.2-8.3c.4-.4-.1-.6-.6-.2L6.2 13 1.3 11.5c-1.1-.3-1.1-1.1.2-1.6l19-7.3c.9-.3 1.7.2 1.4 1.7z"/></svg>'
};

const $ = (s, c) => (c || document).querySelector(s);
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type=hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

let sheetStack = [];
function sheet(opts) {
  const wrap = document.createElement('div');
  wrap.className = 'pp-sheet';
  wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
  const tid = uid('st');
  wrap.setAttribute('aria-labelledby', tid);
  wrap.innerHTML = '<div class="pp-sheet-box" style="--w:' + (opts.width || 540) + 'px"><div class="pp-sheet-head"><div><b id="' + tid + '"></b><span></span></div><button class="pp-x" type="button" aria-label="Закрыть">×</button></div><div class="pp-sheet-body"></div></div>';
  $('b', wrap).textContent = opts.title || '';
  const sub = $('.pp-sheet-head span', wrap); if (opts.sub) sub.textContent = opts.sub; else sub.remove();
  const body = $('.pp-sheet-body', wrap);
  if (typeof opts.body === 'string') body.innerHTML = opts.body; else if (opts.body) body.appendChild(opts.body);
  const prevFocus = document.activeElement;
  const prevOverflow = document.documentElement.style.overflow;
  document.body.appendChild(wrap);
  document.documentElement.style.overflow = 'hidden';
  requestAnimationFrame(() => wrap.classList.add('open'));
  let closed = false;
  const api = {
    el: wrap, body: body,
    setTitle(t, s) { $('b', wrap).textContent = t; let sp = $('.pp-sheet-head span', wrap); if (s) { if (!sp) { sp = document.createElement('span'); $('b', wrap).after(sp); } sp.textContent = s; } else if (sp) sp.remove(); },
    close(reason) {
      if (closed) return; closed = true;
      wrap.classList.remove('open');
      sheetStack = sheetStack.filter(x => x !== api);
      setTimeout(() => wrap.remove(), 260);
      if (!sheetStack.length) document.documentElement.style.overflow = prevOverflow === 'hidden' ? '' : prevOverflow;
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) try { prevFocus.focus({ preventScroll: true }); } catch (e) {}
      if (opts.onClose) opts.onClose(reason);
    },
    focusFirst() { const f = body.querySelector('[autofocus]') || body.querySelector(FOCUSABLE) || $('.pp-x', wrap); if (f) f.focus(); }
  };
  sheetStack.push(api);
  $('.pp-x', wrap).addEventListener('click', () => api.close('x'));
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) api.close('backdrop'); });
  wrap.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); api.close('esc'); }
    if (e.key === 'Tab') {
      const f = Array.prototype.filter.call(wrap.querySelectorAll(FOCUSABLE), el => el.offsetParent !== null || el === document.activeElement);
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  setTimeout(() => api.focusFirst(), 60);
  return api;
}

let toastBox = null;
function toast(text, o) {
  o = o || {};
  if (!toastBox) { toastBox = document.createElement('div'); toastBox.className = 'pp-toasts'; toastBox.setAttribute('aria-live', 'polite'); document.body.appendChild(toastBox); }
  const t = document.createElement('div');
  t.className = 'pp-toast' + (o.kind === 'ok' ? ' ok' : o.kind === 'err' ? ' err' : '');
  t.innerHTML = '<i></i><p></p>';
  $('p', t).textContent = text;
  if (o.href) { const a = document.createElement('a'); a.href = o.href; a.textContent = o.action || 'Открыть'; t.appendChild(a); }
  else if (o.onAction) { const b = document.createElement('button'); b.type = 'button'; b.textContent = o.action || 'OK'; b.addEventListener('click', () => { o.onAction(); hide(); }); t.appendChild(b); }
  toastBox.appendChild(t);
  let tm = setTimeout(hide, o.ms || 6500);
  t.addEventListener('mouseenter', () => clearTimeout(tm));
  t.addEventListener('mouseleave', () => { tm = setTimeout(hide, 2500); });
  function hide() { t.classList.add('out'); setTimeout(() => t.remove(), 320); }
  return hide;
}
global.addEventListener('pp:notify', e => { const d = e.detail || {}; toast(d.text, { href: d.href, action: d.action, kind: 'ok', ms: 9000 }); });

function maskPhone(v) {
  const raw = String(v || '');
  let d = raw.replace(/\D/g, '');
  if (raw.trim().indexOf('+7') === 0) d = d.slice(1); else if (/^[78]/.test(d) && d.length > 10) d = d.slice(1); else if (d.length === 11 && /^[78]/.test(d)) d = d.slice(1);
  d = d.slice(0, 10);
  let s = '+7';
  if (d.length) s += ' (' + d.slice(0, 3);
  if (d.length > 3) s += ') ' + d.slice(3, 6);
  if (d.length > 6) s += '-' + d.slice(6, 8);
  if (d.length > 8) s += '-' + d.slice(8, 10);
  return s;
}
function bindPhoneMask(inp) {
  inp.addEventListener('focus', () => { if (!inp.value) inp.value = '+7 ('; });
  inp.addEventListener('blur', () => { if (inp.value.replace(/\D/g, '').length <= 1) inp.value = ''; });
  inp.addEventListener('input', () => {
    const v = inp.value;
    let d = v.replace(/\D/g, '');
    if (v.trim().indexOf('+7') !== 0 && /^[78]/.test(d) && d.length >= 1 && d.length <= 11 && !/^\+/.test(v.trim())) {
      // вставили «8 903…» или «7903…» — первая цифра — код страны
      if (d.length === 11) d = d.slice(1); else if (d.length > 1 && d[0] === '8') d = d.slice(1);
      inp.value = maskPhone('+7' + d);
    } else inp.value = maskPhone(v);
  });
}

/* Фото: квадратная обрезка по центру (с небольшим смещением вверх — там обычно лицо) и сжатие в JPEG ~400px */
function compressImage(file, size) {
  size = size || 400;
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(new PPError('PHOTO', 'Нужна картинка: JPG, PNG или WebP'));
    if (file.size > 20 * 1024 * 1024) return reject(new PPError('PHOTO', 'Файл больше 20 МБ — выберите фото поменьше'));
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight, s = Math.min(w, h);
        const sx = (w - s) / 2, sy = h > w ? (h - s) * 0.3 : (h - s) / 2;
        const c = document.createElement('canvas'); c.width = c.height = size;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#0b0c18'; ctx.fillRect(0, 0, size, size);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
        let q = 0.84, out = c.toDataURL('image/jpeg', q);
        while (out.length > 110000 && q > 0.45) { q -= 0.1; out = c.toDataURL('image/jpeg', q); }
        URL.revokeObjectURL(url);
        resolve(out);
      } catch (e) { URL.revokeObjectURL(url); reject(new PPError('PHOTO', 'Не получилось обработать фото')); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new PPError('PHOTO', 'Не получилось открыть файл — попробуйте другой')); };
    img.src = url;
  });
}

/* ---------- Документы: ссылки, просмотрщик, группы согласий ---------- */
function docLink(id, text) { const d = docById(id); return '<a href="' + esc(d.file) + '" data-doc="' + d.id + '" target="_blank" rel="noopener">' + esc(text || d.title) + '</a>'; }
/* Просмотр документа в модалке (iframe) с кнопкой «Открыть в новой вкладке» */
function openDoc(id, hash) {
  const d = docById(id); if (!d) return;
  const box = document.createElement('div');
  box.className = 'pp-docview';
  box.innerHTML = '<iframe title="' + esc(d.title) + '" src="' + esc(d.file + (hash || '')) + '"></iframe><div class="pp-row" style="margin-top:12px;flex-wrap:wrap"><span class="pp-h">Редакция ' + esc(d.version) + ' от ' + esc(d.date.split('-').reverse().join('.')) + '</span><a class="pp-link" href="' + esc(d.file + (hash || '')) + '" target="_blank" rel="noopener">Открыть в новой вкладке</a></div>';
  sheet({ title: d.title, body: box, width: 900 });
}
document.addEventListener('click', e => {
  const a = e.target.closest && e.target.closest('a[data-doc]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return;
  e.preventDefault();
  const h = (a.getAttribute('href') || '').split('#')[1];
  openDoc(a.getAttribute('data-doc'), h ? '#' + h : '');
});
/* Отдельный чекбокс на каждый документ, не отмечен заранее. Возвращает {el, ok(), values(), missing(), onChange} */
function consentChecks(ids, o) {
  o = o || {};
  const el = document.createElement('div');
  el.className = 'pp-consents';
  el.innerHTML = ids.map(id => {
    const d = docById(id);
    const txt = esc(d.check).replace(/\{([^}]+)\}/, (m, t) => '</span>' + docLink(id, t.replace(/&amp;/g, '&')) + '<span>');
    return '<label class="pp-check"><input type="checkbox" data-consent="' + id + '"' + (o.required === false ? '' : ' required') + '> <span><span>' + txt + '</span> <small class="pp-ver">ред. ' + esc(d.version) + '</small></span></label>';
  }).join('');
  const boxes = Array.prototype.slice.call(el.querySelectorAll('input'));
  const api = {
    el: el,
    values() { const v = {}; boxes.forEach(b => { v[b.getAttribute('data-consent')] = b.checked; }); return v; },
    missing() { return boxes.filter(b => !b.checked).map(b => docById(b.getAttribute('data-consent'))); },
    ok() { return boxes.every(b => b.checked); },
    reset() { boxes.forEach(b => { b.checked = false; }); }
  };
  boxes.forEach(b => b.addEventListener('change', () => { if (o.onChange) o.onChange(api); }));
  return api;
}
const SHORT_DOC = { consent_pd: 'согласие на обработку ПД', policy: 'ознакомление с Политикой', community_rules: 'Правила сообщества', consent_public: 'согласие на распространение', offer: 'ознакомление с офертой', cookies: 'политику cookie' };
function missingHint(list, extra) {
  const a = list.map(d => SHORT_DOC[d.id] || d.title); let t = a.length ? 'Чтобы продолжить, отметьте: ' + a.join(', ') + '.' : '';
  if (extra && extra.length) t += (t ? ' ' : '') + 'Заполните: ' + extra.join(', ') + '.';
  return t;
}

/* ---------- Вход / регистрация: телефон → код (демо 1234) → имя, возраст и согласия для новых ---------- */
function authForm(container, o) {
  o = o || {};
  const id = uid('au');
  container.innerHTML =
    '<form class="pp-auth-step" data-step="phone" novalidate>' +
      (o.reason ? '<p class="pp-h" style="margin:0 0 16px;font-size:15px;color:var(--muted)">' + esc(o.reason) + '</p>' : '') +
      '<div class="pp-e" role="alert"></div>' +
      '<div class="pp-f"><label class="pp-l" for="' + id + 'p">Телефон</label><input class="pp-i" id="' + id + 'p" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 (900) 000-00-00" required autofocus></div>' +
      '<button class="btn btn-main calm" type="submit" style="width:100%">Получить код</button>' +
      '<p class="pp-h" style="margin:14px 0 0">Телефон не показывается другим игрокам без вашего разрешения.</p>' +
    '</form>' +
    '<form class="pp-auth-step" data-step="code" hidden novalidate>' +
      '<div class="pp-demo"><span>Демо-режим: СМС не отправляется. Код — <b>' + DEMO_CODE + '</b></span></div>' +
      '<p class="pp-h" data-sent style="margin:0 0 14px;font-size:14.5px;color:var(--muted)"></p>' +
      '<div class="pp-f"><label class="pp-l" for="' + id + 'c">Код из СМС</label><input class="pp-i pp-code" id="' + id + 'c" inputmode="numeric" autocomplete="one-time-code" maxlength="4" pattern="[0-9]*" required></div>' +
      '<div data-new hidden>' +
        '<div class="pp-f"><label class="pp-l" for="' + id + 'n">Как вас зовут</label><input class="pp-i" id="' + id + 'n" autocomplete="given-name" maxlength="40" placeholder="Имя"></div>' +
        '<fieldset class="pp-f pp-fs"><legend class="pp-l">Возраст</legend>' +
          '<label class="pp-check"><input type="radio" name="' + id + 'age" value="adult"> <span>Мне есть 18 лет</span></label>' +
          '<label class="pp-check"><input type="radio" name="' + id + 'age" value="minor"> <span>Мне 14–17 лет, мой законный представитель согласен</span></label>' +
        '</fieldset>' +
        '<div data-guardian hidden class="pp-guard">' +
          '<p class="pp-h" style="margin:0 0 12px">Данные родителя или другого законного представителя — сохраним их вместе с согласием.</p>' +
          '<div class="pp-f"><label class="pp-l" for="' + id + 'gf">ФИО представителя</label><input class="pp-i" id="' + id + 'gf" autocomplete="off" maxlength="80" placeholder="Фамилия Имя Отчество"></div>' +
          '<div class="pp-f"><label class="pp-l" for="' + id + 'gp">Телефон представителя</label><input class="pp-i" id="' + id + 'gp" type="tel" inputmode="tel" placeholder="+7 (900) 000-00-00"></div>' +
        '</div>' +
        '<div data-consents></div>' +
      '</div>' +
      '<div class="pp-e" role="alert"></div>' +
      '<p class="pp-h pp-miss" data-miss aria-live="polite"></p>' +
      '<button class="btn btn-main calm" type="submit" style="width:100%">Войти</button>' +
      '<div class="pp-row" style="margin-top:14px"><button class="pp-link" type="button" data-back>Изменить номер</button></div>' +
    '</form>';
  const f1 = container.querySelector('[data-step=phone]'), f2 = container.querySelector('[data-step=code]');
  const ph = f1.querySelector('input'), code = f2.querySelector('.pp-code'), nm = f2.querySelector('#' + id + 'n');
  const gBox = f2.querySelector('[data-guardian]'), gFio = f2.querySelector('#' + id + 'gf'), gPh = f2.querySelector('#' + id + 'gp');
  const submit2 = f2.querySelector('[type=submit]'), miss = f2.querySelector('[data-miss]');
  const cons = consentChecks(REG_DOCS, { onChange: validate });
  f2.querySelector('[data-consents]').appendChild(cons.el);
  bindPhoneMask(ph); bindPhoneMask(gPh);
  if (o.phone) ph.value = maskPhone(o.phone);
  let isNew = false;
  const age = () => { const r = f2.querySelector('input[name="' + id + 'age"]:checked'); return r ? r.value : null; };
  f2.querySelectorAll('input[name="' + id + 'age"]').forEach(r => r.addEventListener('change', () => { gBox.hidden = age() !== 'minor'; validate(); }));
  [nm, gFio, gPh, code].forEach(i => i.addEventListener('input', validate));
  /* Кнопка неактивна, пока не отмечены обязательные пункты; подсказка — чего не хватает */
  function validate() {
    if (!isNew) { submit2.disabled = code.value.trim().length < 4; miss.textContent = ''; return; }
    const extra = [];
    if (nm.value.trim().length < 2) extra.push('имя');
    if (!age()) extra.push('возраст');
    if (age() === 'minor' && (gFio.value.trim().split(/\s+/).length < 2 || !normPhone(gPh.value))) extra.push('данные представителя');
    if (code.value.trim().length < 4) extra.push('код из СМС');
    const m = cons.missing();
    submit2.disabled = !!(m.length || extra.length);
    miss.textContent = submit2.disabled ? missingHint(m, extra) : '';
  }
  const err = (f, m) => { f.querySelector('.pp-e').textContent = m || ''; };
  const busy = (f, on) => { const b = f.querySelector('[type=submit]'); b.classList.toggle('loading', on); if (on) b.disabled = true; };
  f1.addEventListener('submit', async e => {
    e.preventDefault(); err(f1);
    busy(f1, true);
    try {
      const r = await CommunityAPI.requestCode(ph.value);
      isNew = !r.exists;
      f2.querySelector('[data-new]').hidden = !isNew;
      submit2.textContent = isNew ? 'Создать кабинет' : 'Войти';
      f2.querySelector('[data-sent]').textContent = (isNew ? 'Новый игрок — создадим кабинет. ' : 'С возвращением! ') + 'Код отправлен на ' + fmtPhone(normPhone(ph.value)) + '.';
      f1.hidden = true; f2.hidden = false; code.value = ''; validate(); code.focus();
    } catch (x) { err(f1, x.message); ph.setAttribute('aria-invalid', 'true'); ph.focus(); }
    busy(f1, false); f1.querySelector('[type=submit]').disabled = false;
  });
  ph.addEventListener('input', () => ph.removeAttribute('aria-invalid'));
  f2.querySelector('[data-back]').addEventListener('click', () => { f2.hidden = true; f1.hidden = false; ph.focus(); });
  f2.addEventListener('submit', async e => {
    e.preventDefault(); err(f2); validate();
    if (submit2.disabled) return;
    busy(f2, true);
    try {
      const u = isNew
        ? await CommunityAPI.register({ phone: ph.value, code: code.value, name: nm.value, ageGroup: age(), guardian: age() === 'minor' ? { fio: gFio.value, phone: gPh.value } : null, consents: cons.values(), context: o.context })
        : await CommunityAPI.login({ phone: ph.value, code: code.value });
      if (o.onDone) o.onDone(u, isNew);
    } catch (x) { err(f2, x.message); (x.code === 'NAME' ? nm : x.code === 'GUARDIAN' ? gFio : code).focus(); }
    busy(f2, false); validate();
  });
}
function openAuth(o) {
  o = o || {};
  return new Promise(resolve => {
    let done = null;
    const box = document.createElement('div');
    const sh = sheet({ title: o.title || 'Вход в кабинет игрока', sub: 'По номеру телефона — без паролей', body: box, width: 500, onClose: () => resolve(done) });
    authForm(box, { reason: o.reason, phone: o.phone, context: o.context, onDone: (u, isNew) => { done = u; toast(isNew ? 'Кабинет создан. Добро пожаловать, ' + u.name + '!' : 'Вы вошли как ' + u.name, { kind: 'ok' }); sh.close('done'); setTimeout(checkDocUpdates, 400); } });
  });
}

/* ---------- «Документ обновлён»: повторное подтверждение новой редакции ---------- */
let docUpdOpen = false;
function checkDocUpdates(o) {
  o = o || {};
  const me = CommunityAPI.meSync();
  if (!me || me.deletion || docUpdOpen) return false;
  const list = CommunityAPI.outdatedDocsSync();
  if (!list.length) return false;
  docUpdOpen = true;
  const box = document.createElement('div');
  box.innerHTML = '<p class="pp-h" style="font-size:15px;color:var(--muted);margin:0 0 16px">Мы обновили документы. Пока вы не подтвердите новую редакцию, связанные функции кабинета недоступны.</p>' +
    '<ul class="pp-docupd">' + list.map(d => '<li><b>' + esc(d.title) + '</b><span>ред. ' + esc(d.version) + ' от ' + esc(d.date.split('-').reverse().join('.')) + ' · ' + docLink(d.id, 'открыть') + '</span></li>').join('') + '</ul>' +
    '<div data-c></div><p class="pp-h pp-miss" data-miss aria-live="polite"></p>' +
    '<div class="pp-sheet-foot"><button class="btn btn-main calm" type="button" data-ok>Подтвердить</button><button class="btn btn-ghost" type="button" data-later>Позже</button></div>';
  const btn = box.querySelector('[data-ok]'), miss = box.querySelector('[data-miss]');
  const cons = consentChecks(list.map(d => d.id), { onChange: upd });
  box.querySelector('[data-c]').appendChild(cons.el);
  function upd() { btn.disabled = !cons.ok(); miss.textContent = btn.disabled ? missingHint(cons.missing()) : ''; }
  upd();
  const sh = sheet({ title: 'Документ обновлён', sub: 'Подтвердите новую редакцию', body: box, width: 560, onClose: () => { docUpdOpen = false; if (o.onClose) o.onClose(); } });
  btn.addEventListener('click', async () => {
    btn.classList.add('loading');
    try { await CommunityAPI.acceptDocs(list.map(d => d.id), { context: 'doc_update' }); toast('Спасибо! Новая редакция подтверждена', { kind: 'ok' }); sh.close('ok'); }
    catch (x) { toast(x.message, { kind: 'err' }); }
    btn.classList.remove('loading');
  });
  box.querySelector('[data-later]').addEventListener('click', () => sh.close('later'));
  return true;
}

/* ---------- Cookie-баннер и настройки ---------- */
function openCookieSettings() {
  const cur = CommunityAPI.getCookieConsent() || { analytics: false, ads: false };
  const box = document.createElement('div');
  box.innerHTML = '<p class="pp-h" style="font-size:15px;color:var(--muted);margin:0 0 16px">Подробно — в ' + docLink('cookies', 'Политике использования cookie') + '. Выбор можно поменять в любой момент по ссылке «Настройки cookie» внизу страницы.</p>' +
    '<div class="pp-cset">' +
      '<label class="pp-tog"><input type="checkbox" checked disabled> <span><b>Необходимые</b><small>Вход в кабинет, незавершённая бронь, ваши настройки. Без них сайт не работает.</small></span></label>' +
      '<label class="pp-tog"><input type="checkbox" data-k="analytics"' + (cur.analytics ? ' checked' : '') + '> <span><b>Аналитические</b><small>Яндекс Метрика: статистика посещений, карта кликов и Вебвизор — чтобы делать сайт удобнее.</small></span></label>' +
      '<label class="pp-tog"><input type="checkbox" data-k="ads"' + (cur.ads ? ' checked' : '') + '> <span><b>Рекламные</b><small>Оценка эффективности рекламы (пиксель VK Рекламы / Top.Mail.ru).</small></span></label>' +
    '</div>' +
    '<div class="pp-sheet-foot" style="margin-top:18px"><button class="btn btn-main calm" type="button" data-save>Сохранить выбор</button></div>';
  const sh = sheet({ title: 'Настройки cookie', body: box, width: 520 });
  box.querySelector('[data-save]').addEventListener('click', async () => {
    await CommunityAPI.setCookieConsent({ analytics: box.querySelector('[data-k=analytics]').checked, ads: box.querySelector('[data-k=ads]').checked }, 'cookie_banner');
    hideCookieBanner(); sh.close('save'); toast('Настройки cookie сохранены', { kind: 'ok' });
  });
}
let cookieEl = null;
function hideCookieBanner() { if (cookieEl) { cookieEl.remove(); cookieEl = null; document.documentElement.classList.remove('pp-has-cookie'); } }
function cookieBanner() {
  const c = CommunityAPI.getCookieConsent();
  if (c) { if (c.analytics) loadMetrika(); return; }
  if (cookieEl) return;
  cookieEl = document.createElement('section');
  cookieEl.className = 'pp-cookie';
  cookieEl.setAttribute('aria-label', 'Согласие на cookie');
  cookieEl.innerHTML = '<p>Мы используем cookie: необходимые — чтобы работали вход и бронь, аналитические (Яндекс Метрика) — только с вашего согласия. ' + docLink('cookies', 'Подробнее') + '</p><div class="pp-cookie-b"><button class="btn btn-main calm btn-sm" type="button" data-all>Принять</button><button class="btn btn-ghost btn-sm" type="button" data-min>Только необходимые</button><button class="pp-link" type="button" data-cfg>Настроить</button></div>';
  document.body.appendChild(cookieEl);
  document.documentElement.classList.add('pp-has-cookie');
  cookieEl.querySelector('[data-all]').addEventListener('click', async () => { hideCookieBanner(); await CommunityAPI.setCookieConsent({ analytics: true, ads: true }, 'cookie_banner'); });
  cookieEl.querySelector('[data-min]').addEventListener('click', async () => { hideCookieBanner(); await CommunityAPI.setCookieConsent({ analytics: false, ads: false }, 'cookie_banner'); });
  cookieEl.querySelector('[data-cfg]').addEventListener('click', openCookieSettings);
}
document.addEventListener('click', e => { const a = e.target.closest && e.target.closest('[data-cookie-settings]'); if (a) { e.preventDefault(); openCookieSettings(); } });
/* Ссылки на все документы — для подвалов */
function docsFooterHTML() { return DOCS.map(d => '<li>' + docLink(d.id, d.id === 'offer' ? 'Публичная оферта' : d.id === 'cookies' ? 'Политика cookie' : d.id === 'community_rules' ? 'Правила сообщества' : d.id === 'consent_public' ? 'Согласие на распространение ПД' : d.id === 'consent_pd' ? 'Согласие на обработку ПД' : 'Политика обработки ПД') + '</li>').join('') + '<li><a href="#" data-cookie-settings>Настройки cookie</a></li>'; }

/* Кнопка «Кабинет» в шапке: аватар и имя, если вошёл, и счётчик новых событий */
function bindCabButton(el) {
  async function render() {
    let u = null, n = 0;
    try { u = await CommunityAPI.me(); n = await CommunityAPI.unreadCount(); } catch (e) {}
    el.innerHTML = (u ? '<img src="' + esc(u.photo) + '" alt="">' : '<span class="cab-ico">' + ICON.user + '</span>') + '<span class="cab-name">' + esc(u ? u.name : 'Кабинет') + '</span>' + '<span class="pp-badge"' + (n ? '' : ' hidden') + '>' + n + '</span>';
    el.setAttribute('aria-label', 'Личный кабинет' + (u ? ' — ' + u.name : '') + (n ? ', новых событий: ' + n : ''));
  }
  render();
  global.addEventListener('pp:change', render);
  return render;
}

/* QR-подобный узор для макета. В боевой версии код и QR выдаёт контроллер замка после оплаты. */
function qrSVG(text, px) {
  const N = 25, rnd = mulberry(hash('qr' + text));
  const fz = (x, y) => (x < 8 && y < 8) || (x >= N - 8 && y < 8) || (x < 8 && y >= N - 8);
  let r = '';
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { if (fz(x, y)) continue; if (rnd() < 0.47) r += 'M' + x + ' ' + y + 'h1v1h-1z'; }
  const finder = (x, y) => 'M' + x + ' ' + y + 'h7v7h-7zM' + (x + 1) + ' ' + (y + 1) + 'v5h5v-5zM' + (x + 2) + ' ' + (y + 2) + 'h3v3h-3z';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ' + (N + 4) + ' ' + (N + 4) + '" width="' + (px || 160) + '" height="' + (px || 160) + '" shape-rendering="crispEdges" role="img" aria-label="QR-код для входа"><rect x="-2" y="-2" width="' + (N + 4) + '" height="' + (N + 4) + '" fill="#fff"/><path fill="#0a0b16" fill-rule="evenodd" d="' + r + finder(0, 0) + finder(N - 7, 0) + finder(0, N - 7) + '"/></svg>';
}

function levelPill(lv) { return lv ? '<span class="pp-lv" style="--c:' + LEVEL_COLOR[lv] + '">' + esc(label(LEVELS, lv)) + '</span>' : ''; }
function ava(u, size, round) { return '<span class="pp-ava' + (round ? ' round' : '') + '" style="--c:' + (u && u.level ? LEVEL_COLOR[u.level] : '#8f9bff') + ';--s:' + (size || 56) + 'px"><img src="' + esc(u ? u.photo : avatarSVG('?')) + '" alt="' + esc(u ? 'Фото: ' + u.name : '') + '" loading="lazy"></span>'; }
function contactsHTML(c) {
  if (!c) return '';
  let h = '';
  if (c.phone) h += '<a href="tel:+' + c.phone.replace(/\D/g, '') + '">' + ICON.phone + esc(c.phone) + '</a>';
  if (c.tg) h += '<a href="https://t.me/' + encodeURIComponent(c.tg) + '" target="_blank" rel="noopener">' + ICON.tg + '@' + esc(c.tg) + '</a>';
  return h ? '<div class="pp-contacts">' + h + '</div>' : '<p class="pp-h">Игрок скрыл контакты — напишите ему через администратора.</p>';
}

/* Файл для календаря (.ics) */
function icsFor(b) {
  const dt = (ts) => { const d = new Date(ts); return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) + 'T' + pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + '00Z'; };
  const st = tsAt(b.date, b.start);
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Ping Point//Booking//RU', 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
    'UID:' + b.id + '@pingpoint', 'DTSTAMP:' + dt(Date.now()), 'DTSTART:' + dt(st), 'DTEND:' + dt(st + b.dur * 60e3),
    'SUMMARY:Настольный теннис — Ping Point', 'LOCATION:Брянск\\, ул. Красноармейская\\, 100\\, ТРЦ «Мельница»',
    'DESCRIPTION:Бронь ' + b.number + '. Код на вход: ' + (b.code || '—') + '. Телефон: +7 903 644-76-53',
    'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Через час игра в Ping Point', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}
/* Скачивание файла; если браузер не дал скачать — показываем текст для копирования */
function saveFile(name, text, mime) {
  try {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
    return true;
  } catch (e) {
    const box = document.createElement('div');
    box.innerHTML = '<p class="pp-h" style="margin:0 0 10px">Браузер не дал скачать файл. Скопируйте текст и сохраните как <b>' + esc(name) + '</b>:</p><textarea class="pp-i" rows="10" readonly style="font:12px/1.4 monospace"></textarea>';
    box.querySelector('textarea').value = text;
    sheet({ title: 'Файл ' + name, body: box, width: 620 });
    return false;
  }
}

/* =====================================================================
   Экспорт
   ===================================================================== */
global.CommunityAPI = CommunityAPI;
global.BookingAPI = BookingAPI;
global.AdminAPI = AdminAPI;
global.PP = {
  DOCS, REG_DOCS, BOOKING_DOCS, OFFER_URL, CONSENT_ACTION, CONSENT_CONTEXT, REQUEST_TYPES, docById, verCmp, sha256, loadMetrika,
  LEVELS, LEVEL_COLOR, FORMATS, TIMES, HANDS, STYLES, DAY_SHORT, DAY_LONG, MONTH_G, MONTH_S, BOOKING_STATUS, PAYMENT_STATUS, PAY_METHOD, DEMO_CODE,
  esc, plural, money, hhmm, ymd, parseYmd, addDays, dayIdx, tsAt, today, dateLabel, dateLong, ago, label, fmtPhone, normPhone, goal, hash, mulberry,
  rateAt, rentFor, nextSlots: (p, n) => nextSlots(p, n, load().settings), avatarSVG, postSummary, isQuota, PPError
};
global.PPUI = { consentChecks, missingHint, docLink, openDoc, checkDocUpdates, cookieBanner, openCookieSettings, docsFooterHTML,
  sheet, toast, openAuth, authForm, bindCabButton, bindPhoneMask, maskPhone, compressImage, qrSVG, levelPill, ava, contactsHTML, icsFor, saveFile, ICON };

// запускаем таймеры имитации (если что-то ожидает с прошлого визита — сработает сразу)
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scheduleSims); else scheduleSims();
})(window);
