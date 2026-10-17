import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
function fixture(initial) {
  const storage = new Map(initial);
  const context = { TextEncoder, console, URL, Date, CustomEvent: class {},
    setTimeout: (fn,ms) => ms <= 200 ? setTimeout(fn,0) : 1, clearTimeout,
    localStorage: { getItem:k=>storage.get(k)||null, setItem:(k,v)=>storage.set(k,v), removeItem:k=>storage.delete(k) },
    document:{getElementById(){return true;},readyState:'loading',addEventListener(){}},addEventListener(){},dispatchEvent(){} };
  context.window=context; vm.createContext(context);
  vm.runInContext(readFileSync(new URL('../1-neon/community.js',import.meta.url),'utf8'),context);
  return { ...context,storage };
}
const validPost={format:'once',partnerLevel:'any',days:[0,1,2,3,4,5,6],times:['morning'],timeFrom:660,text:'Ищу партнёра для игры утром, стол пополам.'};
function signedFixture() {
  const seed=fixture();seed.CommunityAPI.meSync();
  const db=JSON.parse(seed.storage.get('pp_data_v1'));
  db.users.fixture={...db.users.d1,id:'fixture',demo:false};
  return fixture([['pp_data_v1',JSON.stringify(db)],['pp_session_v1','fixture']]);
}
test('post starts respect exclusive period boundaries and minimum hour',()=>{
  const {PP}=fixture();
  assert.deepEqual(Array.from(PP.allowedPostStarts(['morning'])),[600,630,660,690,720,750]);
  assert.deepEqual(Array.from(PP.allowedPostStarts(['day'])),[780,810,840,870,900,930,960,990]);
  assert.deepEqual(Array.from(PP.allowedPostStarts(['evening'])),[1020,1050,1080,1110,1140,1170]);
  assert.equal(PP.allowedPostStarts([]).length,20);
});
test('suggested slots obey exact start and reject contradictory legacy preferences',()=>{
  const {PP}=fixture(); const p={days:[0,1,2,3,4,5,6],times:['morning'],timeFrom:660};
  assert.equal(PP.nextSlots(p,6).length,6);
  assert.ok(PP.nextSlots(p,6).every(x=>x.start===660));
  assert.equal(PP.nextSlots({...p,timeFrom:960},6).length,0);
});
test('public post API rejects non-finite, fractional, outside and conflicting exact starts',async()=>{
  const {CommunityAPI:C}=signedFixture();
  for(const timeFrom of [NaN,Infinity,-Infinity,661,585,1200,960]) {
    await assert.rejects(C.createPost({...validPost,timeFrom}),e=>e.code==='VALID'&&/Точное начало/.test(e.message));
  }
  const post=await C.createPost(validPost);
  assert.equal(post.timeFrom,660);
  await assert.rejects(C.updatePost(post.id,{...validPost,timeFrom:780}),e=>e.code==='VALID');
  assert.equal((await C.getPost(post.id)).timeFrom,660);
});
test('publish, edit and reopen keep exact preferences and preserve explicit consent checks',async()=>{
  const {CommunityAPI:C,storage}=signedFixture();
  const post=await C.createPost(validPost);
  assert.ok((await C.listMyPosts()).some(x=>x.id===post.id));
  const changed=await C.updatePost(post.id,{...validPost,times:['day'],timeFrom:840});
  assert.equal(changed.timeFrom,840);
  await C.closePost(post.id);await C.reopenPost(post.id);
  assert.equal((await C.getPost(post.id)).status,'open');
  const db=JSON.parse(storage.get('pp_data_v1'));db.users.fixture.consents.consent_public.active=false;
  const refused=fixture([['pp_data_v1',JSON.stringify(db)],['pp_session_v1','fixture']]);
  await assert.rejects(refused.CommunityAPI.createPost(validPost),e=>e.code==='CONSENT_PUBLIC');
});
test('clean booking availability is free and legacy real bookings survive demo exclusion',()=>{
  const clean=fixture(),B=clean.BookingAPI,P=clean.PP;
  const date=P.ymd(P.addDays(new Date(),5));
  assert.ok(B.availabilitySync(date).every(x=>x.state==='free'));
  const db=JSON.parse(clean.storage.get('pp_data_v1'));
  assert.equal(db.bookings.length,0);
  db.bookings.push({id:'legacy-real',date,start:840,dur:60,status:'paid',name:'Fixture',phone:'70000000000',amount:500,createdAt:Date.now(),demo:false});
  db.bookings.push({id:'legacy-demo',date,start:960,dur:60,status:'paid',demo:true});
  const legacy=fixture([['pp_data_v1',JSON.stringify(db)]]);
  const slots=legacy.BookingAPI.availabilitySync(date);
  assert.equal(slots.find(x=>x.start===840).state,'busy');
  assert.equal(slots.find(x=>x.start===960).state,'free');
  assert.equal(JSON.parse(legacy.storage.get('pp_data_v1')).bookings.length,2);
});
test('room rent splits at 13:00 and racket cost stays separate',()=>{
  const {BookingAPI:B}=fixture();
  const q=B.quote({start:720,dur:120,rackets:2});
  assert.equal(q.rent,900);assert.equal(q.rackets,400);assert.equal(q.total,1300);
  assert.equal(q.total/4,325);
});

