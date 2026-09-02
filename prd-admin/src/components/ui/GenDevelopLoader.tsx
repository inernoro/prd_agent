import { useEffect, useRef, useState, type RefObject } from 'react';
import { getGenAvgMs } from '@/lib/genTiming';
import { generationProgressPlacement } from './generationProgressPlacement';

// build-marker: gen-develop-loader v2 (2026-08-30) — 强制 chunk 重编译，冲掉 CDS 构建缓存

/**
 * GenDevelopLoader — 生图等待动效。
 *
 * 一句话主张：**进度画在画框上，不压在画面上；画面上只留一件大而慢的东西在动。**
 *
 * 三版的来龙去脉，写在这里免得下一个人再走一遍：
 *
 *  v0（GenSweepLoader）把「已耗时 / 预计」塞进一枚底部黑胶囊。那是整张卡最重、最实、
 *  最不透明的一块，讲的却是「关于产物的状态」而不是产物本身（违反 artifact-is-experience）；
 *  它还和 Frame 头部、图层面板按钮、左上角尺寸徽章一样按屏幕像素反缩放，四件东西抢同一张卡，
 *  缩放一低必打架 —— PR #1458 打的正是那个补丁。
 *
 *  v1 把胶囊拆了、把进度挪上画框（结构对了），但顺手把动效也换掉了：底纱压到 0.56、
 *  叠了两级潜像马赛克和暗角，横向大斜扫换成更窄的竖向带。用户看完的原话是
 *  「以前的版本更高级一些」。拆下来是两件事：主因是**表面变沉**（九层堆一起，从「轻」掉到「厚」），
 *  次因是**画框不动**（描边一秒才走 2%，肉眼就是一段静止的半截矩形边，读起来像边框画坏了）。
 *
 *  v2（本版）保留 v1 全部的结构收益，把材质换回 v0 那套：
 *   1. 卡面近乎透明（底纱 0.12）+ 一层 45 度细斜纹，一道 92% 宽的暖色柔光斜扫而过。
 *      「高级」的来源是**一件大而慢的东西在动，别的都不抢戏**，不是层数多。
 *   2. 进度仍是画框：描边从正上方顺时针合拢，并**替掉卡片自己的 border**（调用方不再画）。
 *      另有一颗光点沿整圈画框一直跑 —— 边不再是静止的。
 *   3. 文字仍是底边一行：尺寸 / 阶段 / 剩余时间合并成一处，上面两个角还给卡片；
 *      卡片在屏幕上越小，这一行从右往左逐段脱落（见 metaLevel），最后只剩一个点。
 *
 * 性能：持续变化的是两件——斜扫柔光（transform 位移，GPU 合成）与画框跑光
 * （stroke-dashoffset，绘制级动画）。跑光是这版唯一的非合成动画，画布上同时十几张
 * 占位卡时它是主要开销；换成 offset-path 能进合成层，但那条路在不支持的浏览器上
 * 会静默退化成「光点钉在左上角」，宁可要一个到处都对的实现。
 *
 * 可读性：字号 / 间距 / 描边按屏幕像素计量（复用画布逐帧更新的 --invZoom，不等 React 低频同步）；
 * 插入距离同时按百分比封顶，极小卡片上不会把内容挤成负宽度。
 *
 * 主题：画布舞台被钉死成暗色，所以配色走 tokens.css 的 --gen-wait-* 一族（那里写明了
 * 为什么不双写）。组件内零硬编码颜色。
 */

const STYLE_ID = 'gen-develop-loader-styles';

/**
 * 动画一律写在样式表里，**不写进 inline style**。
 * inline 声明压过作者样式表，`@media (prefers-reduced-motion)` 里的 `animation:none`
 * 会被静默无视 —— 那是一条看着有、其实从不生效的无障碍逃生门。
 */
export const GLOBAL_CSS = `
.gen-dev{position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none}
/* 底纱只压一点点：卡片是「留给那张图的一块地方」，不是一块黑砖。压太狠就沉了。 */
.gen-dev__veil{position:absolute;inset:0;background:var(--gen-wait-veil)}
.gen-dev__surface{position:absolute;inset:0;background:var(--gen-wait-surface)}
/* 斜向柔光：宽而软的一道光掠过表面，不是一条亮带。两端完全移出容器，循环处没有接缝。 */
.gen-dev__core{position:absolute;inset:0;background:var(--gen-wait-core);
  will-change:opacity,transform;animation:gen-dev-breathe 5.4s ease-in-out infinite}
.gen-dev__glare{position:absolute;top:-10%;bottom:-10%;left:0;width:58%;
  background:var(--gen-wait-develop);will-change:transform;
  animation:gen-dev-sweep 2.8s linear infinite}
@keyframes gen-dev-sweep{from{transform:translate3d(-110%,0,0)}to{transform:translate3d(210%,0,0)}}
@keyframes gen-dev-breathe{0%,100%{opacity:.5;transform:scale(.97)}50%{opacity:1;transform:scale(1.04)}}
@keyframes gen-dev-pulse{0%,100%{opacity:.5}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){
  .gen-dev__glare{animation:none;opacity:.5;transform:translate3d(5%,0,0)}
  .gen-dev__core{animation:none;opacity:.8;transform:none}
  .gen-dev__head{animation:none;opacity:1}
}
/* 画框：描边即进度。stroke-width 按屏幕像素恒定，所以 5% 缩放下它也还在，
   而原来那条 1 世界像素的 border 在 30% 以下就已经看不见了。
   **没有底轨**：底轨 + 进度弧 + 选中框三条线套在一起，用户原话「这三个边框给用户感觉
   就挺累的，我倾向于只显示 #D97757 的」。整个画框只留赤陶这一种颜色，卡片的边界由
   卡面本身的底纱与织纹交代，不需要再画一圈灰线去说「这里还有个矩形」。 */
.gen-dev__frame{position:absolute;inset:0;overflow:visible}
.gen-dev__halo{fill:none;stroke:var(--gen-wait-progress-halo);stroke-linecap:round;
  stroke-width:calc(8px * var(--invZoom,1));transition:stroke-dashoffset .7s ease-out}
.gen-dev__arc{fill:none;stroke:var(--gen-wait-progress);stroke-linecap:round;
  stroke-width:calc(3px * var(--invZoom,1));transition:stroke-dashoffset .7s ease-out}
.gen-dev__arc--over{stroke:var(--gen-wait-progress-over)}
.gen-dev__halo--over{stroke:var(--gen-wait-progress-over);opacity:.22}
/* 进度的**头部**：一小段更亮更粗的弧，钉在赤陶描边的最前端。
   它不自己绕圈——上一版那颗独立跑的光点和进度描边一样粗、一样亮，画框上于是有两道光，
   用户直接问「两根光柱分别代表什么意思」。一个画框只该有一个光，且它的位置就是进度。
   进度一秒才走 2%，肉眼近乎静止，所以这颗头靠**呼吸**活着，不靠位移。 */
.gen-dev__head{fill:none;stroke:var(--gen-wait-head);stroke-linecap:round;
  stroke-width:calc(4.5px * var(--invZoom,1));transition:stroke-dashoffset .7s ease-out;
  animation:gen-dev-pulse 1.7s ease-in-out infinite}
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

/** 进度头部那一小段亮弧的长度（pathLength 归一化后的单位，即整圈的百分之几）。 */
export const HEAD_LEN = 4;

/**
 * 从正上方出发、顺时针合拢的圆角矩形。
 * 起点定在上边中点而不是左上角：合拢过程左右对称，看着像画框自己在收口。
 *
 * `inset` 是距卡片边缘的**世界**像素。贴着边画会被选中态的蓝色选择框整个盖住
 * （那圈描边是 max(2, 4 * invZoom) 世界像素，屏幕上约 4~6px），于是卡片一被选中
 * 进度就彻底看不见了——用户截图里那条几乎看不出的橙线正是这个。
 */
export function framePath(w: number, h: number, radius: number, inset = 1): string {
  const d = Math.max(1, Math.min(inset, w / 2 - 2, h / 2 - 2));
  const r = Math.max(0, Math.min(radius, w / 2 - d, h / 2 - d));
  const x0 = d;
  const y0 = d;
  const x1 = w - d;
  const y1 = h - d;
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
  viewportRef,
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
  /**
   * 画布的裁切容器。传了就把底边那行夹在可见区域内：卡片被画布边缘裁掉一半时，
   * 那行字本来会跟着跑到看不见的地方去，用户就只剩一张什么都不说的图在转
   * （main 在 GenSweepLoader 上修过这件事，换成本组件时必须一起带过来，
   *  否则这次合并等于把那个修复删掉了）。夹紧算术走共享的
   *  generationProgressPlacement，两个宿主同一份。
   */
  viewportRef?: RefObject<HTMLElement | null>;
}) {
  ensureStyles();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const metaRef = useRef<HTMLDivElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null);
  // 兜底起点固定在挂载时刻（不随每秒 now 漂移）：createdAt 缺失时若用 now 当起点，elapsed 恒为 0。
  const mountAtRef = useRef(Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  /**
   * 底边那行必须留在画布的可见区域内。
   *
   * 卡片被画布边缘裁掉一半时，这行字会跟着跑到看不见的地方，用户就只剩一张
   * 什么都不说的图在转——尺寸、阶段、剩余时间三样全看不到。main 在上一版
   * loader（GenSweepLoader）上修过这件事，本组件替换它时必须把这条接线一起带过来，
   * 否则这次合并等于悄悄把那个修复删掉了。夹紧算术走共享的
   * generationProgressPlacement，两个宿主同一份，不各写一遍（形状 3）。
   *
   * 不传 viewportRef（普通卡片宿主，没有裁切容器）时整段不生效，保持原布局。
   */
  useEffect(() => {
    const root = rootRef.current;
    const meta = metaRef.current;
    const viewport = viewportRef?.current;
    if (!root || !meta || !viewport) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const rect = root.getBoundingClientRect();
      const bounds = viewport.getBoundingClientRect();
      const scale = rect.width / root.offsetWidth;
      if (!Number.isFinite(scale) || scale <= 0) return;
      const placement = generationProgressPlacement(rect, {
        left: Math.max(0, bounds.left), top: Math.max(0, bounds.top),
        right: Math.min(window.innerWidth, bounds.right), bottom: Math.min(window.innerHeight, bounds.bottom),
      }, meta.offsetHeight * scale);
      meta.style.visibility = placement ? 'visible' : 'hidden';
      if (!placement) return;
      meta.style.left = `${placement.left / scale}px`;
      meta.style.right = 'auto';
      meta.style.bottom = `${placement.bottom / scale}px`;
      meta.style.width = `${placement.width / scale}px`;
    };
    const schedule = () => { if (!frame) frame = window.requestAnimationFrame(place); };
    // 只观察祖先变换，不观察这一行自身的样式；否则测量与写入会互相触发成死循环。
    const transforms = new MutationObserver(schedule);
    for (let parent = root.parentElement; parent; parent = parent.parentElement) {
      transforms.observe(parent, { attributes: true, attributeFilter: ['style', 'class'] });
      if (parent === viewport) break;
    }
    const sizes = new ResizeObserver(schedule);
    sizes.observe(root);
    sizes.observe(viewport);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    schedule();
    return () => {
      transforms.disconnect();
      sizes.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [viewportRef]);

  // useEffect 而不是 useLayoutEffect：后者在 SSR/静态渲染下会告警，而画布宿主一律显式传
  // worldW/worldH 走不到这条兜底路径，晚一帧拿到尺寸没有可感知代价。
  // 只有调用方没给世界尺寸时才量。clientWidth/Height 拿到的是未经 transform 的布局像素，
  // 正好就是世界尺寸；getBoundingClientRect 拿到的是屏幕像素，这里不能用。
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
  // 画框内缩到选择框里侧：7 个**屏幕**像素换算回世界像素，另按卡片尺寸的 6% 封顶——
  // 极低缩放下 7/zoom 会大到把画框缩成卡中央的一个小盒子。
  const zoom = box && box.w > 0 && typeof screenW === 'number' ? screenW / box.w : 1;
  const insetWorld = box
    ? Math.max(1, Math.min(7 / Math.max(zoom, 0.02), Math.min(box.w, box.h) * 0.06))
    : 1;
  const path = box && box.w > 2 && box.h > 2
    ? framePath(box.w, box.h, Math.max(2, 16 - insetWorld), insetWorld)
    : null;

  return (
    <div
      ref={rootRef}
      className={`gen-dev${className ? ` ${className}` : ''}`}
      data-testid="generation-progress"
      // 缩到最小档时底边一行只剩一个点，靠文字找不到它。冒烟脚本按这个属性认模式。
      data-gen-mode={mode}
    >
      <div className="gen-dev__veil" />
      <div className="gen-dev__surface" />
      <div className="gen-dev__core" />
      <div className="gen-dev__glare" />
      {level !== 'pip' && <div className="gen-dev__scrim" />}

      <div
        ref={metaRef}
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
          {/* 头部：可见段落在 [pct-HEAD_LEN, pct]，即描边的最前端。
              dash 周期 = HEAD_LEN + 间隔 = 100，所以 offset 加 100 与不加等价，
              这里加上只为避开负数。单位是 pathLength 归一化后的，与卡片尺寸无关。 */}
          <path
            className="gen-dev__head"
            d={path}
            pathLength={100}
            strokeDasharray={`${HEAD_LEN} ${100 - HEAD_LEN}`}
            strokeDashoffset={100 + HEAD_LEN - pct}
          />
        </svg>
      ) : null}
    </div>
  );
}

export default GenDevelopLoader;
