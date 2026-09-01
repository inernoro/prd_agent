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
for (const [r,n,needle] of [['/branch-list','分支列表','sample-building'],['/task-schedule','任务调度','演示数据'],['/reports','验收报告','演示数据']]) {
  await p.goto(BASE+r,{waitUntil:'domcontentloaded'}); await p.waitForTimeout(2600);
  const t=(await p.innerText('body')).replace(/\s+/g,' ');
  console.log(`[${n}] 含「${needle}」= ${t.includes(needle)}  |  ${t.slice(0,150)}`);
}
await b.close();
