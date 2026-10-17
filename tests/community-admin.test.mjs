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
