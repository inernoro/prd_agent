// MAP 验收 · 通用「框选重点」截图工具（反哺 §B2：框选重点是硬要求）。
//
// 任何页面一条命令就能在指定元素/坐标上画红框 + 标签再截图——不用每次手写整个 driver。
// 发给用户的任何指向性截图（评估 / critique / 前后对比 / 诊断）都必须先过它。
//
// 用法：
//   PWPATH=$(npm root -g)/playwright node annotate.mjs \
//     --url "<页面或分享链>" --out /tmp/x.png \
//     --boxes '[{"sel":".react-flow__node[data-id=\"3\"]","n":"②","label":"这块是啥","color":"orange"},
//               {"x":100,"y":200,"w":300,"h":80,"label":"坐标框","color":"red","labelPos":"below"}]' \
//     [--mobile] [--login] [--wait 5000] [--click "button:has-text(\"证据图\")"]
//
// boxes 每项：{sel | x,y,w,h}（sel 优先，取首个匹配的 boundingBox）+ label + color(red/orange/blue/green/purple 或 #hex)
//   + n(可选序号) + labelPos(above 默认 / below / inside) + shape(box 默认方框 / circle 圈圈，圈更友好地指向单个元素)。
//   指向"单个具体元素/按钮/输入框"用 shape:"circle"；框一片"区域/差异"用方框。
// --login 用 env MAP_AI_USER / MAP_ACCEPT_PASS 表单登录；--mobile 用 iPhone 13 视口；--click 截图前先点开某元素。
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium, devices } = require(process.env.PWPATH || '/opt/node22/lib/node_modules/playwright');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}

const url = arg('url');
const out = arg('out', '/tmp/annotated.png');
const boxes = JSON.parse(arg('boxes', '[]'));
const mobile = !!arg('mobile', false);
const doLogin = !!arg('login', false);
const waitMs = parseInt(arg('wait', '4000'), 10);
const clickSel = arg('click', null);
if (!url) { console.error('用法：--url 必填'); process.exit(1); }

const COLORS = { red: '#ff3b30', orange: '#f59e0b', blue: '#3b82f6', green: '#22c55e', purple: '#a855f7' };

const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
const ctxOpt = mobile
  ? { ...devices['iPhone 13'], ignoreHTTPSErrors: true }
  : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true };
const page = await (await browser.newContext(ctxOpt)).newPage();
try {
  const origin = new URL(url).origin;
  if (doLogin) {
    await page.goto(origin + '/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('input[type=text]', { timeout: 20000 });
    await page.fill('input[type=text]', process.env.MAP_AI_USER || '');
    await page.fill('input[type=password]', process.env.MAP_ACCEPT_PASS || '');
    await page.click('button:has-text("进入控制台")');
    await page.waitForTimeout(3500);
  }
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(waitMs);
  if (clickSel) {
    await page.locator(clickSel).first().click({ timeout: 8000 }).catch((e) => console.log('click 失败:', e.message));
    await page.waitForTimeout(2500);
  }
  // selector → 坐标
  for (const box of boxes) {
    if (box.sel && box.x == null) {
      const r = await page.locator(box.sel).first().boundingBox().catch(() => null);
      if (r) { box.x = r.x; box.y = r.y; box.w = r.width; box.h = r.height; }
      else console.log('未找到元素:', box.sel);
    }
  }
  await page.evaluate(({ boxes, COLORS }) => {
    for (const box of boxes) {
      if (box.x == null) continue;
      const color = COLORS[box.color] || box.color || '#ff3b30';
      const isCircle = box.shape === 'circle' || box.shape === 'ellipse';
      // 圈：在元素外多留一圈，用椭圆（border-radius 50%）把目标"圈"起来，比方框更像人手画的圈、更友好
      const pad = isCircle ? 14 : 5;
      const frame = document.createElement('div');
      Object.assign(frame.style, {
        position: 'fixed', left: (box.x - pad) + 'px', top: (box.y - pad) + 'px',
        width: (box.w + pad * 2) + 'px', height: (box.h + pad * 2) + 'px',
        border: `${isCircle ? 4 : 3}px solid ${color}`, borderRadius: isCircle ? '50%' : '10px', zIndex: '2147483647',
        pointerEvents: 'none', boxShadow: `0 0 0 3px ${color}33`,
      });
      document.body.appendChild(frame);
      if (box.label) {
        const tag = document.createElement('div');
        const lift = isCircle ? pad : 0;
        const top = box.labelPos === 'below' ? (box.y + box.h + 8 + lift)
          : box.labelPos === 'inside' ? (box.y + 4) : (box.y - 32 - lift);
        Object.assign(tag.style, {
          position: 'fixed', left: (box.x - pad) + 'px', top: top + 'px', maxWidth: '560px',
          background: color, color: '#fff', font: '700 14px -apple-system,BlinkMacSystemFont,sans-serif',
          padding: '4px 9px', borderRadius: '7px', zIndex: '2147483647', pointerEvents: 'none', whiteSpace: 'nowrap',
        });
        tag.textContent = (box.n ? box.n + ' ' : '') + box.label;
        document.body.appendChild(tag);
      }
    }
  }, { boxes, COLORS });
  await page.waitForTimeout(500);
  await page.screenshot({ path: out });
  console.log('已画框截图 ->', out);
} finally {
  await browser.close();
}
