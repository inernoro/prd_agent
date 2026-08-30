import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { getGenAvgMs } from '@/lib/genTiming';

// build-marker: gen-develop-loader v1 (2026-08-30) — 强制 chunk 重编译，冲掉 CDS 构建缓存

/**
 * GenDevelopLoader — 生图等待「显影」动效（2026-08-30 替换靛蓝流光进度条）
 *
 * 一句话主张：**进度画在画框上，不压在画面上。**
 *
 * 上一版（GenSweepLoader）把「已耗时 / 预计」塞进一枚底部黑胶囊里。那是整张卡最重、
 * 最实、最不透明的一块，讲的却是「关于产物的状态」而不是产物本身
 * （违反 artifact-is-experience.md：主视觉永远留给产物）。更要命的是它和
 * Frame 头部、图层面板按钮、左上角尺寸徽章一样按屏幕像素反缩放，四件东西抢同一张卡，
 * 缩放一低必打架 —— PR #1458 打的正是那个补丁。这一版把那个冲突从结构上消掉：
 *
 *  1. 进度 = 画框。描边从正上方顺时针合拢，同时**替掉卡片自己的边框**（调用方不再画 border）。
 *     零占位、不挡产物；描边按屏幕像素恒定，所以低倍下反而比原来 1 世界像素的边框更读得出来。
 *  2. 画面 = 潜像在显影。两级马赛克由粗到细随进度交叉淡入，一道暖光自上而下缓缓扫过。
 *     等的是图，看的就该是图在成形，而不是又一道「放到表格骨架屏上也成立」的通用流光。
 *  3. 文字 = 底边一行。尺寸 / 阶段 / 剩余时间合并成一处，四个角全部还给卡片。
 *     卡片在屏幕上越小，这一行从右往左逐段脱落（见 metaLevel），最后只剩一个点。
 *
 * 性能：潜像整层是两张 data-URI（模块级常量，全画布共享一份），一张卡两个节点 ——
 * 不是 200+ 个各带动画的格子。画布上同时十几张占位卡时这条很要命。
 * 持续变化的只有「显影带」一个合成层（transform 位移，GPU 合成）。
 *
 * 可读性：宽度受宿主限制，字号 / 间距 / 描边按屏幕像素计量（复用画布逐帧更新的 --invZoom，
 * 不等 React 低频同步）；插入距离同时按百分比封顶，极小卡片上不会把内容挤成负宽度。
 *
 * 主题：画布舞台被钉死成暗色，所以配色走 tokens.css 的 --gen-wait-* 一族（那里写明了
 * 为什么不双写）。组件内零硬编码颜色。
 */

const STYLE_ID = 'gen-develop-loader-styles';

/**
 * 潜像马赛克：一张按 viewBox 拉伸的 data-URI SVG。
 *
 * 为什么不是 DOM 格子：一张卡 6×6 + 12×12 = 180 个节点，每个各带一条 CSS 动画，
 * 画布上十几张占位卡就是两千多个动画元素，直接吃掉画布本就紧张的帧预算。
 * 整层做成一张图之后，一张卡只剩两个节点，而且两张图全画布共享、只解码一次。
 *
 * 随机数用固定种子的 LCG：同一份构建里每次渲染都一样，不引入跨设备/跨帧的抖动
 * （首页墨场那次不可移植的 sin hash 的教训，见 PR #1457）。
 */
function mosaic(cols: number, rows: number, seed: number, baseAlpha: number, spread: number): string {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  let rects = '';
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const alpha = (baseAlpha + rand() * spread).toFixed(3);
      // 冷暖两档交替，避免整层是一块死灰；两个色都是浅色，落在恒暗的卡上才看得见。
      const fill = rand() > 0.62 ? '%23FFE8D8' : '%23E2E0EC';
      rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${fill}" fill-opacity="${alpha}"/>`;
    }
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${cols} ${rows}' preserveAspectRatio='none'>${rects}</svg>`;
  // 只转义 data-URI 里真正会歧义的字符；fill 里的 # 已经预先写成 %23。
  return `url("data:image/svg+xml,${svg.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/"/g, '%22')}")`;
}

// 格子要够密才读成「潜像」。第一版是 6×6 / 12×12，在 420px 的卡上单格 70px，
// 亮度差直接变成一块块脏斑，看着像压缩失真而不是像有东西在浮现（真组件截图实测）。
const LATENT_COARSE = mosaic(11, 11, 20260830, 0.022, 0.034);
const LATENT_FINE = mosaic(26, 26, 771103, 0.016, 0.026);

/**
 * 动画一律写在样式表里，**不写进 inline style**。
 * inline 声明压过作者样式表，`@media (prefers-reduced-motion)` 里的 `animation:none`
 * 会被静默无视 —— 那是一条看着有、其实从不生效的无障碍逃生门。
 */
export const GLOBAL_CSS = `
.gen-dev{position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none}
/* 底纱：占位卡此刻还没有内容。压暗让画布点阵退到后面，但仍透得出来——如实表示「这里是空的」。 */
.gen-dev__veil{position:absolute;inset:0;background:var(--gen-wait-veil)}
/* 潜像：粗格先在，细格随进度浮上来。 */
.gen-dev__latent{position:absolute;inset:0;background-repeat:no-repeat;background-size:100% 100%}
/* 粗格的整体不透明度由进度驱动（--gen-dev-latent），呼吸动画在那个值上下浮动。
   关键：动画在层叠里压过 inline style，所以呼吸的关键帧必须**乘上**那个变量，
   不能直接写死 opacity —— 否则进度驱动的交叉淡入会被呼吸动画整个吃掉，
   看着像「格子永远那么浓」（判据纪律形状 6：判据读的值不是真正生效的那个值）。 */
.gen-dev__latent--coarse{background-image:${LATENT_COARSE};
  opacity:var(--gen-dev-latent,1);animation:gen-dev-breathe 5.6s ease-in-out infinite}
.gen-dev__latent--fine{background-image:${LATENT_FINE}}
/* 显影带：整张卡唯一持续变化的东西，也是「静止超过 2 秒即缺陷」那条的兜底。 */
.gen-dev__develop{position:absolute;left:-6%;right:-6%;top:0;height:45%;
  background:var(--gen-wait-develop);will-change:transform;
  animation:gen-dev-pass 3.6s cubic-bezier(.42,0,.58,1) infinite}
.gen-dev__vignette{position:absolute;inset:0;
  box-shadow:inset 0 0 calc(58px * var(--invZoom,1)) var(--gen-wait-vignette)}
@keyframes gen-dev-pass{from{transform:translate3d(0,-70%,0)}to{transform:translate3d(0,170%,0)}}
@keyframes gen-dev-breathe{
  0%,100%{opacity:calc(var(--gen-dev-latent,1) * .62)}
  50%{opacity:var(--gen-dev-latent,1)}
}
/* 只关动画，不改 opacity —— 那一层的不透明度是进度信息，关掉动效不代表要丢掉它。 */
@media (prefers-reduced-motion:reduce){
  .gen-dev__develop{animation:none;transform:translate3d(0,40%,0)}
  .gen-dev__latent--coarse{animation:none}
}
/* 画框：描边即进度。stroke-width 按屏幕像素恒定，所以 5% 缩放下它也还在，
   而原来那条 1 世界像素的 border 在 30% 以下就已经看不见了。 */
.gen-dev__frame{position:absolute;inset:0;overflow:visible}
.gen-dev__track{fill:none;stroke:var(--gen-wait-track);stroke-width:calc(2px * var(--invZoom,1))}
.gen-dev__halo{fill:none;stroke:var(--gen-wait-progress-halo);stroke-linecap:round;
  stroke-width:calc(6px * var(--invZoom,1));transition:stroke-dashoffset .7s ease-out}
.gen-dev__arc{fill:none;stroke:var(--gen-wait-progress);stroke-linecap:round;
  stroke-width:calc(2px * var(--invZoom,1));transition:stroke-dashoffset .7s ease-out}
.gen-dev__arc--over{stroke:var(--gen-wait-progress-over)}
.gen-dev__halo--over{stroke:var(--gen-wait-progress-over);opacity:.22}
/* 底边一行。插入距离同时按屏幕像素和百分比取小值：纯屏幕像素在极小卡片上会把
   left+right 加到超过卡宽，整行塌成零宽度然后静默消失。 */
.gen-dev__scrim{position:absolute;left:0;right:0;bottom:0;
  height:min(calc(72px * var(--invZoom,1)),46%);background:var(--gen-wait-scrim)}
.gen-dev__meta{position:absolute;
  left:min(calc(14px * var(--invZoom,1)),10%);right:min(calc(14px * var(--invZoom,1)),10%);
  bottom:min(calc(11px * var(--invZoom,1)),8%);
  display:flex;align-items:center;min-width:0;gap:calc(7px * var(--invZoom,1));
  font-family:var(--font-display,system-ui);font-size:calc(12.5px * var(--invZoom,1));
  font-weight:500;letter-spacing:.03em;line-height:1.2;white-space:nowrap}
.gen-dev__meta>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.gen-dev__size{color:var(--gen-wait-text-dim)}
.gen-dev__phase{color:var(--gen-wait-progress)}
.gen-dev__phase--over{color:var(--gen-wait-progress-over)}
.gen-dev__time{color:var(--gen-wait-text)}
.gen-dev__dot{flex:none;border-radius:999px;background:var(--gen-wait-dot);
  width:calc(3px * var(--invZoom,1));height:calc(3px * var(--invZoom,1))}
/* 收到最后一档时留下的那一个点：卡片再小也还有一处说明「这块在做事」。 */
.gen-dev__pip{flex:none;border-radius:999px;background:var(--gen-wait-progress);
  width:calc(5px * var(--invZoom,1));height:calc(5px * var(--invZoom,1))}
.gen-dev__pip--over{background:var(--gen-wait-progress-over)}
`;

function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = GLOBAL_CSS;
  document.head.appendChild(el);
}

/**
 * 从正上方出发、顺时针合拢的圆角矩形。
 * 起点定在上边中点而不是左上角：合拢过程左右对称，看着像画框自己在收口。
 */
export function framePath(w: number, h: number, radius: number): string {
  const r = Math.max(0, Math.min(radius, w / 2 - 1, h / 2 - 1));
  const x0 = 1;
  const y0 = 1;
  const x1 = w - 1;
  const y1 = h - 1;
  const mid = w / 2;
  return `M ${mid} ${y0}`
    + ` H ${x1 - r} A ${r} ${r} 0 0 1 ${x1} ${y0 + r}`
    + ` V ${y1 - r} A ${r} ${r} 0 0 1 ${x1 - r} ${y1}`
    + ` H ${x0 + r} A ${r} ${r} 0 0 1 ${x0} ${y1 - r}`
    + ` V ${y0 + r} A ${r} ${r} 0 0 1 ${x0 + r} ${y0}`
    + ` H ${mid}`;
}

export type GenDevelopMode = 'image' | 'layer';

/**
 * 文字按卡片在屏幕上的宽高逐段脱落。
 * 阈值是半开区间且连续的：每个尺寸只落进一档，不靠「窄的优先」这种默认约定。
 */
export type MetaLevel = 'full' | 'phase' | 'time' | 'pip';

export function metaLevel(screenW: number, screenH: number): MetaLevel {
  if (screenW >= 240 && screenH >= 120) return 'full';
  if (screenW >= 160 && screenH >= 88) return 'phase';
  if (screenW >= 96 && screenH >= 56) return 'time';
  return 'pip';
}

/** 阶段词：让用户知道「现在在做什么」，不是只知道「等了几秒」。 */
export function phaseOf(pct: number, overtime: boolean, mode: GenDevelopMode): string {
  if (mode === 'layer') return '图层分离中';
  if (overtime) return '即将完成';
  if (pct >= 70) return '收尾';
  if (pct >= 22) return '显影';
  if (pct >= 4) return '构图';
  return '排队中';
}

export function GenDevelopLoader({
  createdAt,
  className,
  screenW,
  screenH,
  worldW,
  worldH,
  sizeLabel,
  mode = 'image',
}: {
  createdAt?: number;
  className?: string;
  /**
   * 卡片此刻在**屏幕上**的尺寸（世界尺寸 × zoom），决定底边那行留几段。
   * 不传（非画布宿主）就按全量显示。
   */
  screenW?: number;
  screenH?: number;
  /**
   * 卡片的**世界**尺寸，用来画等比正确的圆角矩形描边。
   * 不传就靠 ResizeObserver 量 —— 但 SSR / 静态渲染量不到，所以画布宿主一律显式传。
   */
  worldW?: number;
  worldH?: number;
  /** 底边那行的尺寸段，如 `1024 × 1024`。原来它是左上角一枚独立徽章，现在并进这一行。 */
  sizeLabel?: string;
  mode?: GenDevelopMode;
}) {
  ensureStyles();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  // 兜底起点固定在挂载时刻（不随每秒 now 漂移）：createdAt 缺失时若用 now 当起点，elapsed 恒为 0。
  const mountAtRef = useRef(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // 只有调用方没给世界尺寸时才量。clientWidth/Height 拿到的是未经 transform 的布局像素，
  // 正好就是世界尺寸；getBoundingClientRect 拿到的是屏幕像素，这里不能用。
  // useEffect 而不是 useLayoutEffect：后者在 SSR/静态渲染下会告警，而画布宿主一律显式传
  // worldW/worldH 走不到这条兜底路径，晚一帧拿到尺寸没有可感知代价。
  const needsMeasure = !(typeof worldW === 'number' && typeof worldH === 'number');
  useEffect(() => {
    if (!needsMeasure) return;
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const sync = () => setMeasured({ w: el.clientWidth, h: el.clientHeight });
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [needsMeasure]);

  const start = createdAt && createdAt > 0 ? createdAt : mountAtRef.current;
  const elapsedMs = Math.max(0, now - start);
  const estMs = getGenAvgMs();
  const elapsedS = Math.round(elapsedMs / 1000);
  const overtime = elapsedMs > estMs;
  // 封顶 95%：出图替换占位才算 100%，不做「卡 93%」式假精确。
  const pct = Math.min(95, Math.round((elapsedMs / estMs) * 100));
  const remainS = Math.max(1, Math.ceil((estMs - elapsedMs) / 1000));

  const level = metaLevel(
    typeof screenW === 'number' ? screenW : Number.POSITIVE_INFINITY,
    typeof screenH === 'number' ? screenH : Number.POSITIVE_INFINITY,
  );
  const phase = phaseOf(pct, overtime, mode);
  const timeText = overtime ? `已 ${elapsedS}s` : `还需约 ${remainS}s`;

  const box = needsMeasure ? measured : { w: worldW as number, h: worldH as number };
  const path = box && box.w > 2 && box.h > 2 ? framePath(box.w, box.h, 16) : null;

  return (
    <div
      ref={rootRef}
      className={`gen-dev${className ? ` ${className}` : ''}`}
      data-testid="generation-progress"
      // 缩到最小档时底边一行只剩一个点，靠文字找不到它。冒烟脚本按这个属性认模式。
      data-gen-mode={mode}
    >
      <div className="gen-dev__veil" />
      <div
        className="gen-dev__latent gen-dev__latent--coarse"
        // 粗格随进度让位给细格：这两个值是逐秒变化的状态，只能内联。
        // 走 CSS 变量而不是直接写 opacity —— 呼吸动画会压过 inline opacity（见上面的关键帧注释）。
        style={{ '--gen-dev-latent': String(0.35 + clamp01(1 - pct / 52) * 0.65) } as CSSProperties}
      />
      <div
        className="gen-dev__latent gen-dev__latent--fine"
        style={{ opacity: clamp01((pct - 18) / 46) * 0.95 }}
      />
      <div className="gen-dev__develop" />
      <div className="gen-dev__vignette" />
      {level !== 'pip' && <div className="gen-dev__scrim" />}

      <div
        className="gen-dev__meta"
        data-testid={mode === 'layer' ? 'frame-layering-badge' : 'generation-progress-meta'}
      >
        {level === 'pip' ? (
          <span className={`gen-dev__pip${overtime ? ' gen-dev__pip--over' : ''}`} />
        ) : (
          <>
            {level === 'full' && sizeLabel ? (
              <>
                <span className="gen-dev__size">{sizeLabel}</span>
                <span className="gen-dev__dot" />
              </>
            ) : null}
            {level === 'full' || level === 'phase' ? (
              <>
                <span className={`gen-dev__phase${overtime ? ' gen-dev__phase--over' : ''}`}>{phase}</span>
                <span className="gen-dev__dot" />
              </>
            ) : null}
            <span className="gen-dev__time">{timeText}</span>
          </>
        )}
      </div>

      {path ? (
        <svg
          className="gen-dev__frame"
          viewBox={`0 0 ${box!.w} ${box!.h}`}
          width={box!.w}
          height={box!.h}
          fill="none"
          aria-hidden
        >
          <path className="gen-dev__track" d={path} />
          <path
            className={`gen-dev__halo${overtime ? ' gen-dev__halo--over' : ''}`}
            d={path}
            pathLength={100}
            strokeDasharray={100}
            strokeDashoffset={100 - pct}
          />
          <path
            className={`gen-dev__arc${overtime ? ' gen-dev__arc--over' : ''}`}
            d={path}
            pathLength={100}
            strokeDasharray={100}
            strokeDashoffset={100 - pct}
          />
        </svg>
      ) : null}
    </div>
  );
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export default GenDevelopLoader;
