import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapter = path.join(root, '1-neon/shared-booking.js');

function fixture() {
  assert.ok(fs.existsSync(adapter), 'Shared server adapter must exist');
  let online = true, events = 0, creates = 0;
  const requests = [];
  const settings = {open:600,close:1230,border:780,priceAm:400,pricePm:500,racket:100,minLeadMin:60,cancelHours:3,holdMin:15,maxPlayers:4,rules:[]};
  const data = {settings, slots:[{start:600,state:'free',rate:400}], date:'2026-10-20'};
  const window = {
    BookingAPI: {availabilitySync:()=>[{start:600,state:'busy'}]}, AdminAPI: {isLogged:()=>true,resetDemo:async()=>true},
    CommunityAPI: {meSync:()=>null}, PP:{},
    dispatchEvent:()=>{events++;}, addEventListener:()=>{}, localStorage:{setItem:()=>{},removeItem:()=>{}},
    document:{visibilityState:'visible',addEventListener:()=>{}},
    fetch:async (url, options)=>{
      requests.push({url, options});
      if (!online) throw Error('offline');
      let result;
      if (url==='/api/session') result={settings,admin:false,csrf:'fixture-token',demoPayments:false};
      else if (url.startsWith('/api/availability')) result=data;
      else if (url==='/api/bookings') { creates++; result={id:'bk-one',date:data.date,status:'pending'}; }
      else result=true;
      return {ok:true,status:200,json:async()=>result};
    }
  };
  const context = {window,globalThis:window,document:window.document,CustomEvent:class{},setTimeout,clearTimeout,setInterval:()=>0,clearInterval:()=>{},AbortController,URLSearchParams,console};
  vm.runInNewContext(fs.readFileSync(adapter,'utf8'),context);
  return {api:window.BookingAPI,admin:window.AdminAPI,requests,offline:()=>{online=false;},events:()=>events,creates:()=>creates};
}

test('server cache stays unknown until fetched, emits once on changed response and fails closed',async()=>{
  const f=fixture();
  assert.equal(f.api.availabilitySync('2026-10-20').length,0);
  await f.api.ready;
  assert.equal(f.admin.isLogged(),false);
  await f.api.refreshAvailability('2026-10-20');
  assert.equal(f.api.availabilityState('2026-10-20').status,'ready');
  assert.equal(f.api.availabilitySync('2026-10-20')[0].state,'free');
  const before=f.events();
  await f.api.refreshAvailability('2026-10-20');
  assert.equal(f.events(),before,'unchanged fetch must not create event/render loop');
  f.offline();
  await assert.rejects(f.api.refreshAvailability('2026-10-20'));
  assert.equal(f.api.availabilityState('2026-10-20').status,'error');
  assert.equal(f.api.availabilitySync('2026-10-20').length,0,'local legacy busy/free data must never leak through');
});

test('all creation uses server session and network failure cannot create local success',async()=>{
  const f=fixture();
  await f.api.ready;
  await f.api.createBooking({date:'2026-10-20',start:600});
  const req=f.requests.find(x=>x.url==='/api/bookings');
  assert.equal(req.options.credentials,'same-origin');
  assert.equal(req.options.headers['X-PP-CSRF'],'fixture-token');
  assert.equal(f.creates(),1);
  f.offline();
  await assert.rejects(f.api.createBooking({date:'2026-10-20',start:600}));
  assert.equal(f.creates(),1);
  await assert.rejects(f.admin.resetDemo());
});

test('transfer preview uses granted booking promo terms without new-purchase promo lookup',async()=>{
  const f=fixture();
  await f.api.ready;
  const quote=f.api.quote({start:900,dur:60,rackets:0,promoTerms:{code:'PASTONE',type:'pct',value:10}},'PASTONE');
  assert.equal(quote.total,450,'500 rubles less granted 10%, even without an active promo cache entry');
  assert.equal(quote.discount,50);
  assert.throws(()=>f.api.quote({start:900,dur:60,promoTerms:{code:'OTHER',type:'rub',value:100}},'PASTONE'));
});
