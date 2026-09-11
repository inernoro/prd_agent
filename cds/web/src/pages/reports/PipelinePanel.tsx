/**
 * 验收报告首页第一屏 —— `/reports` 不选项目时的跨项目总览（2026-09-10，落 G 稿）。
 *
 * G 稿是空间隐喻：一间厂房的剖面。一条改动 = 一只货箱，箱子走传送带过三道闸。
 *
 *   入料溜槽（改动总量）→ 带面缺口（掉下去的＝未部署）→ 部署闸
 *   → 验收闸前的货堆（未验收）→ 验收闸 → 三个料仓（通过 / 原则性通过 / 未通过）
 *   → 合并闸（斜纹面板＝无数据，不是零）
 *
 * 三条纪律，改这个文件前先读：
 *
 * 1. **闸门不承载数据**。闸板落差 BLADE=34 是固定结构件，三道闸画法一致。
 *    「多少过去了、多少没过去」全部由实体承载：缺口里的箱数、货堆的体量、料仓里的箱数。
 *    唯一例外是合并闸的斜纹面板——它表示「这一环无数据」这个状态（分支墓碑未接入），
 *    不是比例、更不是零。
 *
 * 2. **缺口 + 货堆 + 料仓三处箱数相加恒等于入口总量**。三段一律由 changes / deployed /
 *    accepted 现推（见 `splitChanges`），看得出来也算得出来。
 *
 * 3. **屏幕上只有极短标签与数字**。不加解释性句子——文字方案已被三次否决。
 *    颜色全部走 CDS token 且必须 `hsl(var(--x))` 包裹：token 是 HSL 三元组，
 *    裸写 `var(--x)` 会让整条属性静默失效（`.claude/rules/cds-theme-tokens.md` 第 0 条）。
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { buildPipelineHeadline } from '@/lib/pipelineHeadline';
import type { PipelineFunnel, PipelineOverview, PipelineProjectRow } from '@/lib/api';

export interface PipelinePanelProps {
  pipeline: PipelineOverview;
  onOpenProject: (projectId: string) => void;
}

/* ============================ 样式：只管 SVG 里的面 / 线 / 字 ============================
   变量本身不在这里定义——直接吃 cds/web/src/index.css 全局 :root 与 [data-theme] 的同名
   token，白天/黑夜自动翻转。明暗序两套主题一致：
   货箱(surface-sunken) < 传送带(surface-base) < 卡片(card) < 钢构(hairline-strong)。 */
const SCENE_CSS = `
.pp-root .pp-scene{display:block;width:100%;height:auto;margin-inline:auto;}

.pp-root .f-none{fill:none;}
.pp-root .f-card{fill:hsl(var(--card));}
.pp-root .f-deck{fill:hsl(var(--surface-base));}
.pp-root .f-sunken{fill:hsl(var(--surface-sunken));}
.pp-root .f-crate{fill:hsl(var(--surface-sunken));}
.pp-root .f-hair{fill:hsl(var(--hairline));}
.pp-root .f-hairstrong{fill:hsl(var(--hairline-strong));}
.pp-root .f-steel{fill:hsl(var(--hairline-strong));}
.pp-root .f-steel-d{fill:hsl(var(--muted-foreground));}
.pp-root .f-ok{fill:hsl(var(--ok));}
.pp-root .f-warn{fill:hsl(var(--warn));}
.pp-root .f-bad{fill:hsl(var(--bad));}

.pp-root .s-hair{stroke:hsl(var(--hairline));stroke-width:1;}
.pp-root .s-hairstrong{stroke:hsl(var(--hairline-strong));stroke-width:1;}
.pp-root .s-hairstrong-w6{stroke:hsl(var(--hairline-strong));stroke-width:6;fill:none;stroke-linejoin:round;}
.pp-root .s-hairstrong-d{stroke:hsl(var(--hairline-strong));stroke-width:1.5;stroke-dasharray:5 4;}
.pp-root .s-fence{stroke:hsl(var(--hairline));stroke-width:2;stroke-dasharray:2 7;stroke-linecap:round;}

.pp-root .t-huge{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:calc(46px * var(--ts,1));font-weight:700;
  fill:hsl(var(--foreground));letter-spacing:-.02em;}
.pp-root .t-num{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:calc(26px * var(--ts,1));font-weight:700;
  fill:hsl(var(--foreground));}
.pp-root .t-lab{font-size:calc(15px * var(--ts,1));font-weight:600;letter-spacing:.18em;fill:hsl(var(--muted-foreground));}
.pp-root .t-name{font-size:calc(12px * var(--ts,1));fill:hsl(var(--foreground));}
.pp-root .t-tag{font-size:calc(11px * var(--ts,1));letter-spacing:.1em;fill:hsl(var(--muted-foreground));}
.pp-root .t-mut{fill:hsl(var(--hairline-strong));}
.pp-root .t-ok{fill:hsl(var(--ok));}
.pp-root .t-warn{fill:hsl(var(--warn));}
.pp-root .t-bad{fill:hsl(var(--bad));}

/* 背景：锯齿天窗 + 桁架柱 + 地面。厂房的剪影得有个壳才立得住——
   没有壳的时候，图上就是几个形状浮在白底上，看不出这是一个「地方」。
   一律走 hairline，只做衬托，不跟货箱抢。 */
.pp-root .s-bg{stroke:hsl(var(--hairline));stroke-width:1.5;fill:none;stroke-linejoin:round;}
.pp-root .s-bg-thin{stroke:hsl(var(--hairline));stroke-width:1;fill:none;}
.pp-root .f-ground{fill:hsl(var(--hairline) / 0.4);}

/* 紧凑态：只留剪影。图缩到这么小时字号补偿会把标签撑得比闸门还宽，
   而该说的话已经由上面那句判断说了。 */
.pp-root .pp-mini text{display:none;}

.pp-root .g-hit{cursor:pointer;outline:none;}
.pp-root rect[data-tip]:hover,.pp-root circle[data-tip]:hover,.pp-root polygon[data-tip]:hover{
  stroke:hsl(var(--foreground));stroke-width:1.5;}
.pp-root .pp-tip{position:fixed;z-index:60;pointer-events:none;max-width:300px;
  padding:9px 11px;border-radius:8px;border:1px solid hsl(var(--hairline-strong));
  background:hsl(var(--card));color:hsl(var(--foreground));
  box-shadow:0 10px 28px hsl(var(--foreground) / 0.14);}
.pp-root .pp-tip-h{font-size:13px;font-weight:600;line-height:1.5;word-break:break-all;}
.pp-root .pp-tip-l{font-size:12px;line-height:1.6;color:hsl(var(--muted-foreground));word-break:break-all;}
.pp-root .g-hit:hover .t-name,.pp-root .g-hit:focus-visible .t-name{text-decoration:underline;}

/* ---------------------------- 动效 ----------------------------
   只演画面上已有的东西，不为动效新增任何形状：箱子一层层摞到闸前、掉下去的那只
   真的往下掉、过了闸的几条落进料仓、垛一根根垒起来、场外的点一颗颗散开。
   常驻的只有滚轮那一转，说明这条线还在跑。

   三条兜底（缺一就会变成静默失效，见 predicate-and-wiring-discipline 形状 8）：
   1. 基础样式一律是终态（不写 opacity:0 / transform），动画整体关在
      prefers-reduced-motion: no-preference 里。所以 reduce 用户、动画没触发、
      甚至这段 CSS 整个没加载，看到的都是完整静态图，不会白一块。
   2. 只有祖先带 data-play="1" 才跑——由 Card 的 IntersectionObserver 置上，
      置不上（无 IO / 一直没进视口）也只是不播。
   3. backwards 让延迟期间停在 from 态，否则错峰会先闪一下再退回去重播。
   （这段注释里不许出现反引号：整块 CSS 是模板字符串，一个反引号就把它截断了。） */
@media (prefers-reduced-motion: no-preference){
  .pp-root [data-play="1"] .pp-crate{animation:pp-crate-in .42s cubic-bezier(.2,.7,.3,1) backwards;animation-delay:var(--d,0ms);}
  .pp-root [data-play="1"] .pp-fall{animation:pp-fall-in .52s cubic-bezier(.45,.05,.55,1) backwards;animation-delay:var(--d,0ms);}
  .pp-root [data-play="1"] .pp-bin{animation:pp-bin-in .46s cubic-bezier(.45,.05,.55,1) backwards;animation-delay:var(--d,0ms);}
  .pp-root [data-play="1"] .pp-slab{animation:pp-slab-in .4s cubic-bezier(.2,.7,.3,1) backwards;animation-delay:var(--d,0ms);}
  .pp-root [data-play="1"] .pp-bar{animation:pp-bar-in .4s cubic-bezier(.2,.7,.3,1) backwards;animation-delay:var(--d,0ms);
    transform-box:fill-box;transform-origin:left center;}
  .pp-root [data-play="1"] .pp-dot{animation:pp-dot-in .3s ease-out backwards;animation-delay:var(--d,0ms);}
  .pp-root [data-play="1"] .pp-lab{animation:pp-lab-in .52s ease-out backwards;animation-delay:var(--d,0ms);}
  .pp-root .pp-spoke{animation:pp-roll 6s linear infinite;transform-box:fill-box;transform-origin:center;}
  .pp-root .pp-chute{animation:pp-chute 2.6s linear infinite;}
}
@keyframes pp-crate-in{from{opacity:0;transform:translateY(9px);}}
@keyframes pp-fall-in{from{opacity:0;transform:translateY(-46px);}}
@keyframes pp-bin-in{from{opacity:0;transform:translateY(-104px);}}
@keyframes pp-slab-in{from{opacity:0;transform:translateY(7px);}}
@keyframes pp-bar-in{from{opacity:0;transform:scaleX(.15);}}
@keyframes pp-dot-in{from{opacity:0;}}
@keyframes pp-lab-in{from{opacity:0;transform:translateY(6px);}}
@keyframes pp-roll{to{transform:rotate(360deg);}}
@keyframes pp-chute{to{transform:translate(var(--cdx,0px),var(--cdy,0px));}}
`;

/* ============================ 几何常量（照稿，勿改） ============================ */
const DECK_T = 356;
const DECK_B = 372;
const FLOOR = 470;
const BLADE = 34; // 闸板固定落差：结构件，不编码数据
const HEAP_RISE = 156; // 货堆想顶到的高度：门洞净空由它反推，堆矮门洞就矮

const BIN_TOP = 392;
const BIN_W = 96;

const YARD_GY = 430;
const YARD_PITCH = 132;
const YARD_BW = 84;

/* 窄屏（<1024px）纵向流水的几何。货箱与文字尺寸不变，只换向与换行。 */
const M_W = 360;
const M_BELT_X = 300;
const M_BELT_W = 16;
const M_BELT_R = M_BELT_X + M_BELT_W;
const M_ROLL_CX = M_BELT_R + 9;
const M_OPEN = 120;
const M_GATE_NEAR = M_BELT_R + 16;
const M_GATE_FAR = M_GATE_NEAR - M_OPEN;
const M_LINTEL_X = M_GATE_FAR - 16;
const M_BELT_TOP = 140;
const M_G1Y = 196;
const M_GAP_Y = 236;
const M_GAP_H = 64;
const M_SHAFT_LEN = 114;
const M_HEAP_TOP_MIN = 372;
const M_BIN_W = 84;
const M_BIN_CX = [62, 152, 242];

type Tone = 'ok' | 'warn' | 'bad';

/* ============================ 动效驱动 ============================
   CSS 那边负责「怎么动」，这里只负责「什么时候开始动」与「数字怎么涨」。
   两者共用一个开关：Card 上的 data-play。 */

/** 这台机器该不该动。reduce 偏好、或者没有 IntersectionObserver，都按不动处理。 */
function canAnimate(): boolean {
  if (typeof window === 'undefined') return false;
  if (typeof IntersectionObserver !== 'function') return false;
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 图在卡片里显示多大。
 *
 * viewBox 已经随数据变宽变窄了，但光靠它图不会变小——SVG 宽度撑满时，
 * viewBox 越窄内容反而被放得越大，于是「只有三只箱子」的那张图会被放成
 * 一整屏。所以这里按内容量给一个显示宽度上限：数据多就铺满卡片，
 * 数据少就整张图连同高度一起收下去，卡片不再是个装着一点点东西的大盒子。
 */
/**
 * 图缩到多小。
 *
 * 幂次而不是线性：显示高度 = k x vbH，线性收的那点 k 压不下高度，
 * 图还是一张占满半屏的大盒子。0.35 次方让小图明显小一圈，又不至于缩成邮票。
 */
export function sceneScale(vbW: number): number {
  return Math.max(0.45, 0.88 * Math.min(1, vbW / 1440) ** 0.35);
}

export function sceneMaxPx(vbW: number): number {
  return Math.round(vbW * sceneScale(vbW));
}

/**
 * 图的显示宽度 + 字号反向补偿。
 *
 * 整张 SVG 缩小时里面的字会一起缩——一个项目的堆场缩到六成，项目名就只剩 7px，
 * 谁也看不清。所以把缩放的倒数交给 CSS，文字尺寸乘上它，显示出来的字号
 * 跟图缩没缩没有关系。信息少的那张图于是变成「图形小、字照常」，
 * 而不是整块一起糊掉。
 */
export function sceneWidth(vbW: number): React.CSSProperties {
  const k = sceneScale(vbW);
  return { maxWidth: `${sceneMaxPx(vbW)}px`, '--ts': (1 / k).toFixed(3) } as React.CSSProperties;
}

/* ============================ 悬浮提示 ============================
   一只箱子＝一条改动，可是光看图不知道是哪一条。提示走**事件委托**：
   元素只挂一个 data-tip 字符串（换行用 \n），pp-root 上统一接 mouseover /
   mousemove / mouseout。65 只箱子各绑三个闭包是没必要的开销。 */

/** 把几行文字编成 data-tip。空行自动丢掉，省得调用方到处写条件。 */
export function tip(...lines: Array<string | false | null | undefined>): string {
  return lines.filter((l): l is string => Boolean(l)).join('\n');
}

interface TipState {
  x: number;
  y: number;
  lines: string[];
}

function useTipDelegate(): {
  tipState: TipState | null;
  handlers: {
    onMouseOver: (e: React.MouseEvent) => void;
    onMouseMove: (e: React.MouseEvent) => void;
    onMouseOut: (e: React.MouseEvent) => void;
  };
} {
  const [tipState, setTipState] = useState<TipState | null>(null);
  const read = (e: React.MouseEvent): string | null => {
    const el = e.target as Element | null;
    // SVG 元素在旧一点的引擎里没有 closest，兜一手。
    const hit = el && typeof el.closest === 'function' ? el.closest('[data-tip]') : null;
    return hit ? hit.getAttribute('data-tip') : null;
  };
  return {
    tipState,
    handlers: {
      onMouseOver: (e) => {
        const raw = read(e);
        setTipState(raw ? { x: e.clientX, y: e.clientY, lines: raw.split('\n') } : null);
      },
      onMouseMove: (e) => {
        const raw = read(e);
        setTipState(raw ? { x: e.clientX, y: e.clientY, lines: raw.split('\n') } : null);
      },
      onMouseOut: () => setTipState(null),
    },
  };
}

/** 跟着鼠标走的提示框。贴到视口边缘就翻到另一侧，不让它被裁掉。 */
function TipBox({ state }: { state: TipState }): JSX.Element {
  const W = 300;
  const H = 26 * state.lines.length + 20;
  const vw = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 900 : window.innerHeight;
  const left = state.x + 16 + W > vw ? Math.max(8, state.x - 16 - W) : state.x + 16;
  const top = state.y + 18 + H > vh ? Math.max(8, state.y - 18 - H) : state.y + 18;
  return (
    <div className="pp-tip" style={{ left, top }}>
      <div className="pp-tip-h">{state.lines[0]}</div>
      {state.lines.slice(1).map((l, i) => (
        <div key={i} className="pp-tip-l">
          {l}
        </div>
      ))}
    </div>
  );
}

/** 错峰延迟：写进 CSS 自定义属性 --d，动画规则统一读它。 */
function d(ms: number): React.CSSProperties {
  return { '--d': `${Math.max(0, Math.round(ms))}ms` } as React.CSSProperties;
}

/** 卡片是否已经播过。播一次就不再播，滚上滚下不会反复重演。 */
const PlayCtx = createContext(false);

function useInViewPlay(): { ref: React.RefObject<HTMLDivElement>; play: boolean } {
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
function CountText({
  n,
  ...rest
}: { n: number } & React.SVGProps<SVGTextElement>): JSX.Element {
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
  return <text {...rest}>{v}</text>;
}


/**
 * 把漏斗基数拆成分流图的三段。
 *
 * 刻意**不用** `leaks['deployed-not-accepted']` 那个桶：它排除了「合并了没验」那一类，
 * 等分支墓碑数据接进来（当前全库 merged=0，因为聚合还没接），桶里的数会小于真实的
 * 「已部署未验收」，分流图就加不回总数、凭空少几个方块，而且今天两者恰好相等、
 * 明天才静默错位——最难查的那种。用基数现推则恒等成立：
 *   accepted + (deployed - accepted) + (changes - deployed) === changes
 */
export function splitChanges(f: PipelineFunnel): { accepted: number; heap: number; undeployed: number } {
  return {
    accepted: Math.max(0, f.accepted),
    heap: Math.max(0, f.deployed - f.accepted),
    undeployed: Math.max(0, f.changes - f.deployed),
  };
}

/** 货堆分行：底层最宽，逐层收窄，靠闸门一侧对齐。行数与箱数都由数据决定。 */
export function mound(n: number, rowMax: number): number[] {
  const rows: number[] = [];
  let rem = Math.max(0, Math.floor(n));
  let w = Math.min(rowMax, rem);
  while (rem > 0 && w > 0) {
    const t = Math.min(w, rem);
    rows.push(t);
    rem -= t;
    w = Math.max(2, w - 1);
  }
  return rows;
}

export interface CrateScale {
  /** 单只货箱的宽高与行列间距。 */
  cw: number;
  ch: number;
  gx: number;
  gy: number;
  /** 每行箱数，底层在前。 */
  rows: number[];
  /** 整堆占地。 */
  w: number;
  h: number;
}

/**
 * 货箱尺寸由数量反算，而不是写死。
 *
 * 写死 16x12 的后果两头都难看：71 条时 65 只箱子缩在角落、占不到带面一成，
 * 屏幕上最大的一块反倒是空的；5 条时又是三只小箱吊在一整条空带上。
 * 两种毛病看着相反，根子是同一个——**画布尺寸与数据量没有关系**。
 *
 * 所以这里让堆自己决定要多大地方：先按数量定行列（宽扁优于高塔），
 * 再让堆高去顶满给定的净空，横向放不下时才回头压箱子。上下限是有的——
 * 箱子再大也不能变成巨石（一只箱＝一条改动的质感就没了），再小也得看得见。
 * 少量数据时箱子顶到上限、堆仍然小，那时候该缩的是画布本身，不是继续吹箱子。
 */
export function crateScale(
  n: number,
  opt: { span: number; rise: number; min?: number; max?: number; maxRows?: number },
): CrateScale {
  const min = opt.min ?? 10;
  const max = opt.max ?? 34;
  const maxRows = opt.maxRows ?? 6;
  const count = Math.max(0, Math.floor(n));
  if (count === 0) return { cw: min, ch: min * 0.75, gx: min + 2, gy: min * 0.75 + 2, rows: [], w: 0, h: 0 };

  // 先定行数再定列数，而不是反过来。
  //
  // 关键是**行数要封顶**：堆高被门洞净空锁着，行数一多，每只箱子就得变小才塞得下,
  // 于是「120 条的堆反而比 65 条的窄」——越多越挤，完全反直觉。封顶之后数量增长
  // 只能往横里长，堆才会随数据一起变宽。堆的意思本来也是「排着队」，不是「垒成墙」。
  const perMin = min + 2;
  // 从这个行数起步，往上找**让箱子最大**的那一档。
  //
  // 光封顶行数还不够：数量再往上涨，宽度先顶到带面尽头，这时候还按原行数排，
  // 就只能把箱子越压越扁——300 条的堆比 120 条的还矮，画布下半截白白空着。
  // 所以顶格之后要让它往上多堆几行，把高度那一维也用掉。cw 关于行数是单峰的，
  // 过了峰就停，不必搜到底。
  const from = Math.min(maxRows, Math.max(1, Math.round(Math.sqrt(count * 0.55))));
  const to = Math.max(maxRows, 20);
  let best: { rows: number[]; cw: number } | null = null;
  for (let R = from; R <= to; R += 1) {
    // 每行比上一行少一只，R 行装得下 count 只所需要的首行宽度。
    let cols = Math.ceil((count + (R * (R - 1)) / 2) / R);
    // 横向真放不下时才回头砍列数——宁可堆高一点，也不让它戳出带面。
    if (cols * perMin > opt.span) cols = Math.max(1, Math.floor(opt.span / perMin));
    const rows = mound(count, cols);
    const byHeight = (opt.rise / rows.length - 2) * (4 / 3);
    const byWidth = opt.span / rows[0] - 2;
    const cw = Math.min(max, Math.max(min, Math.min(byHeight, byWidth)));
    if (!best || cw > best.cw + 1e-9) best = { rows, cw };
    if (best.cw >= max - 1e-9) break;
    if (cw < best.cw - 1e-9) break;
  }
  const rows = best!.rows;
  const r = rows.length;
  const cw = best!.cw;
  const ch = cw * 0.75;
  const gx = cw + 2;
  const gy = ch + 2;
  return { cw, ch, gx, gy, rows, w: rows[0] * gx, h: r * gy };
}

/** 一垛的箱序：验过的那几条按结论着色排在底部，其余是未验的素箱。 */
function stackSeq(f: PipelineFunnel): Array<Tone | 'crate'> {
  const ok = Math.max(0, f.pass);
  const warn = Math.max(0, f.conditional);
  const bad = Math.max(0, f.fail);
  const rest = Math.max(0, f.changes - ok - warn - bad);
  return [
    ...Array<Tone>(ok).fill('ok'),
    ...Array<Tone>(warn).fill('warn'),
    ...Array<Tone>(bad).fill('bad'),
    ...Array<'crate'>(rest).fill('crate'),
  ];
}

/** 目测宽度：中日韩全角按 12px、其余按 6.8px 估，用来决定项目名折不折行。 */
function textWidth(s: string): number {
  let w = 0;
  for (const c of s) w += /[⺀-鿿＀-￯　-〿]/.test(c) ? 12 : 6.8;
  return w;
}

/** 项目名折行：优先在最靠中间的空格断开，最多两行，超出截断。稿件不臆造名字，这里也不改写。 */
function wrapName(name: string, budget = 110): string[] {
  const s = name.trim();
  if (!s) return [''];
  if (textWidth(s) <= budget) return [s];
  const mid = Math.floor(s.length / 2);
  let cut = -1;
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === ' ') {
      const d = Math.abs(i - mid);
      if (d < best) {
        best = d;
        cut = i;
      }
    }
  }
  let head: string;
  let tail: string;
  if (cut > 0) {
    head = s.slice(0, cut);
    tail = s.slice(cut + 1);
  } else {
    let i = 0;
    let w = 0;
    while (i < s.length && w + textWidth(s[i]) <= budget) {
      w += textWidth(s[i]);
      i += 1;
    }
    head = s.slice(0, Math.max(1, i));
    tail = s.slice(Math.max(1, i));
  }
  if (textWidth(tail) > budget) {
    let i = 0;
    let w = 0;
    while (i < tail.length && w + textWidth(tail[i]) <= budget - 12) {
      w += textWidth(tail[i]);
      i += 1;
    }
    tail = `${tail.slice(0, Math.max(1, i))}…`;
  }
  return [head, tail];
}

/* ============================ 图案定义（斜纹 / 肋纹） ============================ */
function SceneDefs(): JSX.Element {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        <pattern id="pp-rib" width="8" height="8" patternUnits="userSpaceOnUse">
          <rect width="8" height="8" className="f-steel" />
          <rect y="6" width="8" height="2" className="f-steel-d" />
        </pattern>
        <pattern id="pp-nodata" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="10" height="10" className="f-card" />
          <rect width="4" height="10" className="f-hair" />
        </pattern>
      </defs>
    </svg>
  );
}

/* ============================ 宽屏：横向厂房剖面 ============================ */

/** 厂房的壳：锯齿天窗在上、桁架柱贯通、地面压底。纯装饰，不编码任何数据。 */
function HallShell({ top, width }: { top: number; width: number }): JSX.Element {
  const roofV = top + 30;
  const roofP = top + 6;
  const teeth: string[] = [];
  for (let x = 0; x < width; x += 104) {
    teeth.push(`M${x} ${roofV} L${x} ${roofP} L${Math.min(width, x + 104)} ${roofV}`);
  }
  const columns: number[] = [];
  for (let x = 118; x < width - 40; x += 268) columns.push(x);
  return (
    <g aria-hidden="true">
      <path d={teeth.join(' ')} className="s-bg" />
      <line x1={0} y1={roofV} x2={width} y2={roofV} className="s-bg" />
      {columns.map((x) => (
        <line key={x} x1={x} y1={roofV} x2={x} y2={FLOOR} className="s-bg-thin" />
      ))}
      <rect x={0} y={FLOOR + 4} width={width} height={7} className="f-ground" />
    </g>
  );
}

/**
 * 闸门＝固定结构件。开合程度不表示任何数据，三道闸画法一致。
 * 门楣高度由货堆决定（堆矮门洞就矮，整张图跟着矮下来），闸板落差 BLADE 恒定。
 */
function GateH({
  cx,
  label,
  lintel,
  nodata,
  hint,
}: { cx: number; label: string; lintel: number; nodata?: boolean; hint: string }): JSX.Element {
  const lp = cx - 24;
  const rp = cx + 12;
  const sx = lp + 12;
  const sw = rp - lp - 12;
  return (
    <g data-tip={hint}>
      <rect x={lp - 4} y={lintel - 16} width={rp + 12 - (lp - 4)} height={16} className="f-steel" />
      <rect x={lp} y={lintel} width={12} height={DECK_T - lintel} className="f-steel" />
      <rect x={rp} y={lintel} width={12} height={DECK_T - lintel} className="f-steel" />
      {nodata ? (
        <rect x={sx} y={lintel} width={sw} height={DECK_T - lintel} fill="url(#pp-nodata)" className="s-hairstrong-d" />
      ) : (
        <>
          <rect x={sx} y={lintel} width={sw} height={BLADE} fill="url(#pp-rib)" />
          <rect x={sx - 3} y={lintel + BLADE - 5} width={sw + 6} height={5} className="f-steel-d" />
        </>
      )}
      <text x={cx - 6} y={lintel - 28} className="t-lab" textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

function BeltH({ x1, x2 }: { x1: number; x2: number }): JSX.Element {
  const rollers: number[] = [];
  for (let x = x1 + 22; x < x2 - 10; x += 44) rollers.push(x);
  return (
    <g>
      <rect x={x1} y={DECK_T} width={x2 - x1} height={DECK_B - DECK_T} className="f-deck s-hair" />
      {rollers.map((x) => (
        <g key={x}>
          <circle cx={x} cy={DECK_B + 9} r={8} className="f-none s-hairstrong" />
          {/* 辐条画成斜的而不是水平：水平线的包围盒高度为 0，fill-box 下的旋转中心就没法算。 */}
          <line
            x1={x - 4.2}
            y1={DECK_B + 9 - 4.2}
            x2={x + 4.2}
            y2={DECK_B + 9 + 4.2}
            className="s-hairstrong pp-spoke"
          />
        </g>
      ))}
    </g>
  );
}

/**
 * 宽屏厂房的横向分段。**每一段的宽度都由它装的东西决定**，累加出总宽——
 * 这是把写死坐标改掉的整个理由：坐标写死时，71 条改动的货堆只占带面一成，
 * 5 条改动又是三只小箱吊在一整条空带上，两头都难看。
 *
 * 门洞高度同理跟着货堆走：堆矮，门洞就矮，整张图跟着矮下来，卡片不再是
 * 一个固定的大盒子装着一点点东西。
 */
export function hallLayoutWide(f: PipelineFunnel) {
  const { heap, undeployed } = splitChanges(f);
  const sc = crateScale(heap, { span: 760, rise: HEAP_RISE, min: 11, max: 34, maxRows: 6 });
  const openH = Math.min(232, Math.max(104, sc.h + 26));
  const lintel = DECK_T - openH;
  const chuteTop = lintel + 14;
  const gate1 = 336;
  const heapL = gate1 + 44;
  const heapR = heapL + Math.max(sc.w, 56);
  const gate2 = heapR + 44;
  const binCx = [gate2 + 92, gate2 + 212, gate2 + 332];
  const gate3 = gate2 + 440;
  const top = lintel - 92;
  return {
    heap,
    undeployed,
    sc,
    lintel,
    chuteTop,
    gate1,
    heapL,
    heapR,
    gate2,
    binCx,
    gate3,
    top,
    vbW: gate3 + 96,
    vbH: FLOOR + 78 - top,
  };
}

function HallWide({ f, heapTips }: { f: PipelineFunnel; heapTips: string[] }): JSX.Element {
  const L = hallLayoutWide(f);
  const { sc } = L;
  const bins: Array<{ cx: number; label: string; n: number; tone: Tone; hint: string }> = [
    { cx: L.binCx[0], label: '通过', n: Math.max(0, f.pass), tone: 'ok', hint: tip('通过', `${Math.max(0, f.pass)} 条改动验完判了通过`) },
    { cx: L.binCx[1], label: '原则性', n: Math.max(0, f.conditional), tone: 'warn', hint: tip('原则性通过', `${Math.max(0, f.conditional)} 条改动有保留地放行`) },
    { cx: L.binCx[2], label: '未通过', n: Math.max(0, f.fail), tone: 'bad', hint: tip('未通过', `${Math.max(0, f.fail)} 条改动验完判了不通过`) },
  ];
  const chuteTip = tip('入料口', `${Math.max(0, f.changes)} 条改动`, '在途分支与最近撤下的分支');
  const undeployedTip = tip('还没起预览的改动', `${L.undeployed} 条`, '连部署闸都没到');
  const heapFallback = tip('未验收的改动', `${L.heap} 条`, '已部署，还没人验');
  // 货堆按行画，提示按扁平序号取——两边都要稳定，错一位就张冠李戴。
  const rowOffset: number[] = [];
  sc.rows.reduce((acc, n) => {
    rowOffset.push(acc);
    return acc + n;
  }, 0);

  // 溜槽：上口在门楣下方，下口落在带面上，整体向右倾。里面的料沿槽向下流。
  const chuteRun = DECK_T - L.chuteTop;
  const chute = { tl: 24, tr: 140, bl: 92, br: 208 };
  const slide = { dx: (chute.bl - chute.tl) * (sc.gy / Math.max(1, chuteRun)), dy: sc.gy };
  // 槽里的料量跟着总量走：5 条改动配一整槽满料，读起来像「料很多」，
  // 那就又是一处与数据无关的装饰。满槽对应 60 条上下，少了就只铺薄薄一层。
  const feedRows = Math.max(1, Math.ceil((chuteRun / sc.gy + 2) * Math.min(1, f.changes / 60)));
  const feed: Array<{ x: number; y: number }> = [];
  // 多铺一行在最上面：动画每轮向下挪一个行距，没有这一行补位，顶上会空出一条缝，
  // 循环回原点时整槽料会「跳」一下。
  for (let i = 0; i <= feedRows; i += 1) {
    const y = DECK_T - sc.gy * (i + 1);
    for (let x = chute.tl; x < chute.br; x += sc.gx) feed.push({ x, y });
  }

  return (
    <svg
      className="pp-scene"
      viewBox={`0 ${L.top} ${L.vbW} ${L.vbH}`}
      style={sceneWidth(L.vbW)}
      role="img"
      aria-label="验收流水线剖面"
    >
      <defs>
        <clipPath id="pp-chute-w">
          <polygon
            points={`${chute.tl},${L.chuteTop} ${chute.tr},${L.chuteTop} ${chute.br},${DECK_T} ${chute.bl},${DECK_T}`}
          />
        </clipPath>
      </defs>
      <HallShell top={L.top} width={L.vbW} />
      <rect x={0} y={FLOOR} width={L.vbW} height={4} className="f-hair" />

      {/* 入料溜槽：装着料，料在往下流。流量不是计数——总量写在旁边那个大数字上，
          三处计数（缺口 / 货堆 / 料仓）仍然只在带面这一侧，恒等关系不受影响。 */}
      <polygon
        points={`${chute.tl},${L.chuteTop} ${chute.tr},${L.chuteTop} ${chute.br},${DECK_T} ${chute.bl},${DECK_T}`}
        className="f-deck s-hair"
        data-tip={chuteTip}
      />
      <g clipPath="url(#pp-chute-w)" data-tip={chuteTip}>
        <g className="pp-chute" style={{ '--cdx': `${slide.dx}px`, '--cdy': `${slide.dy}px` } as React.CSSProperties}>
          {feed.map((c, i) => (
            <rect key={i} x={c.x} y={c.y} width={sc.cw} height={sc.ch} rx={1} className="f-crate s-hairstrong" />
          ))}
        </g>
      </g>
      <text x={82} y={L.lintel - 58} className="t-lab pp-lab" style={d(60)} textAnchor="middle">
        改动
      </text>
      <CountText x={82} y={L.lintel - 12} className="t-huge" textAnchor="middle" n={f.changes} />

      <BeltH x1={chute.bl} x2={224} />
      <BeltH x1={288} x2={L.vbW - 28} />

      {/* 传送带缺口：掉下去的就是「未部署」，箱数即数据 */}
      <rect x={224} y={DECK_T} width={64} height={FLOOR - DECK_T} className="f-sunken s-hair" data-tip={undeployedTip} />
      {Array.from({ length: L.undeployed }, (_, k) => {
        const y = FLOOR - 3 - (k + 1) * (sc.ch + 3);
        const rot = k % 2 === 0 ? -14 : 9;
        return (
          // 倾角留在 rect 的 transform 属性上，下落交给外层 g 的 CSS transform：
          // 两者写在同一个元素上，CSS 那个会把属性整条盖掉，箱子就摆正了。
          <g key={k} className="pp-fall" style={d(200 + k * 70)} data-tip={undeployedTip}>
            <rect
              x={256 - sc.cw / 2}
              y={y}
              width={sc.cw}
              height={sc.ch}
              rx={1.5}
              className="f-crate s-hairstrong"
              transform={`rotate(${rot} 256 ${y + sc.ch / 2})`}
            />
          </g>
        );
      })}
      <text x={256} y={FLOOR + 26} className="t-lab pp-lab" style={d(240)} textAnchor="middle">
        未部署
      </text>
      <text x={256} y={FLOOR + 58} className="t-num pp-lab" style={d(240)} textAnchor="middle">
        {L.undeployed}
      </text>

      <GateH cx={L.gate1} label="部署" lintel={L.lintel} hint={tip('部署闸', '改动起了预览才算过这道闸')} />

      {/* 货堆：排在验收闸前的队伍，一箱一条改动。尺寸随数量反算，堆高顶满门洞。 */}
      {sc.rows.map((n, i) =>
        Array.from({ length: n }, (_, k) => (
          <rect
            key={`${i}-${k}`}
            x={L.heapR - sc.gx * (k + 1) + 2}
            y={DECK_T - sc.ch - sc.gy * i}
            width={sc.cw}
            height={sc.ch}
            rx={1}
            className="f-crate s-hairstrong pp-crate"
            style={d(300 + i * 55 + k * 9)}
            data-tip={heapTips[rowOffset[i] + k] ?? heapFallback}
          />
        )),
      )}
      <text
        x={(L.heapL + L.heapR) / 2}
        y={FLOOR + 26}
        className="t-lab pp-lab"
        style={d(300)}
        textAnchor="middle"
      >
        未验收
      </text>
      {/* 与同一条基线上的其它数字同字号：46px 的大字会盖住上面那行标签，
          而且「未验收」的分量本来就由它上面那一大堆货箱承担，不靠字号。 */}
      <CountText
        x={(L.heapL + L.heapR) / 2}
        y={FLOOR + 58}
        className="t-num"
        textAnchor="middle"
        n={L.heap}
      />

      <GateH
        cx={L.gate2}
        label="验收"
        lintel={L.lintel}
        hint={tip('验收闸', '有人跑过验收、归了档才算过这道闸')}
      />

      {/* 三个料仓：过闸后按结论分装，仓内箱数即三档计数 */}
      {bins.map(({ cx, label, n, tone, hint }) => {
        const x0 = cx - BIN_W / 2;
        return (
          <g key={label} data-tip={hint}>
            <polygon
              points={`${cx - 20},${DECK_B} ${cx + 20},${DECK_B} ${x0 + BIN_W},${BIN_TOP} ${x0},${BIN_TOP}`}
              className="f-deck s-hair"
            />
            <path
              d={`M${x0} ${BIN_TOP} L${x0} ${FLOOR} L${x0 + BIN_W} ${FLOOR} L${x0 + BIN_W} ${BIN_TOP}`}
              className="f-none s-hairstrong-w6"
            />
            {Array.from({ length: n }, (_, k) => (
              <rect
                key={k}
                x={cx - 36}
                y={FLOOR - 6 - 16 * (k + 1)}
                width={72}
                height={14}
                rx={1}
                className={`f-${tone} pp-bin`}
                style={d(880 + k * 90)}
              />
            ))}
            <text x={cx} y={FLOOR + 26} className="t-lab pp-lab" style={d(880)} textAnchor="middle">
              {label}
            </text>
            <text
              x={cx}
              y={FLOOR + 58}
              className={n ? `t-num t-${tone} pp-lab` : 't-num t-mut pp-lab'}
              style={d(880)}
              textAnchor="middle"
            >
              {n}
            </text>
          </g>
        );
      })}

      <GateH
        cx={L.gate3}
        label="合并"
        lintel={L.lintel}
        nodata
        hint={tip('合并闸', '斜纹＝这一环没有数据', '分支墓碑还没接进聚合，不等于没有东西被合并')}
      />
      <text x={L.gate3 - 6} y={FLOOR + 26} className="t-lab pp-lab" style={d(1000)} textAnchor="middle">
        无数据
      </text>
    </svg>
  );
}

/* ============================ 窄屏：纵向流水 ============================ */

/** 同一道闸转 90 度：门楣在左、两根门柱横跨带面、闸板自左插入。落差仍是 34。 */
function GateV({
  cy,
  label,
  nodata,
  hint,
}: { cy: number; label: string; nodata?: boolean; hint: string }): JSX.Element {
  return (
    <g data-tip={hint}>
      <rect x={M_LINTEL_X} y={cy - 28} width={16} height={52} className="f-steel" />
      <rect x={M_GATE_FAR} y={cy - 24} width={M_OPEN} height={12} className="f-steel" />
      <rect x={M_GATE_FAR} y={cy + 12} width={M_OPEN} height={12} className="f-steel" />
      {nodata ? (
        <rect x={M_GATE_FAR} y={cy - 12} width={M_OPEN} height={24} fill="url(#pp-nodata)" className="s-hairstrong-d" />
      ) : (
        <>
          <rect x={M_GATE_FAR} y={cy - 12} width={BLADE} height={24} fill="url(#pp-rib)" />
          <rect x={M_GATE_FAR + BLADE - 5} y={cy - 15} width={5} height={30} className="f-steel-d" />
        </>
      )}
      <text x={M_LINTEL_X - 12} y={cy + 6} className="t-lab" textAnchor="end">
        {label}
      </text>
    </g>
  );
}

function BeltV({ y1, y2 }: { y1: number; y2: number }): JSX.Element {
  const rollers: number[] = [];
  for (let y = y1 + 22; y < y2 - 10; y += 44) rollers.push(y);
  return (
    <g>
      <rect x={M_BELT_X} y={y1} width={M_BELT_W} height={y2 - y1} className="f-deck s-hair" />
      {rollers.map((y) => (
        <circle key={y} cx={M_ROLL_CX} cy={y} r={8} className="f-none s-hairstrong" />
      ))}
    </g>
  );
}

function HallNarrow({ f, heapTips }: { f: PipelineFunnel; heapTips: string[] }): JSX.Element {
  const { heap, undeployed } = splitChanges(f);
  // 窄屏货箱同样反算尺寸，只是可铺开的宽度换成了带面左侧那 300 个单位。
  const sc = crateScale(heap, { span: 300, rise: 132, min: 10, max: 26, maxRows: 5 });
  const rows = sc.rows;
  const heapBase = M_HEAP_TOP_MIN + sc.gy * Math.max(0, rows.length - 1);
  const g2y = heapBase + 52;
  const spurT = g2y + 56;
  const deckB = spurT + 16;
  const binTop = spurT + 36;
  const floorM = spurT + 114;
  const g3y = floorM + 110;
  const height = g3y + 62;
  const shaftX = M_BELT_X - M_SHAFT_LEN;
  const lx = M_BELT_R - sc.gx * (rows[0] ?? 0) - 26;

  const spurRollers: number[] = [];
  for (let x = 16 + 22; x < M_BELT_R - 10; x += 44) spurRollers.push(x);

  const bins: Array<{ cx: number; label: string; n: number; tone: Tone; hint: string }> = [
    { cx: M_BIN_CX[0], label: '通过', n: Math.max(0, f.pass), tone: 'ok', hint: tip('通过', `${Math.max(0, f.pass)} 条改动验完判了通过`) },
    { cx: M_BIN_CX[1], label: '原则性', n: Math.max(0, f.conditional), tone: 'warn', hint: tip('原则性通过', `${Math.max(0, f.conditional)} 条改动有保留地放行`) },
    { cx: M_BIN_CX[2], label: '未通过', n: Math.max(0, f.fail), tone: 'bad', hint: tip('未通过', `${Math.max(0, f.fail)} 条改动验完判了不通过`) },
  ];
  const chuteTip = tip('入料口', `${Math.max(0, f.changes)} 条改动`, '在途分支与最近撤下的分支');
  const undeployedTip = tip('还没起预览的改动', `${undeployed} 条`, '连部署闸都没到');
  const heapFallback = tip('未验收的改动', `${heap} 条`, '已部署，还没人验');
  const rowOffset: number[] = [];
  rows.reduce((acc, n) => {
    rowOffset.push(acc);
    return acc + n;
  }, 0);

  return (
    <svg className="pp-scene" viewBox={`0 0 ${M_W} ${height}`} role="img" aria-label="验收流水线剖面">
      {/* 入料溜槽 + 总量 */}
      <polygon
        points={`150,44 150,114 ${M_BELT_R},${M_BELT_TOP} ${M_BELT_R},70`}
        className="f-deck s-hair"
        data-tip={chuteTip}
      />
      <text x={24} y={60} className="t-lab pp-lab" style={d(60)}>
        改动
      </text>
      <CountText x={24} y={108} className="t-huge" n={f.changes} />

      <BeltV y1={M_BELT_TOP} y2={M_GAP_Y} />
      <BeltV y1={M_GAP_Y + M_GAP_H} y2={height - 20} />

      {/* 带面缺口：掉出去的就是「未部署」 */}
      <rect
        x={shaftX}
        y={M_GAP_Y}
        width={M_SHAFT_LEN}
        height={M_GAP_H}
        className="f-sunken s-hair"
        data-tip={undeployedTip}
      />
      {Array.from({ length: undeployed }, (_, k) => {
        const x = shaftX + 3 + k * (sc.ch + 2);
        const rot = k % 2 === 0 ? -14 : 9;
        return (
          <g key={k} className="pp-fall" style={d(200 + k * 70)} data-tip={undeployedTip}>
            <rect
              x={x}
              y={M_GAP_Y + 20}
              width={sc.ch}
              height={sc.cw}
              rx={1.5}
              className="f-crate s-hairstrong"
              transform={`rotate(${rot} ${x + sc.ch / 2} ${M_GAP_Y + 20 + sc.cw / 2})`}
            />
          </g>
        );
      })}
      <text x={shaftX - 10} y={M_GAP_Y + 26} className="t-lab pp-lab" style={d(240)} textAnchor="end">
        未部署
      </text>
      <text x={shaftX - 10} y={M_GAP_Y + 58} className="t-num pp-lab" style={d(240)} textAnchor="end">
        {undeployed}
      </text>

      <GateV cy={M_G1Y} label="部署" hint={tip('部署闸', '改动起了预览才算过这道闸')} />

      {/* 货堆：行宽上限降到 6，货箱尺寸不变，只换行 */}
      {rows.map((n, i) =>
        Array.from({ length: n }, (_, k) => (
          <rect
            key={`${i}-${k}`}
            x={M_BELT_R - sc.gx * (k + 1) + 2}
            y={heapBase - sc.gy * i}
            width={sc.cw}
            height={sc.ch}
            rx={1}
            className="f-crate s-hairstrong pp-crate"
            style={d(300 + i * 55 + k * 9)}
            data-tip={heapTips[rowOffset[i] + k] ?? heapFallback}
          />
        )),
      )}
      <text x={lx} y={heapBase - 30} className="t-lab pp-lab" style={d(300)} textAnchor="end">
        未验收
      </text>
      <CountText x={lx} y={heapBase + 12} className="t-huge" textAnchor="end" n={heap} />

      <GateV cy={g2y} label="验收" hint={tip('验收闸', '有人跑过验收、归了档才算过这道闸')} />

      {/* 分料横带 + 三个料仓并排 */}
      <rect x={16} y={spurT} width={M_BELT_R - 16} height={16} className="f-deck s-hair" />
      {spurRollers.map((x) => (
        <g key={x}>
          <circle cx={x} cy={spurT + 25} r={8} className="f-none s-hairstrong" />
          <line
            x1={x - 4.2}
            y1={spurT + 25 - 4.2}
            x2={x + 4.2}
            y2={spurT + 25 + 4.2}
            className="s-hairstrong pp-spoke"
          />
        </g>
      ))}
      {bins.map(({ cx, label, n, tone, hint }) => {
        const x0 = cx - M_BIN_W / 2;
        return (
          <g key={label} data-tip={hint}>
            <polygon
              points={`${cx - 20},${deckB} ${cx + 20},${deckB} ${x0 + M_BIN_W},${binTop} ${x0},${binTop}`}
              className="f-deck s-hair"
            />
            <path
              d={`M${x0} ${binTop} L${x0} ${floorM} L${x0 + M_BIN_W} ${floorM} L${x0 + M_BIN_W} ${binTop}`}
              className="f-none s-hairstrong-w6"
            />
            {Array.from({ length: n }, (_, k) => (
              <rect
                key={k}
                x={cx - 36}
                y={floorM - 6 - 16 * (k + 1)}
                width={72}
                height={14}
                rx={1}
                className={`f-${tone} pp-bin`}
                style={d(880 + k * 90)}
              />
            ))}
            <text x={cx} y={floorM + 26} className="t-lab pp-lab" style={d(880)} textAnchor="middle">
              {label}
            </text>
            <text
              x={cx}
              y={floorM + 58}
              className={n ? `t-num t-${tone} pp-lab` : 't-num t-mut pp-lab'}
              style={d(880)}
              textAnchor="middle"
            >
              {n}
            </text>
          </g>
        );
      })}
      <rect x={0} y={floorM} width={M_W} height={3} className="f-hair" />

      <GateV cy={g3y} label="合并" nodata hint={tip('合并闸', '斜纹＝这一环没有数据', '分支墓碑还没接进聚合，不等于没有东西被合并')} />
      <text x={M_LINTEL_X - 12} y={g3y + 34} className="t-lab pp-lab" style={d(1000)} textAnchor="end">
        无数据
      </text>
    </svg>
  );
}

const ORPHAN_TIP = (n: number): string =>
  tip('报告没记它验的是谁', `${n} 份`, '没有 branch / commit / PR，挂不上任何改动——归档流程的缺口');

const RECLAIMED_TIP = (n: number): string =>
  tip('对应分支已被 CDS 回收', `${n} 份`, '无从核对，是常态不是漏');

/** 一垛的悬浮内容：图上只放得下项目名和一个数，其余都在这里。 */
export function projectTip(p: PipelineProjectRow): string {
  const f = p.funnel;
  const verdicts = f.pass + f.conditional + f.fail;
  return tip(
    p.projectName,
    `改动 ${Math.max(0, f.changes)} · 部署过 ${Math.max(0, f.deployed)} · 验过 ${Math.max(0, f.accepted)}`,
    verdicts > 0
      ? `通过 ${f.pass} · 原则性 ${f.conditional} · 未通过 ${f.fail}`
      : '一条都没验过',
    p.staleReports > 0 ? `另有 ${p.staleReports} 份报告的分支已回收` : '',
    p.lastActivityAt ? `最近动静 ${p.lastActivityAt.slice(0, 10)}` : '没有动静',
    p.githubLinked ? '' : '未接 GitHub，合并这一环查不到',
    '点击进入该项目',
  );
}

/* ============================ 项目垛 ============================ */

/** 堆场宽度：按真实项目数算，不再垫到固定宽度——一个项目就该是窄窄一条。 */
export function yardVbW(projectCount: number): number {
  return Math.max(560, 92 + YARD_PITCH * Math.max(0, projectCount - 1) + 60);
}

function YardWide({
  projects,
  onOpenProject,
}: {
  projects: PipelineProjectRow[];
  onOpenProject: (projectId: string) => void;
}): JSX.Element {
  const maxCh = projects.reduce((a, p) => Math.max(a, Math.max(0, p.funnel.changes)), 0);
  // 层高由最高那一垛反算：最高的一垛总是顶到同一个高度，所以项目少、改动少的时候
  // 格子变大看得清，而不是几条细线贴在地上；画布高度也因此稳定。
  const layer = Math.min(26, Math.max(9, 340 / Math.max(1, maxCh)));
  const top = Math.min(YARD_GY - layer * maxCh - 36, YARD_GY - 60);
  // 宽度按真实项目数算，不再垫到 1360——一个项目就该是窄窄一条，不是一整屏空地。
  const vbW = yardVbW(projects.length);
  return (
    <svg
      className="pp-scene"
      viewBox={`0 ${top} ${vbW} ${512 - top}`}
      style={sceneWidth(vbW)}
      role="img"
      aria-label="按项目分垛"
    >
      <rect x={0} y={YARD_GY + 6} width={vbW} height={3} className="f-hair" />
      {projects.map((p, idx) => {
        const cx = 92 + YARD_PITCH * idx;
        const x = cx - YARD_BW / 2;
        const seq = stackSeq(p.funnel);
        const lines = wrapName(p.projectName);
        const ch = Math.max(0, p.funnel.changes);
        return (
          <g
            key={p.projectId}
            className="g-hit"
            role="button"
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
            {seq.map((tone, i) => (
              <rect
                key={i}
                x={x}
                y={YARD_GY - layer * (i + 1) + 2}
                width={YARD_BW}
                height={layer - 2}
                rx={1}
                className={tone === 'crate' ? 'f-crate s-hairstrong pp-slab' : `f-${tone} pp-slab`}
                style={d(idx * 70 + i * 16)}
              />
            ))}
            {ch ? (
              <CountText x={cx} y={YARD_GY - layer * ch - 10} className="t-num" textAnchor="middle" n={ch} />
            ) : (
              <text x={cx} y={YARD_GY - 14} className="t-num t-mut pp-lab" style={d(idx * 70)} textAnchor="middle">
                0
              </text>
            )}
            {/* 地脚：实心＝接了 GitHub（合并那一格查得到），虚线＝未接（查不到，不等于没合并） */}
            <rect
              x={cx - 48}
              y={YARD_GY}
              width={96}
              height={6}
              className={p.githubLinked ? 'f-hairstrong pp-lab' : 'f-none s-hairstrong-d pp-lab'}
              style={d(idx * 70)}
            />
            {lines.map((ln, li) => (
              <text
                key={li}
                x={cx}
                y={YARD_GY + 30 + li * 16}
                className="t-name pp-lab"
                style={d(idx * 70 + 120)}
                textAnchor="middle"
              >
                {ln}
              </text>
            ))}
            {!p.githubLinked ? (
              <text
                x={cx}
                y={YARD_GY + 30 + lines.length * 16 + 8}
                className="t-tag pp-lab"
                style={d(idx * 70 + 120)}
                textAnchor="middle"
              >
                未接
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** 窄屏：垛倒伏为横向条，长度＝改动数，彩色段仍在起点侧，条首端帽实心/虚线＝GitHub 接没接。 */
function YardNarrow({
  projects,
  onOpenProject,
}: {
  projects: PipelineProjectRow[];
  onOpenProject: (projectId: string) => void;
}): JSX.Element {
  const maxCh = projects.reduce((a, p) => Math.max(a, Math.max(0, p.funnel.changes)), 1);
  const vbW = 6 + 11 * maxCh + 2;
  return (
    <ul className={`m-0 list-none p-0 ${projects.length > 8 ? 'max-h-[352px] overflow-y-auto' : ''}`}>
      {projects.map((p) => {
        const seq = stackSeq(p.funnel);
        return (
          <li key={p.projectId} className="flex h-[44px] items-center gap-2.5" data-tip={projectTip(p)}>
            <div className="flex w-[104px] shrink-0 flex-col justify-center">
              <button
                type="button"
                className="block truncate text-left text-[12px] text-foreground hover:underline"
                onClick={() => onOpenProject(p.projectId)}
              >
                {p.projectName}
              </button>
              {!p.githubLinked ? (
                <span className="text-[11px] leading-tight tracking-[0.1em] text-muted-foreground">未接</span>
              ) : null}
            </div>
            <div className="min-w-0 flex-1">
              <svg
                className="block h-[22px] w-full"
                viewBox={`0 0 ${vbW} 22`}
                preserveAspectRatio="xMinYMid meet"
                aria-hidden="true"
              >
                <rect
                  x={0}
                  y={0}
                  width={4}
                  height={22}
                  className={p.githubLinked ? 'f-hairstrong' : 'f-none s-hairstrong-d'}
                />
                {seq.map((tone, i) => (
                  <rect
                    key={i}
                    x={6 + 11 * i}
                    y={0}
                    width={9}
                    height={22}
                    rx={1}
                    className={tone === 'crate' ? 'f-crate s-hairstrong pp-bar' : `f-${tone} pp-bar`}
                    style={d(i * 16)}
                  />
                ))}
              </svg>
            </div>
            <span className="w-[30px] shrink-0 text-right font-mono text-[13px] font-semibold">
              {Math.max(0, p.funnel.changes)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ============================ 场外：不进闸的两类报告 ============================ */

function dotRows(n: number, per: number): number {
  return Math.ceil(Math.max(0, n) / per);
}

function Dots({
  x0,
  y0,
  n,
  per,
  delay = 0,
  hint,
}: { x0: number; y0: number; n: number; per: number; delay?: number; hint?: string }): JSX.Element {
  return (
    <>
      {Array.from({ length: Math.max(0, n) }, (_, i) => (
        <circle
          key={i}
          cx={x0 + (i % per) * 10}
          cy={y0 + Math.floor(i / per) * 10}
          r={3.2}
          className="f-hairstrong pp-dot"
          style={d(delay + i * 5)}
          data-tip={hint}
        />
      ))}
    </>
  );
}

/** 场外宽度：只算到点阵真正用到的地方，后面不再垫一段固定空白。 */
export function outsideVbW(reclaimed: number): number {
  return Math.max(620, 512 + Math.min(Math.max(0, reclaimed), 30) * 10 + 60);
}

function OutsideWide({ orphan, reclaimed }: { orphan: number; reclaimed: number }): JSX.Element {
  const h = Math.max(108, 48 + dotRows(orphan, 15) * 10 + 20, 34 + dotRows(reclaimed, 30) * 10 + 20);
  const vbW = outsideVbW(reclaimed);
  return (
    <svg className="pp-scene" viewBox={`0 0 ${vbW} ${h}`} style={sceneWidth(vbW)} role="img" aria-label="场外报告">
      <line x1={0} y1={14} x2={vbW} y2={14} className="s-fence" />
      <g data-tip={ORPHAN_TIP(orphan)}>
        <text x={0} y={52} className="t-lab pp-lab" style={d(60)}>
          无主
        </text>
        <CountText x={70} y={56} className="t-num" n={orphan} />
      </g>
      <Dots x0={126} y0={48} n={orphan} per={15} delay={80} hint={ORPHAN_TIP(orphan)} />
      <g data-tip={RECLAIMED_TIP(reclaimed)}>
        <text x={330} y={52} className="t-lab pp-lab" style={d(240)}>
          已回收
        </text>
        <CountText x={428} y={56} className="t-num" n={reclaimed} />
      </g>
      <Dots x0={512} y0={34} n={reclaimed} per={30} delay={260} hint={RECLAIMED_TIP(reclaimed)} />
    </svg>
  );
}

function OutsideNarrow({ orphan, reclaimed }: { orphan: number; reclaimed: number }): JSX.Element {
  const base = 48 + dotRows(orphan, 15) * 10 + 44;
  const h = base + dotRows(reclaimed, 15) * 10 + 24;
  return (
    <svg className="pp-scene" viewBox={`0 0 ${M_W} ${h}`} role="img" aria-label="场外报告">
      <line x1={0} y1={14} x2={M_W} y2={14} className="s-fence" />
      <text x={0} y={52} className="t-lab">
        无主
      </text>
      <text x={76} y={56} className="t-num">
        {orphan}
      </text>
      <Dots x0={136} y0={48} n={orphan} per={15} hint={ORPHAN_TIP(orphan)} />
      <text x={0} y={base + 4} className="t-lab">
        已回收
      </text>
      <text x={76} y={base + 8} className="t-num">
        {reclaimed}
      </text>
      <Dots x0={136} y0={base} n={reclaimed} per={15} hint={RECLAIMED_TIP(reclaimed)} />
    </svg>
  );
}

/* ============================ 结论 ============================ */

const TONE_DOT: Record<'ok' | 'warn' | 'bad', string> = {
  ok: 'bg-[hsl(var(--ok))]',
  warn: 'bg-[hsl(var(--warn))]',
  bad: 'bg-[hsl(var(--bad))]',
};

/**
 * 第一眼那句判断。
 *
 * 句子由 buildPipelineHeadline 规则生成，每句都挂着真实数字——它早就写好了，
 * 只是首页三次重做之后没人再引用它（文件和它的 7 条守卫都还在、测试照绿），
 * 于是这一屏退回成「一堆好看的图形，看不出在讲什么」。这里把它接回来。
 */
function Headline({ h, full }: { h: ReturnType<typeof buildPipelineHeadline>; full?: boolean }): JSX.Element {
  const points = full ? h.points : h.points.slice(0, 2);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2.5">
        <span className={`mt-[9px] h-2 w-2 shrink-0 rounded-full ${TONE_DOT[h.tone]}`} />
        <p className="m-0 text-[19px] font-semibold leading-[1.5]">{h.sentence}</p>
      </div>
      {points.length ? (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 pl-[18px]">
          {points.map((t) => (
            <li key={t} className="text-[13px] leading-[1.6] text-muted-foreground">
              {t}
            </li>
          ))}
        </ul>
      ) : null}
      {full && h.action ? (
        <p className="m-0 pl-[18px] text-[13px] leading-[1.6] text-foreground">{h.action}</p>
      ) : null}
    </div>
  );
}

/* ============================ 面板 ============================ */

/**
 * 一张卡＝一幕，进视口才开演，演一次为止。
 *
 * data-play 是 CSS 那边唯一的开关；PlayCtx 是 CountText 的同一个开关。两处必须同源，
 * 否则会出现「箱子已经摞完、数字还在从 0 爬」这种对不上的画面。
 */
function Card({ children }: { children: React.ReactNode }): JSX.Element {
  const { ref, play } = useInViewPlay();
  return (
    <div
      ref={ref}
      data-play={play ? '1' : '0'}
      className="rounded-[12px] border border-[hsl(var(--hairline))] bg-card px-4 py-4 sm:px-5"
    >
      <PlayCtx.Provider value={play}>{children}</PlayCtx.Provider>
    </div>
  );
}

/**
 * 给货堆里每一只箱子配一个分支名。
 *
 * 名字取自 `leaks` 里 deployed-not-accepted 那一类的 subject。注意**只拿来当标签**，
 * 计数仍由 splitChanges 现推（它刻意不用这个桶，理由见 splitChanges 的注释）。
 * 两边条数对不上时宁可一个都不绑：65 只箱子配 63 个名字，剩下两只会静默错位，
 * 悬浮上去指鹿为马比没有提示更糟。
 */
export function heapTipsOf(pipeline: PipelineOverview): string[] {
  const names = new Map(pipeline.projects.map((p) => [p.projectId, p.projectName]));
  const list = pipeline.leaks.filter((l) => l.kind === 'deployed-not-accepted');
  if (list.length !== splitChanges(pipeline.total).heap) return [];
  return list.map((l) => tip(l.subject, names.get(l.projectId) ?? l.projectId, '已部署，还没人验'));
}

export function PipelinePanel({ pipeline, onOpenProject }: PipelinePanelProps): JSX.Element {
  const orphan = Math.max(0, pipeline.totalLeaks['report-missing-change-key'] ?? 0);
  const reclaimed = Math.max(0, pipeline.staleReports);
  const { tipState, handlers } = useTipDelegate();
  const heapTips = heapTipsOf(pipeline);
  const headline = buildPipelineHeadline(pipeline);
  const [zoom, setZoom] = useState(false);

  // 三张图各自缩到自己该有的大小之后，卡片要是还占满整条，就成了「大盒子装一点东西」——
  // 比不缩还空。所以整块面板跟着最宽的那张图收。
  const panelPx = Math.max(
    sceneMaxPx(hallLayoutWide(pipeline.total).vbW),
    sceneMaxPx(yardVbW(pipeline.projects.length)),
    sceneMaxPx(outsideVbW(reclaimed)),
  );

  const hall = (
    <>
      <div className="lg:hidden">
        <HallNarrow f={pipeline.total} heapTips={heapTips} />
      </div>
      <div className="hidden lg:block">
        <HallWide f={pipeline.total} heapTips={heapTips} />
      </div>
    </>
  );

  return (
    <div className="pp-root flex flex-col gap-4" style={{ maxWidth: `${panelPx}px` }} {...handlers}>
      {tipState ? <TipBox state={tipState} /> : null}
      <style>{SCENE_CSS}</style>
      <SceneDefs />

      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="m-0 text-[22px] font-bold tracking-[0.14em]">验收流水线</h1>
        <div className="flex items-baseline gap-4">
          <span className="font-mono text-[13px] tracking-[0.16em] text-muted-foreground">
            {pipeline.generatedAt.slice(0, 10)}
          </span>
          <button
            type="button"
            className="rounded-md border border-[hsl(var(--hairline))] px-2.5 py-1 text-[12px] text-muted-foreground hover:text-foreground"
            onClick={() => setZoom((v) => !v)}
          >
            {zoom ? '收起' : '放大'}
          </button>
        </div>
      </div>

      {/*
        默认只占一小块：一句判断 + 一张剪影。
        整屏铺开三张图是「好看但不知道在讲什么」——图是支撑，判断才是第一眼该读的
        （conclusion-before-numbers：计数 → 对照 → 结论，停在前两层就是让人自己算）。
        要看细节点「放大」。
      */}
      {zoom ? (
        <>
          <Card>
            <Headline h={headline} full />
          </Card>
          <Card>{hall}</Card>
          <Card>
            <div className="lg:hidden">
              <YardNarrow projects={pipeline.projects} onOpenProject={onOpenProject} />
            </div>
            <div className="hidden lg:block">
              <YardWide projects={pipeline.projects} onOpenProject={onOpenProject} />
            </div>
          </Card>
          <Card>
            <div className="lg:hidden">
              <OutsideNarrow orphan={orphan} reclaimed={reclaimed} />
            </div>
            <div className="hidden lg:block">
              <OutsideWide orphan={orphan} reclaimed={reclaimed} />
            </div>
          </Card>
        </>
      ) : (
        <Card>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center">
            <div className="min-w-0 lg:flex-[5]">
              <Headline h={headline} />
            </div>
            <div className="pp-mini min-w-0 lg:flex-[4]">{hall}</div>
          </div>
        </Card>
      )}
    </div>
  );
}
