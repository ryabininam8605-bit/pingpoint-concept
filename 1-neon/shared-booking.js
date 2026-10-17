/* Shared SQLite booking adapter. Load after community.js, before booking.js.
 * No booking, phone or admin flag from localStorage grants server access.
 * Profiles/posts remain local; original legacy bookings are never imported/deleted.
 */
(function (global) {
'use strict';
const B = global.BookingAPI, A = global.AdminAPI;
if (!B || !A) throw new Error('shared-booking.js requires community.js');
const clone = value => JSON.parse(JSON.stringify(value));
let settings = { open:600, close:1230, border:780, priceAm:400, pricePm:500, racket:100, minLeadMin:60, cancelHours:3, holdMin:15, maxPlayers:4, rules:[] };
let csrf = '', admin = false, boot = null;
const cache = new Map(), requests = new Map(), promos = new Map();
const key = (date, excludeId) => date + '|' + (excludeId || '');
function error(code, message) { const e = new Error(message); e.code = code; return e; }
function emit() { global.dispatchEvent(new CustomEvent('pp:change', { detail:{ source:'shared-booking' } })); }
function localAdminFlag() {
  // Compatibility only for local community moderation. Every booking/admin
  // network operation still checks the unforgeable server session.
  try { if (admin) global.localStorage.setItem('pp_admin_v1','1'); else global.localStorage.removeItem('pp_admin_v1'); } catch (_) {}
}
async function request(path, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const headers = { 'Accept':'application/json' };
    const options = { credentials:'same-origin', cache:'no-store', signal:controller.signal, headers };
    if (body !== undefined) {
      options.method = 'POST'; headers['Content-Type'] = 'application/json'; headers['X-PP-CSRF'] = csrf;
      options.body = JSON.stringify(body);
    }
    const response = await global.fetch(path, options);
    let value;
    try { value = await response.json(); } catch (_) { throw error('NETWORK', 'Сервер бронирования недоступен. Запустите сайт через server.py.'); }
    if (!response.ok) {
      if (response.status === 403 && path.indexOf('/api/admin/') === 0) { admin = false; localAdminFlag(); }
      throw error(value.error && value.error.code || 'SERVER', value.error && value.error.message || 'Не удалось выполнить запрос');
    }
    return value;
  } catch (e) {
    if (e.code) throw e;
    throw error('NETWORK', 'Не удалось связаться с сервером бронирования. Проверьте подключение и повторите.');
  } finally { clearTimeout(timer); }
}
function bootstrap() {
  if (boot) return boot;
  boot = request('/api/session').then(value => {
    settings = value.settings; csrf = value.csrf; admin = !!value.admin; B.demoPayments = !!value.demoPayments;
    localAdminFlag(); return value;
  }).catch(e => { boot = null; admin = false; localAdminFlag(); throw e; });
  // The UI can await the same rejection, while an unobserved initial load is safe.
  boot.catch(() => {});
  B.ready = boot;
  return boot;
}
function query(values) { const p = new URLSearchParams(); Object.keys(values || {}).forEach(k => { if (values[k] != null && values[k] !== '') p.set(k, values[k]); }); return p.toString(); }
async function refresh(date, excludeId) {
  const id = key(date, excludeId);
  if (requests.has(id)) return requests.get(id);
  const old = cache.get(id);
  cache.set(id, { status:'loading', value:old && old.value });
  const pending = (async () => {
    try {
      await bootstrap();
      const value = await request('/api/availability?' + query({date, excludeId}));
      settings = value.settings;
      cache.set(id, { status:'ready', value });
      if (!old || old.status !== 'ready' || JSON.stringify(old.value) !== JSON.stringify(value)) emit();
      return clone(value);
    } catch (e) {
      cache.set(id, { status:'error', error:e.message });
      if (!old || old.status !== 'error' || old.error !== e.message) emit();
      throw e;
    } finally { requests.delete(id); }
  })();
  requests.set(id, pending);
  return pending;
}
function knownDates() { return Array.from(cache.keys()).map(id => id.split('|')); }
async function updateCaches(extraDates) {
  const entries = knownDates();
  (extraDates || []).filter(Boolean).forEach(date => { if (!entries.some(x => x[0] === date && !x[1])) entries.push([date,'']); });
  const results = await Promise.allSettled(entries.map(([date, exclude]) => refresh(date, exclude)));
  // Mutation success remains truthful even if a subsequent availability read fails;
  // affected caches explicitly become error and cannot report stale free slots.
  emit();
  return results;
}
async function mutate(path, body, dates) {
  await bootstrap();
  const value = await request(path, body);
  const booking = value && (value.booking || (value.date && value));
  await updateCaches((dates || []).concat(booking && booking.date || []));
  return value;
}
B.settings = () => clone(settings);
B.demoPayments = false;
B.refreshAvailability = refresh;
B.refreshAllAvailability = (dates, excludeId) => Promise.all(dates.map(date => refresh(date, excludeId)));
B.availabilityState = (date, excludeId) => { const c = cache.get(key(date, excludeId)); return c ? (c.status === 'error' ? { status:'error', error:c.error } : { status:c.status }) : { status:'loading' }; };
B.availabilitySync = (date, excludeId) => { const c = cache.get(key(date, excludeId)); return c && c.status === 'ready' ? clone(c.value.slots) : []; };
B.getAvailability = date => refresh(date);
B.quote = (options, code) => {
  const start = +options.start, dur = +options.dur, rackets = +options.rackets || 0;
  if (!Number.isFinite(start) || !Number.isFinite(dur) || start % 30 || dur % 30 || dur < 60 || dur > 240 || start < settings.open || start + dur > settings.close || !Number.isInteger(rackets) || rackets < 0 || rackets > settings.maxPlayers) throw error('VALID','Проверьте время и число ракеток');
  let rent = 0; for (let minute = start; minute < start + dur; minute += 30) rent += (minute < settings.border ? settings.priceAm : settings.pricePm) / 2;
  const extra = rackets * settings.racket * dur / 60, subtotal = rent + extra;
  const normalizedCode = code ? String(code).trim().toUpperCase() : null;
  const granted = options.promoTerms;
  // Transfer previews can use the discount already granted on the server's
  // booking view, regardless of current promo sales/limits. Server revalidates
  // the actual transfer and never trusts terms supplied by the browser.
  const promo = normalizedCode && granted && granted.code === normalizedCode ? granted : normalizedCode ? promos.get(normalizedCode) : null;
  if (code && !promo) throw error('PROMO','Проверьте промокод на сервере');
  if (promo && (!['pct','rub'].includes(promo.type) || !Number.isFinite(promo.value) || promo.value <= 0 || (promo.type === 'pct' && promo.value > 90))) throw error('PROMO','Проверьте условия скидки');
  const discount = promo ? promo.type === 'pct' ? Math.round(subtotal * promo.value / 100) : Math.min(subtotal,promo.value) : 0;
  return {rent, rackets:extra, subtotal, discount, total:subtotal-discount};
};
B.applyPromo = async (code, options) => { await bootstrap(); const value = await request('/api/promos/apply', Object.assign({},options,{code})); promos.set(value.code,value); return value; };
B.createBooking = async options => {
  const body = Object.assign({}, options, {consents:Object.assign({},options.consents)});
  const profile = global.CommunityAPI.meSync();
  // Registration already records these two acceptances; do not accept the offer
  // for the visitor or modify their profile/consent history here.
  if (profile && profile.docsOk && !profile.deletion) { body.consents.policy = true; body.consents.consent_pd = true; }
  return mutate('/api/bookings', body, [body.date]);
};
B.createPayment = (id, method) => mutate('/api/bookings/' + encodeURIComponent(id) + '/payments', {method});
B.confirmPayment = (id, options) => mutate('/api/payments/' + encodeURIComponent(id) + '/confirm', options || {});
B.getBooking = async id => { await bootstrap(); try { return await request('/api/bookings/' + encodeURIComponent(id)); } catch(e) { if (e.code === 'NOTFOUND') return null; throw e; } };
B.listMyBookings = async () => { await bootstrap(); return request('/api/bookings/mine'); };
B.cancelBooking = id => mutate('/api/bookings/' + encodeURIComponent(id) + '/cancel', {});
B.quoteReschedule = async (id, options) => { await bootstrap(); return request('/api/bookings/' + encodeURIComponent(id) + '/reschedule-quote', options); };
B.rescheduleBooking = (id, options) => mutate('/api/bookings/' + encodeURIComponent(id) + '/reschedule', options, [options.date]);

const originalAdmin = Object.assign({}, A);
delete A.demoCredentials;
A.isLogged = () => admin;
A.login = async (login,password) => { await bootstrap(); const result = await request('/api/admin/login',{login,password}); admin=true; localAdminFlag(); emit(); return result; };
A.logout = async () => { await bootstrap(); const result=await request('/api/admin/logout',{}); admin=false; localAdminFlag(); emit(); return result; };
const adminRead = async (route, values) => { await bootstrap(); return request('/api/admin/' + route + (values ? '?' + query(values) : '')); };
const adminWrite = (route, body) => mutate('/api/admin/' + route, body || {});
A.dashboard = () => adminRead('dashboard');
A.listBookings = filters => adminRead('bookings',filters);
A.getBooking = id => adminRead('bookings/' + encodeURIComponent(id));
A.cancelBooking = (id,withRefund) => adminWrite('bookings/' + encodeURIComponent(id) + '/cancel',{withRefund});
A.moveBooking = (id,options) => adminWrite('bookings/' + encodeURIComponent(id) + '/move',options);
A.markNoShow = id => adminWrite('bookings/' + encodeURIComponent(id) + '/noshow');
A.setPartialRefund = (id,amount,note) => adminWrite('bookings/' + encodeURIComponent(id) + '/partial-refund',{amount,note});
A.refundFault = (id,note) => adminWrite('bookings/' + encodeURIComponent(id) + '/refund-fault',{note});
A.createManualBooking = options => adminWrite('bookings/create',options);
A.confirmManualPayment = (id,method) => adminWrite('bookings/' + encodeURIComponent(id) + '/manual-payment',{method});
A.listBlocks = () => adminRead('blocks');
A.createBlock = options => adminWrite('blocks/create',options);
A.deleteBlock = id => adminWrite('blocks/' + encodeURIComponent(id) + '/delete');
A.listPayments = filters => adminRead('payments',filters);
A.listClients = q => adminRead('clients',{q});
A.getClient = phone => adminRead('client',{phone});
A.getSettings = () => adminRead('settings');
A.saveSettings = async options => { const value=await adminWrite('settings',options); settings=value; promos.clear(); return value; };
A.listPromos = () => adminRead('promos');
A.savePromo = options => adminWrite('promos/save',options);
A.togglePromo = (code,active) => adminWrite('promos/toggle',{code,active});
A.resetDemo = async () => { throw error('DISABLED','Сброс отключён: общие брони и старые данные сохраняются.'); };
// The remaining API only manages local profiles/posts/documents. Revalidate
// server admin rights before invoking it; localStorage flags cannot unlock it.
Object.keys(originalAdmin).forEach(name => {
  if (typeof originalAdmin[name] !== 'function' || A[name] !== originalAdmin[name]) return;
  A[name] = async function () { await adminRead('auth'); admin=true; localAdminFlag(); return originalAdmin[name].apply(originalAdmin,arguments); };
});
function poll() { const entries=knownDates(); if (!entries.length) return; Promise.allSettled(entries.map(([date,exclude])=>refresh(date,exclude))); }
global.addEventListener('focus',poll);
global.addEventListener('online',poll);
if (global.document) global.document.addEventListener('visibilitychange',()=>{ if(global.document.visibilityState==='visible') poll(); });
setInterval(()=>{ if (!global.document || global.document.visibilityState==='visible') poll(); },20000);
bootstrap();
})(window);
