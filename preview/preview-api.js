/* Public walkthrough only. Injected by scripts/build_preview.py, never by server pages.
 * All API responses are simulated in this browser. No credentials, money or door access. */
(function(w){
'use strict';
const script=w.document.currentScript;
if(!script || script.dataset.publicPreview!=='1')return;
const base=new URL('./',script.src),realFetch=w.fetch.bind(w),KEY='pp_public_walkthrough_v1';
const copy=x=>JSON.parse(JSON.stringify(x)),now=()=>Date.now(),day=t=>new Date(t+10800000).toISOString().slice(0,10);
const today=()=>day(now()),shift=(d,n)=>new Date(Date.parse(d+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
const at=(d,m)=>Date.parse(d+'T00:00:00+03:00')+m*60000;
const id=p=>p+'_'+w.crypto.randomUUID(),fail=(message,code='PREVIEW')=>{throw Object.assign(Error(message),{code});};
const settings={open:600,close:1230,border:780,priceAm:400,pricePm:500,racket:100,minLeadMin:60,cancelHours:3,holdMin:15,maxPlayers:4,rules:['Бронь минимум за 1 час','До 4 игроков','Сменная обувь']};
const capabilities={accounts:true,passkeys:false,payments:'demo',access:'unconfigured'};
function user(n,name){return{id:'preview_user_'+n,name,phone:'7000000000'+n,phoneRaw:'7000000000'+n,phoneVerified:false,ageGroup:'adult',age:28,level:'amateur',docsOk:true,outdated:[],createdAt:now()-(28-n*3)*86400000,lastLoginAt:now()-n*3600000,consents:{}};}
function seed(){
 const s={version:1,day:today(),settings:copy(settings),users:[user(1,'Демо · Алексей'),user(2,'Демо · Марина'),user(3,'Демо · Игорь'),user(4,'Демо · Без брони')],current:'preview_user_1',admin:true,bookings:[],payments:[],blocks:[],promos:[{code:'DEMO10',type:'pct',value:10,active:true,used:0,limit:0,description:'Демонстрационная скидка'}],events:[]};
 for(let i=0;i<22;i++){
  const u=s.users[i%3],date=shift(today(),i<20?i-20:i===20?1:2),start=i===21?1080:600+(i%4)*120,dur=60,amount=start<780?400:500,createdAt=i<20?at(date,start)-3600000:now();
  const b={id:'preview_booking_'+i,number:'ДЕМО-'+(100+i),userId:u.id,name:u.name,phone:u.phone,date,start,dur,players:2,rackets:0,amount,status:'paid',createdAt,paymentId:'preview_payment_'+i,expiresAt:null,source:'preview',test:false,moves:0,history:[{at:createdAt,s:'paid',by:'system',note:'Вымышленная оплата для демонстрации'}]};
  s.bookings.push(b);s.payments.push({id:b.paymentId,bookingId:b.id,amount,status:'succeeded',createdAt,paidAt:createdAt,provider:'preview',method:i%2?'sbp':'card',test:false,refunded:0});
 }
 // The player link always has one future example belonging to the selected demo player.
 s.bookings[20].userId=s.users[0].id;s.bookings[20].name=s.users[0].name;s.bookings[20].phone=s.users[0].phone;
 return s;
}
let db;
try{db=JSON.parse(w.localStorage.getItem(KEY));}catch(_){}
if(!db || db.version!==1 || db.day!==today())db=seed();
const entry=new URL(w.location.href).searchParams.get('entry');
if(entry==='player')db.current=db.users[0].id;
if(entry==='admin')db.admin=true;
function save(){try{w.localStorage.setItem(KEY,JSON.stringify(db));}catch(_){} }
save();
let qr='';
const qrReady=realFetch(new URL('demo-qr.svg',base)).then(r=>r.ok?r.text():'').then(x=>{qr=x;}).catch(()=>{});
function documents(){return (w.PP?.DOCS||[]).filter(d=>['policy','consent_pd','community_rules'].includes(d.id)).map(d=>({id:d.id,version:d.version,hash:'public-preview-'+d.id,url:new URL('1-neon/'+d.file,base).href}));}
function profile(u){if(!u)return null;const p=copy(u);documents().forEach(d=>p.consents[d.id]={active:true,version:d.version,hash:d.hash,acceptedAt:p.createdAt});return p;}
function current(){return db.users.find(u=>u.id===db.current)||null;}
function session(){return{settings:copy(db.settings),user:profile(current()),admin:db.admin,csrf:'public-preview-no-authority',demoPayments:true,capabilities:copy(capabilities)};}
function expire(){db.bookings.forEach(b=>{if(b.status==='pending'&&b.expiresAt<now())b.status='expired';});}
function view(b){const startTs=at(b.date,b.start),endTs=startTs+b.dur*60000;const labels={pending:'Ожидает оплаты',paid:'Оплачена',cancelled:'Отменена',refunded:'Возвращена',refund_partial:'Частичный возврат',expired:'Истекла',noshow:'Неявка'};return{...copy(b),statusLabel:labels[b.status]||b.status,startTs,endTs,isPast:endTs<now(),canCancel:['pending','paid'].includes(b.status)&&startTs>now(),cancelFree:startTs-now()>=10800000,cancelLate:startTs>now()&&startTs-now()<10800000,canReschedule:b.status==='paid'&&!b.rescheduled&&startTs-now()>=10800000,timeLabel:hh(b.start)+'–'+hh(b.start+b.dur),dateLabel:b.date,phoneFmt:b.phone,payment:copy(db.payments.find(p=>p.id===b.paymentId)||null),payments:copy(db.payments.filter(p=>p.bookingId===b.id))};}
function hh(m){return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');}
function findBooking(k){const b=db.bookings.find(b=>b.id===k);if(!b)fail('Бронь не найдена','NOTFOUND');return b;}
function range(o,exclude,admin=false){const start=Number(o.start),dur=Number(o.dur);if(!/^\d{4}-\d{2}-\d{2}$/.test(o.date)||start%30||dur%30||dur<60||dur>240||start<db.settings.open||start+dur>db.settings.close)fail('Выберите время в пределах работы комнаты','VALID');if(!admin&&at(o.date,start)-now()<db.settings.minLeadMin*60000)fail('Выберите время минимум за час до начала','LEAD');if(db.bookings.some(b=>b.id!==exclude&&b.date===o.date&&['pending','paid','noshow'].includes(b.status)&&start<b.start+b.dur&&start+dur>b.start)||db.blocks.some(b=>b.date===o.date&&start<b.end&&start+dur>b.start))fail('Это время занято — выберите другое','BUSY');}
function quote(o){let rent=0;for(let m=Number(o.start);m<Number(o.start)+Number(o.dur);m+=30)rent+=(m<db.settings.border?db.settings.priceAm:db.settings.pricePm)/2;const rackets=(Number(o.rackets)||0)*db.settings.racket*Number(o.dur)/60,subtotal=rent+rackets;const pr=o.promo?db.promos.find(p=>p.code===String(o.promo).toUpperCase()&&p.active):null;if(o.promo&&!pr)fail('Промокод не найден','PROMO');const discount=pr?(pr.type==='pct'?Math.round(subtotal*pr.value/100):Math.min(subtotal,pr.value)):0;return{rent,rackets,subtotal,discount,total:subtotal-discount};}
function availability(date,exclude){return{date,settings:copy(db.settings),slots:Array.from({length:(db.settings.close-db.settings.open)/30},(_,i)=>{const start=db.settings.open+i*30,busy=db.bookings.some(b=>b.id!==exclude&&b.date===date&&['pending','paid','noshow'].includes(b.status)&&start<b.start+b.dur&&start+30>b.start),blocked=db.blocks.some(b=>b.date===date&&start<b.end&&start+30>b.start);return{start,state:at(date,start)-now()<db.settings.minLeadMin*60000?'past':blocked?'blocked':busy?'busy':'free',rate:start<db.settings.border?db.settings.priceAm:db.settings.pricePm};})};}
function create(o,admin=false){range(o,null,admin);const q=quote(o),u=current();const b={id:id('preview_booking'),number:'ДЕМО-'+(100+db.bookings.length),userId:u?.id||null,name:o.name||u?.name||'Демо · Гость',phone:o.phone||u?.phone||'70000000000',date:o.date,start:Number(o.start),dur:Number(o.dur),players:Number(o.players)||2,rackets:Number(o.rackets)||0,amount:q.total,promo:o.promo||null,status:'pending',createdAt:now(),expiresAt:now()+900000,source:admin?'admin':'site',test:true,moves:0,history:[{at:now(),s:'pending',by:admin?'admin':'client',note:'Демонстрационная бронь'}]};db.bookings.push(b);return view(b);}
function payment(b,method='sbp'){const p={id:id('preview_payment'),bookingId:b.id,amount:b.amount,method,status:'pending',createdAt:now(),paidAt:null,refunded:0,test:true,provider:'preview'};db.payments.push(p);b.paymentId=p.id;return p;}
function paid(p){const b=findBooking(p.bookingId);p.status='succeeded';p.paidAt=now();b.status='paid';b.test=true;b.expiresAt=null;b.history.push({at:now(),s:'paid',by:'payment',note:'Имитация: деньги не списывались'});return{ok:true,booking:view(b)};}
function refund(b,amount=b.amount){const p=db.payments.find(p=>p.id===b.paymentId);if(p){p.refunded=Number(amount);p.refundedAt=now();p.status=amount>=p.amount?'refunded':'partially_refunded';}b.status=amount>=b.amount?'refunded':'refund_partial';b.refundAmount=Number(amount);b.history.push({at:now(),s:b.status,by:'admin',note:'Имитация возврата'});return view(b);}
function cancel(b){if(b.status==='paid')return refund(b);b.status='cancelled';return view(b);}
function move(b,o,admin=false,onlyQuote=false){const next={date:o.date||b.date,start:o.start??b.start,dur:o.dur??b.dur,rackets:b.rackets,promo:b.promo};range(next,b.id,admin);const amount=quote(next).total,diff=amount-b.amount;if(onlyQuote)return{oldAmount:b.amount,newAmount:amount,diff};Object.assign(b,next,{start:Number(next.start),dur:Number(next.dur),amount,rescheduled:!admin,moves:(b.moves||0)+1});b.history.push({at:now(),s:b.status,by:admin?'admin':'client',note:'Демо-перенос'});return admin?view(b):{booking:view(b),diff};}
function userStats(u){const list=db.bookings.filter(b=>b.userId===u.id),paid=db.payments.filter(p=>list.some(b=>b.id===p.bookingId)&&p.paidAt);return{...profile(u),bookingsCount:list.length,paidCount:paid.length,totalPaid:paid.reduce((s,p)=>s+p.amount-(p.refunded||0),0)};}
function clients(){return [...new Set(db.bookings.map(b=>b.phone))].map(phone=>{const list=db.bookings.filter(b=>b.phone===phone),paid=list.filter(b=>b.status==='paid'&&b.date<=today()),dates=paid.map(b=>b.date).sort(),future=list.filter(b=>b.status==='paid'&&b.date>=today()).map(b=>b.date).sort(),sum=paid.reduce((s,b)=>s+b.amount,0);return{phone,phoneFmt:phone,name:list[0].name,visits:paid.length,bookings:list.length,sum,total:sum,last:dates.at(-1)||null,next:future[0]||null,cancels:list.filter(b=>['cancelled','refunded'].includes(b.status)).length,noshow:list.filter(b=>b.status==='noshow').length,hasCabinet:db.users.some(u=>u.phone===phone)};});}
function analytics(q){const from=q.get('from')||shift(today(),-29),to=q.get('to')||today(),test=q.get('mode')==='test';if(from>to||(Date.parse(to)-Date.parse(from))/86400000>365)fail('Выберите период до 366 дней','VALID');const series=[];for(let d=from;d<=to;d=shift(d,1)){const ps=db.payments.filter(p=>!!p.test===test&&p.paidAt&&day(p.paidAt)===d),gross=ps.reduce((s,p)=>s+p.amount,0),refunds=db.payments.filter(p=>!!p.test===test&&p.refundedAt&&day(p.refundedAt)===d).reduce((s,p)=>s+(p.refunded||0),0);series.push({date:d,registrations:db.users.filter(u=>day(u.createdAt)===d).length,bookings:db.bookings.filter(b=>!!b.test===test&&day(b.createdAt)===d).length,payments:ps.length,gross,refunds,net:gross-refunds});}
 const totals={users:db.users.length,newUsers:0,bookings:0,payments:0,gross:0,refunds:0,net:0};series.forEach(r=>{totals.newUsers+=r.registrations;['bookings','payments','gross','refunds','net'].forEach(k=>totals[k]+=r[k]);});const ps=db.payments.filter(p=>!!p.test===test&&day(p.createdAt)>=from&&day(p.createdAt)<=to),statuses=[...new Set(ps.map(p=>p.status))].map(status=>({status,count:ps.filter(p=>p.status===status).length})),methods=[...new Set(ps.map(p=>p.method))].map(method=>({method,count:ps.filter(p=>p.method===method&&p.paidAt).length,amount:ps.filter(p=>p.method===method&&p.paidAt).reduce((s,p)=>s+p.amount,0)}));return{from,to,mode:test?'test':'live',timezone:'Europe/Moscow',totals,series,statuses,methods};}
function dashboard(){const td=today(),list=db.bookings.map(view),loadDays=Array.from({length:27},(_,i)=>{const date=shift(td,i-20);return{date,label:date.slice(8)+'.'+date.slice(5,7),pct:Math.round(db.bookings.filter(b=>b.date===date&&b.status==='paid').reduce((s,b)=>s+b.dur,0)/630*100),today:i===20,future:i>20,weekend:new Date(date).getDay()%6===0};});return{loadMonth:12,repeatShare:60,clientsTotal:clients().length,revenue:{today:0,week:2000,month:9000},bookings:{today:0,week:4,month:20,upcoming:list.filter(b=>!b.isPast&&b.status==='paid').length,pending:list.filter(b=>b.status==='pending').length,refundsMonth:0},newReports:0,partialPending:[],todayList:list.filter(b=>b.date===td),blocksToday:db.blocks.filter(b=>b.date===td),loadDays,heat:Array.from({length:7},()=>Array.from({length:11},()=>0)),heatHours:Array.from({length:11},(_,i)=>10+i)};}
async function route(path,method,body,q){
 expire();
 if(path==='/api/session')return session();
 if(path==='/api/account/documents')return{list:documents()};
 if(path==='/api/account/me')return{user:profile(current())};
 if(path==='/api/account/logout'){db.current=null;return{user:null,csrf:'preview'};}
 if(path==='/api/account/login'){db.current=db.users[0].id;return{user:profile(current()),csrf:'preview'};}
 if(path==='/api/account/register'){const u=user(db.users.length+1,String(body.name||'Демо · Новый игрок').slice(0,60));u.createdAt=now();u.phone=String(body.phone||u.phone).replace(/\D/g,'');u.phoneRaw=u.phone;db.users.push(u);db.current=u.id;return{user:profile(u),csrf:'preview'};}
 if(path==='/api/account/profile'){const u=current();if(!u)fail('Войдите через ссылку «Кабинет игрока»','AUTH');for(const k of ['name','level','age','hand','style','about','tg','showPhone','photo'])if(k in body)u[k]=body[k];return{user:profile(u)};}
 if(path==='/api/account/password')fail('В демо пароли не сохраняются и не меняются. Входите кнопкой «Кабинет игрока».');
 if(path==='/api/account/passkeys')return{list:[]};
 if(path.includes('/passkeys/'))fail('Ключи устройства доступны в серверной версии; демо не регистрирует биометрию.');
 if(path==='/api/availability')return availability(q.get('date'),q.get('excludeId'));
 if(path==='/api/promos/apply'){const p=db.promos.find(p=>p.code===String(body.code||'').toUpperCase()&&p.active);if(!p)fail('Промокод не найден','PROMO');return copy(p);}
 if(path==='/api/bookings/mine'){const list=db.bookings.filter(b=>b.userId===db.current||b.source==='site').map(view);return{upcoming:list.filter(b=>!b.isPast&&['paid','pending'].includes(b.status)).sort((a,b)=>a.startTs-b.startTs),past:list.filter(b=>b.isPast||!['paid','pending'].includes(b.status)).sort((a,b)=>b.startTs-a.startTs)};}
 if(path==='/api/bookings'&&method==='POST')return create(body);
 let match=path.match(/^\/api\/bookings\/([^/]+)(?:\/(.+))?$/);
 if(match){const b=findBooking(match[1]),action=match[2];if(!action)return view(b);if(action==='payments')return payment(b,body.method);if(action==='cancel')return cancel(b);if(action==='reschedule-quote')return move(b,body,false,true);if(action==='reschedule')return move(b,body);if(action==='access'){await qrReady;const status=b.status!=='paid'?'revoked':at(b.date,b.start+b.dur)<=now()?'expired':at(b.date,b.start)>now()?'scheduled':'active';return{status,reason:'Демонстрационный пример. Не открывает дверь.',test:false,validFrom:at(b.date,b.start),validTo:at(b.date,b.start+b.dur),qrSvg:['active','scheduled'].includes(status)?qr:null,qrPayload:'PINGPOINT-PUBLIC-DEMO-NO-ACCESS'};}}
 match=path.match(/^\/api\/payments\/([^/]+)\/(confirm|refresh)$/);
 if(match){const p=db.payments.find(p=>p.id===match[1]);if(!p)fail('Платёж не найден','NOTFOUND');return match[2]==='confirm'?paid(p):{payment:copy(p),booking:view(findBooking(p.bookingId))};}
 if(path==='/api/admin/login'){db.admin=true;return{ok:true,admin:true};}
 if(path==='/api/admin/logout'){db.admin=false;return{ok:true,admin:false};}
 if(!path.startsWith('/api/admin/'))fail('Этот сценарий доступен в серверной версии.');
 const tail=path.slice(11);
 if(tail==='auth')return{ok:true,admin:db.admin};
 if(tail==='analytics')return analytics(q);
 if(tail==='dashboard')return dashboard();
 if(tail==='users'){let list=db.users.map(userStats);const text=(q.get('q')||'').toLowerCase();if(text)list=list.filter(u=>(u.name+' '+u.phone).toLowerCase().includes(text));const page=Math.max(1,Number(q.get('page'))||1),pageSize=30;return{list:list.slice((page-1)*pageSize,page*pageSize),total:list.length,page,pageSize};}
 if(tail.startsWith('users/')){const u=db.users.find(u=>u.id===tail.slice(6));if(!u)fail('Не найден','NOTFOUND');return{user:userStats(u),bookings:db.bookings.filter(b=>b.userId===u.id).map(view),registrations:documents().map(d=>({docId:d.id,version:d.version,acceptedAt:u.createdAt}))};}
 if(tail==='bookings'){let list=db.bookings.map(view);for(const k of ['date','status'])if(q.get(k))list=list.filter(b=>b[k]===q.get(k));if(q.get('from'))list=list.filter(b=>b.date>=q.get('from'));if(q.get('to'))list=list.filter(b=>b.date<=q.get('to'));if(q.get('q'))list=list.filter(b=>(b.number+' '+b.name+' '+b.phone).toLowerCase().includes(q.get('q').toLowerCase()));return list.sort((a,b)=>a.startTs-b.startTs);}
 if(tail==='bookings/quote'){const q=quote(body);return{...q,tariffTotal:q.total,total:body.amount!==''&&body.amount!=null?Number(body.amount):q.total};}
 if(tail==='bookings/create'){const result=create(body,true),b=findBooking(result.id);if(body.amount!==''&&body.amount!=null)b.amount=Number(body.amount);if(body.pay&&body.pay!=='unpaid')return paid(payment(b,body.pay)).booking;return view(b);}
 match=tail.match(/^bookings\/([^/]+)(?:\/(.+))?$/);
 if(match){const b=findBooking(match[1]);switch(match[2]){case undefined:return view(b);case 'move':return move(b,body,true);case 'cancel':return body.withRefund===false?(b.status='cancelled',view(b)):cancel(b);case 'noshow':b.status='noshow';return view(b);case 'partial-refund':return refund(b,Number(body.amount));case 'refund-fault':return refund(b);case 'manual-payment':return paid(payment(b,body.method)).booking;default:fail('Действие доступно в серверной версии.');}}
 if(tail==='payments'){let list=copy(db.payments).map(p=>({...p,booking:copy(db.bookings.find(b=>b.id===p.bookingId)||null)}));const test=q.get('mode')==='test';if(q.has('mode'))list=list.filter(p=>!!p.test===test);if(q.get('from'))list=list.filter(p=>day(p.createdAt)>=q.get('from'));if(q.get('to'))list=list.filter(p=>day(p.createdAt)<=q.get('to'));if(q.get('status'))list=list.filter(p=>p.status===q.get('status'));return{list};}
 if(tail==='clients')return clients().filter(c=>!q.get('q')||(c.name+' '+c.phone).toLowerCase().includes(q.get('q').toLowerCase()));
 if(tail==='client'){const c=clients().find(c=>c.phone===q.get('phone'));return{...c,profile:null,history:db.bookings.filter(b=>b.phone===q.get('phone')).map(view),payments:copy(db.payments.filter(p=>db.bookings.some(b=>b.id===p.bookingId&&b.phone===q.get('phone'))))};}
 if(tail==='settings'){if(method==='POST')Object.assign(db.settings,body);return copy(db.settings);}
 if(tail==='promos')return copy(db.promos);
 if(tail==='promos/save'){const code=String(body.code||'').toUpperCase(),old=db.promos.find(p=>p.code===code);if(old)Object.assign(old,body,{code});else db.promos.push({...body,code,used:0,active:true});return{ok:true};}
 if(tail==='promos/toggle'){const p=db.promos.find(p=>p.code===body.code);if(p)p.active=body.active;return{ok:true};}
 if(tail==='blocks')return copy(db.blocks);
 if(tail==='blocks/create'){db.blocks.push({...body,start:Number(body.start),end:Number(body.end),id:id('preview_block'),createdAt:now()});return{ok:true};}
 if(/^blocks\/.+\/delete$/.test(tail)){db.blocks=db.blocks.filter(b=>b.id!==tail.split('/')[1]);return{ok:true};}
 if(tail==='integrations')return{payments:{mode:'demo',configured:false,missing:[],message:'Публичная демонстрация. Списаний и подключения ЮKassa нет.'},access:{mode:'unconfigured',configured:false,missing:[],message:'Демо-QR не открывает дверь. Оборудование не подключено.'},passkeys:{configured:false,message:'В демо биометрия и пароли не регистрируются.'}};
 if(tail==='access-events')return{list:copy(db.events),total:db.events.length};
 if(tail==='access/simulate')return{simulation:true,allowed:false,reason:'Публичное демо не даёт доступ к двери'};
 fail('Этот сценарий доступен в серверной версии.');
}
w.fetch=async function(input,options={}){
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url,w.location.href);
 if(url.origin!==w.location.origin||!url.pathname.startsWith('/api/'))return realFetch(input,options);
 try{const body=options.body?JSON.parse(options.body):{},result=await route(decodeURIComponent(url.pathname),options.method||'GET',body,url.searchParams);save();return new w.Response(JSON.stringify(result),{status:200,headers:{'Content-Type':'application/json','X-PingPoint-Preview':'1'}});}
 catch(error){return new w.Response(JSON.stringify({error:{code:error.code||'PREVIEW',message:error.message}}),{status:error.code==='NOTFOUND'?404:400,headers:{'Content-Type':'application/json'}});}
};
function toolbar(){
 const style=w.document.createElement('style');style.textContent='#pp-preview-bar{position:fixed;bottom:0;left:0;right:0;z-index:2147483000;background:#ffe09b;color:#21172b;border-top:1px solid #cc9628;font:12px/1.4 system-ui,sans-serif;padding:8px 14px;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap}#pp-preview-bar a,#pp-preview-bar button{color:#21172b;background:#fff8;border:1px solid #9d7729;border-radius:7px;padding:4px 8px;font:inherit;text-decoration:none;cursor:pointer}body{padding-bottom:80px!important}@media(max-width:600px){#pp-preview-bar{gap:5px;font-size:10px;padding:5px}body{padding-bottom:95px!important}}';w.document.head.append(style);
 style.textContent+='body:has(.pp-sheet) #pp-preview-bar{display:none}.pp-sheet-head>div:after{content:"ДЕМО · деньги и дверь отключены";display:block;color:#ffe09b;font:11px/1.4 system-ui,sans-serif;margin-top:3px}.pp-cookie{bottom:120px!important}';
 const bar=w.document.createElement('aside');bar.id='pp-preview-bar';bar.setAttribute('aria-label','Публичное демо');
 const label=w.document.createElement('span');label.textContent='ДЕМО · все данные вымышленные · без денег и двери. Используйте вымышленные данные.';bar.append(label);
 for(const [label,path] of [['Сайт','1-neon/index.html'],['Кабинет игрока','1-neon/cabinet.html?entry=player#bookings'],['Кабинет админа','1-neon/admin.html?entry=admin#dashboard']]){const a=w.document.createElement('a');a.href=new URL(path,base);a.textContent=label;bar.append(a);}
 const reset=w.document.createElement('button');reset.type='button';reset.textContent='Сбросить демо';reset.onclick=()=>{db=seed();save();w.location.reload();};bar.append(reset);w.document.body.append(bar);
 if(w.AccountAPI){w.AccountAPI.supported=()=>false;}
 if(w.BookingAPI){const original=w.BookingAPI.accessHTML;w.BookingAPI.accessHTML=a=>'<p class="pp-h" role="note"><b>Демонстрационный QR — не для прохода.</b></p>'+original(a);}
}
if(w.document.readyState==='loading')w.document.addEventListener('DOMContentLoaded',toolbar,{once:true});else toolbar();
})(window);
