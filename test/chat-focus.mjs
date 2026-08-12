import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { gotoApp } from './lib/nav.mjs';
const ROOT = new URL('..', import.meta.url).pathname;
const T = { '.html':'text/html','.js':'text/javascript','.json':'application/json','.svg':'image/svg+xml' };
const srv = createServer((q,s)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';const f=normalize(join(ROOT,p));if(!f.startsWith(ROOT)||!existsSync(f)||statSync(f).isDirectory()){s.writeHead(404);s.end();return;}s.writeHead(200,{'content-type':T[extname(f)]||'application/octet-stream'});s.end(readFileSync(f));});
await new Promise(r=>srv.listen(0,r));const PORT=srv.address().port;
const chrome=execSync(`find "${ROOT}chrome-headless-shell" -type f -name 'chrome-headless-shell'|head -1`).toString().trim();
const b=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox']});
let ok = false;
try {
const pg=await b.newPage(); await pg.setViewport({width:430,height:840,deviceScaleFactor:1});
await pg.evaluateOnNewDocument(()=>localStorage.setItem('worklaw.case.v2',JSON.stringify({onboarded:true,stateSel:'Texas',county:'Travis County',issue:'Unpaid overtime or wages',profile:{name:'',employer:'',payType:'',rate:''},caseOpened:new Date().toISOString(),entries:[],done:{},messages:[]})));
await gotoApp(pg, `http://127.0.0.1:${PORT}/index.html`);
await new Promise(r=>setTimeout(r,500));
await pg.evaluate(()=>{const e=[...document.querySelectorAll('button')].find(x=>x.textContent.includes('Ask AI'));e&&e.click();});
await new Promise(r=>setTimeout(r,400));
// focus the input and type char-by-char
await pg.evaluate(()=>{const i=document.querySelector('input[placeholder="Type your question"]');i&&i.focus();});
const scrollBefore = await pg.evaluate(()=>document.querySelector('.scrollarea')?.scrollTop);
await pg.keyboard.type('overtime', {delay: 40});
const res = await pg.evaluate(()=>{
  const i=document.querySelector('input[placeholder="Type your question"]');
  return { value: i ? i.value : '(input gone)', focused: document.activeElement === i, scroll: document.querySelector('.scrollarea')?.scrollTop };
});
console.log('typed "overtime" →', JSON.stringify(res), 'scrollBefore='+scrollBefore);
ok = res.value === 'overtime' && res.focused;
console.log(ok ? '✅ input keeps focus & value' : '❌ BUG: focus/value lost on typing');
} finally {
  await b.close();
  srv.close();
}
process.exit(ok ? 0 : 1);
