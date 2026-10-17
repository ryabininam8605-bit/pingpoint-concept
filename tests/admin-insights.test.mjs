import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import vm from 'node:vm';
const file=new URL('../1-neon/admin-insights.js',import.meta.url);
function api(fetch=async()=>({ok:true,json:async()=>({})})) {
  const window={fetch}; const context={window,Intl,Date,URLSearchParams,console,setTimeout,clearTimeout};
  if(existsSync(file))vm.runInNewContext(readFileSync(file,'utf8'),context);
  return window.AdminInsights||{};
}
test('admin navigation exposes registered users separately from booking contacts',()=>{
  const html=readFileSync(new URL('../1-neon/admin.html',import.meta.url),'utf8');
  assert.match(html,/\['users',\s*'Пользователи'/);
  assert.match(html,/Контакты броней/);
});
test('cash chart and exact table preserve fractional rubles and negative net',()=>{
  const a=api();assert.equal(typeof a.analyticsHTML,'function');
  const html=a.analyticsHTML({mode:'live',timezone:'Europe/Moscow',totals:{users:1,newUsers:1,bookings:0,payments:1,gross:100.01,refunds:200.02,net:-100.01},series:[{date:'2026-10-16',registrations:0,bookings:0,payments:1,gross:100.01,refunds:200.02,net:-100.01}]});
  assert.match(html,/<svg/);assert.match(html,/<table/);assert.match(html,/100,01/);assert.match(html,/200,02/);assert.match(html,/-100,01|−100,01/);assert.match(html,/до комиссии/);assert.doesNotMatch(html,/NaN|Infinity/);
});
test('users with no bookings remain visible and untrusted contact data is escaped',()=>{
  const a=api();assert.equal(typeof a.usersHTML,'function');
  const html=a.usersHTML({list:[{id:'u1',name:'<script>x</script>',phone:'79990000000',phoneVerified:false,createdAt:1,lastLoginAt:null,bookingsCount:0,paidCount:0,totalPaid:0}],total:1,page:1,pageSize:30});
  assert.match(html,/u1/);assert.match(html,/не подтверждён/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});
test('empty analytics stay zero and integrations never promise unknown hardware compatibility',()=>{
  const a=api();assert.equal(typeof a.integrationsHTML,'function');
  const html=a.integrationsHTML({payments:{mode:'disabled',configured:false,missing:['PP_YOOKASSA_SHOP_ID'],message:'не настроено'},access:{configured:true,mode:'online',missing:[]},passkeys:{configured:false}},[]);
  assert.match(html,/PP_YOOKASSA_SHOP_ID/);assert.match(html,/модель/i);assert.match(html,/полев/);assert.doesNotMatch(html,/СКУД подключена|Открыть дверь/);
  assert.match(a.analyticsHTML({mode:'test',totals:{},series:[]}),/Тестовые/);
});
test('admin request uses protected same-origin route and exposes server error for retry',async()=>{
  let seen;const a=api(async(url,options)=>{seen={url,options};return{ok:false,status:403,json:async()=>({error:{code:'AUTH',message:'Войдите снова'}})};});
  assert.equal(typeof a.request,'function');
  await assert.rejects(a.request('users',{q:'а & б',page:2}),e=>e.code==='AUTH'&&e.message==='Войдите снова');
  assert.equal(seen.options.credentials,'same-origin');assert.equal(seen.options.cache,'no-store');assert.match(seen.url,/^\/api\/admin\/users\?/);assert.match(seen.url,/page=2/);
});
