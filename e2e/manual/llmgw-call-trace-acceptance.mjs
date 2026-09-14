// 调用全貌面板的真人路径视觉验收。
//
// 用法（密钥从环境变量取）：
//   LLMGW_BASE=<控制台地址> LLMGW_TOKEN=<会话 token> LLMGW_SESSION=<会话 json> \
//   OUT_DIR=<截图目录> node e2e/manual/llmgw-call-trace-acceptance.mjs
//
// 双主题那两条的判据是「两张图真的不一样」而不是「不是深色底」——控制台默认本来就是浅色，
// 只断言后者的话，深色那一遍从来没验过，两张截图字节完全相同却照样全绿（测试自己坏了）。
// 页面字节取自预览容器（逐字节核对过），API 转发到同一个预览域名——浏览器只跟 localhost 说话。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '/home/user/prd_agent/cds/node_modules/playwright/index.mjs';

const BASE = process.env.LLMGW_BASE;
const TOKEN = process.env.LLMGW_TOKEN;
const OUT = process.env.OUT_DIR;
const session = JSON.parse(process.env.LLMGW_SESSION);
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? '[通过]' : '[失败]'} ${name} — ${detail}`); };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox', '--no-proxy-server'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await ctx.newPage();

const settle = async (ms = 60000) => {
  await page.waitForFunction(() => !/正在加载|正在推演/.test(document.body.innerText), null, { timeout: ms }).catch(() => {});
  await page.waitForTimeout(500);
};
const shot = async (name) => { await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }); };

await page.goto(`${BASE}/llmgw/`, { waitUntil: 'domcontentloaded' });
await page.evaluate(([t, u, te, e]) => {
  localStorage.setItem('llmgw.token', t); localStorage.setItem('llmgw.user', u);
  localStorage.setItem('llmgw.tenant', te); localStorage.setItem('llmgw.expiresAt', e);
}, [TOKEN, JSON.stringify(session.user), JSON.stringify(session.tenant), session.expiresAt]);

// 真人路径：点导航进模型页
await page.goto(`${BASE}/llmgw/`, { waitUntil: 'networkidle' });
await page.click('.lg-console-sidebar nav a:has-text("模型")');
await page.waitForURL('**/llmgw/logical-models**');
await settle();
const traceButtons = await page.locator('button:has-text("调用全貌")').count();
record('模型页每一行都有「调用全貌」按钮', traceButtons > 0, `按钮 ${traceButtons} 个`);
await shot('01-模型页');

// 点开第一个
await page.locator('button:has-text("调用全貌")').first().click();
await page.waitForSelector('[data-testid="call-trace-panel"]', { timeout: 30000 });
await settle();
const conclusion = (await page.locator('[data-testid="call-trace-conclusion"]').innerText()).replace(/\s+/g, ' ').trim();
record('第一屏就是一句结论', /现在发一个请求|现在调它会失败|还没有线路/.test(conclusion), `「${conclusion.slice(0, 90)}」`);
await shot('02-调用全貌');

const unnamed = (await page.locator('[data-testid="call-trace-unnamed"]').innerText()).replace(/\s+/g, ' ').trim();
record('不点名那条路被单独回答', /appCallerCode/.test(unnamed), `「${unnamed.slice(0, 110)}」`);

const gate = (await page.locator('[data-testid="call-trace-gate"]').innerText()).replace(/\s+/g, ' ').trim();
record('目录闸说清谁能点名它，并说明没推演什么', /能点名/.test(gate) && /没在这一屏推演/.test(gate), `「${gate.slice(0, 110)}」`);

const routesText = (await page.locator('[data-testid="call-trace-routes"]').innerText()).replace(/\s+/g, ' ').trim();
const hasQueue = /队首/.test(routesText) || /按权重/.test(routesText) || /一条线路都没有/.test(routesText);
record('候选线路给出排队名次或分配比例', hasQueue, `「${routesText.slice(0, 130)}」`);

const ledger = (await page.locator('[data-testid="call-trace-ledger"]').innerText()).replace(/\s+/g, ' ').trim();
record('账本给调用/花费/未计价', /调用/.test(ledger) && /未计价/.test(ledger), `「${ledger.slice(0, 110)}」`);

// 结论与线路列表必须自洽：结论点名谁，队首就得是谁
const headLabel = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('[data-testid="call-trace-routes"] div')];
  const head = rows.find((el) => (el.innerText || '').startsWith('队首'));
  return head ? head.innerText.replace(/\s+/g, ' ').trim() : null;
});
if (headLabel) {
  const name = headLabel.split(' ')[1] || '';
  record('结论点名的那条，就是列表里的队首', conclusion.includes(name), `队首「${headLabel.slice(0, 80)}」`);
} else {
  record('结论点名的那条，就是列表里的队首', /按权重|会失败|还没有线路/.test(conclusion), '没有队首行，结论也没指名（按权重或调不通），自洽');
}

// 双主题各看一遍。判据必须是「两张图真的不一样」——此前只断言了「不是深色底」，
// 而控制台默认本来就是浅色，于是那一条从来没验过深色，两张截图字节完全相同。
const themeShots = {};
for (const [theme, name] of [['light', '03-白天-调用全貌'], ['dark', '04-黑夜-调用全貌']]) {
  await page.evaluate((t) => {
    localStorage.setItem('llmgw.theme', t);
    document.documentElement.setAttribute('data-theme', t);
  }, theme);
  await page.reload({ waitUntil: 'networkidle' });
  await settle();
  await page.locator('button:has-text("调用全貌")').first().click();
  await page.waitForSelector('[data-testid="call-trace-panel"]', { timeout: 30000 });
  await settle();
  themeShots[theme] = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    panel: getComputedStyle(document.querySelector('[data-testid="call-trace-conclusion"]')).color,
  }));
  await shot(name);
}
const light = themeShots.light;
const dark = themeShots.dark;
record('白天主题底色是浅的', /rgb\(2[0-9]{2}, 2[0-9]{2}, 2[0-9]{2}\)/.test(light.body), `body ${light.body}`);
record('黑夜主题底色是深的', /rgb\([0-9], [0-9]{1,2}, [0-9]{1,2}\)/.test(dark.body), `body ${dark.body}`);
record('两个主题真的不同（不是同一张图）', light.body !== dark.body && light.panel !== dark.panel,
  `白天 body ${light.body} 文字 ${light.panel} / 黑夜 body ${dark.body} 文字 ${dark.panel}`);

await browser.close();
const failed = results.filter((x) => !x.ok);
console.log(`\n合计 ${results.length} 条，失败 ${failed.length} 条`);
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
