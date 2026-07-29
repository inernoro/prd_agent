// Phase D 验收脚手架：以真人路径逐页取证，双主题 + 像素采样。
// 用法：cd llmgw/web && pnpm build && cd ../../e2e && node .verify-pages.mjs
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path';
import { chromium } from '@playwright/test';

const DIST='/home/user/prd_agent/llmgw/web/dist', PORT=5652;
const OUT='/tmp/claude-0/-home-user-prd-agent/7a4638e1-e3a6-56b3-94b0-8498b31c46a7/scratchpad/acc';
fs.mkdirSync(OUT,{recursive:true});
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'};

const ORG={tenant:{id:'t1',name:'MAP Internal',slug:'map-internal',status:'active'},
 teams:[{id:'team-1',name:'平台组',status:'active'},{id:'team-2',name:'客服组',status:'active'}],
 members:[{id:'m1',userId:'u1',username:'map-internal.miduo',displayName:'米多',role:'owner',status:'active',teamIds:['team-1'],version:1},
          {id:'m2',userId:'u2',username:'map-internal.chen',displayName:'陈工',role:'developer',status:'active',teamIds:['team-1'],version:1}]};
const STUBS={
  '/organization':ORG,
  '/service-keys':[{id:'k1',name:'生产密钥',keyPrefix:'gwk_abc',prefix:'gwk_abc',status:'active',
    appCallerCodes:['demo.chat::chat'],ingressProtocols:['gw-native'],scopes:['invoke','route:read'],
    allowedCidrs:[],rateLimitPerMinute:null,sourceSystem:'external',purpose:'runtime',
    createdAt:new Date().toISOString(),lastUsedAt:null,expiresAt:null,rotatedByKeyId:null}],
  '/logs/summary':{total:54,totalTokens:28000,pricedRequests:50,unknownCostRequests:4,priceCoveragePercent:92.6,estimatedCosts:[{currency:'USD',amount:0.02}]},
  '/tenant-governance':{monthlyBudgetUsd:100,budgetReservationUsd:1,rateLimitPerMinute:600,spentUsd:12.5,reservedUsd:0,remainingBudgetUsd:87.5,currentMinuteCount:3},
  '/cost-reconciliations':{items:[],total:0,totalRecords:0,requestRecords:0,windowRecords:0,
    actualUnavailableRequests:0,statusDistribution:[],providerActualCosts:[]},
  '/runtime-gates':{items:[],releaseCommit:'abc1234',status:'ready',readyForHttpFull:true,passed:0,blocked:0,waiting:0},
  '/key-health':{summary:{status:'ok',total:1,unreadable:0,degraded:0}},
  '/shadow-comparisons':{summary:{total:0,allMatch:0,critical:0,httpFail:0},items:[]},
  '/config-authority/report':{summary:{status:'ready',mapOnlyTotal:0,activeMissingGatewayPool:0},items:[]},
  '/protocol-coverage':{items:[],releaseCommit:'abc1234',status:'ready'},
  '/healthz':{status:'ok'},
};
const json=(res,b)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(b));};
const server=http.createServer((req,res)=>{
  const p=new URL(req.url,`http://localhost:${PORT}`).pathname;
  if(p.startsWith('/llmgw/gw/')){
    if(p==='/llmgw/gw/auth/login')return json(res,{success:true,error:null,data:{token:'s',username:'miduo',displayName:'米多',
      expiresAt:new Date(Date.now()+36e5).toISOString(),mustChangePassword:false,
      tenant:{id:'t1',name:'MAP Internal',isInternal:true,role:'owner',teamIds:['team-1']}}});
    const api=p.replace('/llmgw/gw','').split('?')[0];
    return json(res,{success:true,error:null,data:STUBS[api]??{items:[],total:0}});
  }
  const rel=p.replace(/^\/llmgw/,''); const file=rel===''||rel==='/'||!path.extname(rel)?'/index.html':rel;
  const full=path.join(DIST,file);
  if(!fs.existsSync(full)){res.writeHead(404);res.end('{}');return;}
  res.writeHead(200,{'Content-Type':MIME[path.extname(full)]||'application/octet-stream'});res.end(fs.readFileSync(full));
});
await new Promise(r=>server.listen(PORT,r));

const NAV=[ // [名称, 侧边栏 href, 期望 h1 关键词]
 ['概览','/llmgw/',null],['请求记录','/llmgw/logs',null],['逻辑模型','/llmgw/logical-models',null],
 ['模型池','/llmgw/pools',null],['Provider','/llmgw/platforms',null],['模型','/llmgw/models',null],
 ['Exchange','/llmgw/exchanges',null],['Quickstart','/llmgw/quickstart',null],['接入密钥','/llmgw/service-keys',null],
 ['学习中心','/llmgw/learn',null],['团队与成员','/llmgw/organization',null],['预算与用量','/llmgw/usage',null],
 ['审计','/llmgw/audits',null],['系统运维','/llmgw/governance',null],
];
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const problems=[];
for(const theme of ['dark','light']){
  const page=await b.newPage({viewport:{width:1600,height:950}});
  page.on('pageerror',e=>problems.push(`[${theme}] pageerror ${e.message}\n      ${(e.stack||'').split('\n').slice(1,3).join('\n      ')}`));
  await page.addInitScript(t=>{try{localStorage.setItem('llmgw.theme',t);}catch{}},theme);
  await page.goto(`http://localhost:${PORT}/llmgw/logs`);
  await page.waitForSelector('#llmgw-username');
  await page.fill('#llmgw-username','demo');await page.fill('#llmgw-password','demo');
  await page.click('button[type=submit]');await page.waitForURL('**/llmgw/logs');
  for(const [name,href] of NAV){
    // 概览的 href 会被路由渲染成 /llmgw（无尾斜杠），两种都认。
    const alt=href.endsWith('/')?href.slice(0,-1):href;
    const link=`.lg-console-sidebar nav a[href="${href}"], .lg-console-sidebar nav a[href="${alt}"]`;
    try{ await page.waitForSelector(link,{state:'visible',timeout:8000}); }
    catch{ problems.push(`[${theme}] 侧边栏没有 ${name}`); continue; }
    await page.click(link);
    await page.waitForTimeout(900);
    const m=await page.evaluate(()=>{
      const main=document.querySelector('.lg-console-content');
      if(!main) return {missing:true,url:location.pathname,bodyText:document.body.innerText.slice(0,160)};
      const h1=document.querySelector('h1');
      let boxed=false;let el=h1?.parentElement;
      for(let i=0;i<4&&el&&el!==main;i+=1){const cs=getComputedStyle(el);
        if(parseFloat(cs.borderTopWidth)>0||(cs.backgroundColor!=='rgba(0, 0, 0, 0)'&&cs.backgroundColor!=='transparent')){boxed=true;break;}
        el=el.parentElement;}
      const inner=main.firstElementChild?.getBoundingClientRect();
      return {h1:h1?.textContent.trim()||'(无 h1)',boxed,innerW:inner?Math.round(inner.width):0,
              mainW:Math.round(main.getBoundingClientRect().width),
              bg:getComputedStyle(document.body).backgroundColor};
    });
    if (m.missing) { problems.push(`[${theme}] ${name}: 页面未渲染出内容区 url=${m.url} 文本=${m.bodyText}`); continue; }
    if(m.missing){problems.push(`[${theme}] ${name}: 内容区未渲染 url=${m.url} 文本=${m.bodyText}`);continue;}
    if(m.boxed) problems.push(`[${theme}] ${name}: 标题被卡片包住`);
    if(m.h1==='(无 h1)') problems.push(`[${theme}] ${name}: 没有 h1`);
    if(m.innerW && m.mainW-m.innerW>80) problems.push(`[${theme}] ${name}: 内容未贴边（main ${m.mainW} vs 内容 ${m.innerW}）`);
    console.log(`[${theme}] ${name.padEnd(10)} h1=${m.h1.padEnd(12)} 贴边=${m.mainW-m.innerW<=80} bg=${m.bg}`);
    await page.screenshot({path:`${OUT}/${theme}-${href.replace(/\W+/g,'_')}.png`});
  }
  await page.close();
}
console.log('\n问题:',problems.length?problems:'无');
await b.close();server.close();
process.exit(problems.length?1:0);
