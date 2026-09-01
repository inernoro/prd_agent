import { chromium } from 'playwright';
const BASE = 'http://127.0.0.1:7801/';
const OUT = process.env.SHOTS;
const fails = [];
const check = (n, ok, d='') => { console.log(`${ok?'PASS':'FAIL'}  ${n}${d?' — '+d:''}`); if(!ok) fails.push(n); };

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });

for (const theme of ['dark', 'light']) {
  const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
  await p.goto(BASE, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  await p.evaluate(t => { document.documentElement.dataset.theme = t; try { localStorage.setItem('cds-theme', t); } catch {} }, theme);
  await p.waitForTimeout(400);

  // 真人路径：点页面上的入口，不用地址栏直达
  await p.getByRole('button', { name: '接入 Agent' }).first().click();
  await p.getByRole('dialog').waitFor();
  await p.waitForTimeout(1200);
  await p.screenshot({ path: `${OUT}/r0-dialog-${theme}.png` });

  // 上手助手：经验 -> 角色 -> 技能
  await p.getByText('AI 开发经验 1 年以内').click();
  await p.getByRole('heading', { name: '你主要负责什么？' }).waitFor();
  await p.getByRole('heading', { name: '产品经理' }).click();
  await p.getByRole('heading', { name: '带上哪些工作方法？' }).waitFor();
  await p.waitForTimeout(500);

  const primary = p.getByRole('button', { name: /确认这些技能/ });
  check(`[${theme}] 步骤03 主按钮在`, await primary.isVisible());
  const back = await p.getByRole('button', { name: /^返回$/ }).boundingBox();
  const cnt = await p.getByText(/^已选择 \d+ 项$/).boundingBox();
  check(`[${theme}] 返回不压在计数上`, !(back.x+back.width>cnt.x && back.y+back.height>cnt.y && back.y<cnt.y+cnt.height));
  await p.screenshot({ path: `${OUT}/r1-step3-${theme}.png` });

  // 技能库浮层
  await p.getByRole('button', { name: /打开技能库/ }).click();
  await p.getByRole('button', { name: '完成选择' }).waitFor();
  check(`[${theme}] 出口·关闭`, await p.getByRole('button', { name: '关闭技能库' }).isVisible());
  check(`[${theme}] 出口·放弃这次改动`, await p.getByRole('button', { name: '放弃这次改动' }).isVisible());
  check(`[${theme}] 出口·完成选择`, await p.getByRole('button', { name: '完成选择' }).isVisible());
  check(`[${theme}] 分类含全部共5项`, (await p.getByRole('tab').count()) === 5);
  await p.screenshot({ path: `${OUT}/r2-library-${theme}.png` });

  const before = await p.getByText(/^已选择 \d+ 项$/).first().innerText();
  await p.getByRole('button', { name: /创建新技能/ }).click();
  check(`[${theme}] 勾选后计数变`, before !== await p.getByText(/^已选择 \d+ 项$/).first().innerText());
  check(`[${theme}] 打「刚加上」`, await p.getByText('刚加上').first().isVisible());
  await p.screenshot({ path: `${OUT}/r3-added-${theme}.png` });

  await p.getByRole('button', { name: '放弃这次改动' }).click();
  await p.getByRole('heading', { name: '带上哪些工作方法？' }).waitFor();
  check(`[${theme}] 放弃后还原`, (await p.getByText(/^已选择 \d+ 项$/).innerText()) === before);

  // 完成页 + 技能来源
  await p.getByRole('button', { name: /确认这些技能/ }).click();
  await p.waitForTimeout(1200);
  // 鼠标先挪开：上一颗按钮和这一颗几乎同位置，指针停在边缘时
  // hover:-translate-y-0.5 会把按钮从指针下挪走 -> 取消 hover -> 挪回来，来回抖。
  await p.mouse.move(10, 10);
  await p.waitForTimeout(300);
  await p.getByRole('button', { name: /生成我的上手包/ }).click();
  await p.waitForTimeout(1200);
  await p.getByRole('button', { name: /复制启动提示词/ }).waitFor();
  await p.getByRole('button', { name: /技能来源/ }).click();
  await p.waitForTimeout(1200);
  const body = await p.innerText('body');
  check(`[${theme}] 来源面板出来了`, /技能来源/.test(body) && /(内置清单|读不到|没有报出来源)/.test(body));
  check(`[${theme}] 主操作没被挤走`, await p.getByRole('button', { name: /复制启动提示词/ }).isVisible());
  const src = body.match(/来源[\s\S]{0,120}/);
  console.log(`   [${theme}] 面板文案: ${(src?src[0]:'').replace(/\s+/g,' ').slice(0,110)}`);
  await p.screenshot({ path: `${OUT}/r4-source-${theme}.png` });
  await p.close();
}
await b.close();
console.log(fails.length ? `\nFAILED: ${fails.join(' | ')}` : '\nALL REAL-SITE CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
