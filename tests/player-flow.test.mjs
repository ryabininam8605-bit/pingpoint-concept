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

test('guest contact step explains browser retrieval instead of promising SMS delivery',()=>{
  const code=fs.readFileSync(new URL('../1-neon/booking.js',import.meta.url),'utf8');
  const step=code.slice(code.indexOf('  function step3()'),code.indexOf('  /* ---------- шаг 4:'));
  const field=()=>({value:'',classList:{add(){},remove(){}},addEventListener(){},appendChild(){}}),fields=new Map();
  const root={innerHTML:'',querySelector:selector=>{if(!fields.has(selector))fields.set(selector,field());return fields.get(selector);}};
  const context={root,CommunityAPI:{meSync:()=>null},P:{BOOKING_DOCS:['policy'],normPhone:()=>null},UI:{bindPhoneMask(){},consentChecks:()=>({el:{},missing:()=>['policy']}),missingHint:()=>''},st:{name:'',phone:''},s:{cancelHours:3},stepsHTML:()=>'',sumHTML:()=>'',whatHTML:()=>'',quote:()=>({total:400}),money:String,esc:String};
  vm.createContext(context);vm.runInContext(step+'\nstep3();',context);
  assert.doesNotMatch(root.innerHTML,/код и чек придут на телефон|для кода и чека/);
  assert.match(root.innerHTML,/QR/);assert.match(root.innerHTML,/этом браузере/);assert.match(root.innerHTML,/других устройств/);
});

// Exercise the real sheet/access/booking helpers together. The small DOM tracks
// focus-triggered scrolling; real viewport geometry is checked in browser QA.
function accessDialogFixture() {
  const timers=new Map();let timerId=0;
  const document={activeElement:null,documentElement:{style:{}},contains:()=>true,addEventListener(){}};
  class Element {
    constructor(tag='div',attrs='') {this.tag=tag;this.attrs=attrs;this.style={};this.dataset={};this.children=[];this.listeners={};this.scrollTop=0;this.isConnected=true;this.offsetParent={};this.classList={add(){},remove(){}};}
    set innerHTML(value) {this.html=value;this.children=[];for(const m of value.matchAll(/<(div|b|span|button|input|a|select|textarea|img)\b([^>]*)>/g))this.appendChild(new Element(m[1],m[2]));}
    get innerHTML(){return this.html||'';}
    appendChild(child){child.parent=this;this.children.push(child);return child;}
    setAttribute(key,value){this.attrs+=' '+key+'="'+value+'"';if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,ch)=>ch.toUpperCase())]=value;}
    matches(selector){if(selector.startsWith('.'))return ((this.className||'')+' '+(this.attrs.match(/class="([^"]*)"/)?.[1]||'')).split(/\s+/).includes(selector.slice(1));if(selector.startsWith('['))return this.attrs.includes(selector.slice(1,-1).split('=')[0]);return this.tag===selector;}
    closest(selector){return this.matches(selector)?this:this.parent?.closest(selector)||null;}
    all(){return this.children.flatMap(child=>[child,...child.all()]);}
    querySelectorAll(selector){return this.all().filter(node=>selector.includes(',')?['button','input','a','select','textarea'].includes(node.tag):node.matches(selector.split(' ').at(-1)));}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
    focus(options){document.activeElement=this;if(!options?.preventScroll){const body=this.closest('.pp-sheet-body');if(body)body.scrollTop=600;}}
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
    contains(node){return this===node||this.all().includes(node);}
  }
  document.body=new Element('body');document.createElement=tag=>new Element(tag);
  const paid={id:'paid-booking',number:'PP-SYNTHETIC',date:'2026-10-18',timeLabel:'12:00–13:00',status:'paid',statusLabel:'Оплачена',players:2,rackets:0,amount:400,test:false};
  const access={status:'scheduled',test:false,qrSvg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"></svg>',qrPayload:'synthetic-opaque',validFrom:1792220400000,validTo:1792224000000};
  const context={document,BookingAPI:{},AdminAPI:{},CommunityAPI:{meSync:()=>null},localStorage:{setItem(){},removeItem(){}},dispatchEvent(){},addEventListener(){},
    fetch:async url=>({ok:true,json:async()=>url==='/api/session'?{csrf:'initial',settings:{},capabilities:{access:'unconfigured'}}:url.endsWith('/access')?access:paid}),
    CustomEvent:class{},AbortController,URL,URLSearchParams,Intl,Date,console,
    setTimeout:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),setInterval:()=>0,
    requestAnimationFrame:fn=>fn(),uid:()=> 'dialog-title',esc:String,money:String,ICO_OK:'',P:{dateLabel:String,dateLong:String},resume(){},err(){}};
  context.window=context;vm.createContext(context);
  const community=fs.readFileSync(new URL('../1-neon/community.js',import.meta.url),'utf8');
  vm.runInContext(community.slice(community.indexOf('const $ = (s, c)'),community.indexOf('let toastBox =')),context);
  context.UI={sheet:context.sheet,docLink:()=>'',saveFile(){},icsFor(){},toast:message=>{throw Error(message);}};context.PPUI=context.UI;
  vm.runInContext(fs.readFileSync(new URL('../1-neon/shared-booking.js',import.meta.url),'utf8'),context);
  const booking=fs.readFileSync(new URL('../1-neon/booking.js',import.meta.url),'utf8');
  vm.runInContext(booking.slice(booking.indexOf('function successHTML('),booking.indexOf('async function resume('))+booking.slice(booking.indexOf('async function showBooking('),booking.indexOf('/* Перенос:')),context);
  context.PPBooking={showBooking:context.showBooking};context.U=context.UI;context.B=context.BookingAPI;
  const cabinet=fs.readFileSync(new URL('../1-neon/cabinet.html',import.meta.url),'utf8');
  vm.runInContext(cabinet.slice(cabinet.indexOf('function showCode('),cabinet.indexOf('function nextSameWeekday(')),context);
  return {context,paid,document,Element,booking,flush:async()=>{for(let i=0;i<12;i++)await Promise.resolve();for(const [id,timer]of timers)if(timer.ms===60){timers.delete(id);timer.fn();}}};
}
test('opening a QR from cabinet or payment success keeps focus at the modal start and traps Tab',async()=>{
  for(const entry of ['cabinet','success']) {
    const f=accessDialogFixture(),c=f.context;await c.BookingAPI.ready;
    if(entry==='cabinet')await c.showCode(f.paid);
    else {
      c.root=new f.Element();c.st={booking:f.paid};c.stepsHTML=()=>'<p>Шаг 5 из 5</p>';
      c.sh=c.UI.sheet({title:'Бронирование',body:c.root});c.sh.body.scrollTop=400;
      vm.runInContext(f.booking.slice(f.booking.indexOf('  function step5()'),f.booking.indexOf('  if (resumeBooking)'))+'\nstep5();',c);
    }
    await f.flush();
    const dialog=f.document.body.children.at(-1),body=dialog.querySelector('.pp-sheet-body'),close=dialog.querySelector('.pp-x');
    assert.ok(f.document.activeElement===close,entry+': initial focus belongs to the close control, above the QR');
    assert.equal(body.scrollTop,0,entry+': showing a pass cannot auto-scroll its upper quiet zone out of view');
    const controls=dialog.querySelectorAll('button,input,a,select,textarea'),last=controls.at(-1);last.focus({preventScroll:true});
    let trapped=false;dialog.listeners.keydown[0]({key:'Tab',shiftKey:false,preventDefault(){trapped=true;}});
    assert.equal(trapped,true);assert.equal(f.document.activeElement,close,'Tab wraps inside the dialog');
  }
});
test('ordinary authentication sheets retain their first form control focus',async()=>{
  const f=accessDialogFixture(),form=new f.Element();form.innerHTML='<input name="phone"><input name="password">';
  const sh=f.context.UI.sheet({title:'Войти',body:form});await f.flush();
  assert.equal(f.document.activeElement,form.querySelector('input'));
  assert.ok(sh.el.contains(f.document.activeElement));
});
