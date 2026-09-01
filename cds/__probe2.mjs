import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const bad = [];
p.on('console', m => { if (m.type()==='error') bad.push('console: '+m.text().slice(0,120)); });
p.on('requestfailed', r => bad.push('reqfail: '+r.url().slice(0,120)+' '+(r.failure()?.errorText||'')));
await p.goto('http://127.0.0.1:7801/', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2500);
await p.getByRole('button', { name: '接入 Agent' }).first().click();
await p.getByRole('dialog').waitFor();
await p.getByText('AI 开发经验 1 年以内').click();
await p.getByRole('heading', { name: '产品经理' }).click();
await p.getByRole('button', { name: /确认这些技能/ }).click();
await p.waitForTimeout(2500);
const btn = p.getByRole('button', { name: /生成我的上手包/ });
console.log('--- 采样 生成我的上手包 的位置，每 400ms 一次 ---');
const seen = new Set();
for (let i = 0; i < 8; i++) {
  const bb = await btn.boundingBox();
  const s = bb ? `x=${bb.x.toFixed(1)} y=${bb.y.toFixed(1)} w=${bb.width.toFixed(1)} h=${bb.height.toFixed(1)}` : 'null';
  seen.add(s); console.log(`  t=${i*400}ms  ${s}`);
  await p.waitForTimeout(400);
}
console.log('不同位置数:', seen.size, seen.size>1 ? '=> 一直在动' : '=> 稳定');
// 谁在动？扫父链的 transform / animation
const info = await btn.evaluate(el => {
  const out = [];
  for (let n = el; n && n !== document.body; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.transform !== 'none' || cs.animationName !== 'none' || cs.transitionProperty !== 'all' && cs.transitionProperty !== 'none') {
      out.push({ tag: n.tagName, cls: (n.className||'').toString().slice(0,90), transform: cs.transform.slice(0,60), anim: cs.animationName, trans: cs.transitionProperty });
    }
  }
  return out;
});
console.log('祖先链上带动效的节点:'); info.forEach(i => console.log('  ', JSON.stringify(i)));
console.log('页面报错/失败请求:'); [...new Set(bad)].slice(0,8).forEach(x => console.log('  ', x));
await p.screenshot({ path: process.env.SHOTS + '/probe-step4.png' });
await b.close();
