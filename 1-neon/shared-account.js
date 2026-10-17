/* Server identity. Load after shared-booking.js. Passwords and passkey material
 * stay in memory for a request; local community records never grant authority. */
(function(global) {
'use strict';
const B=global.BookingAPI,C=global.CommunityAPI;
if(!B || !B.request || !C) throw Error('shared-account.js requires shared-booking.js');
const copy=x=>x==null?null:JSON.parse(JSON.stringify(x));
const failure=(code,message)=>Object.assign(new Error(message),{code});
let profile=null,canonicalDocs=[];
function apply(user) {
  const changed=JSON.stringify(profile)!==JSON.stringify(user || null);
  profile=copy(user);
  if(C._setServerUser) C._setServerUser(profile);
  if(changed)global.dispatchEvent(new CustomEvent('pp:change',{detail:{source:'shared-account'}}));
  return C.meSync();
}
function session(value) { if(value && 'user' in value) apply(value.user); }
function current() { const local=C._serverMe && C._serverMe(); return profile ? Object.assign(copy(profile),local || {},{docsOk:profile.docsOk,outdated:profile.outdated || [],phoneVerified:false}) : null; }
if(C._setServerUser) C._setServerUser(null);
C.meSync=current;
global.addEventListener('pp:session',e=>session(e.detail));
const api=global.AccountAPI={
  ready:B.ready.then(value=>{session(value);return current();}),
  async documents() { canonicalDocs=(await B.request('/api/account/documents')).list;return copy(canonicalDocs); },
  async register(options) {
    const docs=await this.documents(),consents={};
    for(const doc of docs) {
      const checked=options.consents && options.consents[doc.id];
      if(checked!==true && !(checked && checked.accepted===true)) throw failure('CONSENT','Подтвердите каждый обязательный документ для регистрации.');
      // Use the revisions the player saw. A changed document is rejected by
      // the server instead of silently substituting new consent text.
      consents[doc.id]=checked===true?{accepted:true,version:doc.version,hash:doc.hash}:copy(checked);
    }
    const value=await B.request('/api/account/register',Object.assign({},options,{consents}));
    return apply(value.user);
  },
  async login(options) { return apply((await B.request('/api/account/login',{phone:options.phone,password:options.password})).user); },
  async logout() { await B.request('/api/account/logout',{});apply(null);return true; },
  async me() { return apply((await B.request('/api/account/me')).user); },
  async updateProfile(patch) { return apply((await B.request('/api/account/profile',patch)).user); },
  async changePassword(currentPassword,newPassword) { return B.request('/api/account/password',{currentPassword,newPassword}); },
  supported() { return !!(global.isSecureContext && global.PublicKeyCredential && global.navigator && global.navigator.credentials); },
  async listPasskeys() { return (await B.request('/api/account/passkeys')).list; },
  async deletePasskey(id) { return B.request('/api/account/passkeys/delete',{id}); },
  async addPasskey() { return ceremony('register'); },
  async loginPasskey(phone) { return ceremony('login',phone); }
};
api.ready.catch(()=>{});
['register','login','logout','me','updateProfile'].forEach(name=>{C[name]=(...args)=>api[name](...args);});
C.requestCode=async()=>{throw failure('PASSWORD','Для входа используйте пароль или ключ доступа устройства.');};
const unsupported=async()=>{throw failure('SERVER_ACTION_UNAVAILABLE','Это действие с серверным аккаунтом пока недоступно в кабинете. Обратитесь к администратору: запрос на сервер не отправлен.');};
C.deleteProfile=unsupported;C.restoreProfile=unsupported;
const oldRevoke=C.revokeConsent,oldAccept=C.acceptDocs,oldExport=C.exportMyData;
const oldDocs=C.docs;
C.docs=async()=>{
  const list=oldDocs?await oldDocs.call(C):[],docs=await api.documents();
  return list.map(item=>{
    const canonical=docs.find(doc=>doc.id===item.id);
    if(!canonical)return Object.assign({},item,{scope:'local'});
    const consent=profile && profile.consents && profile.consents[item.id];
    return Object.assign({},item,{version:canonical.version,scope:'server',my:consent?{version:consent.version,at:consent.acceptedAt,active:consent.active}:null,status:!consent?'none':!consent.active?'revoked':consent.hash!==canonical.hash || consent.version!==canonical.version?'outdated':'ok'});
  });
};
C.outdatedDocsSync=()=>profile?(profile.outdated || []).map(id=>Object.assign({},(global.PP.DOCS || []).find(doc=>doc.id===id),canonicalDocs.find(doc=>doc.id===id))):[];
C.revokeConsent=id=>id==='consent_public' && oldRevoke ? oldRevoke.call(C,id):unsupported();
C.acceptDocs=(ids,options)=>ids.every(id=>id==='consent_public') && oldAccept?oldAccept.call(C,ids,options):unsupported();
C.exportMyData=async()=>({scope:'Серверный профиль и брони; объявления и отклики только этого браузера. Это не полный экспорт серверного журнала согласий.',profile:await api.me(),bookings:await B.listMyBookings(),localCommunity:oldExport?await oldExport.call(C):null});
function decode(value) { const raw=global.atob(value.replace(/-/g,'+').replace(/_/g,'/'));return Uint8Array.from(raw,x=>x.charCodeAt(0)).buffer; }
function encode(value) { return global.btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function credentialJSON(credential) {
  const response={};
  for(const key of ['clientDataJSON','attestationObject','authenticatorData','signature','userHandle']) if(credential.response[key]!=null)response[key]=encode(credential.response[key]);
  if(credential.response.getTransports)response.transports=credential.response.getTransports();
  return {id:credential.id,rawId:encode(credential.rawId),type:credential.type,response,authenticatorAttachment:credential.authenticatorAttachment||undefined,clientExtensionResults:credential.getClientExtensionResults?credential.getClientExtensionResults():{}};
}
async function ceremony(kind,phone) {
  await api.ready.catch(()=>B.refreshSession());
  if(!api.supported())throw failure('PASSKEY_UNSUPPORTED','Ключ доступа недоступен в этом браузере. Откройте сайт по HTTPS и используйте пароль.');
  if(!B.capabilities.passkeys)throw failure('PASSKEY_UNCONFIGURED','Ключи доступа для адреса этого сайта ещё не настроены. Используйте пароль.');
  const base='/api/account/passkeys/'+kind;
  const options=await B.request(base+'/options',kind==='login'?{phone}:{});
  options.challenge=decode(options.challenge);
  if(options.user)options.user.id=decode(options.user.id);
  for(const key of ['allowCredentials','excludeCredentials']) if(options[key])options[key]=options[key].map(item=>Object.assign({},item,{id:decode(item.id)}));
  let credential;
  try { credential=await global.navigator.credentials[kind==='login'?'get':'create']({publicKey:options}); }
  catch(e) { if(e.name==='NotAllowedError'||e.name==='AbortError')throw failure('PASSKEY_CANCELLED','Вход ключом отменён или ключ не найден. Можно войти паролем.');throw failure('PASSKEY_FAILED','Устройство не подтвердило ключ доступа. Попробуйте ещё раз или используйте пароль.'); }
  if(!credential)throw failure('PASSKEY_CANCELLED','Подтверждение ключом отменено. Используйте пароль.');
  const value=await B.request(base+'/verify',{credential:credentialJSON(credential)});
  return kind==='login'?apply(value.user):value;
}
const esc=value=>String(value==null?'':value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
api.authForm=function(container,options) {
  const o=options || {},id='account-'+Math.random().toString(36).slice(2);
  container.innerHTML='<form novalidate class="pp-auth-step">'+(o.reason?'<p class="pp-h">'+esc(o.reason)+'</p>':'')+
    '<div class="pp-row" style="margin-bottom:20px;gap:12px"><button type="button" class="btn btn-ghost btn-sm" data-mode="login" aria-pressed="true">Войти</button><button type="button" class="btn btn-ghost btn-sm" data-mode="register" aria-pressed="false">Регистрация</button></div>'+
    '<div class="pp-f"><label class="pp-l" for="'+id+'phone">Телефон — логин</label><input class="pp-i" id="'+id+'phone" name="phone" type="tel" autocomplete="username" required placeholder="+7 (900) 000-00-00"><span class="pp-h">Номер не подтверждается по SMS.</span></div>'+
    '<div class="pp-f"><label class="pp-l" for="'+id+'password">Пароль</label><input class="pp-i" id="'+id+'password" name="password" type="password" autocomplete="current-password" minlength="10" maxlength="128" required><button class="pp-link" type="button" data-show aria-pressed="false">Показать пароль</button><span class="pp-h">От 10 до 128 символов. Не забывайте пароль: восстановление пока через администратора.</span></div>'+
    '<div data-register hidden><div class="pp-f"><label class="pp-l" for="'+id+'name">Имя</label><input class="pp-i" id="'+id+'name" name="name" autocomplete="given-name" maxlength="40"></div>'+
    '<fieldset class="pp-f pp-fs"><legend class="pp-l">Возраст</legend><label class="pp-check"><input type="radio" name="ageGroup" value="adult"> <span>Мне есть 18 лет</span></label><label class="pp-check"><input type="radio" name="ageGroup" value="minor"> <span>Мне 14–17 лет, мой законный представитель согласен</span></label></fieldset>'+
    '<div data-guardian hidden><div class="pp-f"><label class="pp-l" for="'+id+'guardian">ФИО законного представителя</label><input class="pp-i" id="'+id+'guardian" name="guardian" maxlength="80"></div><div class="pp-f"><label class="pp-l" for="'+id+'guardianphone">Телефон представителя</label><input class="pp-i" id="'+id+'guardianphone" name="guardianPhone" type="tel"></div></div><div data-documents role="status"></div></div>'+
    '<p class="pp-e" role="alert"></p><button class="btn btn-main calm" type="submit" style="width:100%">Войти по паролю</button>'+
    '<button class="btn btn-ghost" type="button" data-passkey style="width:100%;margin-top:12px">Войти ключом устройства</button><p class="pp-h" data-passkey-hint>Устройство предложит отпечаток, лицо или PIN. Ключ можно добавить после входа по паролю.</p><p class="pp-h" data-local-note>Старые профили и объявления этого браузера сохранены. Для серверного кабинета нужна новая регистрация.</p></form>';
  const form=container.querySelector('form'),field=name=>form.querySelector('[name="'+name+'"]'),phone=field('phone'),password=field('password'),error=form.querySelector('.pp-e'),submit=form.querySelector('[type=submit]'),docBox=form.querySelector('[data-documents]'),pk=form.querySelector('[data-passkey]');
  let mode='login',busy=false,docs=null,docsLoading=false,keyAvailable=false;
  if(global.PPUI)global.PPUI.bindPhoneMask(phone);
  if(o.phone)phone.value=o.phone;
  function update() {
    submit.textContent=mode==='register'?'Создать кабинет':'Войти по паролю';submit.disabled=busy || (mode==='register' && (!docs || docsLoading));
    form.querySelector('[data-register]').hidden=mode!=='register';pk.hidden=mode!=='login';
    password.autocomplete=mode==='register'?'new-password':'current-password';
    form.querySelectorAll('[data-mode]').forEach(button=>{button.disabled=busy;button.setAttribute('aria-pressed',String(button.dataset.mode===mode));});
    pk.disabled=busy || !keyAvailable;
  }
  async function documents() {
    docsLoading=true;update();docBox.textContent='Загружаем документы…';
    try { docs=await api.documents();docBox.innerHTML=docs.map(doc=>{
      const meta=global.PP && global.PP.DOCS && global.PP.DOCS.find(d=>d.id===doc.id);
      return '<label class="pp-check" style="margin:12px 0"><input type="checkbox" data-document="'+esc(doc.id)+'"> <span>'+(global.PPUI?global.PPUI.docLink(doc.id,meta?meta.title:doc.id):esc(doc.id))+' · ред. '+esc(doc.version)+'</span></label>';
    }).join(''); }
    catch(e) { docs=null;docBox.textContent='Документы не загрузились. Переключитесь на вход и обратно, чтобы повторить.';error.textContent=e.message; }
    docsLoading=false;update();
  }
  form.querySelectorAll('[data-mode]').forEach(button=>button.addEventListener('click',()=>{mode=button.dataset.mode;error.textContent='';update();if(mode==='register'&&!docs&&!docsLoading)documents();}));
  form.querySelector('[data-show]').addEventListener('click',e=>{password.type=password.type==='password'?'text':'password';e.currentTarget.textContent=password.type==='password'?'Показать пароль':'Скрыть пароль';e.currentTarget.setAttribute('aria-pressed',String(password.type==='text'));});
  form.querySelectorAll('[name=ageGroup]').forEach(input=>input.addEventListener('change',()=>{form.querySelector('[data-guardian]').hidden=!form.querySelector('[name=ageGroup][value=minor]:checked');}));
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy)return;error.textContent='';
    if(!phone.value.trim() || password.value.length<10 || password.value.length>128) {error.textContent='Укажите телефон и пароль от 10 до 128 символов.';return;}
    const body={phone:phone.value,password:password.value};
    if(mode==='register') {
      const age=form.querySelector('[name=ageGroup]:checked');
      if(field('name').value.trim().length<2 || !age) {error.textContent='Укажите имя и возраст.';return;}
      if(!docs || docs.some(doc=>!docBox.querySelector('[data-document="'+doc.id+'"]').checked)) {error.textContent='Отметьте каждый обязательный документ.';return;}
      body.name=field('name').value;body.ageGroup=age.value;
      if(age.value==='minor')body.guardian={fio:field('guardian').value,phone:field('guardianPhone').value};
      body.consents=Object.fromEntries(docs.map(doc=>[doc.id,{accepted:true,version:doc.version,hash:doc.hash}]));
    }
    busy=true;update();
    try {await api.ready.catch(()=>B.refreshSession());const user=mode==='register'?await api.register(body):await api.login(body);password.value='';if(o.onDone)o.onDone(user,mode==='register');}
    catch(e) {error.textContent=e.message;if(e.code==='DOCS_CHANGED')await documents();}
    finally {busy=false;update();}
  });
  pk.addEventListener('click',async()=>{if(busy)return;if(!phone.value.trim()){error.textContent='Сначала укажите телефон — логин аккаунта.';return;}busy=true;update();error.textContent='';try{const user=await api.loginPasskey(phone.value);if(o.onDone)o.onDone(user,false);}catch(e){error.textContent=e.message;}finally{busy=false;update();}});
  api.ready.then(()=>{keyAvailable=api.supported() && !!B.capabilities.passkeys;if(!keyAvailable)form.querySelector('[data-passkey-hint]').textContent='Ключ устройства сейчас недоступен для этого браузера или адреса. Входите по паролю.';update();}).catch(e=>{error.textContent=e.message;});
  update();
};
api.mountSecurity=async function(container) {
  container.innerHTML='<h2>Вход и безопасность</h2><p class="hint">Телефон — неподтверждённый логин. Биометрия остаётся на устройстве, сайт её не получает.</p><div data-keys role="status">Загрузка ключей…</div><button type="button" class="btn btn-ghost btn-sm" data-add>Добавить ключ устройства</button><p class="hint">Подтверждение отпечатком, лицом или PIN выбирает устройство.</p><form data-password novalidate><div class="pp-f"><label class="pp-l">Текущий пароль<input class="pp-i" type="password" autocomplete="current-password" name="current" required></label></div><div class="pp-f"><label class="pp-l">Новый пароль<input class="pp-i" type="password" autocomplete="new-password" name="next" minlength="10" maxlength="128" required></label></div><button class="btn btn-ghost btn-sm" type="submit">Изменить пароль</button></form><p class="pp-e" role="alert"></p><p data-security-note class="hint" aria-live="polite"></p>';
  const error=container.querySelector('.pp-e'),keys=container.querySelector('[data-keys]'),add=container.querySelector('[data-add]');
  async function refresh() {try {const list=await api.listPasskeys();keys.innerHTML=list.length?'<ul>'+list.map(item=>'<li>'+esc(item.name || 'Ключ устройства')+' <button class="pp-link" type="button" data-delete="'+esc(item.id)+'">Удалить ключ</button></li>').join('')+'</ul>':'<p class="hint">Ключей доступа пока нет.</p>';keys.querySelectorAll('[data-delete]').forEach(button=>button.addEventListener('click',async()=>{button.disabled=true;error.textContent='';try{await api.deletePasskey(button.dataset.delete);await refresh();}catch(e){error.textContent=e.message;button.disabled=false;}}));}catch(e){keys.textContent='Не удалось загрузить ключи.';error.textContent=e.message;}}
  add.disabled=!api.supported() || !B.capabilities.passkeys;
  if(add.disabled)container.querySelector('[data-security-note]').textContent='Ключи устройства недоступны для этого браузера или адреса сайта. Пароль продолжает работать.';
  add.addEventListener('click',async()=>{add.disabled=true;error.textContent='';try{await api.addPasskey();await refresh();}catch(e){error.textContent=e.message;}finally{add.disabled=false;}});
  container.querySelector('[data-password]').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,button=form.querySelector('button');button.disabled=true;error.textContent='';try{await api.changePassword(form.elements.current.value,form.elements.next.value);form.reset();container.querySelector('[data-security-note]').textContent='Пароль изменён. Остальные сеансы завершены.';}catch(e){error.textContent=e.message;}finally{button.disabled=false;}});
  await refresh();
};
})(window);
