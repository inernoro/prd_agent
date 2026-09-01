import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE='http://127.0.0.1:7801';
const [U,P]=fs.readFileSync(process.env.CREDS,'utf8').split('\n');
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
const ctx=await b.newContext({viewport:{width:1440,height:900}}); const p=await ctx.newPage();
await p.goto(`${BASE}/login`,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(1800);
await p.locator('input[placeholder="操作员用户名"]').fill(U);
await p.locator('input[placeholder="密码"]').fill(P);
await p.getByRole('button',{name:'登录',exact:true}).click(); await p.waitForTimeout(3500);
for (const [r,n] of [['/project-list','项目列表'],['/branch-list','分支列表'],['/release-center','发布中心']]) {
  await p.goto(BASE+r,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2500);
  const t=(await p.innerText('body')).replace(/\s+/g,' ');
  console.log(`\n[${n}] ${t.slice(0,190)}`);
}
await p.goto(BASE+'/project-list',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2500);
await p.screenshot({path:process.env.SHOTS+'/peek-projects.png'});
await b.close();
