import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { resolveChromePath } from './test/lib/chrome.mjs';
import puppeteer from 'puppeteer-core';
const ROOT='/home/user/USAAssist/';
const T={'.html':'text/html','.js':'text/javascript','.json':'application/json'};
// Serve the repo under /USAAssist/ exactly as GitHub Pages does.
const server=createServer((q,r)=>{
  let p=decodeURIComponent(q.url.split('?')[0]);
  if(!p.startsWith('/USAAssist')){r.writeHead(404);r.end('not under subpath');return;}
  p=p.slice('/USAAssist'.length)||'/';
  if(p==='/')p='/index.html';
  const f=normalize(join(ROOT,p));
  if(!f.startsWith(ROOT)||!existsSync(f)||statSync(f).isDirectory()){r.writeHead(404);r.end('nf');return;}
  r.writeHead(200,{'content-type':T[extname(f)]||'application/octet-stream'});r.end(readFileSync(f));});
await new Promise(r=>server.listen(0,r));
const BASE=`http://127.0.0.1:${server.address().port}/USAAssist/`;
const b=await puppeteer.launch({executablePath:resolveChromePath(),args:['--no-sandbox'],headless:true});
const p=await b.newPage();
const reqs=[];
p.on('pageerror',e=>console.log('PAGEERROR:',e.message));
p.on('console',m=>{if(m.type()==='error')console.log('CONSOLE:',m.text());});
p.on('requestfailed',r=>reqs.push('FAILED '+r.url()));
p.on('response',r=>{ if(r.url().includes('content/')) reqs.push(r.status()+' '+r.url().replace(BASE,'…/')); });
await p.evaluateOnNewDocument(()=>{try{localStorage.setItem('worklaw.seenWelcome.v1','1')}catch(e){}});
await p.goto(BASE,{waitUntil:'networkidle0',timeout:40000});
await new Promise(r=>setTimeout(r,2500));
console.log('--- content requests ---'); reqs.forEach(x=>console.log('  '+x));
const map = await p.evaluate(()=>({
  usMapShapes: document.querySelectorAll('.wlUsMap path[role="button"]').length,
  hasSelect: !!document.querySelector('#onb-state'),
  heading: (document.querySelector('h1')||{}).innerText,
}));
console.log('--- map state ---', JSON.stringify(map));
await b.close(); server.close();
