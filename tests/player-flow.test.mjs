import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function fixture() {
  const calls=[],win={BookingAPI:{},AdminAPI:{},CommunityAPI:{meSync:()=>null},localStorage:{setItem(){},removeItem(){}},dispatchEvent(){},addEventListener(){},fetch:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>url==='/api/session'?{csrf:'session-csrf',settings:{},capabilities:{payments:'live',access:'unconfigured'}}:url.endsWith('/refresh')?{payment:{status:'pending'},booking:{id:'book',status:'pending'}}:{status:'scheduled',test:false,qrSvg:'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>',qrPayload:'server-issued-opaque',validFrom:1792220400000,validTo:1792224000000}};}};
  vm.runInNewContext(fs.readFileSync(new URL('../1-neon/shared-booking.js',import.meta.url),'utf8'),{window:win,CustomEvent:class{},AbortController,URL,URLSearchParams,setTimeout,clearTimeout,setInterval:()=>0});
  return {api:win.BookingAPI,calls};
}
test('checkout rejects executable, plain HTTP and credentialed redirect URLs',async()=>{
  const f=fixture();await f.api.ready;
  assert.equal(typeof f.api.checkoutUrl,'function','checkout must validate provider redirect');
  for(const confirmationUrl of ['javascript:alert(1)','http://bank.example/pay','https://u:p@bank.example/pay','//bank.example/pay']) assert.throws(()=>f.api.checkoutUrl({confirmationUrl}));
  assert.equal(f.api.checkoutUrl({confirmationUrl:'https://yoomoney.ru/checkout/payments/v2/contract?orderId=sample'}),'https://yoomoney.ru/checkout/payments/v2/contract?orderId=sample');
});
test('payment return rechecks the server and never invokes demo confirmation',async()=>{
  const f=fixture();await f.api.ready;
  assert.equal(typeof f.api.refreshPayment,'function','provider reconciliation must be exposed');
  const value=await f.api.refreshPayment('pay /?');
  assert.equal(value.booking.status,'pending');
  const call=f.calls.find(x=>x.url.includes('/refresh'));
  assert.equal(call.url,'/api/payments/pay%20%2F%3F/refresh');
  assert.equal(call.options.headers['X-PP-CSRF'],'session-csrf');
  assert.equal(f.calls.some(x=>x.url.endsWith('/confirm')),false);
});
test('access display uses only the server QR and marks unconfigured doors; expiry removes it',async()=>{
  const f=fixture();await f.api.ready;
  assert.equal(typeof f.api.accessHTML,'function','one shared server QR presentation is required');
  const response=await f.api.getAccess('book');
  const html=f.api.accessHTML(response);
  assert.match(html,/СКУД не подключена/);
  assert.match(html,/data:image\/svg\+xml/);
  assert.match(html,/Повторный вход/);
  assert.doesNotMatch(html,/server-issued-opaque/,'opaque token must not become an HTML fallback');
  assert.doesNotMatch(f.api.accessHTML({...response,status:'expired'}),/<img/);
  assert.doesNotMatch(f.api.accessHTML({...response,test:true}),/<img/);
  assert.doesNotMatch(f.api.accessHTML({status:'unavailable',reason:'<script>bad</script>'}),/<script>/);
});
test('updated documents keep owned paid bookings and QR visible with an honest renewal path',async()=>{
  const html=fs.readFileSync(new URL('../1-neon/cabinet.html',import.meta.url),'utf8');
  const render=html.slice(html.indexOf('async function renderPanel('),html.indexOf('function chips('));
  const bookings=html.slice(html.indexOf('let bkCache ='),html.indexOf('function showCode(b)'));
  const panel={innerHTML:'',dataset:{},contains:()=>false},paid={id:'paid-booking',number:'PP-TEST',status:'paid',statusLabel:'Оплачена',test:false,startTs:Date.now()+86400000,endTs:Date.now()+90000000,dateLabel:'18.10.2026',timeLabel:'12:00–13:00',players:2,dur:60,amount:400};
  let reads=0;
  const context={panel,document:{activeElement:null},tab:'bookings',me:{docsOk:false,outdated:['policy']},profDirty:false,renderSeq:1,AFTER:{},openNewAfter:false,showAllPast:false,TABS:[['bookings','Мои бронирования'],['profile','Профиль']],PANELS:{},settings:()=>({cancelHours:3,holdMin:15}),B:{listMyBookings:async()=>{reads++;return {upcoming:[paid],past:[]};}},P:{money:v=>String(v)+' ₽',plural:()=> 'игрока'},U:{docLink:()=>'<a>Оферта</a>'},esc:v=>String(v),Date,console};
  vm.createContext(context);vm.runInContext(render+'\n'+bookings+'\nPANELS.bookings=pBookings;',context);
  await context.renderPanel(1,false);
  assert.equal(reads,1,'existing server bookings must be loaded despite stale registration documents');
  assert.match(panel.innerHTML,/PP-TEST/);
  assert.match(panel.innerHTML,/data-act="bk-code"/,'paid booking must retain its real QR action');
  assert.match(panel.innerHTML,/администратор/i);
  assert.doesNotMatch(panel.innerHTML,/полминуты|брони в кабинете недоступны|всё заработает как прежде/);
  context.tab='profile';
  await context.renderPanel(1,false);
  assert.match(panel.innerHTML,/продление в кабинете пока недоступно/);
  assert.match(panel.innerHTML,/href="#bookings"/);
  assert.doesNotMatch(panel.innerHTML,/полминуты|всё заработает как прежде/);
});
test('automatic document check cannot cover booking navigation with unsupported server renewal',()=>{
  const cabinet=fs.readFileSync(new URL('../1-neon/cabinet.html',import.meta.url),'utf8');
  const community=fs.readFileSync(new URL('../1-neon/community.js',import.meta.url),'utf8');
  const updates=community.slice(community.indexOf('let docUpdOpen ='),community.indexOf('/* ---------- Cookie-баннер'));
  const routes=cabinet.slice(cabinet.indexOf('function route(initial)'),cabinet.indexOf('/* ---------- старт ---------- */'));
  const help=cabinet.slice(cabinet.indexOf('function confirmDocs('),cabinet.indexOf('function editConditions('));
  const dialogs=[],timers=[],listeners={},rendered=[];let consentChecks=0;
  const element={innerHTML:'',classList:{add(){},remove(){}},addEventListener(){},appendChild(){},querySelector(){return this;}};
  const user={id:'owned-account',docsOk:false,outdated:['policy']};
  const context={AccountAPI:{},me:user,CommunityAPI:{meSync:()=>user,outdatedDocsSync:()=>[{id:'policy',title:'Политика',version:'2',date:'2026-10-17'}]},C:{meSync:()=>user},
    document:{createElement:()=>Object.create(element)},location:{hash:'#profile'},tab:'profile',mode:'app',TABS:[['profile','Профиль'],['bookings','Мои бронирования']],TAB_IDS:['profile','bookings'],fresh:{},profDirty:false,showAllPast:false,
    appView:{getBoundingClientRect:()=>({top:0})},scrollY:0,scrollTo(){},render(){rendered.push(context.tab);},scheduleRender(){},
    addEventListener:(name,fn)=>{listeners[name]=fn;},setTimeout:fn=>timers.push(fn),
    esc:String,docLink:()=>'<a>Политика</a>',missingHint:()=>'',consentChecks:()=>{consentChecks++;return {el:{},ok:()=>false,missing:()=>[]};},sheet:options=>{dialogs.push(options);return {close(){}};},U:{sheet:options=>dialogs.push(options)}};
  context.window=context;context.global=context;
  vm.createContext(context);vm.runInContext(updates+'\n'+routes+'\n'+help,context);
  context.U.checkDocUpdates=context.checkDocUpdates;
  const startup=cabinet.match(/setTimeout\(\(\) => U\.checkDocUpdates\(\), 500\);/)[0];
  vm.runInContext(startup,context);timers.forEach(fn=>fn());
  assert.equal(dialogs.length,0,'startup must not block the bookings link with an unsupported consent modal');
  // Browser default action for the real #bookings link after a click.
  context.location.hash='#bookings';listeners.hashchange();
  assert.equal(context.tab,'bookings');assert.deepEqual(rendered,['bookings']);
  context.confirmDocs();
  assert.equal(dialogs.length,1);assert.match(dialogs[0].body,/пока недоступно/);
  assert.doesNotMatch(dialogs[0].body,/<input|data-ok|type="checkbox"/);
  assert.equal(consentChecks,0,'server renewal must never offer legacy acceptance');
  delete context.AccountAPI;
  assert.equal(context.checkDocUpdates(),true,'legacy local community checks are preserved');
  assert.equal(consentChecks,1);
});
