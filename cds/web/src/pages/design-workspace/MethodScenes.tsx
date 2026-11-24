/* V21（用户：视频用代码生成；每个验收方式的页面顶部一段动画，演示原理、作用、覆盖范围）。
 * 每个画面是时间的纯函数：draw(beat, p) 只依赖第几段和段内进度 0..1，不读时钟、不随机。
 * 所以同一份代码既在 CDS 页面里直接播放，也能逐帧导出 mp4（tools/render-video.mjs 按帧 seek 截图）。
 * 画布 640×300；颜色全部取主题变量，浅色深色自动跟随。数据都是虚构的。 */
import type { JSX } from 'react';

export type Beat = { title: string; line: string };
export type Scene = { beats: [Beat, Beat, Beat]; draw: (beat: number, p: number) => JSX.Element };
export const BEAT_SECONDS = 5;
export const beatNames = ['原理', '作用', '覆盖范围'] as const;

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const ease = (x: number) => 1 - (1 - clamp(x)) ** 3;
const seg = (p: number, a: number, b: number) => ease((p - a) / (b - a));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const pulse = (p: number, n = 3) => .5 + .5 * Math.sin(p * Math.PI * 2 * n);

function Page({ x, y, w, h, shift = 0, o = 1, label, dark }: { x: number; y: number; w: number; h: number; shift?: number; o?: number; label?: string; dark?: boolean }) {
  return <g transform={`translate(${x} ${y})`} opacity={o}>
    <rect width={w} height={h} rx={6} className={dark ? 'mx-paper-dark' : 'mx-paper'} />
    <rect width={w} height={h * .12} rx={6} className="mx-bar" />
    <rect x={5} y={h * .17} width={w * .18} height={h * .78} rx={3} className="mx-soft" />
    <rect x={w * .26} y={h * .19} width={w * .66} height={h * .13} rx={3} className="mx-block" />
    <rect x={w * .26 + shift} y={h * .38} width={w * .4} height={h * .22} rx={3} className="mx-accent" />
    <rect x={w * .26} y={h * .66} width={w * .66} height={h * .26} rx={3} className="mx-soft" />
    {label && <text x={w / 2} y={h + 18} className="mx-label" textAnchor="middle">{label}</text>}
  </g>;
}
const Tick = ({ x, y, ok = true, k = 1 }: { x: number; y: number; ok?: boolean; k?: number }) => <g transform={`translate(${x} ${y}) scale(${k})`} opacity={k}>
  <circle r={8} className={ok ? 'mx-ok-fill' : 'mx-bad-fill'} />
  <path d={ok ? 'M-3.5 0 L-1 2.8 L4 -3' : 'M-3 -3 L3 3 M3 -3 L-3 3'} className="mx-mark" /></g>;
const Pill = ({ x, y, w, text, tone = 'line', o = 1 }: { x: number; y: number; w: number; text: string; tone?: 'line' | 'ok' | 'bad' | 'warn' | 'accent'; o?: number }) => <g transform={`translate(${x} ${y})`} opacity={o}>
  <rect width={w} height={24} rx={12} className={`mx-pill mx-pill-${tone}`} /><text x={w / 2} y={16} textAnchor="middle" className="mx-pill-text">{text}</text></g>;
function arc(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number) {
  const pt = (r: number, a: number) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${pt(r1, a0)} A${r1} ${r1} 0 ${large} 1 ${pt(r1, a1)} L${pt(r0, a1)} A${r0} ${r0} 0 ${large} 0 ${pt(r0, a0)} Z`;
}

export const scenes: Record<string, Scene> = {
  compare: {
    beats: [{ title: '原理', line: '设计图和实现图，同一画面、同视口、同主题、同一份数据，叠在一起比' },
      { title: '作用', line: '位置、大小、颜色不一样的地方自动框出来，一处一处解释' },
      { title: '覆盖范围', line: '每个画面 × 每条验收项要求的视口和主题；缺一张都不能签收' }],
    draw: (beat, p) => {
      if (beat === 0) {
        const k = seg(p, .3, .85);
        return <g><Page x={lerp(70, 220, k)} y={60} w={200} h={150} label="设计稿" />
          <Page x={lerp(370, 220, k)} y={60} w={200} h={150} o={lerp(1, .55, k)} shift={10} label={k > .95 ? '' : '实现 · 提交 a1b2c3'} />
          <g opacity={seg(p, .85, 1)}><text x={320} y={250} textAnchor="middle" className="mx-label">叠加，透明度 50%</text></g></g>;
      }
      if (beat === 1) {
        const k = seg(p, .05, .3);
        return <g><Page x={220} y={60} w={200} h={150} /><Page x={220} y={60} w={200} h={150} o={.55} shift={10} />
          <rect x={220 + 200 * .26 - 4} y={60 + 150 * .38 - 4} width={200 * .4 + 18} height={150 * .22 + 8} rx={4} className="mx-diff" opacity={k * (.6 + .4 * pulse(p))} />
          <rect x={220 - 3} y={57} width={206} height={150 * .12 + 6} rx={4} className="mx-diff" opacity={seg(p, .35, .55) * (.6 + .4 * pulse(p))} />
          <g opacity={seg(p, .55, .8)}><Pill x={455} y={95} w={130} text="本屏 2 处不同" tone="bad" />
            <text x={455} y={140} className="mx-small">① 主按钮右移 10 像素</text><text x={455} y={160} className="mx-small">② 页头底色不同</text></g></g>;
      }
      const cols = ['桌面浅', '桌面深', '手机浅', '手机深']; const rows = ['设计库', '打开稿件', '验收总览', '对照图', '记录'];
      const missing = new Set([7, 13]);
      return <g>{cols.map((c, i) => <text key={c} x={190 + i * 70} y={52} textAnchor="middle" className="mx-small">{c}</text>)}
        {rows.map((r, j) => <text key={r} x={140} y={82 + j * 38} textAnchor="end" className="mx-small">{r}</text>)}
        {rows.flatMap((_, j) => cols.map((__, i) => { const n = j * 4 + i; const on = seg(p, n / 24, n / 24 + .08);
          return <g key={n}><rect x={160 + i * 70} y={64 + j * 38} width={60} height={28} rx={5} className="mx-soft" />
            <rect x={160 + i * 70} y={64 + j * 38} width={60} height={28} rx={5} className={missing.has(n) ? 'mx-miss' : 'mx-ok-soft'} opacity={on} />
            {on > .5 && <text x={190 + i * 70} y={83 + j * 38} textAnchor="middle" className="mx-small">{missing.has(n) ? '缺实拍' : '对上'}</text>}</g>; }))}
        <g opacity={seg(p, .85, 1)}><Pill x={455} y={140} w={160} text="18/20 · 不能签收" tone="warn" /></g></g>;
    },
  },
  visual: {
    beats: [{ title: '原理', line: '十条通用视觉检查，从上到下逐块扫一遍：对齐、间距、字号、颜色……' },
      { title: '作用', line: '找出对照图看不出的问题：差几个像素、截断、溢出、深色下看不清' },
      { title: '覆盖范围', line: '每个画面的五个区块 × 十条检查，每格写证据，只写「一致」不算' }],
    draw: (beat, p) => {
      const checks = ['对齐', '间距', '字号', '颜色', '层级', '截断', '溢出', '状态', '空态', '深色'];
      if (beat === 0) {
        const y = lerp(40, 250, p);
        return <g><Page x={90} y={40} w={260} h={210} />
          <rect x={86} y={y - 2} width={268} height={4} className="mx-scan" />
          <rect x={86} y={40} width={268} height={Math.max(0, y - 40)} className="mx-scan-soft" />
          {checks.map((c, i) => <g key={c} transform={`translate(400 ${46 + i * 21})`}><text x={22} y={5} className="mx-small">V-{String(i + 1).padStart(2, '0')} {c}</text>
            <Tick x={6} y={0} k={seg(p, i / 10, i / 10 + .08)} /></g>)}</g>;
      }
      if (beat === 1) {
        const k = seg(p, .1, .45);
        return <g><Page x={90} y={40} w={260} h={210} shift={6} />
          <circle cx={lerp(220, 220, k)} cy={130} r={lerp(0, 64, k)} className="mx-lens" />
          <g opacity={seg(p, .4, .6)}><line x1={150} y1={40 + 210 * .38} x2={290} y2={40 + 210 * .38} className="mx-guide" />
            <line x1={150} y1={40 + 210 * .19 + 27} x2={290} y2={40 + 210 * .19 + 27} className="mx-guide" /></g>
          <g opacity={seg(p, .6, .85)}><Pill x={400} y={100} w={190} text="V-01 对齐：右移 6 像素" tone="bad" />
            <text x={400} y={146} className="mx-small">证据：主按钮左边 x=148，</text><text x={400} y={166} className="mx-small">标题左边 x=142</text></g></g>;
      }
      const blocks = ['页头', '导航', '内容', '表格', '弹窗'];
      return <g>{blocks.map((b, j) => <text key={b} x={130} y={86 + j * 36} textAnchor="end" className="mx-small">{b}</text>)}
        {checks.map((c, i) => <text key={c} x={156 + i * 42} y={56} textAnchor="middle" className="mx-small">{c}</text>)}
        {blocks.flatMap((_, j) => checks.map((__, i) => { const n = j * 10 + i; const on = seg(p, n / 56, n / 56 + .06); const bad = n === 21 || n === 36;
          return <rect key={n} x={140 + i * 42} y={70 + j * 36} width={32} height={24} rx={4} className={bad ? 'mx-bad-soft' : 'mx-ok-soft'} opacity={on} />; }))}
        <g opacity={seg(p, .9, 1)}><text x={320} y={270} textAnchor="middle" className="mx-label">50 格，2 格有问题 → 要修</text></g></g>;
    },
  },
  mece: {
    beats: [{ title: '原理', line: '把风险按六个维度分开，一个维度一个格子' },
      { title: '作用', line: '每个风险找一条证明它的验收；找不到的就是漏项，标红' },
      { title: '覆盖范围', line: '六个维度不重不漏；没覆盖的要补一条，或写明为什么不需要' }],
    draw: (beat, p) => {
      const dims = ['正确性', '兼容性', '性能容量', '安全合规', '运维部署', '用户体验'];
      const cx = 220, cy = 150, step = Math.PI * 2 / 6, start = -Math.PI / 2;
      const ring = dims.map((d, i) => { const a0 = start + i * step + .03, a1 = start + (i + 1) * step - .03; const mid = (a0 + a1) / 2;
        const show = beat === 0 ? seg(p, i / 7, i / 7 + .15) : 1;
        const gap = i === 4 && beat === 1 && p > .55; const fixed = i === 4 && beat === 2;
        return <g key={d} opacity={show}><path d={arc(cx, cy, 58, 108, a0, a1)} className={gap ? 'mx-bad-soft' : fixed ? 'mx-ok-soft' : beat > 0 ? 'mx-ok-soft' : 'mx-soft'} />
          <text x={cx + 132 * Math.cos(mid)} y={cy + 132 * Math.sin(mid) + 4} textAnchor="middle" className="mx-small">{d}</text></g>; });
      const dots = [0, 1, 1, 2, 3, 5, 5, 4].map((d, i) => { const a = start + (d + .3 + (i % 2) * .4) * step; const k = beat === 1 ? seg(p, i / 10, i / 10 + .25) : beat === 2 ? 1 : 0;
        return <circle key={i} cx={lerp(560, cx + 84 * Math.cos(a), k)} cy={lerp(60 + i * 24, cy + 84 * Math.sin(a), k)} r={6} className={d === 4 && beat === 1 ? 'mx-bad-fill' : 'mx-ok-fill'} opacity={beat === 0 ? 0 : 1} />; });
      return <g>{ring}{dots}
        <text x={cx} y={cy - 4} textAnchor="middle" className="mx-big">{beat === 0 ? '6' : '8'}</text>
        <text x={cx} y={cy + 16} textAnchor="middle" className="mx-small">{beat === 0 ? '个维度' : '个风险'}</text>
        {beat === 1 && <g opacity={seg(p, .6, .8)}><Pill x={420} y={220} w={180} text="漏项：运维部署 R-OPS-1" tone="bad" /></g>}
        {beat === 2 && <g opacity={seg(p, .1, .4)}><Pill x={420} y={110} w={180} text="补冒烟 S-6 → 覆盖" tone="ok" />
          <text x={420} y={160} className="mx-small">8 个风险 · 0 漏项</text><text x={420} y={180} className="mx-small">不需要的写理由</text></g>}</g>;
    },
  },
  regress: {
    beats: [{ title: '原理', line: '缺陷、工单、线上吐槽里出现过的问题，收进一张易错清单' },
      { title: '作用', line: '以后每一版都按这张清单查一遍，同一个问题不出现第二次' },
      { title: '覆盖范围', line: '出现过一次就永久检查；清单只增不减，除非功能下线' }],
    draw: (beat, p) => {
      const src = [['缺陷', '手机按钮点不到'], ['工单', '深色下看不清'], ['吐槽', '刷新就白屏']];
      const box = <g><rect x={400} y={70} width={190} height={170} rx={10} className="mx-paper" /><text x={495} y={95} textAnchor="middle" className="mx-label">易错清单</text></g>;
      if (beat === 0) return <g>{box}{src.map(([tag, text], i) => { const k = seg(p, i * .25, i * .25 + .35);
        return <g key={tag} transform={`translate(${lerp(40, 412, k)} ${lerp(60 + i * 70, 110 + i * 36, k)})`}>
          <rect width={166} height={28} rx={6} className={k > .98 ? 'mx-ok-soft' : 'mx-block'} /><text x={8} y={18} className="mx-small">{tag} · {text}</text></g>; })}</g>;
      if (beat === 1) return <g>{box}{src.map(([tag, text], i) => <g key={tag} transform={`translate(412 ${110 + i * 36})`}><rect width={166} height={28} rx={6} className="mx-ok-soft" /><text x={8} y={18} className="mx-small">{tag} · {text}</text></g>)}
        {['V18', 'V19', 'V20'].map((v, i) => { const k = seg(p, i * .25, i * .25 + .4);
          return <g key={v} transform={`translate(${lerp(20, 300, k)} ${120 + i * 40})`}><Pill x={0} y={0} w={60} text={v} tone="accent" />{k > .95 && <Tick x={78} y={12} />}</g>; })}
        <line x1={380} y1={60} x2={380} y2={250} className="mx-guide" /></g>;
      const n = Math.round(lerp(3, 12, seg(p, 0, .8)));
      return <g>{box}{Array.from({ length: Math.min(n, 9) }, (_, i) => <rect key={i} x={412} y={106 + i * 14} width={166} height={10} rx={3} className="mx-ok-soft" />)}
        <text x={200} y={140} textAnchor="middle" className="mx-big">{n}</text><text x={200} y={166} textAnchor="middle" className="mx-small">条，每版都查</text></g>;
    },
  },
  flow: {
    beats: [{ title: '原理', line: '按角色把关键任务从头走到尾，每一步写操作和预期' },
      { title: '作用', line: '每一步对照预期和实际；有一步对不上，流程就不通过' },
      { title: '覆盖范围', line: '三个角色各自的关键流程：设计方出稿、实现方交付、评审人签收' }],
    draw: (beat, p) => {
      const steps = ['打开稿件', '绑定画面', '运行验收', '签收'];
      const xs = steps.map((_, i) => 110 + i * 140);
      if (beat < 2) {
        const pos = beat === 0 ? lerp(xs[0], xs[3], seg(p, .05, .9)) : xs[3];
        return <g><line x1={xs[0]} y1={110} x2={xs[3]} y2={110} className="mx-track" />
          {steps.map((s, i) => <g key={s}><circle cx={xs[i]} cy={110} r={16} className="mx-soft" /><text x={xs[i]} y={115} textAnchor="middle" className="mx-small">{i + 1}</text>
            <text x={xs[i]} y={150} textAnchor="middle" className="mx-label">{s}</text>
            {beat === 1 && <g opacity={seg(p, i * .2, i * .2 + .2)}><text x={xs[i]} y={186} textAnchor="middle" className="mx-small">预期通过</text>
              <text x={xs[i]} y={206} textAnchor="middle" className="mx-small">实际</text><Tick x={xs[i]} y={230} ok={i !== 2} /></g>}</g>)}
          {beat === 0 && <g transform={`translate(${pos} 70)`}><circle r={14} className="mx-accent" /><text y={5} textAnchor="middle" className="mx-on">人</text></g>}
          {beat === 1 && <g opacity={seg(p, .8, 1)}><text x={320} y={275} textAnchor="middle" className="mx-label">第 3 步对不上 → 流程不通过</text></g>}</g>;
      }
      const lanes = [['设计方', '出稿 → 门禁 → 发布'], ['实现方', '实现 → 补证据 → 提交'], ['评审人', '检查 → 评论 → 签收']];
      return <g>{lanes.map(([who, what], j) => { const y = 70 + j * 70; const k = seg(p, j * .2, j * .2 + .5);
        return <g key={who}><text x={100} y={y + 5} textAnchor="end" className="mx-label">{who}</text><line x1={120} y1={y} x2={580} y2={y} className="mx-track" />
          <circle cx={lerp(120, 580, k)} cy={y} r={9} className="mx-accent" /><text x={350} y={y + 26} textAnchor="middle" className="mx-small">{what}</text></g>; })}</g>;
    },
  },
  human: {
    beats: [{ title: '原理', line: '程序判不了的，由人按清单一条条看：操作、预期、执行人、时间' },
      { title: '作用', line: '桌面和手机都看，好不好用、读不读得懂，写下看到了什么' },
      { title: '覆盖范围', line: '只覆盖程序测不了的项；有权成员签收，签了才算' }],
    draw: (beat, p) => {
      const items = ['打开稿件就是画面', '右栏五项读得懂', '对照图能看清差异', '停用要写理由', '手机能横向滑动'];
      if (beat === 0) return <g>{items.map((it, i) => { const k = seg(p, i * .18, i * .18 + .12);
        return <g key={it} transform={`translate(170 ${60 + i * 40})`}><rect width={22} height={22} rx={4} className="mx-soft" /><Tick x={11} y={11} k={k} /><text x={36} y={16} className="mx-label">{it}</text></g>; })}
        <text x={470} y={240} className="mx-small">执行人 周叙 · 11-25</text></g>;
      if (beat === 1) return <g><rect x={90} y={50} width={260} height={170} rx={8} className="mx-paper" /><rect x={90} y={50} width={260} height={18} rx={8} className="mx-bar" />
        <rect x={430} y={40} width={100} height={190} rx={14} className="mx-paper" /><rect x={470} y={48} width={20} height={4} rx={2} className="mx-bar" />
        <text x={220} y={245} textAnchor="middle" className="mx-small">桌面浅色 / 深色</text><text x={480} y={250} textAnchor="middle" className="mx-small">手机浅色 / 深色</text>
        <Tick x={220} y={135} k={seg(p, .2, .4)} /><Tick x={480} y={135} k={seg(p, .5, .7)} /></g>;
      const k = seg(p, .15, .45);
      return <g>{items.map((it, i) => <g key={it} transform={`translate(110 ${60 + i * 40})`}><Tick x={11} y={11} /><text x={30} y={16} className="mx-label">{it}</text></g>)}
        <g transform={`translate(470 150) rotate(-12) scale(${lerp(2.2, 1, k)})`} opacity={k}><rect x={-70} y={-30} width={140} height={60} rx={8} className="mx-stamp" /><text y={10} textAnchor="middle" className="mx-stamp-text">签收</text></g>
        <text x={470} y={250} textAnchor="middle" className="mx-small" opacity={seg(p, .5, .7)}>有权成员 林岚</text></g>;
    },
  },
  smoke: {
    beats: [{ title: '原理', line: '每次部署后先打开关键页面、调关键接口，看能不能用' },
      { title: '作用', line: '基本功能坏了就先停下，后面的验收不用白做' },
      { title: '覆盖范围', line: '关键页面和接口；几分钟跑完，每次部署都跑' }],
    draw: (beat, p) => {
      const apis = ['GET /design', 'GET /runs', 'POST /evidence', 'GET /artifacts'];
      const page = <Page x={60} y={70} w={170} h={130} />;
      return <g>{page}{apis.map((a, i) => { const y = 66 + i * 46; const travel = beat === 0 ? seg(p, i * .2, i * .2 + .3) : 1;
        const bad = beat === 1 && i === 2 && p > .3; const tone = beat === 0 ? (travel > .98 ? 'ok' : 'line') : bad ? 'bad' : 'ok';
        return <g key={a}><line x1={230} y1={135} x2={400} y2={y + 12} className="mx-track" />
          {beat === 0 && travel < .98 && <circle cx={lerp(230, 400, travel)} cy={lerp(135, y + 12, travel)} r={5} className="mx-accent" />}
          <Pill x={400} y={y} w={140} text={bad ? `${a} · 500` : a} tone={tone} /></g>; })}
        {beat === 1 && <g opacity={seg(p, .45, .65)}><Pill x={150} y={240} w={260} text="冒烟不过：后面的验收先停" tone="bad" /></g>}
        {beat === 2 && <g opacity={seg(p, .1, .4)}><circle cx={590} cy={250} r={22} className="mx-soft" /><path d={`M590 250 L590 ${232} M590 250 L${590 + 14 * Math.sin(p * 6.28)} ${250 - 14 * Math.cos(p * 6.28)}`} className="mx-hand" />
          <text x={540} y={256} textAnchor="end" className="mx-small">4 个接口 · 2 分钟</text></g>}</g>;
    },
  },
  debt: {
    beats: [{ title: '原理', line: '暂时没法测量的验收项，不假装通过，记成验收债务' },
      { title: '作用', line: '每笔债写负责人、到期日和怎么还，到期自动提醒' },
      { title: '覆盖范围', line: '所有没有测量方法、或被停用的验收；每版看债是变多还是变少' }],
    draw: (beat, p) => {
      const ledger = <g><rect x={360} y={50} width={240} height={200} rx={10} className="mx-paper" /><text x={480} y={76} textAnchor="middle" className="mx-label">验收债务</text></g>;
      if (beat === 0) { const k = seg(p, .25, .8);
        return <g>{ledger}<g transform={`translate(${lerp(60, 372, k)} ${lerp(120, 92, k)})`}><rect width={216} height={44} rx={6} className="mx-block" />
          <text x={10} y={18} className="mx-small">A-58 视觉验收标准</text><text x={10} y={35} className="mx-small">没有测量方法</text></g></g>; }
      if (beat === 1) return <g>{ledger}<rect x={372} y={92} width={216} height={lerp(44, 120, seg(p, .1, .5))} rx={6} className="mx-block" />
        <text x={382} y={110} className="mx-small">A-58 视觉验收标准</text>
        {['负责人：周叙', '到期：12-05', '怎么还：补测量脚本'].map((t, i) => <text key={t} x={382} y={136 + i * 22} className="mx-small" opacity={seg(p, .4 + i * .15, .55 + i * .15)}>{t}</text>)}</g>;
      const vals = [6, 5, 3, 2]; return <g>{vals.map((v, i) => { const h = v * 26 * seg(p, i * .15, i * .15 + .3);
        return <g key={i}><rect x={160 + i * 90} y={240 - h} width={50} height={h} rx={4} className={i === 3 ? 'mx-ok-fill' : 'mx-accent'} /><text x={185 + i * 90} y={262} textAnchor="middle" className="mx-small">V{18 + i}</text></g>; })}
        <text x={320} y={50} textAnchor="middle" className="mx-label" opacity={seg(p, .7, .9)}>债越来越少</text></g>;
    },
  },
};
