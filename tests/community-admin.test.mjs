import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('admin page executes initialization and exposes a working server login form',async()=>{
  const nodes=new Map();
  function node(selector) {
    if(!nodes.has(selector))nodes.set(selector,{
      hidden:selector==='#login',innerHTML:'',textContent:'',value:'',listeners:new Map(),
      classList:{contains:()=>false,add(){},remove(){},toggle(){}},
      addEventListener(type,fn){this.listeners.set(type,fn);},setAttribute(){},removeAttribute(){},focus(){},
    });
    return nodes.get(selector);
  }
  let submitted=null;
  const context={
    console,Date,setTimeout:()=>1,clearTimeout(){},
    location:{hash:''},
    document:{querySelector:node,querySelectorAll:()=>[],addEventListener(){}},
    PP:{esc:String,money:String,hhmm:String,dateLong:String,today:()=> '2026-10-17'},
    PPUI:{docsFooterHTML:()=>'',toast(){}},
    BookingAPI:{ready:Promise.resolve()},
    CommunityAPI:{},
    AdminAPI:{isLogged:()=>false,login:async(login,password)=>{submitted={login,password};throw new Error('Проверьте данные для входа');}},
    addEventListener(){},matchMedia:()=>({matches:false,addEventListener(){}}),
  };
  context.window=context;vm.createContext(context);
  const html=readFileSync(new URL('../1-neon/admin.html',import.meta.url),'utf8');
  const scripts=[...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(x=>!x[1].includes('src='));
  for(const script of scripts)vm.runInContext(script[2],context,{filename:'admin.html'});
  await Promise.resolve();
  assert.equal(node('#login').hidden,false);
  assert.equal(node('#app').hidden,true);
  assert.match(node('#nav').innerHTML,/href="#settings"/);
  assert.equal(typeof node('#loginForm').listeners.get('submit'),'function');
  node('#lgLogin').value='fixture-account';node('#lgPass').value='fixture-password';
  await node('#loginForm').listeners.get('submit')({preventDefault(){}});
  assert.deepEqual(submitted,{login:'fixture-account',password:'fixture-password'});
  assert.equal(node('#loginErr').textContent,'Проверьте данные для входа');
  assert.equal(node('#loginForm [type=submit]').disabled,false);
});

const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function manualFormFixture(){
  const elements=[],nodes=new Map(),sheets=[],quotes=[],saves=[];
  class Element {
    constructor(){this.listeners=new Map();this.children=new Map();this.value='';this.disabled=false;this.classList={contains:()=>false,add(){},remove(){},toggle(){}};elements.push(this);}
    set innerHTML(html){
      this.html=html;
      for(const match of html.matchAll(/<(input|select|textarea)\b([^>]*)>([\s\S]*?)(?:<\/\1>|(?=<))/gi)){
        const id=match[2].match(/\bid="([^"]+)"/);if(!id)continue;
        const field=this.querySelector('#'+id[1]);
        field.value=match[2].match(/\bvalue="([^"]*)"/)?.[1]||'';
        if(match[1]==='select')field.innerHTML=match[3];
      }
      if(/^<option/.test(html)){const options=[...html.matchAll(/<option\b([^>]*)>([^<]*)<\/option>/g)];const selected=options.find(x=>/\bselected\b/.test(x[1]))||options[0];this.value=selected?.[1].match(/value="([^"]*)"/)?.[1]??selected?.[2]??'';}
    }
    get innerHTML(){return this.html||'';}
    querySelector(selector){if(!this.children.has(selector))this.children.set(selector,new Element());return this.children.get(selector);}
    querySelectorAll(){return [];}
    addEventListener(type,fn){this.listeners.set(type,fn);}
    appendChild(child){this.child=child;}
    setAttribute(){} removeAttribute(){} focus(){}
  }
  const node=key=>{if(!nodes.has(key))nodes.set(key,new Element());return nodes.get(key);};
  let logged=false;
  const settings={open:600,close:1230,maxPlayers:4,racket:100};
  const context={console,Date,setTimeout:()=>1,clearTimeout(){},location:{hash:''},
    document:{querySelector:node,querySelectorAll:()=>[],createElement:()=>new Element(),addEventListener(){},contains:()=>true},
    PP:{esc:String,money:v=>v+' ₽',hhmm:String,dateLong:String,today:()=> '2026-10-20'},
    PPUI:{docsFooterHTML:()=>'',toast(){},bindPhoneMask(){},sheet:options=>{sheets.push(options);return {close:()=>options.onClose?.()};}},
    BookingAPI:{ready:Promise.resolve(),settings:()=>settings,refreshAvailability:async()=>[],availabilityState:()=>({status:'ready'}),availabilitySync:()=>[],quote:()=>({total:400,rent:400,rackets:0,discount:0})},
    CommunityAPI:{},AdminAPI:{isLogged:()=>logged,login:async()=>{logged=true;},dashboard:()=>new Promise(()=>{}),
      quoteManualBooking:values=>new Promise((resolve,reject)=>quotes.push({values,resolve,reject})),
      createManualBooking:values=>new Promise(resolve=>saves.push({values,resolve})),
    },addEventListener(){},scrollTo(){},matchMedia:()=>({matches:false,addEventListener(){}}),
  };
  context.window=context;vm.createContext(context);
  const html=readFileSync(new URL('../1-neon/admin.html',import.meta.url),'utf8');
  for(const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!script[1].includes('src='))vm.runInContext(script[2],context,{filename:'admin.html'});
  return {quotes,saves,sheets,node,async open(){
    await flush();await node('#loginForm').listeners.get('submit')({preventDefault(){}});
    node('#view').child.querySelector('[data-new]').listeners.get('click')();
    await flush();
    const form=sheets.at(-1).body;
    const field=label=>{const labels=[...form.innerHTML.matchAll(/<label\b[^>]*for="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g)];const entry=labels.find(x=>x[2].startsWith(label));assert.ok(entry,'Visible field '+label);return form.querySelector('#'+entry[1]);};
    return {form,field,submit:()=>form.listeners.get('submit')({preventDefault(){}}),button:form.querySelector('[type=submit]'),preview:form.querySelector('[data-quote]')};
  }};
}

test('manual booking waits for latest server preview and ignores stale responses before saving',async()=>{
  const f=manualFormFixture(),ui=await f.open();
  assert.equal(f.quotes.length,1,'initial price must be confirmed on the server');
  assert.equal(ui.button.disabled,true);
  await ui.submit();assert.equal(f.saves.length,0,'pending preview cannot save');
  f.quotes[0].resolve({rent:400,rackets:0,discount:0,tariffTotal:400,total:400});await flush();
  assert.equal(ui.button.disabled,false);
  const promo=ui.field('Промокод');
  promo.value='OLD10';promo.listeners.get('input')();
  promo.value='NEW20';promo.listeners.get('input')();
  assert.equal(f.quotes.length,3);
  f.quotes[2].resolve({rent:400,rackets:0,discount:80,tariffTotal:320,total:320});await flush();
  f.quotes[1].reject(Error('Expired old promo'));await flush();
  assert.match(ui.preview.innerHTML,/320 ₽/);
  assert.doesNotMatch(ui.preview.innerHTML,/Expired old promo/);
  const amount=ui.field('Сумма,');amount.value='100';amount.listeners.get('input')();
  amount.value='275';amount.listeners.get('input')();
  assert.equal(ui.button.disabled,true);
  await ui.submit();assert.equal(f.saves.length,0);
  f.quotes[4].resolve({rent:400,rackets:0,discount:80,tariffTotal:320,total:275});await flush();
  f.quotes[3].resolve({rent:400,rackets:0,discount:80,tariffTotal:320,total:100});await flush();
  assert.match(ui.preview.innerHTML,/275 ₽/);
  assert.doesNotMatch(ui.preview.innerHTML,/100 ₽/);
  ui.field('Заметка').value='Пожелания';
  const saving=ui.submit(),duplicate=ui.submit();
  assert.equal(f.saves.length,1,'double submit must not create duplicate bookings');
  assert.equal(f.saves[0].values.expectedAmount,275);
  assert.equal(f.saves[0].values.promo,'NEW20');
  assert.equal(f.saves[0].values.note,'Пожелания');
  f.saves[0].resolve({number:'PP-test',dateLabel:'20.10.2026',timeLabel:'10:00–11:00'});
  await Promise.all([saving,duplicate]);
});
