import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from '@playwright/test';
const DIST='/home/user/prd_agent/prd-admin/dist';
const _src=fs.readFileSync('/home/user/prd_agent/prd-admin/src/app/navRegistry.tsx','utf8');
const PERMS=[...new Set(['access',...[..._src.matchAll(/'([a-z][a-z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)+)'/g)].map(m=>m[1])])];
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
const srv=http.createServer((req,res)=>{const u=decodeURIComponent((req.url||'/').split('?')[0]);
 if(u.startsWith('/api/')||u.startsWith('/gw/')){res.writeHead(200,{'content-type':'application/json'});
   return res.end(JSON.stringify({success:true,data:{items:[],total:0,effectivePermissions:PERMS,permissions:PERMS,isRoot:true,menu:[]},error:null}));}
 const f=path.join(DIST,u==='/'?'index.html':u.replace(/^\//,''));
 if(fs.existsSync(f)&&fs.statSync(f).isFile()){res.writeHead(200,{'content-type':MIME[path.extname(f)]||'application/octet-stream'});return res.end(fs.readFileSync(f));}
 res.writeHead(200,{'content-type':'text/html'});res.end(fs.readFileSync(path.join(DIST,'index.html')));});
await new Promise(r=>srv.listen(5674,'127.0.0.1',r));
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const c=await b.newContext({viewport:{width:1440,height:900}});const p=await c.newPage();
p.on('console',m=>{if(m.type()==='error')console.log('  [console.error]',m.text().slice(0,120));});
await p.addInitScript((PERMS)=>{
  localStorage.setItem('map-mobile-theme-v2',JSON.stringify({state:{mode:'light'},version:0}));
  localStorage.setItem('prd-admin-auth',JSON.stringify({state:{isAuthenticated:true,token:'audit',refreshToken:'audit',sessionKey:'audit',user:{userId:'audit',username:'audit',userType:'Human'},permissions:PERMS,permissionsLoaded:true,isRoot:true,menuCatalog:[],menuCatalogLoaded:true,cdnBaseUrl:'',permFingerprint:'audit'},version:0}));
},PERMS);
await p.goto('http://127.0.0.1:5674/chat',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(3000);
console.log('URL      :', p.url());
console.log('dataTheme:', await p.evaluate(()=>document.documentElement.dataset.theme||'(无)'));
console.log('theme LS :', await p.evaluate(()=>localStorage.getItem('map-mobile-theme-v2')));
console.log('auth LS  :', (await p.evaluate(()=>localStorage.getItem('prd-admin-auth')||''))?.slice(0,80));
console.log('body 文本:', (await p.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').slice(0,120))));
await p.screenshot({path:'/tmp/claude-0/-home-user-prd-agent/206796b0-72ab-5695-9679-87e7e136e5c2/scratchpad/probe-local.png'});
await b.close();srv.close();
