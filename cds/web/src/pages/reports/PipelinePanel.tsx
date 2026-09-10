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
.pp-root .pp-scene{display:block;width:100%;height:auto;}

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

.pp-root .t-huge{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:46px;font-weight:700;
  fill:hsl(var(--foreground));letter-spacing:-.02em;}
.pp-root .t-num{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:26px;font-weight:700;
  fill:hsl(var(--foreground));}
.pp-root .t-lab{font-size:15px;font-weight:600;letter-spacing:.18em;fill:hsl(var(--muted-foreground));}
.pp-root .t-name{font-size:12px;fill:hsl(var(--foreground));}
.pp-root .t-tag{font-size:11px;letter-spacing:.1em;fill:hsl(var(--muted-foreground));}
.pp-root .t-mut{fill:hsl(var(--hairline-strong));}
.pp-root .t-ok{fill:hsl(var(--ok));}
.pp-root .t-warn{fill:hsl(var(--warn));}
.pp-root .t-bad{fill:hsl(var(--bad));}

.pp-root .g-hit{cursor:pointer;outline:none;}
.pp-root .g-hit:hover .t-name,.pp-root .g-hit:focus-visible .t-name{text-decoration:underline;}
`;

/* ============================ 几何常量（照稿，勿改） ============================ */
const DECK_T = 356;
const DECK_B = 372;
const LINTEL_B = 176;
const OPEN_H = DECK_T - LINTEL_B;
const FLOOR = 470;
const BLADE = 34; // 闸板固定落差：结构件，不编码数据
const CW = 16;
const CH_ = 12;
const CGX = 18;
const CGY = 14;
const GATE1_CX = 324;
const GATE2_CX = 802;
const GATE3_CX = 1264;
const HEAP_R = GATE2_CX - 24;
const ROW_MAX = 13;

const BIN_TOP = 392;
const BIN_W = 96;
const BIN_CX = [900, 1020, 1140];

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
const M_ROW_MAX = 6;
const M_BELT_TOP = 140;
const M_G1Y = 196;
const M_GAP_Y = 236;
const M_GAP_H = 64;
const M_SHAFT_LEN = 114;
const M_HEAP_TOP_MIN = 372;
const M_BIN_W = 84;
const M_BIN_CX = [62, 152, 242];

type Tone = 'ok' | 'warn' | 'bad';

/**
 * 把漏斗基数拆成分流图的三段。
 *
 * 刻意**不用** `leaks['deployed-not-accepted']` 那个桶：它排除了「合并了没验」那一类，
 * 等分支墓碑数据接进来（当前全库 merged=0，因为聚合还没接），桶里的数会小于真实的
 * 「已部署未验收」，分流图就加不回总数、凭空少几个方块，而且今天两者恰好相等、
 * 明天才静默错位——最难查的那种。用基数现推则恒等成立：
 *   accepted + (deployed - accepted) + (changes - deployed) === changes
 */
function splitChanges(f: PipelineFunnel): { accepted: number; heap: number; undeployed: number } {
  return {
    accepted: Math.max(0, f.accepted),
    heap: Math.max(0, f.deployed - f.accepted),
    undeployed: Math.max(0, f.changes - f.deployed),
  };
}

/** 货堆分行：底层最宽，逐层收窄，靠闸门一侧对齐。行数与箱数都由数据决定。 */
function mound(n: number, rowMax: number): number[] {
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

/** 闸门＝固定结构件。开合程度不表示任何数据，三道闸画法一致。 */
function GateH({ cx, label, nodata }: { cx: number; label: string; nodata?: boolean }): JSX.Element {
  const lp = cx - 24;
  const rp = cx + 12;
  const sx = lp + 12;
  const sw = rp - lp - 12;
  return (
    <g>
      <rect x={lp - 4} y={LINTEL_B - 16} width={rp + 12 - (lp - 4)} height={16} className="f-steel" />
      <rect x={lp} y={LINTEL_B} width={12} height={DECK_T - LINTEL_B} className="f-steel" />
      <rect x={rp} y={LINTEL_B} width={12} height={DECK_T - LINTEL_B} className="f-steel" />
      {nodata ? (
        <rect x={sx} y={LINTEL_B} width={sw} height={OPEN_H} fill="url(#pp-nodata)" className="s-hairstrong-d" />
      ) : (
        <>
          <rect x={sx} y={LINTEL_B} width={sw} height={BLADE} fill="url(#pp-rib)" />
          <rect x={sx - 3} y={LINTEL_B + BLADE - 5} width={sw + 6} height={5} className="f-steel-d" />
        </>
      )}
      <text x={cx - 6} y={LINTEL_B - 28} className="t-lab" textAnchor="middle">
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
        <circle key={x} cx={x} cy={DECK_B + 9} r={8} className="f-none s-hairstrong" />
      ))}
    </g>
  );
}

function HallWide({ f }: { f: PipelineFunnel }): JSX.Element {
  const { heap, undeployed } = splitChanges(f);
  const rows = mound(heap, ROW_MAX);
  const lx = HEAP_R - CGX * (rows[0] ?? 0) - 26;
  const bins: Array<{ cx: number; label: string; n: number; tone: Tone }> = [
    { cx: BIN_CX[0], label: '通过', n: Math.max(0, f.pass), tone: 'ok' },
    { cx: BIN_CX[1], label: '原则性', n: Math.max(0, f.conditional), tone: 'warn' },
    { cx: BIN_CX[2], label: '未通过', n: Math.max(0, f.fail), tone: 'bad' },
  ];

  return (
    <svg className="pp-scene" viewBox="0 112 1360 436" role="img" aria-label="验收流水线剖面">
      <rect x={0} y={FLOOR} width={1360} height={4} className="f-hair" />

      {/* 入料溜槽 + 总量 */}
      <polygon points="46,206 128,206 176,356 106,356" className="f-deck s-hair" />
      <text x={88} y={150} className="t-lab" textAnchor="middle">
        改动
      </text>
      <text x={88} y={196} className="t-huge" textAnchor="middle">
        {f.changes}
      </text>

      <BeltH x1={106} x2={224} />
      <BeltH x1={288} x2={1332} />

      {/* 传送带缺口：掉下去的就是「未部署」，箱数即数据 */}
      <rect x={224} y={DECK_T} width={64} height={FLOOR - DECK_T} className="f-sunken s-hair" />
      {Array.from({ length: undeployed }, (_, k) => {
        const y = FLOOR - 3 - (k + 1) * (CH_ + 2);
        const rot = k % 2 === 0 ? -14 : 9;
        return (
          <rect
            key={k}
            x={244}
            y={y}
            width={24}
            height={CH_ + 1}
            rx={1.5}
            className="f-crate s-hairstrong"
            transform={`rotate(${rot} 256 ${y + 7})`}
          />
        );
      })}
      <text x={256} y={FLOOR + 26} className="t-lab" textAnchor="middle">
        未部署
      </text>
      <text x={256} y={FLOOR + 58} className="t-num" textAnchor="middle">
        {undeployed}
      </text>

      <GateH cx={GATE1_CX} label="部署" />

      {/* 货堆：排在验收闸前的队伍，一箱一条改动 */}
      {rows.map((n, i) =>
        Array.from({ length: n }, (_, k) => (
          <rect
            key={`${i}-${k}`}
            x={HEAP_R - CGX * (k + 1) + 2}
            y={344 - CGY * i}
            width={CW}
            height={CH_}
            rx={1}
            className="f-crate s-hairstrong"
          />
        )),
      )}
      <text x={lx} y={252} className="t-lab" textAnchor="end">
        未验收
      </text>
      <text x={lx} y={302} className="t-huge" textAnchor="end">
        {heap}
      </text>

      <GateH cx={GATE2_CX} label="验收" />

      {/* 三个料仓：过闸后按结论分装，仓内箱数即三档计数 */}
      {bins.map(({ cx, label, n, tone }) => {
        const x0 = cx - BIN_W / 2;
        return (
          <g key={label}>
            <polygon
              points={`${cx - 20},${DECK_B} ${cx + 20},${DECK_B} ${x0 + BIN_W},${BIN_TOP} ${x0},${BIN_TOP}`}
              className="f-deck s-hair"
            />
            <path
              d={`M${x0} ${BIN_TOP} L${x0} ${FLOOR} L${x0 + BIN_W} ${FLOOR} L${x0 + BIN_W} ${BIN_TOP}`}
              className="f-none s-hairstrong-w6"
            />
            {Array.from({ length: n }, (_, k) => (
              <rect key={k} x={cx - 36} y={FLOOR - 6 - 16 * (k + 1)} width={72} height={14} rx={1} className={`f-${tone}`} />
            ))}
            <text x={cx} y={FLOOR + 26} className="t-lab" textAnchor="middle">
              {label}
            </text>
            <text x={cx} y={FLOOR + 58} className={n ? `t-num t-${tone}` : 't-num t-mut'} textAnchor="middle">
              {n}
            </text>
          </g>
        );
      })}

      <GateH cx={GATE3_CX} label="合并" nodata />
      <text x={1258} y={FLOOR + 26} className="t-lab" textAnchor="middle">
        无数据
      </text>
    </svg>
  );
}

/* ============================ 窄屏：纵向流水 ============================ */

/** 同一道闸转 90 度：门楣在左、两根门柱横跨带面、闸板自左插入。落差仍是 34。 */
function GateV({ cy, label, nodata }: { cy: number; label: string; nodata?: boolean }): JSX.Element {
  return (
    <g>
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

function HallNarrow({ f }: { f: PipelineFunnel }): JSX.Element {
  const { heap, undeployed } = splitChanges(f);
  const rows = mound(heap, M_ROW_MAX);
  const heapBase = M_HEAP_TOP_MIN + CGY * Math.max(0, rows.length - 1);
  const g2y = heapBase + 52;
  const spurT = g2y + 56;
  const deckB = spurT + 16;
  const binTop = spurT + 36;
  const floorM = spurT + 114;
  const g3y = floorM + 110;
  const height = g3y + 62;
  const shaftX = M_BELT_X - M_SHAFT_LEN;
  const lx = M_BELT_R - CGX * (rows[0] ?? 0) - 26;

  const spurRollers: number[] = [];
  for (let x = 16 + 22; x < M_BELT_R - 10; x += 44) spurRollers.push(x);

  const bins: Array<{ cx: number; label: string; n: number; tone: Tone }> = [
    { cx: M_BIN_CX[0], label: '通过', n: Math.max(0, f.pass), tone: 'ok' },
    { cx: M_BIN_CX[1], label: '原则性', n: Math.max(0, f.conditional), tone: 'warn' },
    { cx: M_BIN_CX[2], label: '未通过', n: Math.max(0, f.fail), tone: 'bad' },
  ];

  return (
    <svg className="pp-scene" viewBox={`0 0 ${M_W} ${height}`} role="img" aria-label="验收流水线剖面">
      {/* 入料溜槽 + 总量 */}
      <polygon points={`150,44 150,114 ${M_BELT_R},${M_BELT_TOP} ${M_BELT_R},70`} className="f-deck s-hair" />
      <text x={24} y={60} className="t-lab">
        改动
      </text>
      <text x={24} y={108} className="t-huge">
        {f.changes}
      </text>

      <BeltV y1={M_BELT_TOP} y2={M_GAP_Y} />
      <BeltV y1={M_GAP_Y + M_GAP_H} y2={height - 20} />

      {/* 带面缺口：掉出去的就是「未部署」 */}
      <rect x={shaftX} y={M_GAP_Y} width={M_SHAFT_LEN} height={M_GAP_H} className="f-sunken s-hair" />
      {Array.from({ length: undeployed }, (_, k) => {
        const x = shaftX + 3 + k * 14;
        const rot = k % 2 === 0 ? -14 : 9;
        return (
          <rect
            key={k}
            x={x}
            y={M_GAP_Y + 20}
            width={CH_ + 1}
            height={24}
            rx={1.5}
            className="f-crate s-hairstrong"
            transform={`rotate(${rot} ${x + 6.5} ${M_GAP_Y + 32})`}
          />
        );
      })}
      <text x={shaftX - 10} y={M_GAP_Y + 26} className="t-lab" textAnchor="end">
        未部署
      </text>
      <text x={shaftX - 10} y={M_GAP_Y + 58} className="t-num" textAnchor="end">
        {undeployed}
      </text>

      <GateV cy={M_G1Y} label="部署" />

      {/* 货堆：行宽上限降到 6，货箱尺寸不变，只换行 */}
      {rows.map((n, i) =>
        Array.from({ length: n }, (_, k) => (
          <rect
            key={`${i}-${k}`}
            x={M_BELT_R - CGX * (k + 1) + 2}
            y={heapBase - CGY * i}
            width={CW}
            height={CH_}
            rx={1}
            className="f-crate s-hairstrong"
          />
        )),
      )}
      <text x={lx} y={heapBase - 30} className="t-lab" textAnchor="end">
        未验收
      </text>
      <text x={lx} y={heapBase + 12} className="t-huge" textAnchor="end">
        {heap}
      </text>

      <GateV cy={g2y} label="验收" />

      {/* 分料横带 + 三个料仓并排 */}
      <rect x={16} y={spurT} width={M_BELT_R - 16} height={16} className="f-deck s-hair" />
      {spurRollers.map((x) => (
        <circle key={x} cx={x} cy={spurT + 25} r={8} className="f-none s-hairstrong" />
      ))}
      {bins.map(({ cx, label, n, tone }) => {
        const x0 = cx - M_BIN_W / 2;
        return (
          <g key={label}>
            <polygon
              points={`${cx - 20},${deckB} ${cx + 20},${deckB} ${x0 + M_BIN_W},${binTop} ${x0},${binTop}`}
              className="f-deck s-hair"
            />
            <path
              d={`M${x0} ${binTop} L${x0} ${floorM} L${x0 + M_BIN_W} ${floorM} L${x0 + M_BIN_W} ${binTop}`}
              className="f-none s-hairstrong-w6"
            />
            {Array.from({ length: n }, (_, k) => (
              <rect key={k} x={cx - 36} y={floorM - 6 - 16 * (k + 1)} width={72} height={14} rx={1} className={`f-${tone}`} />
            ))}
            <text x={cx} y={floorM + 26} className="t-lab" textAnchor="middle">
              {label}
            </text>
            <text x={cx} y={floorM + 58} className={n ? `t-num t-${tone}` : 't-num t-mut'} textAnchor="middle">
              {n}
            </text>
          </g>
        );
      })}
      <rect x={0} y={floorM} width={M_W} height={3} className="f-hair" />

      <GateV cy={g3y} label="合并" nodata />
      <text x={M_LINTEL_X - 12} y={g3y + 34} className="t-lab" textAnchor="end">
        无数据
      </text>
    </svg>
  );
}

/* ============================ 项目垛 ============================ */

function YardWide({
  projects,
  onOpenProject,
}: {
  projects: PipelineProjectRow[];
  onOpenProject: (projectId: string) => void;
}): JSX.Element {
  const maxCh = projects.reduce((a, p) => Math.max(a, Math.max(0, p.funnel.changes)), 0);
  const top = Math.min(YARD_GY - 11 * maxCh - 36, YARD_GY - 60);
  const vbW = Math.max(1360, 92 + YARD_PITCH * Math.max(0, projects.length - 1) + 60);
  return (
    <svg className="pp-scene" viewBox={`0 ${top} ${vbW} ${512 - top}`} role="img" aria-label="按项目分垛">
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
            onClick={() => onOpenProject(p.projectId)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpenProject(p.projectId);
              }
            }}
          >
            <title>{p.projectName}</title>
            {seq.map((tone, i) => (
              <rect
                key={i}
                x={x}
                y={YARD_GY - 11 * (i + 1) + 2}
                width={YARD_BW}
                height={9}
                rx={1}
                className={tone === 'crate' ? 'f-crate s-hairstrong' : `f-${tone}`}
              />
            ))}
            {ch ? (
              <text x={cx} y={YARD_GY - 11 * ch - 10} className="t-num" textAnchor="middle">
                {ch}
              </text>
            ) : (
              <text x={cx} y={YARD_GY - 14} className="t-num t-mut" textAnchor="middle">
                0
              </text>
            )}
            {/* 地脚：实心＝接了 GitHub（合并那一格查得到），虚线＝未接（查不到，不等于没合并） */}
            <rect
              x={cx - 48}
              y={YARD_GY}
              width={96}
              height={6}
              className={p.githubLinked ? 'f-hairstrong' : 'f-none s-hairstrong-d'}
            />
            {lines.map((ln, li) => (
              <text key={li} x={cx} y={YARD_GY + 30 + li * 16} className="t-name" textAnchor="middle">
                {ln}
              </text>
            ))}
            {!p.githubLinked ? (
              <text x={cx} y={YARD_GY + 30 + lines.length * 16 + 8} className="t-tag" textAnchor="middle">
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
          <li key={p.projectId} className="flex h-[44px] items-center gap-2.5">
            <div className="flex w-[104px] shrink-0 flex-col justify-center">
              <button
                type="button"
                className="block truncate text-left text-[12px] text-foreground hover:underline"
                title={p.projectName}
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
                    className={tone === 'crate' ? 'f-crate s-hairstrong' : `f-${tone}`}
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

function Dots({ x0, y0, n, per }: { x0: number; y0: number; n: number; per: number }): JSX.Element {
  return (
    <>
      {Array.from({ length: Math.max(0, n) }, (_, i) => (
        <circle key={i} cx={x0 + (i % per) * 10} cy={y0 + Math.floor(i / per) * 10} r={3.2} className="f-hairstrong" />
      ))}
    </>
  );
}

function OutsideWide({ orphan, reclaimed }: { orphan: number; reclaimed: number }): JSX.Element {
  const h = Math.max(108, 48 + dotRows(orphan, 15) * 10 + 20, 34 + dotRows(reclaimed, 30) * 10 + 20);
  return (
    <svg className="pp-scene" viewBox={`0 0 1360 ${h}`} role="img" aria-label="场外报告">
      <line x1={0} y1={14} x2={1360} y2={14} className="s-fence" />
      <text x={0} y={52} className="t-lab">
        无主
      </text>
      <text x={70} y={56} className="t-num">
        {orphan}
      </text>
      <Dots x0={126} y0={48} n={orphan} per={15} />
      <text x={330} y={52} className="t-lab">
        已回收
      </text>
      <text x={428} y={56} className="t-num">
        {reclaimed}
      </text>
      <Dots x0={512} y0={34} n={reclaimed} per={30} />
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
      <Dots x0={136} y0={48} n={orphan} per={15} />
      <text x={0} y={base + 4} className="t-lab">
        已回收
      </text>
      <text x={76} y={base + 8} className="t-num">
        {reclaimed}
      </text>
      <Dots x0={136} y0={base} n={reclaimed} per={15} />
    </svg>
  );
}

/* ============================ 面板 ============================ */

function Card({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="rounded-[12px] border border-[hsl(var(--hairline))] bg-card px-4 py-4 sm:px-5">{children}</div>
  );
}

export function PipelinePanel({ pipeline, onOpenProject }: PipelinePanelProps): JSX.Element {
  const orphan = Math.max(0, pipeline.totalLeaks['report-missing-change-key'] ?? 0);
  const reclaimed = Math.max(0, pipeline.staleReports);

  return (
    <div className="pp-root flex flex-col gap-4">
      <style>{SCENE_CSS}</style>
      <SceneDefs />

      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="m-0 text-[22px] font-bold tracking-[0.14em]">验收流水线</h1>
        <span className="font-mono text-[13px] tracking-[0.16em] text-muted-foreground">
          {pipeline.generatedAt.slice(0, 10)}
        </span>
      </div>

      <Card>
        <div className="lg:hidden">
          <HallNarrow f={pipeline.total} />
        </div>
        <div className="hidden lg:block">
          <HallWide f={pipeline.total} />
        </div>
      </Card>

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
    </div>
  );
}
