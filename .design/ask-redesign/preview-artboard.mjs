import { launch } from '../../.claude/skills/design-replication/scripts/browser.mjs';
import fs from 'node:fs';
const file = process.argv[2], out = process.argv[3], w = Number(process.argv[4]||1440), h = Number(process.argv[5]||1040);
// 把 .dc.html 变成可直接看的 HTML：去掉 support.js、把 x-dc/helmet 摊平
let s = fs.readFileSync(file,'utf8');
s = s.replace('<script src="./support.js"></script>','')
     .replace('<x-dc>','').replace('</x-dc>','')
     .replace('<helmet>','').replace('</helmet>','');
fs.writeFileSync('/tmp/preview.html', s);
const b = await launch();
const ctx = await b.newContext({ viewport: { width: w, height: h } });
const p = await ctx.newPage();
await p.goto('file:///tmp/preview.html', { waitUntil: 'load' });
await p.waitForTimeout(2500);
const box = await p.evaluate(() => ({ h: document.body.scrollHeight }));
console.log(file, '内容高度', box.h, '/ 画框', h, box.h > h ? '警告：超框' : 'ok');
await p.screenshot({ path: out, fullPage: true });
await b.close();
