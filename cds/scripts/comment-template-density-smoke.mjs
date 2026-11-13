// Deterministic UI layout/state evidence. This does not prove a live deployment or GitHub delivery.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { resolveFixture, isEventStream } from './fixtures/mobile-layout-fixtures.mjs';
const dist=path.resolve(process.env.CDS_TEMPLATE_DIST||'cds/web/dist');
const out=path.resolve(process.env.CDS_TEMPLATE_EVIDENCE||path.join(os.tmpdir(),'cds-comment-template-density'));
fs.mkdirSync(out,{recursive:true});
const measureOnly=process.argv.includes('--measure-only');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml'};
const server=http.createServer((req,res)=>{const file=path.resolve(dist,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));const target=file.startsWith(dist+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()?file:path.join(dist,'index.html');res.setHeader('Content-Type',mime[path.extname(target)]||'application/octet-stream');fs.createReadStream(target).pipe(res);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}`;
const b=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||(fs.existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined),args:['--no-sandbox']});
const assert=(value,message)=>{if(!value)throw Error(message)};
const records=[];
try{
 for(const width of (process.env.CDS_TEMPLATE_WIDTH?[Number(process.env.CDS_TEMPLATE_WIDTH)]:[1440,390]))for(const theme of ['light','dark']){
  const p=await b.newPage({viewport:{width,height:width===390?844:900},isMobile:width===390,hasTouch:width===390,colorScheme:theme,reducedMotion:'reduce'});
  await p.addInitScript(v=>localStorage.setItem('cds_theme',v),theme);
  let fail=false,delay=0;const errors=[],unknown=new Set(),writes=[];
  const body='# 预览核对\n分支：{{branch}}\n{{unknown}}';
  const keys=['branch','shortSha','commitSha','previewUrl','dashboardUrl','repoFullName','prNumber','prUrl','prReviewUrl'];
  const variables=keys.map(key=>({key,label:key==='branch'?'分支名':`变量 ${key}`,example:key==='branch'?'fixture/branch':'https://example.invalid/'+key}));
  p.on('pageerror',e=>errors.push(e.message));
  await p.route('**/api/**',async route=>{
   const request=route.request(),pathname=new URL(request.url()).pathname.replace(/^\/_cds/,'');
   if(isEventStream(pathname))return route.fulfill({contentType:'text/event-stream',body:': ready\n\n'});
   if(['PUT','PATCH','DELETE'].includes(request.method())){writes.push(pathname);return route.fulfill({status:405,json:{error:'测试禁止保存配置'}})}
   if(pathname==='/api/comment-template/preview'){
    if(delay)await new Promise(r=>setTimeout(r,delay));
    return fail?route.fulfill({status:503,json:{error:'示例预览暂不可用，请重试'}}):route.fulfill({json:{ok:true,rendered:request.postDataJSON().body.replaceAll('{{branch}}','fixture/branch')}});
   }
   let data;
   if(pathname==='/api/comment-template')data={ok:true,body,defaultBody:body,isDefault:true,updatedAt:null,variables};
   else if(/^\/api\/projects\/[^/]+\/identity-history$/.test(pathname))data={records:[],nextCursor:null,coverage:'since-baseline'};
   else if(/^\/api\/projects\/[^/]+\/recent-auto-deploys$/.test(pathname))data={items:[]};
   else {data=resolveFixture(pathname);if(data===null){unknown.add(pathname);data={}}}
   await route.fulfill({json:data});
  });
  await p.goto(base+'/project-list');
  await p.locator('article[data-project-id] .cds-project-actions button').first().click();
  await p.getByRole('menuitem',{name:'项目设置',exact:true}).click();
  await p.getByRole('tab',{name:'评论模板',exact:true}).click();
  const panel=p.locator('[role=tabpanel][data-state=active]'),editor=panel.locator('textarea').first();
  await editor.fill(body);await panel.getByRole('button',{name:'预览',exact:true}).click();
  const preview=p.getByRole('heading',{name:'示例预览',exact:true}).locator('..').locator('.whitespace-pre-wrap');
  await preview.filter({hasText:'fixture/branch'}).waitFor();
  await p.evaluate(async()=>{await document.fonts.ready;await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))});
  const eb=await editor.boundingBox(),pb=await preview.boundingBox();
  const scroll=()=>p.evaluate(()=>[...document.querySelectorAll('*')].reduce((n,e)=>n+e.scrollTop,0));
  const initial=await scroll();await p.screenshot({path:`${out}/${width}-${theme}.png`});
  await preview.scrollIntoViewIfNeeded();const toPreview=await scroll();await editor.scrollIntoViewIfNeeded();const back=await scroll();
  const row={provenance:'deterministic-fixture',width,theme,editor:eb,preview:pb,referenceCount:variables.length,toPreviewScroll:Math.abs(toPreview-initial),backToEditorScroll:Math.abs(back-toPreview),font:await editor.evaluate(e=>getComputedStyle(e).fontSize),overflow:await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth)};
  records.push(row);fs.writeFileSync(`${out}/measurements.json`,JSON.stringify(records,null,2));
  if(!measureOnly){
   if(width===1440){assert(pb.y+pb.height<=900&&eb.y+eb.height<=900,'编辑与预览不能同时在首屏阅读');assert(pb.x>eb.x+eb.width,'宽屏预览应与编辑并列，不能隔着变量目录');assert(row.toPreviewScroll===0&&row.backToEditorScroll===0,'编辑与读预览仍需往返滚动')}
   assert(!row.overflow,'评论模板文档横向溢出');
   const reference=panel.locator('summary').filter({hasText:'可用变量'});
   assert(await reference.count()===1,'变量参考应按需出现，不能占据输入和预览之间');
   assert((await reference.boundingBox()).y>=pb.y+pb.height,'变量参考仍排在预览结果之前');
   await reference.focus();await p.keyboard.press('Enter');
   await p.getByText('点击变量会插入到模板光标位置。未识别变量会原样保留，便于排查拼写。',{exact:true}).waitFor();
   await editor.evaluate(e=>{e.focus();e.setSelectionRange(0,2)});
   await p.getByRole('button',{name:/\{\{prNumber\}\}/}).click();
   assert((await editor.inputValue()).startsWith('{{prNumber}}'),'变量未插入到所选文字位置');
   await reference.click();
   fail=true;await panel.getByRole('button',{name:'预览',exact:true}).click();
   await p.getByRole('alert').filter({hasText:'预览失败'}).waitFor();
   assert(await editor.inputValue()!=='','预览失败不应清空草稿');
   fail=false;delay=300;
   await editor.fill('旧草稿 {{branch}}');await panel.getByRole('button',{name:'预览',exact:true}).click();await editor.fill('预览期间的新输入');
   await preview.filter({hasText:'旧草稿 fixture/branch'}).waitFor();
   assert(await editor.inputValue()==='预览期间的新输入','延迟预览覆盖了较新的草稿');
   delay=0;await editor.fill('');await panel.getByRole('button',{name:'预览',exact:true}).click();
   await preview.filter({hasText:'fixture/branch'}).waitFor();assert((await preview.innerText()).includes('{{unknown}}'),'未知变量说明与实际保留行为不一致');
  }
  assert(writes.length===0,'布局验收不应保存项目配置');assert(errors.length===0,`页面异常：${errors.join(';')}`);assert(unknown.size===0,`fixture未登记：${[...unknown].join(',')}`);
  await p.close();
 }
 console.log(JSON.stringify({status:measureOnly?'MEASURED':'PASS',snapshots:records.length,out}));
}finally{await b.close();await new Promise(r=>server.close(r))}
