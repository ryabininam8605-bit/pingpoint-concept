import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
const source=readFileSync(new URL('../preview/preview-api.js',import.meta.url),'utf8');
function browser(enabled=true,stored=new Map()){
 const forwarded=[],listeners={};
 const original=async(input)=>{forwarded.push(String(input));return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>');};
 const w={fetch:original,URL,Response,crypto:webcrypto,location:{origin:'https://example.github.io',href:'https://example.github.io/pingpoint-concept/1-neon/index.html'},localStorage:{getItem:k=>stored.get(k)||null,setItem:(k,v)=>stored.set(k,v)},document:{currentScript:{src:'https://example.github.io/pingpoint-concept/preview-api.js',dataset:enabled?{publicPreview:'1'}:{}},readyState:'loading',addEventListener:(k,f)=>{listeners[k]=f;}},PP:{DOCS:[{id:'policy',version:'1.0',file:'docs/politika.html'},{id:'consent_pd',version:'1.0',file:'docs/soglasie-pd.html'},{id:'community_rules',version:'1.0',file:'docs/pravila-soobshchestva.html'}]}};
 vm.runInNewContext(source,{window:w,URL,Date,JSON,Number,Math,String,Error,Array,Object,Set,decodeURIComponent});
 async function request(path,body){const r=await w.fetch(path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});return{status:r.status,body:await r.json()};}
 return{w,original,forwarded,stored,listeners,request};
}
test('preview cannot activate without the exported page marker',()=>{
 const b=browser(false);assert.equal(b.w.fetch,b.original);assert.equal(b.stored.size,0);assert.equal(b.forwarded.length,0);
});
test('demo API never calls a real server and unsupported operations fail locally',async()=>{
 const b=browser(),s=await b.request('/api/session');assert.equal(s.body.capabilities.payments,'demo');assert.equal(s.body.capabilities.access,'unconfigured');assert.equal(s.body.user.name,'Демо · Алексей');assert.equal(s.body.admin,true);
 const result=await b.request('/api/yookassa/webhook',{anything:'not sent'});assert.equal(result.status,400);assert.equal(b.forwarded.length,1);assert.ok(b.forwarded[0].endsWith('/pingpoint-concept/demo-qr.svg'));
 await b.w.fetch('https://external.example/image.jpg');assert.equal(b.forwarded.length,2);
});
test('demo registration never persists passwords and edits stay in the preview namespace',async()=>{
 const b=browser();const r=await b.request('/api/account/register',{name:'Демо · Новый',phone:'70000000009',password:'must-not-be-stored'});assert.equal(r.body.user.name,'Демо · Новый');
 await b.request('/api/account/profile',{name:'Демо · Изменён',passwordHash:'never-store-this'});
 const store=[...b.stored.entries()];assert.equal(store.length,1);assert.equal(store[0][0],'pp_public_walkthrough_v1');assert.ok(!store[0][1].includes('must-not-be-stored'));assert.ok(!store[0][1].includes('never-store-this'));
 const next=browser(true,b.stored);assert.equal((await next.request('/api/account/me')).body.user.name,'Демо · Изменён');
 await b.request('/api/account/password',{currentPassword:'old',newPassword:'never-save'});assert.ok(![...b.stored.values()].join('').includes('never-save'));
});
test('booking, conflict, simulated payment and cancellation change local availability',async()=>{
 const b=browser();const session=(await b.request('/api/session')).body;const date=new Date(Date.now()+3*86400000).toISOString().slice(0,10);const data={date,start:780,dur:60,players:2,rackets:0,name:'Демо',phone:'70000000001'};
 const before=(await b.request('/api/availability?date='+date)).body;assert.equal(before.slots.find(s=>s.start===780).state,'free');
 const created=await b.request('/api/bookings',data);assert.equal(created.body.amount,500);const key=created.body.id;
 const conflict=await b.request('/api/bookings',data);assert.equal(conflict.body.error.code,'BUSY');
 const p=(await b.request('/api/bookings/'+key+'/payments',{method:'sbp'})).body;
 assert.equal((await b.request('/api/payments/'+p.id+'/confirm',{})).body.booking.status,'paid');
 const all=(await b.request('/api/bookings/mine')).body;assert.ok(all.upcoming.some(x=>x.id===key));
 const stats=(await b.request('/api/admin/analytics?from='+new Date(Date.now()+10800000).toISOString().slice(0,10)+'&to='+new Date(Date.now()+10800000).toISOString().slice(0,10)+'&mode=test')).body;assert.equal(stats.totals.gross,500);
 await b.request('/api/bookings/'+key+'/cancel',{});const after=(await b.request('/api/availability?date='+date)).body;assert.equal(after.slots.find(s=>s.start===780).state,'free');assert.equal(session.settings.pricePm,500);
});
test('admin gets registrations without bookings, zero-filled charts and sample-only QR',async()=>{
 const b=browser(),users=(await b.request('/api/admin/users')).body;assert.equal(users.total,4);assert.equal(users.list.find(u=>u.name.includes('Без брони')).bookingsCount,0);
 const today=new Date(Date.now()+10800000).toISOString().slice(0,10),from=new Date(Date.now()+10800000-6*86400000).toISOString().slice(0,10);
 const stats=(await b.request('/api/admin/analytics?from='+from+'&to='+today+'&mode=live')).body;assert.equal(stats.series.length,7);assert.equal(stats.totals.net,stats.totals.gross-stats.totals.refunds);assert.ok(stats.totals.gross>0);
 const bookings=(await b.request('/api/bookings/mine')).body;const a=(await b.request('/api/bookings/'+bookings.upcoming[0].id+'/access')).body;assert.equal(a.qrPayload,'PINGPOINT-PUBLIC-DEMO-NO-ACCESS');assert.ok(a.qrSvg.startsWith('<svg'));assert.ok(!a.qrPayload.startsWith('pp1_'));
 const integrations=(await b.request('/api/admin/integrations')).body;assert.equal(integrations.payments.configured,false);assert.equal(integrations.access.configured,false);
});
