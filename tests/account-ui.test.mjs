import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const dir = new URL('../1-neon/', import.meta.url);
function fixture(handler, credentials) {
  const requests=[], events=[], listeners={}; let user=null;
  const win={BookingAPI:{},AdminAPI:{},CommunityAPI:{meSync:()=>({id:'legacy'}),login:async()=>({id:'legacy'}),register:async()=>({id:'legacy'}),_setServerUser:u=>{user=u;},_serverMe:()=>user},PP:{},
    localStorage:{setItem(){},removeItem(){}},dispatchEvent:e=>{events.push(e);(listeners[e.type]||[]).forEach(fn=>fn(e));},addEventListener:(type,fn)=>(listeners[type]||=[]).push(fn),document:{visibilityState:'visible',addEventListener(){}},
    isSecureContext:true,PublicKeyCredential:class{},navigator:{credentials},atob:s=>Buffer.from(s,'base64').toString('binary'),btoa:s=>Buffer.from(s,'binary').toString('base64'),
    fetch:async(url,options)=>{requests.push({url,options});const result=handler?.(url,options);return {ok:!result?.error,status:result?.error?400:200,json:async()=>result||(url==='/api/session'?{settings:{},csrf:'before',user:null,capabilities:{accounts:true,passkeys:true,payments:'test',access:'unconfigured'}}:url.startsWith('/api/availability?')?{settings:{},slots:[]}:{} )};}};
  const context={window:win,document:win.document,CustomEvent:class {constructor(name,opts){this.type=name;this.detail=opts?.detail;}},setTimeout,clearTimeout,setInterval:()=>0,AbortController,URLSearchParams,URL,Uint8Array,ArrayBuffer,console};
  vm.runInNewContext(fs.readFileSync(new URL('shared-booking.js',dir),'utf8'),context);
  const file=new URL('shared-account.js',dir); if(fs.existsSync(file))vm.runInNewContext(fs.readFileSync(file,'utf8'),context);
  return {win,requests,events};
}
test('server login replaces legacy identity and rotates booking mutation CSRF',async()=>{
  const f=fixture(url=>url==='/api/account/login'?{user:{id:'server-user'},csrf:'after'}:url==='/api/bookings'?{id:'b1'}:null);
  await f.win.BookingAPI.ready;
  const u=await f.win.CommunityAPI.login({phone:'+79001234567',password:'long-password'});
  assert.equal(u.id,'server-user','legacy local login must never remain authoritative');
  await f.win.BookingAPI.createBooking({date:'2026-11-01',start:600,consents:{}});
  assert.equal(f.requests.find(x=>x.url==='/api/bookings').options.headers['X-PP-CSRF'],'after');
  assert.equal(f.win.CommunityAPI.meSync().id,'server-user');
});
test('registration sends the server canonical consent revisions, without accepting unchecked boxes',async()=>{
  const docs=[{id:'policy',version:'2',hash:'abc',url:'docs/politika.html'}];
  const f=fixture(url=>url==='/api/account/documents'?{list:docs}:url==='/api/account/register'?{user:{id:'new'},csrf:'new-token'}:null);
  await f.win.BookingAPI.ready;
  await assert.rejects(f.win.CommunityAPI.register({phone:'79001234567',password:'long-password',consents:{policy:false}}));
  assert.equal(f.requests.filter(x=>x.url==='/api/account/register').length,0);
  await f.win.CommunityAPI.register({phone:'79001234567',password:'long-password',consents:{policy:true}});
  assert.deepEqual(JSON.parse(f.requests.find(x=>x.url==='/api/account/register').options.body).consents,{policy:{accepted:true,version:'2',hash:'abc'}});
});
test('failed authentication and unsupported destructive operations never report local success',async()=>{
  const f=fixture(url=>url==='/api/account/login'?{error:{code:'AUTH',message:'Ошибка входа'}}:null);
  await f.win.BookingAPI.ready;
  await assert.rejects(f.win.CommunityAPI.login({phone:'79001234567',password:'wrong'}),/Ошибка входа/);
  assert.equal(f.win.CommunityAPI.meSync(),null);
  await assert.rejects(f.win.CommunityAPI.deleteProfile(),/сервер|администратор/i);
  await assert.rejects(f.win.CommunityAPI.revokeConsent('consent_pd'),/сервер|администратор/i);
});
test('cancelled WebAuthn dialog never verifies and password login remains usable',async()=>{
  const f=fixture(url=>url==='/api/account/passkeys/login/options'?{challenge:'AQID',allowCredentials:[]}:url==='/api/account/login'?{user:{id:'ok'},csrf:'next'}:null,{get:async()=>{const e=new Error('cancel');e.name='NotAllowedError';throw e;}});
  await f.win.BookingAPI.ready;
  assert.ok(f.win.AccountAPI,'server account adapter must expose passkey support');
  await assert.rejects(f.win.AccountAPI.loginPasskey('79001234567'),/отмен|ключ/i);
  assert.equal(f.requests.filter(x=>x.url.endsWith('/login/verify')).length,0);
  assert.equal((await f.win.CommunityAPI.login({phone:'79001234567',password:'long-password'})).id,'ok');
});
test('real community bridge keeps old records but rejects a saved local session',async()=>{
  const storage=new Map(),settings={open:600,close:1230,maxPlayers:4},win={TextEncoder,Date,URL,console,
    localStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
    document:{readyState:'loading',getElementById:()=>true,addEventListener(){}},addEventListener(){},dispatchEvent(){},
    fetch:async url=>({ok:true,status:200,json:async()=>url==='/api/session'?{settings,csrf:'initial',user:null,capabilities:{accounts:true}}:{user:{id:'account-uuid',name:'Серверный игрок',phoneRaw:'79001234567',phone:'+79001234567',consents:{},docsOk:true,createdAt:1},csrf:'rotated'}})};
  win.window=win;
  const context=vm.createContext({...win,window:win,TextEncoder,CustomEvent:class{},setTimeout:(fn,ms)=>ms<200?setTimeout(fn,0):0,clearTimeout,setInterval:()=>0,AbortController,URLSearchParams});
  vm.runInContext(fs.readFileSync(new URL('community.js',dir),'utf8'),context);
  win.CommunityAPI.meSync();
  const data=JSON.parse(storage.get('pp_data_v1'));
  data.users.legacy={...data.users.d1,id:'legacy',demo:false,name:'Старый профиль'};
  data.posts.push({...data.posts[0],id:'legacy-post',authorId:'legacy',demo:false});
  storage.set('pp_data_v1',JSON.stringify(data));storage.set('pp_session_v1','legacy');
  assert.equal(win.CommunityAPI.meSync().id,'legacy');
  for(const file of ['shared-booking.js','shared-account.js'])vm.runInContext(fs.readFileSync(new URL(file,dir),'utf8'),context);
  await win.AccountAPI.ready;
  assert.equal(win.CommunityAPI.meSync(),null,'saved local identity does not authenticate a server account');
  await win.CommunityAPI.login({phone:'79001234567',password:'correct-password'});
  assert.equal(win.CommunityAPI.meSync().id,'account-uuid');
  const persisted=JSON.parse(storage.get('pp_data_v1'));
  assert.equal(persisted.users.legacy.name,'Старый профиль');
  assert.ok(persisted.posts.some(p=>p.id==='legacy-post' && p.authorId==='legacy'));
  assert.equal(storage.get('pp_session_v1'),'legacy','server bridge does not overwrite legacy records');
  assert.ok(!storage.get('pp_data_v1').includes('correct-password'));
});
test('identical profile reads do not re-emit pp:change and trigger header fetch loops',async()=>{
  const f=fixture(url=>url==='/api/account/me'?{user:{id:'same-user'}}:null);
  await f.win.AccountAPI.ready;
  await f.win.AccountAPI.me();
  const changes=f.events.filter(event=>event.detail?.source==='shared-account').length;
  await f.win.AccountAPI.me();
  assert.equal(f.events.filter(event=>event.detail?.source==='shared-account').length,changes,'identical read must be silent');
});
test('authoritative profile reads and edits survive a later CSRF-only password response',async()=>{
  for(const route of ['me','profile']) {
    const f=fixture(url=>url==='/api/account/login'?{user:{id:'player',name:'Before'},csrf:'login-token'}:url==='/api/account/'+route?{user:{id:'player',name:'Updated'}}:url==='/api/account/password'?{ok:true,csrf:'password-token'}:null);
    await f.win.AccountAPI.ready;
    await f.win.AccountAPI.login({phone:'79001234567',password:'long-password'});
    if(route==='me')await f.win.AccountAPI.me();else await f.win.AccountAPI.updateProfile({name:'Updated'});
    assert.equal(f.win.BookingAPI.session().user.name,'Updated',route+' must update the shared session snapshot without csrf');
    await f.win.AccountAPI.changePassword('long-password','different-password');
    assert.equal(f.win.CommunityAPI.meSync().name,'Updated','password CSRF rotation cannot restore the old profile');
    assert.equal(f.win.BookingAPI.session().csrf,'password-token');
    const last=f.events.filter(e=>e.type==='pp:session').at(-1);
    assert.equal(last.detail.user.name,'Updated');
  }
});
test('admin user details and WebAuthn user descriptors do not replace the current account snapshot',async()=>{
  const routes=['/api/admin/users/other','/api/account/passkeys/register/options'];
  const f=fixture(url=>url==='/api/account/login'?{user:{id:'self',name:'Current player'},csrf:'login-token'}:routes.includes(url)?{user:{id:'other',name:'Other user DTO'}}:null);
  await f.win.AccountAPI.ready;await f.win.AccountAPI.login({phone:'79001234567',password:'long-password'});
  for(const route of routes) {
    const viewed=await f.win.BookingAPI.request(route,route.endsWith('/options')?{}:undefined);
    assert.equal(viewed.user.id,'other');
    assert.equal(f.win.BookingAPI.session().user.id,'self',route);
    assert.equal(f.win.CommunityAPI.meSync().id,'self');
  }
});
test('actual player pages load the account adapter before inline startup',async()=>{
  for(const page of ['index.html','cabinet.html']) {
    const html=fs.readFileSync(new URL(page,dir),'utf8'),order=[];
    for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if(/application\/(?:ld\+json|json)/i.test(match[1]))continue;
      const src=match[1].match(/\bsrc="([^"]+)"/i);
      if(!src)break;
      order.push(src[1].split('?')[0]);
    }
    assert.deepEqual(order,['community.js','shared-booking.js','shared-account.js'],`${page}: account identity must exist before inline page startup`);
    const f=fixture();await f.win.AccountAPI.ready;
    assert.equal(typeof f.win.AccountAPI.authForm,'function');
    assert.equal(typeof f.win.BookingAPI.request,'function');
  }
});
