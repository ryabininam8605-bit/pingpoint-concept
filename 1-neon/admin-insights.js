/* Server-backed administrator views. No QR payloads or local identity authority. */
(function (w) {
'use strict';
const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rub = value => new Intl.NumberFormat('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(value)||0)+' ₽';
const count = value => new Intl.NumberFormat('ru-RU').format(Number(value)||0);
const day = value => /^\d{4}-\d{2}-\d{2}$/.test(value||'') ? value.slice(8)+'.'+value.slice(5,7)+'.'+value.slice(0,4) : '—';
const stamp = value => value ? new Intl.DateTimeFormat('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value)) : '—';
const states={pending:'Ожидает оплаты',succeeded:'Оплачен',failed:'Ошибка',canceled:'Отменён',refunded:'Возвращён',partially_refunded:'Частично возвращён',requires_review:'Требует проверки',payment_review:'Оплата требует проверки',refund_pending:'Возврат в обработке',paid:'Оплачена',cancelled:'Отменена',refund_partial:'Нужен расчёт возврата',noshow:'Неявка',expired:'Истекла'};
const methods={card:'Карта',bank_card:'Карта',sbp:'СБП',cash:'Наличные',sberbank:'Сбербанк',yoo_money:'ЮMoney'};
const status = value => '<span class="tag">'+esc(states[value]||value||'—')+'</span>';
const cell = (label,html) => '<td data-l="'+esc(label)+'"><div class="c">'+html+'</div></td>';
const table = (labels,rows,empty) => '<div class="tw free"><table class="t cards"><thead><tr>'+labels.map(l=>'<th scope="col">'+esc(l)+'</th>').join('')+'</tr></thead><tbody>'+(rows||'<tr><td class="empty" colspan="'+labels.length+'">'+esc(empty||'Нет записей')+'</td></tr>')+'</tbody></table></div>';
async function request(path,params) {
  const query=new URLSearchParams();Object.entries(params||{}).forEach(([k,v])=>{if(v!==undefined&&v!=='')query.set(k,v);});
  const controller=w.AbortController?new w.AbortController():null;
  const timeout=controller?setTimeout(()=>controller.abort(),12000):null;
  try {
    const response=await w.fetch('/api/admin/'+path+(query.size?'?'+query:''),{credentials:'same-origin',cache:'no-store',signal:controller?controller.signal:undefined,headers:{Accept:'application/json'}});
    let body;try{body=await response.json();}catch(_){throw new Error('Сервер вернул непонятный ответ. Повторите загрузку.');}
    if(!response.ok){const error=new Error(body.error&&body.error.message||'Не удалось загрузить данные');error.code=body.error&&body.error.code;throw error;}return body;
  } catch(error) {
    if(error.name==='AbortError')throw new Error('Сервер долго не отвечает. Повторите загрузку.');
    throw error;
  } finally {if(timeout)clearTimeout(timeout);}
}
function chart(series,keys,title,unit) {
  const width=760,height=245,L=70,R=18,T=24,B=45,W=width-L-R,H=height-T-B;
  const values=series.flatMap(row=>keys.map(k=>Number(row[k.key])||0));
  const lo=Math.min(0,...values),hi=Math.max(1,...values),span=hi-lo;
  const x=i=>L+(series.length<=1?W/2:i*W/(series.length-1));const y=v=>T+(hi-v)/span*H;
  let svg='<svg class="ins-chart" viewBox="0 0 '+width+' '+height+'" role="img" aria-label="'+esc(title+', '+unit+'. Точные данные в таблице ниже')+'"><title>'+esc(title+' · '+unit)+'</title>';
  const ticks=unit==='шт.'?[...new Set([0,Math.round(hi/3),Math.round(hi*2/3),Math.ceil(hi)])]:[lo,lo+span/3,lo+span*2/3,hi];
  for(const n of ticks){svg+='<line x1="'+L+'" x2="'+(width-R)+'" y1="'+y(n)+'" y2="'+y(n)+'" stroke="rgba(160,170,255,.15)"/><text x="'+(L-8)+'" y="'+(y(n)+4)+'" text-anchor="end">'+esc(new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(n))+'</text>';}
  svg+='<text x="'+L+'" y="13">'+esc(unit)+'</text>';
  keys.forEach(k=>{const points=series.map((r,i)=>x(i)+','+y(Number(r[k.key])||0)).join(' ');svg+='<polyline points="'+points+'" fill="none" stroke="'+k.color+'" stroke-width="2.5" stroke-linejoin="round"/>';series.forEach((r,i)=>{const text=day(r.date)+': '+k.label+' '+(unit==='₽'?rub(r[k.key]):count(r[k.key]));svg+='<circle cx="'+x(i)+'" cy="'+y(Number(r[k.key])||0)+'" r="3" fill="'+k.color+'"><title>'+esc(text)+'</title></circle>';});});
  const indices=[...new Set([0,Math.floor((series.length-1)/2),series.length-1])].filter(i=>i>=0&&i<series.length);
  indices.forEach(i=>{svg+='<text x="'+x(i)+'" y="'+(height-19)+'" text-anchor="'+(i===0?'start':i===series.length-1?'end':'middle')+'">'+esc(day(series[i].date))+'</text>';});
  svg+='</svg><div class="legend">'+keys.map(k=>'<span><i style="background:'+k.color+'"></i>'+esc(k.label)+'</span>').join('')+'</div>';return svg;
}
function analyticsHTML(data) {
  const t=data.totals||{},series=data.series||[];
  const cards=[['Поступления',rub(t.gross),'До комиссии платёжной системы'],['Подтверждённые возвраты',rub(t.refunds),'По дате подтверждения возврата'],['Поступления − возвраты',rub(t.net),'До комиссии; это не прибыль'],['Оплат за период',count(t.payments),'По дате подтверждённой оплаты'],['Новые регистрации',count(t.newUsers),'Всего аккаунтов: '+count(t.users)],['Новые брони',count(t.bookings),'По дате создания брони']];
  let html='<p class="box '+(data.mode==='test'?'warn':'')+'">'+(data.mode==='test'?'Тестовые платежи — реальные поступления сюда не входят.':'Реальные платежи — тестовые операции исключены.')+' Период и время: Москва.</p><div class="kpis">'+cards.map(c=>'<div class="kpi"><span>'+esc(c[0])+'</span><b>'+esc(c[1])+'</b><small>'+esc(c[2])+'</small></div>').join('')+'</div>';
  html+='<section class="panel"><h2>Деньги по дням</h2><p class="note">Поступления до комиссии — по дате оплаты. Возвраты — по дате подтверждения. Суммы в рублях.</p>'+chart(series,[{key:'gross',label:'Поступления',color:'#3dffa8'},{key:'refunds',label:'Возвраты',color:'#ffb938'},{key:'net',label:'Разница',color:'#8f9bff'}],'Поступления и возвраты','₽')+'</section>';
  html+='<section class="panel"><h2>Регистрации, брони и оплаты</h2>'+chart(series,[{key:'registrations',label:'Регистрации',color:'#ff2e63'},{key:'bookings',label:'Созданные брони',color:'#8f9bff'},{key:'payments',label:'Подтверждённые оплаты',color:'#3dffa8'}],'Количество событий по дням','шт.')+'<p class="note">Регистрации общие для обоих режимов. Брони и деньги разделены на реальные и тестовые.</p></section>';
  if(!series.some(r=>['registrations','bookings','payments','gross','refunds'].some(k=>Number(r[k]))))html+='<p class="box">За выбранный период событий нет. Нулевые дни сохранены в таблице.</p>';
  html+='<section class="panel"><details><summary>Точные данные по дням</summary>'+table(['Дата (Москва)','Регистрации','Брони','Оплаты','Поступления, ₽','Возвраты, ₽','Разница, ₽'],series.map(r=>'<tr>'+cell('Дата',day(r.date))+cell('Регистрации',count(r.registrations))+cell('Брони',count(r.bookings))+cell('Оплаты',count(r.payments))+cell('Поступления',rub(r.gross))+cell('Возвраты',rub(r.refunds))+cell('Разница',rub(r.net))+'</tr>').join(''),'Нет данных за период')+'</details></section>';
  html+='<section class="panel"><h2>Способы оплаты</h2>'+table(['Способ','Оплат','Поступления до комиссии'],(data.methods||[]).map(m=>'<tr>'+cell('Способ',esc(methods[m.method]||m.method))+cell('Оплат',count(m.count))+cell('Поступления',rub(m.amount))+'</tr>').join(''),'Подтверждённых оплат нет')+'</section>';
  html+='<section class="panel"><h2>Статусы созданных платёжных попыток</h2><p class="note">По дате создания попытки; этот счётчик не равен числу поступлений по дате оплаты.</p>'+table(['Статус','Попыток'],(data.statuses||[]).map(row=>'<tr>'+cell('Статус',status(row.status))+cell('Попыток',count(row.count))+'</tr>').join(''),'Платёжных попыток нет')+'</section>';return html;
}
function usersHTML(data) {
  return table(['Пользователь','Телефон-логин','Зарегистрирован (Москва)','Последний вход (Москва)','Брони','Реальные оплаты'],(data.list||[]).map(u=>'<tr>'+cell('Пользователь','<button class="linkbtn" type="button" data-user="'+esc(u.id)+'">'+esc(u.name)+'</button><small class="hash">'+esc(u.id)+'</small>')+cell('Телефон-логин',esc(u.phone)+'<small>'+(u.phoneVerified?'подтверждён':'не подтверждён')+'</small>')+cell('Зарегистрирован',esc(stamp(u.createdAt)))+cell('Последний вход',esc(stamp(u.lastLoginAt)))+cell('Брони',count(u.bookingsCount))+cell('Реальные оплаты',count(u.paidCount)+'<small>'+esc(rub(u.totalPaid))+' до возвратов и комиссии</small>')+'</tr>').join(''),'Зарегистрированных пользователей не найдено')+'<div class="more"><span>Всего: '+count(data.total)+' · страница '+count(data.page)+' из '+Math.max(1,Math.ceil(data.total/data.pageSize))+'</span><div class="acts"><button type="button" class="btn btn-ghost btn-xs" data-prev '+(data.page<=1?'disabled':'')+'>← Назад</button><button type="button" class="btn btn-ghost btn-xs" data-next '+(data.page*data.pageSize>=data.total?'disabled':'')+'>Далее →</button></div></div>';
}
const reasons={active:'Сеанс идёт',scheduled:'Сеанс ещё не начался',expired:'Сеанс закончился',revoked:'Пропуск отозван',payment_invalid:'Оплата не даёт доступа',refund_pending:'Возврат в обработке',unknown:'Пропуск не найден'};
function integrationsHTML(data,events) {
  const names={payments:'ЮKassa',access:'СКУД',passkeys:'Ключи доступа устройства'};
  let html='<div class="ins-integrations">'+Object.entries(names).map(([key,name])=>{const item=data[key]||{};const badge=key==='access'?(item.configured?'Онлайн-коннектор настроен':'СКУД не подключена'):(item.configured?'Параметры настроены':'Не настроено');return '<section class="panel"><h2>'+name+'</h2><p class="tag">'+badge+'</p><p>'+esc(item.message||'Ожидаются параметры подключения')+'</p>'+(item.mode?'<p class="note">Режим: '+esc(item.mode)+'</p>':'')+(key==='access'?'<p class="note">Модель оборудования ещё уточняется. Совместимость и полевой проход не проверены. Коннектор проверяет право входа; команд открытия двери в панели нет.</p>':'')+(item.missing&&item.missing.length?'<p class="note">Заполнить на сервере:</p><ul class="ins-vars">'+item.missing.map(v=>'<li><code>'+esc(v)+'</code></li>').join('')+'</ul>':'')+(key==='passkeys'&&item.origin?'<p class="note">Origin: '+esc(item.origin)+'<br>RP ID: '+esc(item.rpId)+'</p>':'')+'</section>';}).join('')+'</div>';
  html+='<section class="panel"><h2>Последние проверки прохода</h2><p class="note">Москва. Токены QR и секреты здесь не отображаются. События «Симуляция» не являются физическим проходом.</p>'+table(['Когда','Бронь','Дверь','Решение','Причина'],(events||[]).map(e=>{const simulation=String(e.reason||'').startsWith('simulation:');const reason=String(e.reason||'').replace(/^simulation:/,'');return '<tr>'+cell('Когда',esc(stamp(e.at)))+cell('Бронь',e.bookingId?'<button class="linkbtn hash" type="button" data-booking="'+esc(e.bookingId)+'">'+esc(e.bookingId)+'</button>':'—')+cell('Дверь',esc(e.doorId||'—'))+cell('Решение',(simulation?'Симуляция: ':'')+(e.result==='allow'?'Разрешён':'Отказ'))+cell('Причина',esc(reasons[reason]||reason))+'</tr>';}).join(''),'Проверок прохода пока нет')+'</section>';return html;
}
function paymentsHTML(data) {
 return table(['Платёж / источник','Бронь','Сумма','Статус','Создан (Москва)','Оплачен (Москва)','Возврат'],(data.list||[]).map(p=>'<tr>'+cell('Платёж / источник','<span class="hash">'+esc(p.id)+'</span><small>'+esc(p.provider||'Прежний платёж')+' · '+(p.test===false?'реальный':'тестовый')+' · '+esc(methods[p.method]||p.method||'—')+'</small>')+cell('Бронь',p.booking?'<button class="linkbtn" type="button" data-booking="'+esc(p.booking.id)+'">'+esc(p.booking.number)+'</button><small>'+esc(p.booking.name)+'</small>':esc(p.bookingId||'—'))+cell('Сумма',rub(p.amount))+cell('Статус',status(p.status)+(p.reviewReason?'<small>'+esc(p.reviewReason)+'</small>':''))+cell('Создан',esc(stamp(p.createdAt)))+cell('Оплачен',esc(stamp(p.paidAt)))+cell('Возврат',rub(p.refunded||0))+'</tr>').join(''),'Платёжных попыток за выбранный период нет');
}
function errorHTML(error) {return '<div class="box alert" role="alert">'+esc(error.message||'Не удалось загрузить данные')+' <button class="btn btn-ghost btn-xs" data-retry type="button">Повторить</button></div>';}
function bindLoad(root,alive,onError,load,render) {
  let generation=0;
  async function refresh(){const own=++generation;root.setAttribute('aria-busy','true');root.innerHTML='<p class="box" role="status">Загрузка серверных данных…</p>';try{const data=await load();if(alive()&&own===generation)root.innerHTML=render(data);}catch(error){if(alive()&&own===generation){root.innerHTML=errorHTML(error);if(error.code==='AUTH'&&onError)onError(error);const retry=root.querySelector('[data-retry]');if(retry)retry.onclick=refresh;}}finally{if(alive()&&own===generation)root.setAttribute('aria-busy','false');}}
  return refresh;
}
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function shift(value,n){const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
let widget=0;
function controls(root,state,change) {
  const id='ins'+(++widget);root.innerHTML='<form class="bar ins-controls"><div class="fld"><span class="lbl">Период</span><div class="seg">'+[7,30,90].map(n=>'<button type="button" data-period="'+n+'" aria-pressed="'+(state.days===n)+'">'+n+' дней</button>').join('')+'</div></div><div class="fld"><label for="'+id+'f">С</label><input id="'+id+'f" class="in" type="date" name="from" required value="'+state.from+'"></div><div class="fld"><label for="'+id+'t">По</label><input id="'+id+'t" class="in" type="date" name="to" required value="'+state.to+'"></div><div class="fld"><label for="'+id+'m">Платежи</label><select class="in" id="'+id+'m" name="mode"><option value="live">Реальные</option><option value="test">Тестовые</option></select></div><button class="btn btn-main btn-sm" type="submit">Показать</button><p class="ins-validation" role="alert" data-validation></p></form>';
  root.querySelector('[name=mode]').value=state.mode;
  root.querySelectorAll('[data-period]').forEach(b=>b.onclick=()=>{state.days=Number(b.dataset.period);state.to=today();state.from=shift(state.to,1-state.days);controls(root,state,change);change();});
  root.querySelector('form').onsubmit=e=>{e.preventDefault();const from=root.querySelector('[name=from]').value,to=root.querySelector('[name=to]').value;const length=(new Date(to)-new Date(from))/86400000;if(!from||!to||length<0||length>=366){root.querySelector('[data-validation]').textContent='Выберите период от 1 до 366 дней.';return;}Object.assign(state,{from,to,mode:root.querySelector('[name=mode]').value,days:null});controls(root,state,change);change();};
  root.querySelector('[name=mode]').onchange=e=>{state.mode=e.target.value;change();};
}
const defaultPeriod=()=>({days:30,to:today(),from:shift(today(),-29),mode:'live'});
function mountAnalytics(root,alive,o) {const state=defaultPeriod();root.innerHTML='<section class="panel"><div class="eyebrow">Общие данные сайта</div><h2>Регистрации и деньги</h2><div data-controls></div></section><div data-data></div>';const output=root.querySelector('[data-data]');const refresh=bindLoad(output,alive,o.onError,()=>request('analytics',{from:state.from,to:state.to,mode:state.mode}),analyticsHTML);controls(root.querySelector('[data-controls]'),state,refresh);refresh();return refresh;}
function mountUsers(root,alive,o) {
 const state={q:'',page:1,pageSize:30};root.innerHTML='<section class="panel"><h2>Зарегистрированные пользователи</h2><p class="note">Общий серверный реестр, включая пользователей без броней. Телефон используется как логин; владение номером не проверено. Контакты гостевых броней находятся в отдельном разделе.</p><form class="bar" role="search"><div class="fld grow"><label for="ins-user-search">Имя или телефон</label><input class="in" id="ins-user-search" name="q" type="search" maxlength="100" placeholder="Найти пользователя"></div><button class="btn btn-ghost btn-sm">Найти</button></form><div data-data></div></section>';
 const output=root.querySelector('[data-data]'),refresh=bindLoad(output,alive,o.onError,()=>request('users',state),usersHTML);
 root.querySelector('form').onsubmit=e=>{e.preventDefault();state.q=root.querySelector('[name=q]').value.trim();state.page=1;refresh();};
 output.addEventListener('click',e=>{if(e.target.closest('[data-next]')){state.page++;refresh();}if(e.target.closest('[data-prev]')){state.page=Math.max(1,state.page-1);refresh();}const b=e.target.closest('[data-user]');if(b)openUser(b.dataset.user,o);});refresh();return refresh;
}
async function openUser(id,o) {
 const box=w.document.createElement('div');let closed=false;w.PPUI.sheet({title:'Пользователь',sub:'Серверная регистрация',body:box,width:820,onClose:()=>{closed=true;}});
 const refresh=bindLoad(box,()=>!closed,o.onError,()=>request('users/'+encodeURIComponent(id)),d=>{const u=d.user;return '<h3>'+esc(u.name)+'</h3><p class="hash">'+esc(u.id)+'</p><dl class="kv"><div><dt>Телефон-логин</dt><dd>'+esc(u.phone)+' · '+(u.phoneVerified?'подтверждён':'не подтверждён')+'</dd></div><div><dt>Зарегистрирован · Москва</dt><dd>'+esc(stamp(u.createdAt))+'</dd></div><div><dt>Последний вход · Москва</dt><dd>'+esc(stamp(u.lastLoginAt))+'</dd></div></dl><h3>Регистрационные согласия</h3>'+table(['Документ','Версия','Принято (Москва)'],(d.registrations||[]).map(c=>'<tr>'+cell('Документ',esc(c.docId||c.id))+cell('Версия',esc(c.docVersion||c.version))+cell('Принято',esc(stamp(c.acceptedAt||c.at)))+'</tr>').join(''),'Нет серверных записей')+'<h3>Брони и оплаты</h3>'+table(['Бронь','Сеанс','Стоимость','Статус','Платежи'],(d.bookings||[]).map(b=>'<tr>'+cell('Бронь','<button class="linkbtn" data-booking="'+esc(b.id)+'" type="button">'+esc(b.number)+'</button>')+cell('Сеанс',day(b.date))+cell('Стоимость',rub(b.amount))+cell('Статус',status(b.status))+cell('Платежи',(b.payments||(b.payment?[b.payment]:[])).map(p=>status(p.status)+' '+esc(rub(p.amount))+' · '+(p.test===false?'реальный':'тестовый')).join('<br>')||'—')+'</tr>').join(''),'У пользователя пока нет броней');});box.addEventListener('click',e=>{const b=e.target.closest('[data-booking]');if(b)o.openBooking(b.dataset.booking);});refresh();
}
function mountPayments(root,alive,o) {
 const state=defaultPeriod();let last=null,limit=30;
 root.innerHTML='<section class="panel"><div class="panel-h"><h2>Реестр платёжных попыток</h2><button class="btn btn-ghost btn-xs" data-export type="button" disabled>Выгрузить CSV</button></div><p class="note">Фильтр — по дате создания попытки. Возврат здесь — накопленная сумма по платежу за всё время. Это реестр, а поступления по дате оплаты и возвраты по дате подтверждения смотрите в «Сводке».</p><div data-controls></div><div class="bar"><div class="fld"><label for="ins-pay-status">Статус</label><select id="ins-pay-status" class="in"><option value="">Все статусы</option>'+['pending','succeeded','requires_review','refunded','partially_refunded','canceled','failed'].map(k=>'<option value="'+k+'">'+states[k]+'</option>').join('')+'</select></div></div><div data-data></div></section>';
 const output=root.querySelector('[data-data]'),exportButton=root.querySelector('[data-export]');
 function draw(data){return paymentsHTML({list:data.list.slice(0,limit)})+'<div class="more"><span>Показано '+Math.min(data.list.length,limit)+' из '+data.list.length+'</span>'+(data.list.length>limit?'<button type="button" class="btn btn-ghost btn-xs" data-more-pay>Показать ещё</button>':'')+'</div>';}
 const refresh=bindLoad(output,alive,o.onError,async()=>{exportButton.disabled=true;last=null;const data=await request('payments',{from:state.from,to:state.to,mode:state.mode,status:state.status});return data;},data=>{last=data;exportButton.disabled=false;return draw(data);});
 const changed=()=>{limit=30;refresh();};controls(root.querySelector('[data-controls]'),state,changed);
 root.querySelector('#ins-pay-status').onchange=e=>{state.status=e.target.value;changed();};
 root.addEventListener('click',e=>{const b=e.target.closest('[data-booking]');if(b)o.openBooking(b.dataset.booking);if(e.target.closest('[data-more-pay]')&&last){limit+=30;output.innerHTML=draw(last);}});
 exportButton.onclick=()=>{
   if(!last)return;
   const csvCell=value=>{let text=String(value==null?'':value);if(/^[=+\-@]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
   const rows=[['Режим',state.mode,'Период создания попыток',state.from,state.to],['Платёж','Бронь','Провайдер','Тестовый','Сумма RUB','Статус','Создан (Москва)','Оплачен (Москва)','Возвращено RUB']];
   last.list.forEach(p=>rows.push([p.id,p.bookingId,p.provider||'',p.test!==false?'да':'нет',p.amount,states[p.status]||p.status,stamp(p.createdAt),stamp(p.paidAt),p.refunded||0]));
   w.PPUI.saveFile('pingpoint-payments-'+state.mode+'-'+state.from+'.csv','\ufeff'+rows.map(row=>row.map(csvCell).join(';')).join('\r\n'),'text/csv;charset=utf-8');
 };
 refresh();return refresh;
}
function mountIntegrations(root,alive,o) {const refresh=bindLoad(root,alive,o.onError,async()=>{const [data,events]=await Promise.all([request('integrations'),request('access-events',{limit:100})]);return{data,events};},v=>integrationsHTML(v.data,v.events.list));root.addEventListener('click',e=>{const b=e.target.closest('[data-booking]');if(b)o.openBooking(b.dataset.booking);});refresh();return refresh;}
w.AdminInsights={request,analyticsHTML,usersHTML,integrationsHTML,paymentsHTML,errorHTML,mountAnalytics,mountUsers,mountPayments,mountIntegrations};
})(window);
