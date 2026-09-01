import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:7801';
const [U, P] = fs.readFileSync(process.env.CREDS, 'utf8').split('\n');
const ROUTES = [
  ['/project-list','项目列表'], ['/branch-list','分支列表'], ['/branch-topology','分支拓扑'],
  ['/release-center','发布中心'], ['/release-console','发布控制台'], ['/reports','验收报告'],
  ['/status','状态'], ['/task-schedule','任务调度'], ['/cds-settings','CDS 系统设置'],
];

const AUDIT = () => {
  const lum = c => { const f=v=>{v/=255; return v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4}; return 0.2126*f(c[0])+0.7152*f(c[1])+0.0722*f(c[2]); };
  const cr = (a,b) => { const la=lum(a),lb=lum(b),hi=Math.max(la,lb),lo=Math.min(la,lb); return (hi+0.05)/(lo+0.05); };
  const parse = s => { const m = s && s.match(/[\d.]+/g); return m ? m.slice(0,3).map(Number) : null; };
  const opaque = s => { if(!s) return false; const m=s.match(/rgba?\(([^)]+)\)/); if(!m) return false;
    const p=m[1].split(',').map(parseFloat); return p.length<4 || p[3]>=0.92; };
  const behind = el => { for(let n=el.parentElement;n;n=n.parentElement){ const bg=getComputedStyle(n).backgroundColor; if(opaque(bg)) return parse(bg);} return [255,255,255]; };
  const flat=[]; let solid=0;
  for (const el of document.querySelectorAll('div,section,article,button,li,a,form,aside,table,fieldset')) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    if (r.width < 120 || r.height < 56) continue;              // 只看「大面」，小徽章不算
    if (cs.visibility==='hidden'||cs.display==='none'||+cs.opacity<0.5) continue;
    if (parseFloat(cs.borderTopLeftRadius) < 8) continue;
    const hasBorder = parseFloat(cs.borderTopWidth)>0 && cs.borderTopStyle!=='none';
    const hasShadow = cs.boxShadow && cs.boxShadow!=='none';
    if (!hasBorder && !hasShadow) continue;
    if (!opaque(cs.backgroundColor)) continue;
    const me=parse(cs.backgroundColor), bg=behind(el);
    const ratio = cr(me,bg);
    // 有真阴影的不算：白天的抬升本来就该靠阴影
    const realShadow = hasShadow && !/rgba\(0, 0, 0, 0\)/.test(cs.boxShadow) && !/^rgb/.test(cs.boxShadow.trim());
    if (ratio < 1.05 && !realShadow) flat.push({ ratio:+ratio.toFixed(3), tag:el.tagName,
        w:Math.round(r.width), h:Math.round(r.height), cls:(el.className||'').toString().slice(0,60) });
    else solid++;
  }
  return { flat, solid };
};

const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await page.locator('input[placeholder="操作员用户名"]').fill(U);
await page.locator('input[placeholder="密码"]').fill(P);
await page.getByRole('button', { name: '登录', exact: true }).click();
await page.waitForTimeout(4000);
const landed = page.url().replace(BASE,'');
console.log('登录后落到:', landed);
if (landed.startsWith('/login')) { console.log('登录仍失败，终止（不产出假结论）'); await b.close(); process.exit(1); }

const totals = { dark:{flat:0,solid:0}, light:{flat:0,solid:0} };
const detail = [];
for (const [route,name] of ROUTES) for (const theme of ['dark','light']) {
  try {
    await page.goto(`${BASE}${route}`, { waitUntil:'domcontentloaded' });
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(2600);
    const res = await page.evaluate(AUDIT);
    totals[theme].flat += res.flat.length; totals[theme].solid += res.solid;
    if (res.flat.length) detail.push({ name, theme, flat: res.flat });
    console.log(`${name.padEnd(12)} ${theme.padEnd(5)} 同色大面 ${String(res.flat.length).padStart(3)} / 有落差 ${res.solid}`);
  } catch(e) { console.log(`${name.padEnd(12)} ${theme.padEnd(5)} 失败 ${String(e.message).slice(0,50)}`); }
}
console.log('\n=== 合计 ===');
for (const t of ['dark','light']) console.log(`  ${t}: 同色大面 ${totals[t].flat} / 有落差 ${totals[t].solid}`);
console.log('\n=== 白天独有（深色没有、白天才塌的）最多的页面 ===');
const byPage = {};
for (const d of detail) { byPage[d.name] ??= {}; byPage[d.name][d.theme] = d.flat.length; }
Object.entries(byPage).sort((a,b)=>(b[1].light||0)-(a[1].light||0)).forEach(([n,v]) =>
  console.log(`  ${n.padEnd(12)} dark=${v.dark||0} light=${v.light||0}`));
fs.writeFileSync(process.env.OUT, JSON.stringify(detail, null, 1));
await b.close();
