import { readFileSync,readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
function run(command,args) {
  const result=spawnSync(command,args,{cwd:root,encoding:'utf8'});
  const output=(result.stdout||'')+(result.stderr||'');
  if(output)process.stdout.write(output.split('\n').slice(-30).join('\n'));
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status||1);
}
let scripts=0;
for(const name of readdirSync(path.join(root,'1-neon'))) {
  const file=path.join(root,'1-neon',name);
  if(name.endsWith('.js')){run(process.execPath,['--check',file]);scripts++;}
  if(name.endsWith('.html')) {
    const html=readFileSync(file,'utf8');
    for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if(/\bsrc\s*=|\btype\s*=\s*["'](?:application\/ld\+json|application\/json)/i.test(match[1]))continue;
      new vm.Script(match[2],{filename:name});scripts++;
    }
  }
}
console.log(`Syntax: ${scripts} scripts passed`);
run(process.execPath,['--test',...readdirSync(path.join(root,'tests')).filter(n=>n.endsWith('.test.mjs')).map(n=>path.join('tests',n))]);
run('python',['-m','unittest','discover','-s','tests','-p','test_*.py']);
