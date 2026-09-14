/**
 * 验收首页第一屏的紧凑条（2026-09-14，落 B 稿）。
 *
 * 上一版紧凑态是把厂房剖面整个缩小：一张小示意图浮在一大片空卡片中间，
 * 屏越宽越难看，用户原话「这个设计可以吗，我看这个完全是看不明白」。
 * 根子是隐喻本身——厂房要占半屏、带标签才读得懂，缩到几百像素又按「少字」
 * 把标签隐去，等于把唯一的解释也拿掉了。
 *
 * 这一版换成「大数字领衔 + 微型图形」：
 *   改动总量 → 拆成三段（没起预览 / 待验收 / 已验完）→ 结论三档 → 项目分布 → 场外报告
 * 数字在任何尺寸下都读得准，图形只做补充，所以不怕宽屏也不怕数据少。
 *
 * 三条纪律：
 * 1. **每段点阵共用同一个分母**（都是 changes 个格子，点亮各自那几个），
 *    所以三段的比例可以直接对看，不需要图例。
 * 2. **点子尺寸随条数分档**：5 条时是 20px 的大方块，71 条时是 5px 的细点。
 *    数据少的时候格子变大而不是画面变空——上一版最大的毛病就在这里。
 * 3. 颜色一律走 token 且 `hsl()` 包裹（token 是 HSL 三元组，裸写整条属性静默失效）。
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PipelineOverview, PipelineProjectRow } from '@/lib/api';

/* ============================ 动效 ============================
   基础样式一律是终态，动画整体关在 prefers-reduced-motion: no-preference 里，
   且只有容器带 data-play="1" 才跑。reduce 用户、没有 IntersectionObserver、
   CSS 没加载，看到的都是完整静态图，不会出现「元素停在 opacity:0」那种空白。 */

/** 这台机器该不该动。reduce 偏好、或者没有 IntersectionObserver，都按不动处理。 */
function canAnimate(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof IntersectionObserver !== 'function') return false;
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 「这一屏该开始动了」沿组件树往下传。
 *
 * 默认 true：任何没被 Provider 包住的用法（测试直接渲染、将来别处复用）都按
 * 「立刻显示终值」处理 —— 数字停在 0 是错数，比没有动效严重得多。
 */
const PlayCtx = createContext(true);

/** 错峰延迟：写进 CSS 自定义属性 --d，动画规则统一读它。 */
function d(ms: number): React.CSSProperties {
  return { '--d': `${Math.max(0, Math.round(ms))}ms` } as React.CSSProperties;
}

function useInViewPlay(): {
  ref: React.RefObject<HTMLDivElement>;
  play: boolean;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [play, setPlay] = useState(false);
  useEffect(() => {
    if (!canAnimate()) {
      setPlay(true);
      return undefined;
    }
    const el = ref.current;
    if (!el) {
      setPlay(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setPlay(true);
        io.disconnect();
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    // 兜底：进不了视口（阈值没够 / 观察器不触发）也要在 1.2s 后放行。
    // 不放行的代价不是「没动效」而是「CountText 停在 0」——那是错数，不许发生。
    const t = window.setTimeout(() => {
      setPlay(true);
      io.disconnect();
    }, 1200);
    return () => {
      window.clearTimeout(t);
      io.disconnect();
    };
  }, []);
  return { ref, play };
}

/**
 * 会从 0 涨到 n 的数字。
 *
 * 初值就是 n（终态），挂载后才在能动的前提下压回 0 —— 反过来写（初值 0）的话，
 * 一旦 play 因为任何原因没来，屏幕上就是个理直气壮的错数。
 */
function CountText({ n, ...rest }: { n: number } & React.HTMLAttributes<HTMLSpanElement>): JSX.Element {
  const play = useContext(PlayCtx);
  const [v, setV] = useState(n);
  useLayoutEffect(() => {
    if (canAnimate()) setV(0);
  }, []);
  useEffect(() => {
    if (!play) return undefined;
    if (!canAnimate()) {
      setV(n);
      return undefined;
    }
    const t0 = performance.now();
    const dur = 760;
    let raf = requestAnimationFrame(function step(now: number) {
      const p = Math.min(1, (now - t0) / dur);
      setV(Math.round(n * (1 - (1 - p) ** 3)));
      if (p < 1) raf = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(raf);
  }, [play, n]);
  return <span {...rest}>{v}</span>;
}

export interface CompactStripProps {
  pipeline: PipelineOverview;
  /** 三段拆分，与放大态共用同一套现推口径。 */
  split: { accepted: number; heap: number; undeployed: number };
  orphan: number;
  reclaimed: number;
  onOpenProject: (projectId: string) => void;
  /** 项目垛的悬浮内容，与放大态共用。 */
  projectTip: (p: PipelineProjectRow) => string;
}

export const EXPAND_CSS = `
/* 放大态：与紧凑条同一套语言（数字 + 分段条 + 点阵），不再切换成另一种隐喻。
   之前放大态是厂房剖面，两套视觉摆在同一页上，读者要在两种编码之间来回翻译。 */
.ex{display:flex;flex-direction:column;gap:14px;}
.ex table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;}
.ex th{padding:0 0 8px;text-align:left;font-size:11px;font-weight:400;letter-spacing:.12em;
  color:hsl(var(--muted-foreground));border-bottom:1px solid hsl(var(--hairline));white-space:nowrap;}
.ex th.n,.ex td.n{text-align:right;}
.ex td{padding:9px 0;border-bottom:1px solid hsl(var(--hairline));vertical-align:middle;}
.ex tr.row{cursor:pointer;}
.ex tr.row:hover td,.ex tr.row:focus-visible td{background:hsl(var(--surface-base));}
.ex .pname{font-size:13px;font-weight:600;padding-right:16px;white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis;max-width:220px;}
.ex .off{margin-left:8px;font-size:11px;font-weight:400;color:hsl(var(--muted-foreground));}
.ex .barcell{width:60%;padding-right:16px;}
.ex .seg{display:flex;gap:1px;height:14px;width:100%;border-radius:2px;overflow:hidden;
  background:hsl(var(--surface-sunken));}
.ex .seg span{display:block;height:100%;}
.ex .e1{background:hsl(var(--hairline-strong));}
.ex .e2{background:hsl(var(--muted-foreground));}
.ex .e3{background:hsl(var(--foreground));}
.ex .num{font-size:14px;font-weight:600;padding-left:14px;white-space:nowrap;}
.ex .num.mute{color:hsl(var(--hairline-strong));}
.ex .when{font-size:12px;color:hsl(var(--muted-foreground));padding-left:14px;white-space:nowrap;}
.ex .outside{display:flex;flex-wrap:wrap;gap:28px;padding-top:2px;}
.ex .obox{display:flex;align-items:baseline;gap:8px;min-width:0;}
.ex .olab{font-size:11px;letter-spacing:.12em;color:hsl(var(--muted-foreground));white-space:nowrap;}
.ex .onum{font-size:19px;font-weight:600;}
.ex .odots{display:flex;flex-wrap:wrap;gap:2px;align-content:center;max-width:420px;}
.ex .odots i{display:block;width:5px;height:5px;border-radius:1px;background:hsl(var(--hairline-strong));}
`;

export const STRIP_CSS = `
.cs{display:flex;flex-direction:column;gap:16px;border-radius:12px;
  border:1px solid hsl(var(--hairline));background:hsl(var(--card));
  padding:16px 18px;font-variant-numeric:tabular-nums;}
@media (min-width:1024px){
  .cs{flex-direction:row;align-items:stretch;justify-content:space-between;gap:20px;
    height:176px;padding:16px 22px;overflow:hidden;}
}

.cs .z{display:flex;min-width:0;flex-direction:column;justify-content:flex-start;}
.cs .z > :last-child{margin-top:auto;}
.cs .vr{display:none;}
@media (min-width:1024px){
  .cs .vr{display:block;flex:0 0 1px;align-self:stretch;background:hsl(var(--hairline));}
}

.cs .pad{height:10px;flex:0 0 auto;}
.cs .eyebrow{font-size:11px;line-height:13px;letter-spacing:.12em;white-space:nowrap;
  color:hsl(var(--muted-foreground));}
.cs .eyebrow b{font-weight:600;letter-spacing:0;color:hsl(var(--foreground));}

.cs .num{font-weight:600;letter-spacing:-.02em;line-height:1;}
.cs .numbox{height:64px;display:flex;align-items:flex-end;}
.cs .num-xl{font-size:64px;}
.cs .num-l{font-size:40px;}
.cs .t1{color:hsl(var(--hairline-strong));}
.cs .t2{color:hsl(var(--muted-foreground));}
.cs .t3{color:hsl(var(--foreground));}

.cs .z-total{flex:1 1 124px;max-width:180px;}
.cs .rail{display:flex;gap:1px;height:10px;width:100%;}
.cs .rail span{display:block;height:100%;}
.cs .f1{background:hsl(var(--hairline-strong));}
.cs .f2{background:hsl(var(--muted-foreground));}
.cs .f3{background:hsl(var(--foreground));}

.cs .z-stages{flex:1.4 1 432px;max-width:666px;margin-left:-2px;}
.cs .bracket{height:10px;flex:0 0 10px;margin-left:-20px;border-bottom:1px solid hsl(var(--hairline));}
.cs .stagerow{display:flex;gap:18px;width:100%;flex:1 1 auto;align-items:stretch;}
.cs .stage{position:relative;display:flex;min-width:0;flex:1 1 0;flex-direction:column;
  justify-content:space-between;}
.cs .stage .tick{position:absolute;top:-6px;left:0;width:1px;height:6px;background:hsl(var(--hairline));}
.cs .field{display:flex;flex-wrap:wrap;gap:var(--dg);align-content:flex-end;width:100%;overflow:hidden;}
.cs .d{display:block;width:var(--dot);height:var(--dot);border-radius:1px;
  background:hsl(var(--surface-sunken));}
/* 点亮态必须写在 .d 之后：同特异性时后写的赢，写在前面会被上面那条底色整条盖掉，
   于是三段点阵全是浅灰、一个都不亮——页面照常渲染，没有任何报错
   （predicate-and-wiring-discipline 形状 6：生效的不是你以为的那条）。 */
.cs .d.f1{background:hsl(var(--hairline-strong));}
.cs .d.f2{background:hsl(var(--muted-foreground));}
.cs .d.f3{background:hsl(var(--foreground));}
.cs .d.v-ok{background:hsl(var(--ok));}
.cs .d.v-warn{background:hsl(var(--warn));}
.cs .d.v-bad{background:hsl(var(--bad));}

.cs .z-verdict{flex:1 1 140px;max-width:250px;}
.cs .vlist{display:flex;flex-direction:column;gap:7px;}
.cs .vrow{display:flex;align-items:center;gap:7px;}
.cs .chip{flex:0 0 8px;height:8px;border-radius:2px;}
.cs .vlab{flex:0 0 52px;font-size:11px;white-space:nowrap;color:hsl(var(--muted-foreground));}
.cs .vbarw{flex:1 1 auto;min-width:20px;height:8px;border-radius:2px;overflow:hidden;
  background:hsl(var(--surface-sunken));}
.cs .vbar{display:block;height:100%;}
.cs .vnum{flex:0 0 16px;text-align:right;font-size:15px;font-weight:600;}
.cs .c-ok{background:hsl(var(--ok));}
.cs .c-warn{background:hsl(var(--warn));}
.cs .c-bad{background:hsl(var(--bad));}
.cs .n-ok{color:hsl(var(--ok));}
.cs .n-warn{color:hsl(var(--warn));}
.cs .n-bad{color:hsl(var(--bad));}
.cs .n-zero{color:hsl(var(--hairline-strong));}

.cs .z-proj{flex:4 1 300px;min-width:240px;max-width:990px;}
.cs .lead{display:flex;align-items:baseline;gap:8px;margin-top:5px;}
.cs .lead b{font-size:13px;font-weight:600;}
.cs .lead span{font-size:13px;color:hsl(var(--muted-foreground));}
.cs .barrow{display:flex;align-items:flex-end;gap:4px;height:92px;margin-top:5px;
  border-bottom:1px solid hsl(var(--hairline-strong));}
.cs .bar{display:flex;min-width:0;align-items:flex-end;cursor:pointer;}
.cs .track{position:relative;display:block;width:100%;height:92px;overflow:hidden;
  border:1px solid hsl(var(--hairline));border-bottom:none;border-radius:2px 2px 0 0;
  background:hsl(var(--surface-base));}
.cs .track.empty{background:transparent;border-left:1px dotted hsl(var(--hairline-strong));
  border-right:1px dotted hsl(var(--hairline-strong));}
.cs .fill{position:absolute;left:0;right:0;bottom:0;background:hsl(var(--foreground));}
.cs .bar:hover .track,.cs .bar:focus-visible .track{border-color:hsl(var(--foreground));}

.cs .z-side{flex:1 1 106px;max-width:190px;}
.cs .slist{display:flex;flex-direction:column;gap:11px;}
.cs .srow{display:grid;grid-template-columns:auto 1fr;column-gap:8px;row-gap:4px;align-items:baseline;}
.cs .slab{font-size:11px;color:hsl(var(--muted-foreground));}
.cs .snum{font-size:19px;font-weight:600;text-align:right;}
.cs .sbarw{grid-column:1 / -1;height:4px;border-radius:2px;overflow:hidden;
  background:hsl(var(--surface-sunken));}
.cs .sbar{display:block;height:100%;background:hsl(var(--hairline-strong));}

@media (prefers-reduced-motion: no-preference){
  .cs[data-play="1"] .d{animation:cs-dot .26s ease-out backwards;animation-delay:var(--d,0ms);}
  .cs[data-play="1"] .rail span,.cs[data-play="1"] .vbar,.cs[data-play="1"] .sbar{
    animation:cs-growx .52s cubic-bezier(.2,.7,.3,1) backwards;transform-origin:left center;}
  .cs[data-play="1"] .fill{animation:cs-growy .52s cubic-bezier(.2,.7,.3,1) backwards;
    animation-delay:.18s;transform-origin:center bottom;}
}
@keyframes cs-dot{from{opacity:0;transform:scale(.35);}}
@keyframes cs-growx{from{transform:scaleX(0);}}
@keyframes cs-growy{from{transform:scaleY(0);}}

@media (max-width:1340px) and (min-width:1024px){
  .cs{gap:15px;padding:16px 18px;}
  .cs .stagerow{gap:14px;}
  .cs .z-stages{flex:1.4 1 354px;}
  .cs .bracket{margin-left:-15px;}
  .cs .num-xl{font-size:56px;}
  .cs .numbox{height:56px;}
}
`;

/**
 * 点子尺寸随条数分档。
 *
 * 不做「按容器宽高实算」是有意的：容器宽度由 flex 在运行时决定，CSS 算不出来，
 * 要算就得上 ResizeObserver，为一排小方块引一套测量循环不划算。分档表的效果
 * 一样达到了目的——5 条时每格 20px，71 条时 5px，数据少的时候格子变大。
 */
export function dotMetrics(total: number): {
  dot: number;
  gap: number;
  height: number;
} {
  const n = Math.max(0, Math.floor(total));
  if (n <= 8) return { dot: 20, gap: 3, height: 20 };
  if (n <= 24) return { dot: 12, gap: 2, height: 26 };
  if (n <= 60) return { dot: 7, gap: 2, height: 27 };
  if (n <= 140) return { dot: 5, gap: 2, height: 33 };
  if (n <= 320) return { dot: 4, gap: 1, height: 35 };
  return { dot: 3, gap: 1, height: 36 };
}

/**
 * 一段的点阵：分母恒为总量，点亮自己那几个，其余留成底色。
 *
 * `lit` 是逐点的 class，不是一个统一色——「已验完」那段要按三档结论分色，
 * 整段一个色的话，屏幕上的彩色就只剩结论那三行小条，整块看着发灰。
 */
function Field({ total, lit }: { total: number; lit: string[] }): JSX.Element {
  const m = dotMetrics(total);
  const n = Math.max(0, Math.floor(total));
  return (
    <div
      className="field"
      style={{
        ['--dot' as string]: `${m.dot}px`,
        ['--dg' as string]: `${m.gap}px`,
        height: m.height,
      }}
    >
      {Array.from({ length: n }, (_, i) => (
        <i key={i} className={i < lit.length ? `d ${lit[i]}` : 'd'} style={d(i * 6)} />
      ))}
    </div>
  );
}

function Stage({
  label,
  n,
  total,
  tone,
  lit,
  hint,
}: {
  label: string;
  n: number;
  total: number;
  tone: string;
  lit: string[];
  hint: string;
}): JSX.Element {
  return (
    <div className="stage" data-tip={hint}>
      <div className="tick" />
      <div className="eyebrow">{label}</div>
      <div className="numbox">
        <CountText className={`num num-l ${tone === 'f1' ? 't1' : tone === 'f2' ? 't2' : 't3'}`} n={n} />
      </div>
      <Field total={total} lit={lit} />
    </div>
  );
}

export function CompactStrip({
  pipeline,
  split,
  orphan,
  reclaimed,
  onOpenProject,
  projectTip,
}: CompactStripProps): JSX.Element {
  const t = pipeline.total;
  const changes = Math.max(0, t.changes);
  const verdicts = [
    { key: 'ok', label: '通过', n: Math.max(0, t.pass) },
    { key: 'warn', label: '原则通过', n: Math.max(0, t.conditional) },
    { key: 'bad', label: '未通过', n: Math.max(0, t.fail) },
  ];
  const vMax = Math.max(1, ...verdicts.map((v) => v.n));
  // 已验完那段按三档结论分色，剩下的（有报告但结论字段为空）留中性深色。
  // 这是唯一一处能把彩色带进主体又不编造数据的地方——三档计数聚合里本来就有。
  const acceptedLit = [
    ...Array<string>(Math.max(0, t.pass)).fill('v-ok'),
    ...Array<string>(Math.max(0, t.conditional)).fill('v-warn'),
    ...Array<string>(Math.max(0, t.fail)).fill('v-bad'),
  ].slice(0, split.accepted);
  while (acceptedLit.length < split.accepted) acceptedLit.push('f3');
  const projects = pipeline.projects;
  const lead = projects[0];
  const sideMax = Math.max(1, orphan, reclaimed);
  const { ref, play } = useInViewPlay();

  return (
    <PlayCtx.Provider value={play}>
      <div className="cs" ref={ref} data-play={play ? '1' : '0'}>
        <div className="z z-total" data-tip={`在途与最近撤下的分支\n共 ${changes} 条`}>
          <div className="pad" />
          <div className="eyebrow">改动</div>
          <div className="numbox">
            <CountText className="num num-xl" n={changes} />
          </div>
          <div className="rail">
            <span className="f1" style={{ flex: `${split.undeployed} 0 0`, minWidth: 3 }} />
            <span className="f2" style={{ flex: `${split.heap} 0 0`, minWidth: 3 }} />
            <span className="f3" style={{ flex: `${split.accepted} 0 0`, minWidth: 3 }} />
          </div>
        </div>

        <div className="z z-stages">
          <div className="bracket" />
          <div className="stagerow">
            <Stage
              label="没起预览"
              n={split.undeployed}
              total={changes}
              tone="f1"
              lit={Array<string>(split.undeployed).fill('f1')}
              hint={`还没起预览的改动\n${split.undeployed} 条\n连部署这一步都没到`}
            />
            <Stage
              label="待验收"
              n={split.heap}
              total={changes}
              tone="f2"
              lit={Array<string>(split.heap).fill('f2')}
              hint={`已部署、还没人验的改动\n${split.heap} 条`}
            />
            <Stage
              label="已验完"
              n={split.accepted}
              total={changes}
              tone="f3"
              lit={acceptedLit}
              hint={`跑过验收并归了档的改动\n${split.accepted} 条\n按结论分色：通过 ${t.pass} · 原则通过 ${t.conditional} · 未通过 ${t.fail}`}
            />
          </div>
        </div>

        <div className="vr" />

        <div className="z z-verdict">
          <div className="pad" />
          <div className="eyebrow">结论</div>
          <div className="vlist">
            {verdicts.map((v) => (
              <div className="vrow" key={v.key} data-tip={`${v.label}\n${v.n} 条改动验完判了这一档`}>
                <span className={`chip c-${v.key}`} />
                <span className="vlab">{v.label}</span>
                <span className="vbarw">
                  <span className={`vbar c-${v.key}`} style={{ width: `${(v.n / vMax) * 100}%` }} />
                </span>
                <span className={`vnum ${v.n ? `n-${v.key}` : 'n-zero'}`}>{v.n}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="vr" />

        <div className="z z-proj">
          <div className="pad" />
          <div className="eyebrow">
            项目 <b>{projects.length}</b>
          </div>
          <div className="lead">
            {lead ? (
              <>
                <b>{lead.projectName}</b>
                <span>{Math.max(0, lead.funnel.changes)}</span>
              </>
            ) : (
              <span>还没有项目</span>
            )}
          </div>
          {/* 宽 ∝ 改动数、底部填充 ∝ 验过比例，于是留白面积正好等于欠验的量。 */}
          <div className="barrow">
            {projects.map((p) => {
              const ch = Math.max(0, p.funnel.changes);
              const acc = Math.max(0, Math.min(ch, p.funnel.accepted));
              return (
                <div
                  key={p.projectId}
                  className="bar"
                  role="button"
                  tabIndex={0}
                  style={{ flex: ch > 0 ? `${ch} 1 8px` : '0 0 8px' }}
                  data-tip={projectTip(p)}
                  onClick={() => onOpenProject(p.projectId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenProject(p.projectId);
                    }
                  }}
                >
                  <span className={ch > 0 ? 'track' : 'track empty'}>
                    {ch > 0 ? <span className="fill" style={{ height: `${(acc / ch) * 100}%` }} /> : null}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="vr" />

        <div className="z z-side">
          <div className="pad" />
          <div className="eyebrow">报告</div>
          <div className="slist">
            <div
              className="srow"
              data-tip={`报告没记它验的是谁\n${orphan} 份\n没有 branch / commit / PR，挂不上任何改动`}
            >
              <span className="slab">无主</span>
              <span className="snum">{orphan}</span>
              <span className="sbarw">
                <span className="sbar" style={{ width: `${(orphan / sideMax) * 100}%` }} />
              </span>
            </div>
            <div className="srow" data-tip={`对应分支已被 CDS 回收\n${reclaimed} 份\n无从核对，是常态不是漏`}>
              <span className="slab">已回收</span>
              <span className="snum">{reclaimed}</span>
              <span className="sbarw">
                <span className="sbar" style={{ width: `${(reclaimed / sideMax) * 100}%` }} />
              </span>
            </div>
          </div>
        </div>
      </div>
    </PlayCtx.Provider>
  );
}

export interface ExpandedPanelProps {
  pipeline: PipelineOverview;
  orphan: number;
  reclaimed: number;
  onOpenProject: (projectId: string) => void;
  projectTip: (p: PipelineProjectRow) => string;
}

/** 一行项目的三段：与总览同一套拆法，口径不另开一套。 */
export function rowSplit(f: PipelineProjectRow['funnel']): {
  undeployed: number;
  heap: number;
  accepted: number;
} {
  const changes = Math.max(0, f.changes);
  const deployed = Math.max(0, Math.min(changes, f.deployed));
  const accepted = Math.max(0, Math.min(deployed, f.accepted));
  return {
    undeployed: changes - deployed,
    heap: deployed - accepted,
    accepted,
  };
}

/**
 * 放大态：项目明细表 + 场外报告。
 *
 * 每行一个项目，横条按「没起预览 / 待验收 / 已验完」分段，宽度正比于条数——
 * 和上面那条总览用的是同一套编码，所以不需要重新学一遍怎么读。
 */
export function ExpandedPanel({
  pipeline,
  orphan,
  reclaimed,
  onOpenProject,
  projectTip,
}: ExpandedPanelProps): JSX.Element {
  const maxCh = Math.max(1, ...pipeline.projects.map((p) => Math.max(0, p.funnel.changes)));
  return (
    <div className="ex">
      <table>
        <thead>
          <tr>
            <th>项目</th>
            <th>没起预览 / 待验收 / 已验完</th>
            <th className="n">改动</th>
            <th className="n">验过</th>
            <th className="n">最近</th>
          </tr>
        </thead>
        <tbody>
          {pipeline.projects.map((p) => {
            const sp = rowSplit(p.funnel);
            const ch = Math.max(0, p.funnel.changes);
            return (
              <tr
                key={p.projectId}
                className="row"
                tabIndex={0}
                data-tip={projectTip(p)}
                onClick={() => onOpenProject(p.projectId)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onOpenProject(p.projectId);
                  }
                }}
              >
                <td className="pname">
                  {p.projectName}
                  {p.githubLinked ? null : <span className="off">未接</span>}
                </td>
                {/* 条长按该项目占最大项目的比例，所以行与行之间可以横向对看。 */}
                <td className="barcell">
                  <div className="seg" style={{ width: `${(ch / maxCh) * 100}%` }}>
                    <span className="e1" style={{ flex: `${sp.undeployed} 0 0` }} />
                    <span className="e2" style={{ flex: `${sp.heap} 0 0` }} />
                    <span className="e3" style={{ flex: `${sp.accepted} 0 0` }} />
                  </div>
                </td>
                <td className="n">
                  <span className={ch ? 'num' : 'num mute'}>{ch}</span>
                </td>
                <td className="n">
                  <span className={sp.accepted ? 'num' : 'num mute'}>{sp.accepted}</span>
                </td>
                <td className="n">
                  <span className="when">{p.lastActivityAt ? p.lastActivityAt.slice(5, 10) : '无'}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="outside">
        <div
          className="obox"
          data-tip={`报告没记它验的是谁\n${orphan} 份\n没有 branch / commit / PR，挂不上任何改动`}
        >
          <span className="olab">无主</span>
          <span className="onum">{orphan}</span>
          <span className="odots">
            {Array.from({ length: Math.min(orphan, 120) }, (_, i) => (
              <i key={i} />
            ))}
          </span>
        </div>
        <div className="obox" data-tip={`对应分支已被 CDS 回收\n${reclaimed} 份\n无从核对，是常态不是漏`}>
          <span className="olab">已回收</span>
          <span className="onum">{reclaimed}</span>
          <span className="odots">
            {Array.from({ length: Math.min(reclaimed, 120) }, (_, i) => (
              <i key={i} />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}
