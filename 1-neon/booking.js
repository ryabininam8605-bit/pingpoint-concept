/*
 * Ping Point — бронирование и оплата на сайте (модальное окно).
 * Требует community.js (BookingAPI, CommunityAPI, PP, PPUI).
 *
 * PPBooking.open({date, start, dur, players, rackets, title, partnerResponseId}) — новая бронь
 * PPBooking.resume(bookingId)      — вернуться к оплате неоплаченной брони (держится 15 минут)
 * PPBooking.reschedule(bookingId)  — перенос по оферте: один раз, не позднее чем за 3 часа
 * PPBooking.showBooking(bookingId) — код доступа, QR и «Добавить в календарь»
 * Любой элемент с атрибутом data-book открывает бронь; пресет берётся из
 * data-book-date / data-book-start / data-book-dur / data-book-players / data-book-rackets / data-book-title.
 *
 * Страница оплаты — имитация в тестовом режиме. В боевой версии сервер создаёт платёж в ЮKassa,
 * покупатель платит на её защищённой странице или в виджете, а бронь подтверждается вебхуком.
 */
(function () {
'use strict';
const P = window.PP, UI = window.PPUI;
const esc = P.esc, money = P.money, hhmm = P.hhmm;

const CSS = `
.pp-sheet-body.bk-body{padding-bottom:0}
.bk [hidden]{display:none!important}
.bk-steps{display:flex;gap:6px;list-style:none;margin:0 0 22px;padding:0;counter-reset:bk}
.bk-steps li{flex:1;counter-increment:bk;font-size:12px;font-weight:700;color:var(--dim);letter-spacing:.02em;min-width:0}
.bk-steps li::before{content:"";display:block;height:4px;border-radius:9px;background:rgba(255,255,255,.08);margin-bottom:8px}
.bk-steps li.done::before{background:rgba(255,46,99,.55)}
.bk-steps li.on{color:var(--ink)}
.bk-steps li.on::before{background:var(--neon);box-shadow:0 0 12px var(--neon)}
.bk-steps span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bk-stepcap{display:none;margin:-12px 0 18px;font-size:13px;font-weight:700;color:var(--muted)}
.bk-stepcap b{color:var(--ink)}
.bk-h{font-family:var(--display);font-size:15px;font-weight:700;margin:0 0 12px;display:flex;flex-wrap:wrap;justify-content:space-between;align-items:baseline;gap:4px 10px}
.bk-h small{font-family:var(--text);font-size:13px;font-weight:600;color:var(--muted)}
.bk-sec{margin-bottom:22px}
.bk-cal{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:6px}
.bk-cal .wd{font-size:11px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);text-align:center;padding-bottom:2px}
.bk-day{position:relative;border:0;border-radius:12px;padding:8px 2px 7px;cursor:pointer;background:rgba(255,255,255,.035);box-shadow:inset 0 0 0 1px var(--line);text-align:center;transition:background .2s,box-shadow .2s;color:var(--ink)}
.bk-day b{display:block;font-family:var(--display);font-size:16px;line-height:1.1}
.bk-day i{display:block;font-style:normal;font-size:11px;color:#3dffa8;margin-top:3px;white-space:nowrap}
.bk-day.full i{color:var(--dim)}
.bk-day:hover{background:rgba(255,255,255,.07)}
.bk-day[aria-pressed=true]{background:rgba(255,46,99,.14);box-shadow:inset 0 0 0 1.5px var(--neon),0 0 18px -6px var(--neon)}
.bk-day.we b{color:var(--ball-hot)}
.bk-day:disabled{opacity:.35;cursor:not-allowed}
.bk-dur{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.bk-stp{display:inline-flex;align-items:center;border-radius:14px;background:rgba(255,255,255,.04);box-shadow:inset 0 0 0 1px var(--line);padding:4px}
.bk-stp button{width:40px;height:40px;border:0;border-radius:10px;background:rgba(255,255,255,.06);font-size:20px;cursor:pointer;color:var(--ink)}
.bk-stp button:hover:not(:disabled){background:var(--neon)}
.bk-stp button:disabled{opacity:.3;cursor:not-allowed}
.bk-stp output{min-width:78px;text-align:center;font-family:var(--display);font-weight:700;font-size:16px}
.bk-slots{display:grid;grid-template-columns:repeat(auto-fill,minmax(76px,1fr));gap:7px}
.bk-slot{border:0;border-radius:12px;padding:10px 4px 8px;cursor:pointer;text-align:center;color:var(--ink);background:rgba(61,255,168,.06);box-shadow:inset 0 0 0 1.5px rgba(61,255,168,.4);transition:transform .15s,background .15s,box-shadow .15s}
.bk-slot b{display:block;font-family:var(--display);font-size:15px}
.bk-slot span{display:block;font-size:11px;color:var(--muted);margin-top:2px}
.bk-slot.free:hover{transform:translateY(-2px);background:rgba(61,255,168,.14)}
.bk-slot.busy,.bk-slot.past,.bk-slot.blocked,.bk-slot.nofit{cursor:not-allowed;background:rgba(255,255,255,.025);box-shadow:inset 0 0 0 1px rgba(255,255,255,.06)}
.bk-slot.busy b{color:var(--dim);text-decoration:line-through;text-decoration-color:rgba(255,46,99,.6)}
.bk-slot.blocked b{color:var(--dim)}
.bk-slot.past b,.bk-slot.nofit b{color:#4a4e6d}
.bk-slot.busy span,.bk-slot.past span,.bk-slot.blocked span,.bk-slot.nofit span{color:#4a4e6d}
.bk-slot.sel,.bk-slot.inr{background:rgba(255,46,99,.16);box-shadow:inset 0 0 0 1.5px var(--neon),0 0 16px -6px var(--neon)}
.bk-slot.inr{box-shadow:inset 0 0 0 1px rgba(255,46,99,.6)}
.bk-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px;font-size:12.5px;color:var(--muted)}
.bk-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px}
.bk-empty{grid-column:1/-1;padding:18px;border-radius:12px;background:rgba(255,255,255,.03);color:var(--muted);text-align:center;font-size:14.5px}
.bk-ppl{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.bk-ppl button{border:0;border-radius:14px;padding:12px 4px;cursor:pointer;color:var(--muted);background:rgba(255,255,255,.03);box-shadow:inset 0 0 0 1px var(--line);font-weight:700}
.bk-ppl button b{display:block;font-family:var(--display);font-size:20px;color:var(--ink)}
.bk-ppl button[aria-pressed=true]{background:rgba(255,46,99,.12);box-shadow:inset 0 0 0 1.5px var(--neon),0 0 18px -6px var(--neon);color:#fff}
.bk-promo{display:flex;gap:8px}
.bk-promo .pp-i{text-transform:uppercase;letter-spacing:.06em}
.bk-promo .btn{flex-shrink:0}
.bk-sum{border-radius:18px;padding:16px 18px;background:radial-gradient(90% 90% at 100% 0%,rgba(255,46,99,.16),transparent 60%),rgba(255,255,255,.03);box-shadow:inset 0 0 0 1px var(--line);margin-bottom:6px}
.bk-sum div{display:flex;justify-content:space-between;gap:12px;font-size:14.5px;color:#c6c8e2;padding:3px 0}
.bk-sum div b{color:var(--ink);font-variant-numeric:tabular-nums;white-space:nowrap}
.bk-sum .disc b{color:#3dffa8}
.bk-sum .tot{margin-top:8px;padding-top:10px;border-top:1px dashed rgba(255,255,255,.14);font-size:16px;color:var(--ink);font-weight:700}
.bk-sum .tot b{font-family:var(--display);font-size:22px}
.bk-sum .pp{font-size:13px;color:var(--ball-hot)}
.bk-bar{position:sticky;bottom:0;z-index:2;margin:18px -26px 0;padding:14px 26px calc(18px + env(safe-area-inset-bottom));display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:linear-gradient(180deg,rgba(15,17,36,0),#0f1124 22%)}
.bk-bar .bk-what{flex:1 1 200px;min-width:0;font-size:14px;color:var(--muted);line-height:1.35}
.bk-bar .bk-what b{display:block;color:var(--ink);font-size:15.5px}
.bk-bar .btn{flex:0 0 auto}
.bk-bar.static{position:static;background:none;border-top:1px solid var(--line);margin-top:22px}
.bk-back{border:0;background:none;color:var(--muted);font:700 14px var(--text);cursor:pointer;padding:8px 4px}
.bk-back:hover{color:var(--ink)}
.bk-me{display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:14px;background:rgba(61,255,168,.06);box-shadow:inset 0 0 0 1px rgba(61,255,168,.3);margin-bottom:16px;font-size:14.5px}
.bk-me img{width:40px;height:40px;border-radius:50%;object-fit:cover}
.bk-grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
.bk-test{display:flex;align-items:center;justify-content:center;gap:8px;padding:8px 12px;border-radius:10px;background:repeating-linear-gradient(135deg,rgba(245,166,35,.18) 0 12px,rgba(245,166,35,.08) 12px 24px);box-shadow:inset 0 0 0 1px rgba(245,166,35,.5);color:#ffd08a;font-size:12.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;margin-bottom:16px}
.bk-payhead{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;padding:16px 18px;border-radius:18px;background:#fff;color:#1a1d33;margin-bottom:14px}
.bk-payhead small{display:block;font-size:12px;color:#6d7299;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.bk-payhead b{display:block;font-size:17px}
.bk-payhead span{font-size:13px;color:#6d7299}
.bk-payhead .sum{font-family:var(--display);font-size:26px;font-weight:900;white-space:nowrap}
.bk-hold{font-size:14px;color:var(--muted);margin:0 0 14px}
.bk-hold b{color:var(--ball-hot);font-variant-numeric:tabular-nums}
.bk-tabs{display:flex;padding:4px;border-radius:14px;background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px var(--line);margin-bottom:16px}
.bk-tabs button{flex:1;border:0;background:none;padding:11px 8px;border-radius:10px;font-weight:700;font-size:14px;color:var(--muted);cursor:pointer}
.bk-tabs button[aria-selected=true]{background:var(--ink);color:var(--bg)}
.bk-card{padding:18px;border-radius:18px;background:linear-gradient(150deg,#232740,#12152a);box-shadow:inset 0 0 0 1px rgba(143,155,255,.3)}
.bk-card .pp-i{font-variant-numeric:tabular-nums;letter-spacing:.06em}
.bk-tc{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}
.bk-tc button{border:0;border-radius:10px;padding:8px 10px;background:rgba(255,255,255,.05);box-shadow:inset 0 0 0 1px var(--line);color:var(--muted);font:600 12.5px var(--text);cursor:pointer;text-align:left}
.bk-tc button b{display:block;color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:.04em}
.bk-tc button:hover{box-shadow:inset 0 0 0 1px var(--ball-hot)}
.bk-sbp{display:grid;grid-template-columns:auto 1fr;gap:18px;align-items:center;padding:18px;border-radius:18px;background:rgba(255,255,255,.03);box-shadow:inset 0 0 0 1px var(--line)}
.bk-sbp svg{border-radius:10px;display:block}
.bk-sbp p{margin:0 0 12px;font-size:14.5px;color:#c6c8e2}
.bk-proc{display:grid;place-items:center;gap:14px;padding:40px 10px;text-align:center;color:var(--muted)}
.bk-proc i{width:42px;height:42px;border-radius:50%;border:3px solid rgba(255,255,255,.12);border-top-color:var(--neon);animation:ppspin .8s linear infinite}
.bk-ok{text-align:center;padding:4px 0 8px}
.bk-ok .chk{width:64px;height:64px;margin:0 auto 12px;border-radius:50%;display:grid;place-items:center;background:rgba(61,255,168,.12);box-shadow:inset 0 0 0 2px #3dffa8,0 0 30px -6px #3dffa8;color:#3dffa8}
.bk-ok .chk svg{width:30px;height:30px}
.bk-ok h3{font-family:var(--display);font-size:22px;margin:0 0 4px}
.bk-ok p{margin:0;color:var(--muted);font-size:14.5px}
.bk-code{display:grid;grid-template-columns:1fr auto;gap:18px;align-items:center;margin:18px 0;padding:18px;border-radius:20px;background:radial-gradient(80% 120% at 0% 0%,rgba(255,46,99,.2),transparent 60%),linear-gradient(160deg,#1d2140,#0c0d1a);box-shadow:inset 0 0 0 1.5px var(--neon),0 0 40px -12px rgba(255,46,99,.6);text-align:left}
.bk-code small{display:block;font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.bk-code b{display:block;font-family:var(--display);font-weight:900;font-size:clamp(30px,7vw,40px);letter-spacing:.14em;color:#fff;text-shadow:0 0 18px rgba(255,46,99,.7);margin:6px 0 8px;font-variant-numeric:tabular-nums}
.bk-code span{font-size:13px;color:#c6c8e2;line-height:1.45;display:block}
.bk-code svg{width:112px;height:112px;border-radius:10px}
.bk-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-bottom:16px;text-align:left}
.bk-facts div{padding:10px 12px;border-radius:12px;background:rgba(255,255,255,.03);box-shadow:inset 0 0 0 1px var(--line);font-size:13px;color:var(--muted)}
.bk-facts b{display:block;color:var(--ink);font-size:15px}
.bk-acts{display:flex;flex-wrap:wrap;gap:10px}
.bk-acts .btn{flex:1 1 180px}
@media (max-width:640px){
  .bk-bar{margin:18px -20px 0;padding:12px 20px calc(16px + env(safe-area-inset-bottom))}
  .bk-bar .btn{flex:1 1 100%}
  .bk-day i{font-size:0;height:6px;width:6px;border-radius:50%;background:#3dffa8;margin:4px auto 0;box-shadow:0 0 6px #3dffa8}
  .bk-day.full i{background:var(--dim);box-shadow:none}
  .bk-day b{font-size:15px}
  .bk-cal{gap:4px}
  .bk-slots{grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}
  .bk-slot{padding:9px 2px 7px}
  .bk-slot b{font-size:14px}
  .bk-grid2{grid-template-columns:1fr}
  .bk-sbp{grid-template-columns:1fr;justify-items:center;text-align:center}
  .bk-code{grid-template-columns:1fr}
  .bk-code svg{justify-self:center;width:140px;height:140px}
  .bk-steps li span{display:none}
  .bk-steps li::before{margin-bottom:0}
  .bk-stepcap{display:block}
}
@media (prefers-reduced-motion:reduce){.bk-slot,.bk-day{transition:none}.bk-slot.free:hover{transform:none}}
`;
(function () { const st = document.createElement('style'); st.id = 'bk-css'; st.textContent = CSS; document.head.appendChild(st); })();

const ICO_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 10 17 19 7"/></svg>';
const STEPS = ['Время', 'Игроки', 'Контакты', 'Оплата', 'Готово'];
const durTxt = m => String(m / 60).replace('.', ',') + ' ч';
const perHour = (s, m) => P.rateAt(s, m);
function fits(slots, s, start, dur) {
  if (start + dur > s.close) return false;
  for (let m = start; m < start + dur; m += 30) { const x = slots.find(y => y.start === m); if (!x || x.state !== 'free') return false; }
  return true;
}
function parts(s, start, dur) { let am = 0, pm = 0; for (let m = start; m < start + dur; m += 30) { if (m < s.border) am += 30; else pm += 30; } return { am: am, pm: pm }; }
function next14() { const out = [], t = new Date(); for (let i = 0; i < 14; i++) out.push(P.ymd(P.addDays(t, i))); return out; }
function err(box, m) { const e = box.querySelector('.pp-e'); if (e) e.textContent = m || ''; }

/* ------------------------------------------------------------------ */
function open(preset, resumeBooking) {
  preset = preset || {};
  const s = BookingAPI.settings();
  const me = CommunityAPI.meSync();
  const signed = !!(me && !me.deletion && me.docsOk);
  const days = next14();
  const clampDur = d => Math.max(60, Math.min(240, Math.round((+d || 60) / 30) * 30));
  const st = {
    step: 1, date: null, start: null, dur: clampDur(preset.dur), players: Math.max(1, Math.min(s.maxPlayers, +preset.players || 2)),
    rackets: Math.max(0, +preset.rackets || 0), promo: null, promoInput: '', name: signed ? me.name : '', phone: signed ? me.phoneRaw : '',
    booking: null, payment: null, method: 'card', partnerResponseId: preset.partnerResponseId || null, busy: false
  };
  if (st.rackets > st.players) st.rackets = st.players;
  const av = d => BookingAPI.availabilitySync(d);
  if (preset.date && days.indexOf(preset.date) >= 0) st.date = preset.date;
  if (preset.start != null && preset.start !== '') {
    const ps = +preset.start;
    if (!st.date) st.date = days.find(d => fits(av(d), s, ps, st.dur)) || null;
    if (st.date && fits(av(st.date), s, ps, st.dur)) st.start = ps;
  }
  if (!st.date) st.date = days.find(d => av(d).some(x => x.state === 'free')) || days[0];

  const root = document.createElement('div');
  root.className = 'bk';
  let timer = 0;
  const sh = UI.sheet({ title: preset.title ? 'Бронь: ' + preset.title : 'Бронирование стола', sub: 'Ping Point · ТРЦ «Мельница», 4 этаж, офис 422', body: root, width: 760, onClose: onClose });
  sh.body.classList.add('bk-body');
  if (!resumeBooking) P.goal('booking_start');
  const onChange = () => { if (st.step === 1 && !st.busy) render(); };
  window.addEventListener('pp:change', onChange);

  function onClose(reason) {
    clearInterval(timer);
    window.removeEventListener('pp:change', onChange);
    if (st.booking && st.booking.status === 'pending' && reason !== 'paid') {
      const id = st.booking.id, until = st.booking.expiresAt;
      if (until > Date.now()) UI.toast('Бронь ' + st.booking.number + ' ждёт оплаты до ' + hhmm(new Date(until).getHours() * 60 + new Date(until).getMinutes()) + ' — потом время освободится', { action: 'Оплатить', onAction: () => resume(id), ms: 12000 });
    }
  }
  function stepsHTML() {
    return '<ol class="bk-steps" aria-label="Шаги бронирования">' + STEPS.map((t, i) => '<li class="' + (i + 1 < st.step ? 'done' : i + 1 === st.step ? 'on' : '') + '"' + (i + 1 === st.step ? ' aria-current="step"' : '') + '><span>' + (i + 1) + '. ' + t + '</span></li>').join('') + '</ol><p class="bk-stepcap" aria-hidden="true">Шаг ' + st.step + ' из 5 · <b>' + STEPS[st.step - 1] + '</b></p>';
  }
  function quote() { try { return BookingAPI.quote({ start: st.start, dur: st.dur, rackets: st.rackets }, st.promo ? st.promo.code : null); } catch (e) { st.promo = null; return BookingAPI.quote({ start: st.start, dur: st.dur, rackets: st.rackets }); } }
  function whatHTML() {
    if (st.start == null) return '<b>Выберите время</b>' + P.dateLabel(st.date);
    const q = quote();
    return '<b>' + esc(P.dateLabel(st.date)) + ' · ' + hhmm(st.start) + '–' + hhmm(st.start + st.dur) + '</b>' + durTxt(st.dur) + ' · ' + money(q.total) + (st.step > 1 ? ' · ' + st.players + ' ' + P.plural(st.players, 'игрок', 'игрока', 'игроков') : '');
  }
  function sumHTML() {
    const q = quote(), p = parts(s, st.start, st.dur);
    let h = '<div class="bk-sum" aria-live="polite">';
    if (p.am) h += '<div><span>Аренда до ' + hhmm(s.border) + ' · ' + durTxt(p.am) + ' × ' + money(s.priceAm) + '</span><b>' + money(p.am / 60 * s.priceAm) + '</b></div>';
    if (p.pm) h += '<div><span>Аренда после ' + hhmm(s.border) + ' · ' + durTxt(p.pm) + ' × ' + money(s.pricePm) + '</span><b>' + money(p.pm / 60 * s.pricePm) + '</b></div>';
    if (st.rackets) h += '<div><span>Проф. ракетки · ' + st.rackets + ' шт. × ' + durTxt(st.dur) + '</span><b>' + money(q.rackets) + '</b></div>';
    if (q.discount) h += '<div class="disc"><span>Промокод ' + esc(st.promo.code) + '</span><b>−' + money(q.discount) + '</b></div>';
    h += '<div class="tot"><span>Итого за стол</span><b>' + money(q.total) + '</b></div>';
    if (st.players > 1) h += '<div class="pp"><span>С человека</span><b>~' + money(Math.ceil(q.total / st.players / 10) * 10) + '</b></div>';
    return h + '</div>';
  }

  function render(focusSel) {
    clearInterval(timer);
    if (st.step === 1) step1(); else if (st.step === 2) step2(); else if (st.step === 3) step3(); else if (st.step === 4) step4(); else step5();
    const f = focusSel && root.querySelector(focusSel); if (f) f.focus({ preventScroll: true });
  }

  /* ---------- шаг 1: дата и время ---------- */
  function step1() {
    const slots = av(st.date);
    if (st.start != null && !fits(slots, s, st.start, st.dur)) st.start = null;
    const t0 = P.parseYmd(days[0]), lead = P.dayIdx(t0);
    let cal = '<div class="bk-cal" role="group" aria-label="Дата">' + P.DAY_SHORT.map(d => '<span class="wd" aria-hidden="true">' + d + '</span>').join('');
    for (let i = 0; i < lead; i++) cal += '<span aria-hidden="true"></span>';
    days.forEach(d => {
      const dd = P.parseYmd(d), sl = av(d), free = sl.filter(x => x.state === 'free').length, we = P.dayIdx(dd) >= 5;
      cal += '<button type="button" class="bk-day' + (we ? ' we' : '') + (free ? '' : ' full') + '" data-date="' + d + '" aria-pressed="' + (d === st.date) + '"' + (free ? '' : ' disabled') + ' aria-label="' + esc(P.dateLong(d)) + (free ? ', свободно окон: ' + free : ', мест нет') + '"><b>' + dd.getDate() + '</b><i>' + (free ? free + ' ' + P.plural(free, 'окно', 'окна', 'окон') : 'нет мест') + '</i></button>';
    });
    cal += '</div>';
    let grid = '';
    const last = s.close - 60;
    const startable = slots.filter(x => x.start <= last);
    startable.forEach(x => {
      let cls = x.state;
      if (x.state === 'free' && !fits(slots, s, x.start, st.dur)) cls = 'nofit';
      const inr = st.start != null && x.start > st.start && x.start < st.start + st.dur;
      const sel = st.start === x.start;
      const lbl = cls === 'free' ? perHour(s, x.start) + ' ₽/ч' : cls === 'busy' ? 'занято' : cls === 'blocked' ? 'закрыто' : cls === 'nofit' ? 'мало' : '—';
      grid += '<button type="button" class="bk-slot ' + cls + (sel ? ' sel' : '') + (inr ? ' inr' : '') + '" data-start="' + x.start + '"' + (cls === 'free' ? '' : ' disabled') + ' aria-pressed="' + sel + '" aria-label="' + hhmm(x.start) + (cls === 'free' ? ', свободно, ' + perHour(s, x.start) + ' рублей в час' : cls === 'nofit' ? ', не хватает времени на ' + durTxt(st.dur) : ', недоступно') + '"><b>' + hhmm(x.start) + '</b><span>' + lbl + '</span></button>';
    });
    if (!startable.some(x => x.state === 'free' && fits(slots, s, x.start, st.dur))) grid = '<div class="bk-empty">На этот день нет окна на ' + durTxt(st.dur) + '. Выберите другой день или уменьшите длительность.</div>' + grid;
    root.innerHTML = stepsHTML() +
      '<div class="bk-sec"><h3 class="bk-h">Дата <small>' + esc(P.dateLong(st.date)) + '</small></h3>' + cal + '</div>' +
      '<div class="bk-sec"><h3 class="bk-h" id="bkDurL">Сколько играем <small>минимум 1 час, шаг 30 минут</small></h3><div class="bk-dur"><div class="bk-stp" role="group" aria-labelledby="bkDurL"><button type="button" data-dur="-30" aria-label="Меньше"' + (st.dur <= 60 ? ' disabled' : '') + '>−</button><output aria-live="polite">' + durTxt(st.dur) + '</output><button type="button" data-dur="30" aria-label="Больше"' + (st.dur >= 240 ? ' disabled' : '') + '>+</button></div></div></div>' +
      '<div class="bk-sec"><h3 class="bk-h">Начало <small>до ' + hhmm(s.border) + ' — ' + s.priceAm + ' ₽/ч, после — ' + s.pricePm + ' ₽/ч</small></h3><div class="bk-slots">' + grid + '</div>' +
      '<div class="bk-legend"><span><i style="box-shadow:inset 0 0 0 1.5px #3dffa8;background:rgba(61,255,168,.15)"></i>Свободно</span><span><i style="background:rgba(255,46,99,.4)"></i>Занято</span><span><i style="background:rgba(255,255,255,.08)"></i>Не успеть: бронь не позднее чем за ' + (s.minLeadMin / 60) + ' ч</span></div></div>' +
      '<div class="bk-bar"><div class="bk-what">' + whatHTML() + '</div><button class="btn btn-main calm" type="button" data-next' + (st.start == null ? ' disabled' : '') + '>Дальше</button></div>';
    root.querySelectorAll('.bk-day').forEach(b => b.addEventListener('click', () => { st.date = b.getAttribute('data-date'); render('.bk-day[aria-pressed=true]'); }));
    root.querySelectorAll('[data-dur]').forEach(b => b.addEventListener('click', () => { st.dur = clampDur(st.dur + +b.getAttribute('data-dur')); render('[data-dur="' + b.getAttribute('data-dur') + '"]'); }));
    root.querySelectorAll('.bk-slot.free').forEach(b => b.addEventListener('click', () => { st.start = +b.getAttribute('data-start'); render('[data-next]'); }));
    root.querySelector('[data-next]').addEventListener('click', () => { st.step = 2; render('.bk-ppl [aria-pressed=true]'); sh.body.scrollTop = 0; });
  }

  /* ---------- шаг 2: игроки, ракетки, промокод ---------- */
  function step2() {
    root.innerHTML = stepsHTML() +
      '<div class="bk-sec"><h3 class="bk-h" id="bkPl">Сколько вас <small>цена за стол, не за человека</small></h3><div class="bk-ppl" role="group" aria-labelledby="bkPl">' +
      [1, 2, 3, 4].slice(0, s.maxPlayers).map(n => '<button type="button" data-p="' + n + '" aria-pressed="' + (st.players === n) + '"><b>' + n + '</b>' + P.plural(n, 'игрок', 'игрока', 'игроков') + '</button>').join('') + '</div></div>' +
      '<div class="bk-sec"><h3 class="bk-h" id="bkRk">Профессиональные ракетки <small>+' + s.racket + ' ₽/ч за штуку, обычные — бесплатно</small></h3><div class="bk-stp" role="group" aria-labelledby="bkRk"><button type="button" data-r="-1" aria-label="Меньше"' + (st.rackets <= 0 ? ' disabled' : '') + '>−</button><output aria-live="polite">' + st.rackets + '</output><button type="button" data-r="1" aria-label="Больше"' + (st.rackets >= st.players ? ' disabled' : '') + '>+</button></div></div>' +
      '<div class="bk-sec"><label class="bk-h" for="bkPromo">Промокод</label><div class="pp-e" role="alert"></div><div class="bk-promo"><input class="pp-i" id="bkPromo" autocomplete="off" maxlength="20" placeholder="Например, PONG10" value="' + esc(st.promo ? st.promo.code : st.promoInput) + '"><button class="btn btn-ghost btn-sm" type="button" data-promo>' + (st.promo ? 'Убрать' : 'Применить') + '</button></div>' + (st.promo ? '<p class="pp-h" style="margin:8px 0 0;color:#3dffa8">Промокод применён: ' + esc(st.promo.note) + '</p>' : '') + '</div>' +
      sumHTML() +
      '<div class="bk-bar"><button class="bk-back" type="button" data-back>← Время</button><div class="bk-what">' + whatHTML() + '</div><button class="btn btn-main calm" type="button" data-next>Дальше</button></div>';
    root.querySelectorAll('[data-p]').forEach(b => b.addEventListener('click', () => { st.players = +b.getAttribute('data-p'); if (st.rackets > st.players) st.rackets = st.players; render('[data-p="' + st.players + '"]'); }));
    root.querySelectorAll('[data-r]').forEach(b => b.addEventListener('click', () => { st.rackets = Math.max(0, Math.min(st.players, st.rackets + +b.getAttribute('data-r'))); render('[data-r="' + b.getAttribute('data-r') + '"]'); }));
    const inp = root.querySelector('#bkPromo');
    inp.addEventListener('input', () => { st.promoInput = inp.value; });
    const apply = async () => {
      if (st.promo) { st.promo = null; st.promoInput = ''; render('#bkPromo'); return; }
      const btn = root.querySelector('[data-promo]'); btn.classList.add('loading');
      try { st.promo = await BookingAPI.applyPromo(inp.value, { start: st.start, dur: st.dur, rackets: st.rackets }); render('[data-promo]'); }
      catch (x) { btn.classList.remove('loading'); err(root, x.message); inp.setAttribute('aria-invalid', 'true'); inp.focus(); }
    };
    root.querySelector('[data-promo]').addEventListener('click', apply);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } });
    root.querySelector('[data-back]').addEventListener('click', () => { st.step = 1; render('.bk-slot.sel'); });
    root.querySelector('[data-next]').addEventListener('click', () => { st.step = 3; render(); sh.body.scrollTop = 0; });
  }

  /* ---------- шаг 3: контакты и согласия ---------- */
  function step3() {
    const meNow = CommunityAPI.meSync();
    const isSigned = !!(meNow && !meNow.deletion && meNow.docsOk);
    if (isSigned && !st.phone) { st.name = meNow.name; st.phone = meNow.phoneRaw; }
    const docs = isSigned ? ['offer'] : P.BOOKING_DOCS.concat('offer');
    root.innerHTML = stepsHTML() +
      (isSigned
        ? '<div class="bk-me"><img src="' + esc(meNow.photo) + '" alt=""><div>Бронь попадёт в ваш кабинет: <b>' + esc(meNow.name) + '</b>, ' + esc(meNow.phone) + '</div></div>'
        : '<p class="pp-h" style="font-size:14.5px;margin:0 0 16px">Есть кабинет? <button class="pp-link" type="button" data-login style="font-size:14.5px;color:var(--ball-hot)">Войдите</button> — бронь сохранится в нём, а контакты подставятся сами.</p>') +
      '<div class="pp-e" role="alert"></div>' +
      '<div class="bk-grid2"><div class="pp-f"><label class="pp-l" for="bkName">Имя</label><input class="pp-i" id="bkName" autocomplete="name" maxlength="60" value="' + esc(st.name) + '" placeholder="Как к вам обращаться"></div>' +
      '<div class="pp-f"><label class="pp-l" for="bkPhone">Телефон <small>для кода и чека</small></label><input class="pp-i" id="bkPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 (900) 000-00-00"' + (isSigned ? ' readonly' : '') + '></div></div>' +
      '<div data-c></div>' +
      '<p class="pp-h" style="margin:-4px 0 12px">' + (isSigned ? '' : 'Бронь без кабинета тоже работает: код и чек придут на телефон. ') + 'Отмена не позднее чем за ' + s.cancelHours + ' ч — возврат 100%, позже — за вычетом фактических расходов; перенос — бесплатно один раз.</p>' +
      sumHTML() +
      '<p class="pp-h pp-miss" data-miss aria-live="polite" style="margin:12px 0 0"></p>' +
      '<div class="bk-bar"><button class="bk-back" type="button" data-back>← Назад</button><div class="bk-what">' + whatHTML() + '</div><button class="btn btn-main calm" type="button" data-next>К оплате · ' + money(quote().total) + '</button></div>';
    const nm = root.querySelector('#bkName'), ph = root.querySelector('#bkPhone'), next = root.querySelector('[data-next]'), miss = root.querySelector('[data-miss]');
    UI.bindPhoneMask(ph);
    if (st.phone) ph.value = UI.maskPhone('+7' + String(st.phone).replace(/\D/g, '').slice(-10));
    const cons = UI.consentChecks(docs, { onChange: validate });
    root.querySelector('[data-c]').appendChild(cons.el);
    function validate() {
      st.name = nm.value; st.phone = ph.value;
      const extra = [];
      if (nm.value.trim().length < 2) extra.push('имя');
      if (!P.normPhone(ph.value)) extra.push('телефон');
      const m = cons.missing();
      next.disabled = !!(m.length || extra.length);
      miss.textContent = next.disabled ? UI.missingHint(m, extra) : '';
    }
    [nm, ph].forEach(i => i.addEventListener('input', validate));
    validate();
    const lg = root.querySelector('[data-login]');
    if (lg) lg.addEventListener('click', async () => { const u = await UI.openAuth({ reason: 'Войдите, чтобы бронь сохранилась в кабинете', phone: P.normPhone(ph.value) || '', context: 'booking' }); if (u) { st.name = u.name; st.phone = u.phoneRaw; render(); } });
    root.querySelector('[data-back]').addEventListener('click', () => { st.step = 2; render(); });
    next.addEventListener('click', async () => {
      validate(); if (next.disabled) return;
      next.classList.add('loading'); err(root);
      try {
        st.booking = await BookingAPI.createBooking({ date: st.date, start: st.start, dur: st.dur, players: st.players, rackets: st.rackets, promo: st.promo ? st.promo.code : null, name: nm.value, phone: ph.value, consents: cons.values(), partnerResponseId: st.partnerResponseId });
        st.step = 4; st.payment = null; st.method = 'card'; render(); sh.body.scrollTop = 0;
      } catch (x) {
        next.classList.remove('loading'); err(root, x.message);
        if (x.code === 'BUSY' || x.code === 'LEAD') { UI.toast(x.message, { kind: 'err' }); st.step = 1; st.start = null; render(); }
      }
    });
  }

  /* ---------- шаг 4: оплата (тестовый режим) ---------- */
  function step4() {
    const b = st.booking;
    root.innerHTML = stepsHTML() +
      '<div class="bk-test" role="note">Тестовый режим · деньги не списываются</div>' +
      '<div class="bk-payhead"><div><small>Оплата заказа</small><b>' + esc(b.number) + ' · Ping Point</b><span>Аренда стола: ' + esc(P.dateLabel(b.date)) + ', ' + esc(b.timeLabel) + '</span></div><div class="sum">' + money(b.amount) + '</div></div>' +
      '<p class="bk-hold">Время удерживается за вами ещё <b data-timer>15:00</b>. Не успеете — слот освободится.</p>' +
      '<div class="pp-e" role="alert"></div>' +
      '<div class="bk-tabs" role="tablist" aria-label="Способ оплаты"><button type="button" role="tab" id="bkT1" aria-controls="bkCard" aria-selected="' + (st.method === 'card') + '" data-m="card">Банковская карта</button><button type="button" role="tab" id="bkT2" aria-controls="bkSbp" aria-selected="' + (st.method === 'sbp') + '" data-m="sbp">СБП</button></div>' +
      '<form class="bk-card" id="bkCard" role="tabpanel" aria-labelledby="bkT1" novalidate' + (st.method === 'card' ? '' : ' hidden') + '>' +
        '<p class="pp-h" style="margin:0 0 8px">Тестовые карты — нажмите, чтобы подставить:</p>' +
        '<div class="bk-tc"><button type="button" data-tc="5555 5555 5555 4444"><b>5555 5555 5555 4444</b>оплата пройдёт</button><button type="button" data-tc="4000 0000 0000 0002"><b>4000 0000 0000 0002</b>банк откажет</button></div>' +
        '<div class="pp-f"><label class="pp-l" for="bkNum">Номер карты</label><input class="pp-i" id="bkNum" inputmode="numeric" autocomplete="cc-number" placeholder="0000 0000 0000 0000" maxlength="19"></div>' +
        '<div class="bk-grid2"><div class="pp-f"><label class="pp-l" for="bkExp">Срок</label><input class="pp-i" id="bkExp" inputmode="numeric" autocomplete="cc-exp" placeholder="ММ/ГГ" maxlength="5"></div>' +
        '<div class="pp-f"><label class="pp-l" for="bkCvc">CVC</label><input class="pp-i" id="bkCvc" type="password" inputmode="numeric" autocomplete="cc-csc" placeholder="•••" maxlength="3"></div></div>' +
        '<button class="btn btn-main calm" type="submit" style="width:100%">Оплатить ' + money(b.amount) + '</button>' +
      '</form>' +
      '<div class="bk-sbp" id="bkSbp" role="tabpanel" aria-labelledby="bkT2"' + (st.method === 'sbp' ? '' : ' hidden') + '><div data-qr></div><div><p>Отсканируйте QR-код в приложении банка и подтвердите платёж на ' + money(b.amount) + '.</p><button class="btn btn-main calm" type="button" data-sbp>Я оплатил</button></div></div>' +
      '<p class="pp-h" style="margin:14px 0 0">Это имитация платёжной формы. В боевой версии оплата проходит на защищённой странице ЮKassa: данные карты не попадают на сайт Ping Point, чек придёт по 54-ФЗ.</p>' +
      '<div class="bk-bar static"><button class="bk-back" type="button" data-cancel>Отменить бронь</button><div class="bk-what">' + whatHTML() + '</div></div>';
    const tEl = root.querySelector('[data-timer]');
    const tick = () => {
      const left = Math.max(0, st.booking.expiresAt - Date.now());
      tEl.textContent = String(Math.floor(left / 60000)).padStart(2, '0') + ':' + String(Math.floor(left / 1000) % 60).padStart(2, '0');
      if (!left) { clearInterval(timer); expired(); }
    };
    tick(); timer = setInterval(tick, 1000);
    root.querySelectorAll('[role=tab]').forEach(t => t.addEventListener('click', () => { st.method = t.getAttribute('data-m'); render('[data-m="' + st.method + '"]'); }));
    root.querySelector('[role=tablist]').addEventListener('keydown', e => { if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { st.method = st.method === 'card' ? 'sbp' : 'card'; render('[data-m="' + st.method + '"]'); } });
    const num = root.querySelector('#bkNum'), exp = root.querySelector('#bkExp'), cvc = root.querySelector('#bkCvc');
    num.addEventListener('input', () => { num.value = num.value.replace(/\D/g, '').slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 '); });
    exp.addEventListener('input', () => { const d = exp.value.replace(/\D/g, '').slice(0, 4); exp.value = d.length > 2 ? d.slice(0, 2) + '/' + d.slice(2) : d; });
    cvc.addEventListener('input', () => { cvc.value = cvc.value.replace(/\D/g, '').slice(0, 3); });
    root.querySelectorAll('[data-tc]').forEach(x => x.addEventListener('click', () => { num.value = x.getAttribute('data-tc'); const d = new Date(); exp.value = '12/' + String(d.getFullYear() + 2).slice(2); cvc.value = '123'; root.querySelector('#bkCard [type=submit]').focus(); }));
    root.querySelector('#bkCard').addEventListener('submit', async e => {
      e.preventDefault(); err(root);
      const n = num.value.replace(/\D/g, ''), ex = exp.value.split('/'), mm = +ex[0], yy = +ex[1];
      const now = new Date(), yNow = now.getFullYear() % 100;
      if (n.length !== 16) { err(root, 'Номер карты — 16 цифр'); num.focus(); return; }
      if (!(mm >= 1 && mm <= 12) || !(yy > yNow || (yy === yNow && mm >= now.getMonth() + 1))) { err(root, 'Проверьте срок действия карты'); exp.focus(); return; }
      if (cvc.value.length !== 3) { err(root, 'CVC — три цифры на обороте карты'); cvc.focus(); return; }
      pay('card', { card: n });
    });
    if (st.method === 'sbp') {
      (async () => {
        try { if (!st.payment || st.payment.method !== 'sbp' || st.payment.status !== 'pending') st.payment = await BookingAPI.createPayment(st.booking.id, 'sbp'); root.querySelector('[data-qr]').innerHTML = UI.qrSVG('sbp-' + st.payment.id, 150); }
        catch (x) { handlePayErr(x); }
      })();
      root.querySelector('[data-sbp]').addEventListener('click', () => pay('sbp', {}));
    }
    root.querySelector('[data-cancel]').addEventListener('click', async () => {
      try { await BookingAPI.cancelBooking(st.booking.id); } catch (x) {}
      st.booking = null; st.payment = null; st.step = 1; render(); UI.toast('Неоплаченная бронь отменена, время освобождено');
    });
  }
  function handlePayErr(x) {
    if (x.code === 'EXPIRED') return expired();
    err(root, x.message);
  }
  function expired() {
    clearInterval(timer);
    st.booking = null; st.payment = null;
    root.innerHTML = stepsHTML() + '<div class="bk-ok"><div class="chk" style="background:rgba(255,46,99,.12);box-shadow:inset 0 0 0 2px var(--neon);color:var(--neon)">!</div><h3>Время на оплату вышло</h3><p>Бронь не оплачена за ' + s.holdMin + ' минут, поэтому слот освобождён. Выберите время заново — это быстро.</p></div><div class="bk-acts" style="margin-top:18px"><button class="btn btn-main calm" type="button" data-again>Выбрать время</button></div>';
    root.querySelector('[data-again]').addEventListener('click', () => { st.step = 1; render(); });
    root.querySelector('[data-again]').focus();
  }
  async function pay(method, data) {
    st.busy = true;
    const form = root.querySelector(method === 'card' ? '#bkCard' : '#bkSbp');
    const keep = form.innerHTML;
    form.innerHTML = '<div class="bk-proc" role="status"><i></i>Проверяем оплату…</div>';
    try {
      if (method === 'card' || !st.payment || st.payment.status !== 'pending') st.payment = await BookingAPI.createPayment(st.booking.id, method);
      const r = await BookingAPI.confirmPayment(st.payment.id, data);
      st.busy = false;
      if (r.ok) { st.booking = r.booking; st.step = 5; render(); sh.body.scrollTop = 0; return; }
      st.payment = null;
      render(); err(root, r.reason);
    } catch (x) { st.busy = false; if (x.code === 'EXPIRED') return expired(); form.innerHTML = keep; render(); err(root, x.message); }
  }

  /* ---------- шаг 5: готово ---------- */
  function step5() {
    root.innerHTML = stepsHTML() + successHTML(st.booking, true);
    bindSuccess(root, st.booking, sh);
    const f = root.querySelector('[data-ics]'); if (f) f.focus();
  }

  if (resumeBooking) { st.booking = resumeBooking; st.date = resumeBooking.date; st.start = resumeBooking.start; st.dur = resumeBooking.dur; st.players = resumeBooking.players; st.rackets = resumeBooking.rackets; st.step = 4; }
  render();
  return sh;
}

/* Карточка успешной брони: код доступа, QR, календарь. Код в боевой версии выдаёт контроллер замка. */
function successHTML(b, fresh) {
  const me = CommunityAPI.meSync();
  return '<div class="bk-ok">' + (fresh ? '<div class="chk">' + ICO_OK + '</div><h3>Оплачено! Стол ваш</h3><p>Бронь ' + esc(b.number) + ' · чек и код отправлены на ' + esc(b.phoneFmt) + '</p>' : '<h3 style="margin-bottom:2px">Бронь ' + esc(b.number) + '</h3><p>' + esc(b.statusLabel) + '</p>') + '</div>' +
    '<div class="bk-code"><div><small>Код на вход</small><b>' + esc(String(b.code || '').replace(/(\d{3})(\d{3})/, '$1 $2')) + '</b><span>Введите на панели у двери комнаты или покажите QR. Код действует в забронированное время.</span></div>' + UI.qrSVG(b.id + '-' + b.code, 140) + '</div>' +
    '<div class="bk-facts"><div>Когда<b>' + esc(P.dateLabel(b.date)) + ', ' + esc(b.timeLabel) + '</b></div><div>Игроков<b>' + b.players + (b.rackets ? ' · проф. ракеток ' + b.rackets : '') + '</b></div><div>Оплачено<b>' + money(b.amount) + '</b></div><div>Где<b>ТРЦ «Мельница», 4 этаж, офис 422</b></div></div>' +
    '<div class="bk-acts"><button class="btn btn-ghost" type="button" data-ics>Добавить в календарь</button>' +
    (me && !me.deletion ? '<a class="btn btn-main calm" href="cabinet.html#bookings">В кабинет</a>' : '<button class="btn btn-main calm" type="button" data-reg>Создать кабинет</button>') + '</div>' +
    (me ? '' : '<p class="pp-h" style="margin:12px 0 0;text-align:center">В кабинете видны все брони и коды, там же отмена и перенос. Брони на этот номер появятся в нём сами.</p>') +
    '<p class="pp-h" style="margin:10px 0 0;text-align:center">Отмена не позднее чем за 3 часа — возврат 100%. ' + UI.docLink('offer', 'Условия оферты') + '</p>';
}
function bindSuccess(root, b, sh) {
  root.querySelector('[data-ics]').addEventListener('click', () => { UI.saveFile('ping-point-' + b.number + '.ics', UI.icsFor(b), 'text/calendar;charset=utf-8'); });
  const r = root.querySelector('[data-reg]');
  if (r) r.addEventListener('click', async () => { const u = await UI.openAuth({ title: 'Создать кабинет', reason: 'Регистрация по номеру из брони — бронь сразу появится в кабинете', phone: b.phone, context: 'booking' }); if (u) location.href = 'cabinet.html#bookings'; });
}

async function resume(id) {
  try {
    const b = await BookingAPI.getBooking(id);
    if (!b || b.status !== 'pending') { UI.toast(b && b.status === 'expired' ? 'Время на оплату вышло — выберите время заново' : 'Эта бронь уже не ждёт оплаты', { kind: 'err' }); return; }
    open({}, b);
  } catch (x) { UI.toast(x.message, { kind: 'err' }); }
}
async function showBooking(id) {
  try {
    const b = await BookingAPI.getBooking(id);
    if (!b) return;
    if (b.status === 'pending') return resume(id);
    const box = document.createElement('div');
    box.innerHTML = b.code && (b.status === 'paid') ? successHTML(b, false) : '<p class="pp-h" style="font-size:15px">Бронь ' + esc(b.number) + ': ' + esc(b.statusLabel) + '. Кода доступа нет.</p>';
    const sh = UI.sheet({ title: 'Бронь ' + b.number, sub: P.dateLong(b.date) + ', ' + b.timeLabel, body: box, width: 620 });
    if (box.querySelector('[data-ics]')) bindSuccess(box, b, sh);
  } catch (x) { UI.toast(x.message, { kind: 'err' }); }
}

/* Перенос: другое свободное время, та же длительность. Разница в цене — доплата или возврат. */
async function reschedule(id) {
  let b;
  try { b = await BookingAPI.getBooking(id); } catch (x) { UI.toast(x.message, { kind: 'err' }); return; }
  if (!b || !b.canReschedule) { UI.toast(b && b.rescheduled ? 'Бесплатный перенос уже использован' : 'Перенос возможен не позднее чем за 3 часа до начала', { kind: 'err' }); return; }
  const s = BookingAPI.settings(), days = next14();
  const st = { date: b.date, start: null };
  const root = document.createElement('div'); root.className = 'bk';
  const sh = UI.sheet({ title: 'Перенос брони ' + b.number, sub: 'Сейчас: ' + P.dateLabel(b.date) + ', ' + b.timeLabel + ' · бесплатно, один раз', body: root, width: 720 });
  sh.body.classList.add('bk-body');
  function render(foc) {
    const slots = BookingAPI.availabilitySync(st.date, b.id);
    let cal = '<div class="bk-cal" role="group" aria-label="Дата">' + P.DAY_SHORT.map(d => '<span class="wd" aria-hidden="true">' + d + '</span>').join('');
    for (let i = 0; i < P.dayIdx(P.parseYmd(days[0])); i++) cal += '<span aria-hidden="true"></span>';
    days.forEach(d => { const dd = P.parseYmd(d), sl = BookingAPI.availabilitySync(d, b.id), ok = sl.some(x => x.state === 'free' && fits(sl, s, x.start, b.dur)); cal += '<button type="button" class="bk-day' + (P.dayIdx(dd) >= 5 ? ' we' : '') + (ok ? '' : ' full') + '" data-date="' + d + '" aria-pressed="' + (d === st.date) + '"' + (ok ? '' : ' disabled') + ' aria-label="' + esc(P.dateLong(d)) + '"><b>' + dd.getDate() + '</b><i>' + (ok ? 'есть' : 'нет') + '</i></button>'; });
    cal += '</div>';
    let grid = '';
    slots.filter(x => x.start <= s.close - b.dur).forEach(x => {
      const same = x.start === b.start && st.date === b.date;
      let cls = x.state === 'free' && !fits(slots, s, x.start, b.dur) ? 'nofit' : x.state;
      if (same) cls = 'busy';
      const sel = st.start === x.start;
      grid += '<button type="button" class="bk-slot ' + cls + (sel ? ' sel' : '') + '" data-start="' + x.start + '"' + (cls === 'free' ? '' : ' disabled') + ' aria-pressed="' + sel + '"><b>' + hhmm(x.start) + '</b><span>' + (same ? 'сейчас' : cls === 'free' ? P.rateAt(s, x.start) + ' ₽/ч' : '—') + '</span></button>';
    });
    let diffTxt = '';
    if (st.start != null) {
      const q = BookingAPI.quote({ start: st.start, dur: b.dur, rackets: b.rackets }, b.promo || null);
      const d = q.total - b.amount;
      diffTxt = d > 0 ? 'Доплата ' + money(d) : d < 0 ? 'Вернём разницу ' + money(-d) : 'Без доплаты';
    }
    root.innerHTML = '<div class="pp-e" role="alert"></div><div class="bk-sec"><h3 class="bk-h">Новая дата <small>' + esc(P.dateLong(st.date)) + '</small></h3>' + cal + '</div><div class="bk-sec"><h3 class="bk-h">Новое время <small>длительность ' + durTxt(b.dur) + '</small></h3><div class="bk-slots">' + grid + '</div></div>' +
      '<div class="bk-bar"><div class="bk-what">' + (st.start == null ? '<b>Выберите новое время</b>Перенос бесплатный — меняется только цена по тарифу' : '<b>' + esc(P.dateLabel(st.date)) + ' · ' + hhmm(st.start) + '–' + hhmm(st.start + b.dur) + '</b>' + diffTxt) + '</div><button class="btn btn-main calm" type="button" data-go' + (st.start == null ? ' disabled' : '') + '>Перенести</button></div>';
    root.querySelectorAll('.bk-day').forEach(x => x.addEventListener('click', () => { st.date = x.getAttribute('data-date'); st.start = null; render('.bk-day[aria-pressed=true]'); }));
    root.querySelectorAll('.bk-slot.free').forEach(x => x.addEventListener('click', () => { st.start = +x.getAttribute('data-start'); render('[data-go]'); }));
    root.querySelector('[data-go]').addEventListener('click', async e => {
      const btn = e.currentTarget; btn.classList.add('loading');
      try {
        const r = await BookingAPI.rescheduleBooking(b.id, { date: st.date, start: st.start, dur: b.dur });
        sh.close('ok');
        UI.toast('Бронь перенесена на ' + P.dateLabel(st.date) + ', ' + r.booking.timeLabel + (r.diff > 0 ? '. Доплата ' + money(r.diff) + ' прошла' : r.diff < 0 ? '. Разницу ' + money(-r.diff) + ' вернём на карту' : ''), { kind: 'ok', ms: 9000 });
      } catch (x) { btn.classList.remove('loading'); err(root, x.message); }
    });
    const f = foc && root.querySelector(foc); if (f) f.focus({ preventScroll: true });
  }
  render();
}

document.addEventListener('click', e => {
  const el = e.target.closest && e.target.closest('[data-book]');
  if (!el) return;
  e.preventDefault();
  const g = n => el.getAttribute('data-book-' + n);
  open({ date: g('date'), start: g('start'), dur: g('dur') ? +g('dur') : null, players: g('players') ? +g('players') : null, rackets: g('rackets') ? +g('rackets') : 0, title: g('title'), partnerResponseId: g('response') });
});

window.PPBooking = { open: open, resume: resume, reschedule: reschedule, showBooking: showBooking };
})();
