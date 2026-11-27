/* 生成原型示例素材（只用于原型，不进源码差异）：
 *   课程视频两段（WebM，无旁白，字幕由页面的逐字稿面板呈现）、PDF 教材（原文件 + 逐页图）、视觉练习的基线与实际截图。
 *   node tools/make-assets.mjs   需要 playwright 与 ffmpeg */
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src/assets');
const tmp = path.join(root, '.asset-tmp');
rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true }); mkdirSync(out, { recursive: true });

const font = `font-family:"WenQuanYi Zen Hei","Noto Sans CJK SC",sans-serif;`;
const base = `*{box-sizing:border-box;margin:0;padding:0} body{${font}}`;

/* ---------- 视频分镜 ---------- */
const sceneCss = `${base}
.s{width:960px;height:540px;background:#14161c;color:#f4f1ea;padding:56px 64px;position:relative;overflow:hidden}
.k{font-size:15px;letter-spacing:4px;color:#d97757;margin-bottom:18px}
.t{font-size:42px;font-weight:700;line-height:1.25}
.d{font-size:21px;color:#c9c4ba;margin-top:18px;line-height:1.6;max-width:760px}
.n{position:absolute;right:64px;bottom:44px;font-size:14px;color:#7d786f}
.row{display:flex;gap:18px;margin-top:34px}
.c{flex:1;background:#1f222b;border:1px solid #2e323d;border-radius:12px;padding:20px}
.c b{display:block;font-size:19px;margin-bottom:8px} .c span{font-size:15px;color:#a9a399;line-height:1.55}
.code{background:#0d0f13;border:1px solid #2e323d;border-radius:12px;padding:18px 22px;font-family:monospace;font-size:17px;line-height:1.7;margin-top:26px;color:#d6d2c8}
.add{color:#7fd19b} .del{color:#ef8a7a} .mark{background:#5a2a1f;outline:2px solid #d97757;border-radius:3px}
.pill{display:inline-block;padding:4px 12px;border-radius:999px;font-size:14px;margin-right:8px}
.p0{background:#5a2a1f;color:#ffb3a1} .ok{background:#1e3d2a;color:#9ee2b4} .no{background:#33343b;color:#c9c4ba}
.flow{display:flex;align-items:center;gap:12px;margin-top:40px}
.f{background:#1f222b;border:1px solid #2e323d;border-radius:10px;padding:16px 18px;font-size:18px;text-align:center;min-width:128px}
.f.on{border-color:#d97757;color:#ffd2c2} .ar{color:#7d786f;font-size:22px}`;
const videos = {
  'lesson-review': [
    ['第 1 课 · 代码评审', '让 Agent 先读懂改动，再下结论', '评审不是挑语法，而是判断这次改动会不会让用户拿到错的结果。'],
    ['第一步', '给 Agent 完整上下文', '改动的 diff、需求原文、相关测试。缺一样，它就只能猜。', `<div class="row"><div class="c"><b>diff</b><span>改了哪几行</span></div><div class="c"><b>需求</b><span>本来要做到什么</span></div><div class="c"><b>测试</b><span>现在怎么证明</span></div></div>`],
    ['第二步', '要求每条意见带证据', '证据 = 文件、行号、能复现的输入。', `<div class="code">total = price - minus <span class="mark">* rate</span><br><span class="del">- return Math.max(total, 0)</span><br><span class="add">+ return total</span></div>`],
    ['第三步', '逐条判断：采纳还是驳回', 'Agent 也会误报。看证据，不看语气。', `<div class="row"><div class="c"><span class="pill p0">P0</span><b>满减后再打折算错</b><span>证据可复现 → 采纳</span></div><div class="c"><span class="pill no">P1</span><b>建议加并发锁</b><span>纯计算无共享状态 → 驳回</span></div></div>`],
    ['第四步', '修完必须复测', '同一组输入再跑一遍，红变绿才算修好。', `<div class="flow"><div class="f">评审</div><div class="ar">→</div><div class="f">判断</div><div class="ar">→</div><div class="f">修复</div><div class="ar">→</div><div class="f on">复测</div><div class="ar">→</div><div class="f">交付</div></div>`],
    ['小结', '三句话带走', '上下文给全 · 意见要证据 · 判断归你，复测归测试。'],
  ],
  'lesson-loop': [
    ['第 5 课 · 闭环', '发现问题之后：修复、复测、交付', '一次交付要回答三件事：改了什么、怎么证明、还剩什么。'],
    ['修复', '只改被证实的问题', '驳回的意见写清理由，不顺手多改。', `<div class="row"><div class="c"><span class="pill ok">采纳</span><b>2 条</b><span>附修复 diff</span></div><div class="c"><span class="pill no">驳回</span><b>1 条</b><span>附驳回理由</span></div></div>`],
    ['复测', '用同一份输入证明', '单元测试守住边界，联合测试守住整条链路。', `<div class="flow"><div class="f on">单元测试 12/12</div><div class="ar">→</div><div class="f on">联合测试 3/3</div><div class="ar">→</div><div class="f">视觉对照</div></div>`],
    ['交付', '交付说明三段式', '能做什么 · 怎么证明 · 还有什么没做到。', `<div class="code">能做什么：满减与折扣叠加后金额正确<br>怎么证明：单元测试 12/12，联合测试 3/3<br>还没做到：多币种未覆盖，已登记</div>`],
    ['小结', '没复测的修复不算修复', '交付说明里没有证据的那句话，就是下一次返工。'],
  ],
};

/* ---------- PDF 教材 ---------- */
const pageCss = `${base}
@page{size:A4;margin:0}
.p{width:794px;height:1123px;padding:72px 76px;background:#fbf9f5;color:#1d1f24;position:relative;page-break-after:always;overflow:hidden}
.p h1{font-size:34px;line-height:1.3;margin-bottom:10px} .p h2{font-size:24px;margin:26px 0 12px;color:#9a4a32}
.p h3{font-size:17px;margin:18px 0 8px}
.p p,.p li{font-size:15px;line-height:1.85;color:#33363d} .p ul{padding-left:22px}
.p .meta{font-size:13px;color:#7a7d85;letter-spacing:2px} .p .foot{position:absolute;left:76px;right:76px;bottom:40px;font-size:12px;color:#9a9da4;display:flex;justify-content:space-between;border-top:1px solid #e3ddd2;padding-top:10px}
.p table{width:100%;border-collapse:collapse;margin-top:10px} .p td,.p th{border:1px solid #e3ddd2;padding:9px 10px;font-size:14px;text-align:left;vertical-align:top} .p th{background:#f1ece3}
.p pre{background:#f1ece3;border-radius:8px;padding:14px 16px;font-size:13px;line-height:1.6;font-family:monospace;white-space:pre-wrap}
.p .box{border-left:4px solid #9a4a32;background:#f4ede3;padding:12px 16px;margin:14px 0;font-size:14px;line-height:1.7}
.cover{background:#1d1f24;color:#f4f1ea} .cover h1{font-size:46px;margin-top:260px} .cover p{color:#c9c4ba;font-size:18px} .cover .meta{color:#d97757}`;
const pages = [
  ['封面', `<div class="p cover"><div class="meta">MAP 学习中心 · 课程教材</div><h1>自动化测试实践</h1><p>用 Agent 做代码评审、视觉验收、单元测试与联合测试，<br>并把修复、复测、交付串成一个闭环。</p><div class="foot" style="color:#7d786f;border-color:#2e323d"><span>示例教材 · 共 8 页</span><span>2026 版</span></div></div>`],
  ['第 1 课 · 代码评审', `<h1>第 1 课 · 代码评审</h1><div class="meta">先读懂改动，再下结论</div><h2>评审要回答的问题</h2><p>这次改动，会不会让用户拿到错误的结果？会不会让原本正常的功能坏掉？代码风格是最后才看的事。</p><h2>交给 Agent 的上下文</h2><table><tr><th>材料</th><th>作用</th><th>缺了会怎样</th></tr><tr><td>改动 diff</td><td>知道改了哪些行</td><td>只能泛泛而谈</td></tr><tr><td>需求原文</td><td>知道本来要做到什么</td><td>把需求当缺陷</td></tr><tr><td>相关测试</td><td>知道现在如何证明</td><td>建议无法验证</td></tr></table><div class="box">每条意见必须给出：文件、行号、能复现问题的输入。没有证据的意见先放一边。</div>`],
  ['第 1 课 · 判断意见', `<h1>判断 Agent 的意见</h1><h2>三种结论</h2><ul><li><b>采纳</b>：证据可复现，影响用户结果。</li><li><b>驳回</b>：前提不成立（例如函数是纯计算，却建议加锁）。</li><li><b>记录</b>：有价值但不在本次范围，登记后续处理。</li></ul><h2>常见误报</h2><p>并发、性能、安全类意见最容易“听起来很对”。先问：这段代码真的有共享状态、真的在热路径、真的接收外部输入吗？</p><pre>// 纯函数：输入相同，输出相同，没有共享状态
export function applyCoupons(price, coupons) { ... }</pre>`],
  ['第 2 课 · 视觉验收', `<h1>第 2 课 · 视觉验收</h1><div class="meta">截图、对照、标注</div><h2>流程</h2><ul><li>同一份演示数据，在基线与实际页面各截一张。</li><li>两个主题、两个视口都要截：桌面与 375 宽手机。</li><li>Agent 标出差异，你判断哪些是缺陷、哪些在容差内。</li></ul><h2>容差怎么定</h2><table><tr><th>差异</th><th>通常判定</th></tr><tr><td>文字被截断、遮挡</td><td>缺陷</td></tr><tr><td>对比度低于 4.5</td><td>缺陷</td></tr><tr><td>阴影 1px 偏差</td><td>容差内</td></tr></table>`],
  ['第 3 课 · 单元测试', `<h1>第 3 课 · 单元测试</h1><div class="meta">先写一条会失败的测试</div><h2>让 Agent 写测试的提示</h2><pre>为 applyCoupons 补单元测试：
1. 覆盖满减后再折扣、金额归零、四舍五入到分
2. 每条测试先在旧代码上失败，再在修复后通过
3. 不要依赖当前时间与随机数</pre><h2>审测试，和审代码一样严</h2><p>依赖当前时间、依赖执行顺序的测试会时好时坏。它通过时你不知道它证明了什么，失败时你也不知道该不该修。</p>`],
  ['第 4 课 · 联合测试', `<h1>第 4 课 · 联合测试</h1><div class="meta">把真实链路串起来</div><h2>单元测试证明不了的事</h2><p>每个函数都对，拼在一起仍可能错：接口字段名不一致、金额单位一个是元一个是分、前端展示取了旧字段。</p><h2>一条联合测试的形状</h2><pre>加购 → 选券 → 下单接口 → 订单详情页
断言：页面显示的应付金额 = 接口返回的 payable</pre><div class="box">联合测试打真实部署的预览地址，不打本地桩。</div>`],
  ['第 5 课 · 闭环', `<h1>第 5 课 · 修复、复测、交付</h1><h2>修复</h2><p>只改被证实的问题。驳回的意见写清理由，不顺手扩大范围。</p><h2>复测</h2><p>同一组输入再跑一遍，单元测试守边界，联合测试守链路，视觉对照守画面。</p><h2>交付说明三段式</h2><table><tr><th>段落</th><th>写什么</th></tr><tr><td>现在能做什么</td><td>用普通话描述结果</td></tr><tr><td>怎么证明</td><td>测试数量、截图、运行记录</td></tr><tr><td>还没做到什么</td><td>已知边界和登记位置</td></tr></table>`],
  ['附录 · 检查清单', `<h1>附录 · 交付前检查清单</h1><ul><li>每条采纳的意见都有修复和复测证据</li><li>每条驳回的意见都写了理由</li><li>新测试先失败、后通过，且不依赖时间与随机数</li><li>联合测试打的是真实预览地址</li><li>两个主题、两个视口都截过图</li><li>交付说明三段齐全，没有“应该没问题”</li></ul><div class="box">这份清单可以直接贴进 Agent 的提示词，让它在交付前自查一遍。</div>`],
];

/* ---------- 视觉练习截图 ---------- */
const cardCss = (dark, broken) => `${base}
body{background:${dark ? '#141418' : '#f3efe8'};width:640px;height:400px;display:flex;align-items:center;justify-content:center}
.card{width:520px;border-radius:14px;padding:28px;background:${dark ? '#1e1e24' : '#fffdf9'};box-shadow:0 ${broken ? 7 : 6}px 24px rgba(0,0,0,.18);color:${dark ? '#f2f2f6' : '#1d1f24'}}
.h{font-size:20px;font-weight:700} .r{display:flex;justify-content:space-between;font-size:15px;margin-top:14px;color:${dark ? (broken ? '#55565e' : '#b9b9c4') : '#5b5e66'}}
.sum{display:flex;justify-content:space-between;align-items:baseline;margin-top:20px;padding-top:16px;border-top:1px solid ${dark ? '#2f2f38' : '#ebe5da'}}
.sum b{font-size:30px} .btn{margin-top:22px;height:48px;border-radius:12px;background:#b0523a;color:#fff;font-size:16px;font-weight:700;display:flex;align-items:center;justify-content:center;${broken ? 'width:170px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:0 14px' : 'width:100%'}}`;
const cardHtml = `<div class="card"><div class="h">订单结算</div><div class="r"><span>商品合计</span><span>¥ 299.00</span></div><div class="r"><span>满 200 减 30</span><span>- ¥ 30.00</span></div><div class="r"><span>会员 9 折</span><span>- ¥ 26.90</span></div><div class="sum"><span>应付</span><b>¥ 242.10</b></div><div class="btn">确认支付 ¥ 242.10，预计 30 分钟送达</div></div>`;

const browser = await chromium.launch();
const shot = async (html, file, w, h, scale = 1) => {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  await page.setContent(html); await page.screenshot({ path: file }); await page.close();
};
const webp = (src, dst, q = 62) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-c:v', 'libwebp', '-quality', String(q), dst]);

for (const [name, scenes] of Object.entries(videos)) {
  const frames = [];
  for (const [i, [k, t, d, extra = '']] of scenes.entries()) {
    const f = path.join(tmp, `${name}-${i}.png`);
    await shot(`<style>${sceneCss}</style><div class="s"><div class="k">${k}</div><div class="t">${t}</div><div class="d">${d}</div>${extra}<div class="n">自动化测试实践 · 示例视频 ${i + 1}/${scenes.length}</div></div>`, f, 960, 540);
    frames.push(f);
  }
  const per = 5, fade = 0.6;
  const args = ['-y', '-loglevel', 'error'];
  frames.forEach(f => args.push('-loop', '1', '-t', String(per), '-i', f));
  let chain = '', last = '[0:v]';
  for (let i = 1; i < frames.length; i++) {
    const label = `[v${i}]`;
    chain += `${last}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${(per - fade) * i}${label};`;
    last = label;
  }
  chain += `${last}format=yuv420p[out]`;
  args.push('-filter_complex', chain, '-map', '[out]', '-r', '12', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '48', '-row-mt', '1', path.join(out, `${name}.webm`));
  execFileSync('ffmpeg', args);
  webp(frames[0], path.join(out, `${name}-poster.webp`), 55);
}

const pdfPage = await browser.newPage({ viewport: { width: 794, height: 1123 } });
const wrap = body => body.startsWith('<div class="p') ? body : `<div class="p">${body}<div class="foot"><span>自动化测试实践 · 示例教材</span><span>{n} / 8</span></div></div>`;
const all = pages.map(([, b], i) => wrap(b).replace('{n}', String(i + 1))).join('');
await pdfPage.setContent(`<style>${pageCss}</style>${all}`);
await pdfPage.pdf({ path: path.join(out, 'handbook.pdf'), width: '794px', height: '1123px', printBackground: true });
await pdfPage.close();
for (const [i, [, b]] of pages.entries()) {
  const f = path.join(tmp, `page-${i + 1}.png`);
  await shot(`<style>${pageCss}</style>${wrap(b).replace('{n}', String(i + 1))}`, f, 794, 1123, 1.25);
  webp(f, path.join(out, `handbook-p${i + 1}.webp`), 58);
}

for (const [file, dark, broken] of [['visual-baseline', true, false], ['visual-actual', true, true]]) {
  const f = path.join(tmp, `${file}.png`);
  await shot(`<style>${cardCss(dark, broken)}</style>${cardHtml}`, f, 640, 400, 1.5);
  webp(f, path.join(out, `${file}.webp`), 70);
}
{
  const f = path.join(tmp, 'cover.png');
  await shot(`<style>${base} .c{width:400px;height:312px;background:#14161c;color:#f4f1ea;padding:30px 28px;position:relative;overflow:hidden}
  .k{font-size:12px;letter-spacing:3px;color:#d97757} .t{font-size:30px;font-weight:700;margin-top:10px;line-height:1.25}
  .l{display:flex;flex-direction:column;gap:7px;margin-top:22px} .r{display:flex;align-items:center;gap:10px;font-size:14px;color:#c9c4ba}
  .d{width:22px;height:22px;border-radius:999px;border:1.5px solid #4a4e5a;display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:#a9a399}
  .r.on .d{border-color:#d97757;color:#ffd2c2} .r.on{color:#f4f1ea}</style>
  <div class="c"><div class="k">课程 · 5 课 · 3 个练习</div><div class="t">自动化测试实践</div><div class="l">
  ${['代码评审', '视觉验收', '单元测试', '联合测试', '修复 · 复测 · 交付'].map((x, i) => `<div class="r${i === 4 ? ' on' : ''}"><span class="d">${i + 1}</span>${x}</div>`).join('')}</div></div>`, f, 400, 312, 1);
  webp(f, path.join(out, 'course-cover.webp'), 70);
}
await browser.close();
rmSync(tmp, { recursive: true, force: true });
writeFileSync(path.join(out, 'README.md'), '由 tools/make-assets.mjs 生成的示例素材，只用于原型演示。\n');
console.log('done');
