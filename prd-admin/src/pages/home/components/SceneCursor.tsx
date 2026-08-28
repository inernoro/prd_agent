import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { SCENE } from '../scenes/sceneTokens';

/**
 * 演示用的鼠标指针 —— 让每一幕看起来是「有人在操作」，而不是「东西自己在变」。
 *
 * 之前每一幕都是状态自己翻转：图凭空出现、文字凭空被选中。看的人能看出在动，
 * 但看不出**是谁让它动的**。补一枚会走位、会按下的指针，动作就有了主语。
 *
 * 落点**只认真实元素，不认手写坐标**。第一版是给每一拍写一对百分比，结果指针
 * 全程落在空处：那些百分比是相对整块面板量的，而画布上的图活在一个
 * `lg:right-[444px]` 的子容器里 —— 两套坐标系差着一整个对话面板的宽度，怎么调
 * 都对不上。所以这一版反过来：每一拍只说**指向谁**（目标元素上的
 * `data-cursor-target`），落点由 `getBoundingClientRect` 当场量。元素挪了、
 * 换了断点、面板缩放了，指针跟着走，不需要有人回来改数字。
 *
 * 三条约定：
 *
 * 1. **先走到，再发生**。指针到位与状态翻转之间留一拍，顺序是「移过去 → 按下 →
 *    然后那件事才发生」。反过来（东西先变、指针后到）比没有指针更假。
 * 2. **落点来自真实元素**，不写死坐标（理由见上）。
 * 3. **`prefers-reduced-motion` 下整枚不渲染**：它纯粹是动效，关掉动效的人不需要
 *    一枚静止的箭头杵在画面中间（内容一个都不能少，但装饰可以少）。
 */

export interface CursorSpot {
  /** 指向谁：目标元素上 `data-cursor-target` 的值 */
  target: string;
  /** 落点在目标框里的相对位置（0=左/上，1=右/下），默认正中偏左上一点，像真手停的地方 */
  ax?: number;
  ay?: number;
  /** 这一拍是否处于「按下」状态（画一圈按下波纹） */
  press?: boolean;
  /** 这一拍是否隐藏指针（比如还没开始操作，或已经离开面板） */
  hidden?: boolean;
}

/** 指针本体的箭头路径（macOS 风格实心箭头 + 描边，深浅底上都看得见）。 */
const ARROW = 'M3 2l14 10.2-6.1.5 3.4 6.7-2.6 1.3-3.4-6.8L3 18.6z';

interface Pos { left: number; top: number }

export function SceneCursor({
  spot,
  /** 当前拍号。只用来给「按下」这一次手势做 key —— 连着两拍都按下时（视觉幕的
   *  选中 → 混合就是），元素不换 key 的话动画不会重放，第二次点击看着像没发生。 */
  beat,
  /** 走位时长；跟着这一幕的节拍走，别比它自己那一拍还长 */
  travelMs = 460,
  style,
}: {
  spot: CursorSpot | null;
  beat: number;
  travelMs?: number;
  style?: CSSProperties;
}) {
  const hostRef = useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const prevPos = useRef<Pos | null>(null);

  const target = spot?.target ?? null;
  const ax = spot?.ax ?? 0.5;
  const ay = spot?.ay ?? 0.5;

  useLayoutEffect(() => {
    const anchor = hostRef.current;
    if (!anchor || !target) return undefined;
    // offsetParent = 最近的定位祖先，也就是这一幕的面板根。目标必须在同一个面板里，
    // 否则量出来的偏移没有意义（窄屏时对话面板挪到了面板外面，就属于这种情况）。
    const host = anchor.offsetParent as HTMLElement | null;
    if (!host) return undefined;

    let raf = 0;
    const measure = () => {
      const el = host.querySelector<HTMLElement>(`[data-cursor-target="${CSS.escape(target)}"]`);
      if (!el) { setPos(null); return; }
      // 目标是跨行的行内内容（比如被划中的那一段文字）时，getBoundingClientRect 给的是
      // 整个段落块 —— 落在它的 94% 宽处就是最后一行右边的空白里，看着像指针飘着。
      // 取**最后一个行框**，`ax:1` 才真的落在「划到的那个字」后面。
      const rects = el.getClientRects();
      const t = rects.length > 1 ? rects[rects.length - 1] : el.getBoundingClientRect();
      const h = host.getBoundingClientRect();
      if (t.width === 0 || t.height === 0) { setPos(null); return; }
      setPos({ left: t.left - h.left + t.width * ax, top: t.top - h.top + t.height * ay });
    };

    measure();
    // 目标可能和指针同一拍出现（这一帧还没挂上），补量一次
    raf = requestAnimationFrame(measure);

    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, [target, ax, ay]);

  // 这一拍有没有换落点。换了 → 波纹要等它走到再扩散，否则就成了「东西先响、
  // 指针后到」，比没有指针更假（见上面第 1 条约定）。
  // 记上一拍的落点走 effect 而不是渲染期改 ref：StrictMode 会重复渲染，
  // 渲染期写 ref 的话第二遍就把「刚才在哪」冲成了「现在在哪」，moved 恒 false。
  const prev = prevPos.current;
  useEffect(() => { prevPos.current = pos; }, [pos]);
  const moved = !!pos && !!prev && (Math.abs(prev.left - pos.left) > 2 || Math.abs(prev.top - pos.top) > 2);
  /*
   * 第一次量到落点的那一帧不能有过渡。没量到时 left/top 兜底写 0，一旦量到就会从
   * 面板左上角滑过来 —— 那一拍要是正好要按下（知识库「划中一句话」就是），
   * 波纹会在半路上响，衔接录像机也会把它记成「按在空处」。
   * 首次出现直接就位，之后的走位才走过渡。
   */
  const appearing = !!pos && prev === null;

  // 量不到目标就整枚收起来：宁可没有指针，也不要一枚指着空处的箭头
  const on = !!spot && !spot.hidden && !!pos;

  const pressDelay = moved ? `${travelMs}ms` : '0ms';

  return (
    <span
      ref={hostRef}
      aria-hidden
      // 整拍都挂着的机读信号。**给工具看的，不是给眼睛看的**：按下的视觉是一次
      // 260ms 的手势，而无头浏览器在这台机器上约 400ms 才出一帧，判据挂在动画上
      // 必然采空（第一版就是这么把「按下 0 次」测出来的）。属性不受帧率影响。
      data-scene-press={on && spot?.press ? '1' : undefined}
      data-scene-cursor-on={on ? '1' : '0'}
      className="absolute pointer-events-none map-scene-anim"
      style={{
        left: `${pos?.left ?? 0}px`,
        top: `${pos?.top ?? 0}px`,
        // z 要压过面板里的卡片，但别压过旁白条
        zIndex: 20,
        opacity: on ? 1 : 0,
        transform: 'translate(-2px, -2px)',
        transition: appearing
          ? 'opacity .32s ease'
          : `left ${travelMs}ms cubic-bezier(.32,.72,.24,1), top ${travelMs}ms cubic-bezier(.32,.72,.24,1),`
            + ` opacity .32s ease`,
        ...style,
      }}
    >
      {/*
        按下是**一次完整的手势**：按下去、弹回来。
        上一版把 scale(0.88) 挂在整拍上，那一拍有 1-2.2 秒，看着像鼠标键被摁住不放。

        key 用拍号：视觉幕的「选中 → 混合」是连着两拍都按下，元素不换 key 的话
        CSS 动画不会重放，第二次点击在画面上等于没发生。
      */}
      <span
        key={beat}
        className="block"
        style={on && spot?.press
          ? { animation: 'mapSceneCursorClick .26s cubic-bezier(.32,.72,.24,1) both', animationDelay: pressDelay }
          : undefined}
      >
        {/* 按下波纹：跟手势同一个延迟，扩散一次就没 */}
        {on && spot?.press && (
          <span
            className="absolute block rounded-full"
            style={{
              left: '-11px', top: '-11px', width: '30px', height: '30px',
              border: `1.5px solid ${SCENE.ink}`,
              animation: 'mapSceneCursorPress .5s cubic-bezier(.19,1,.22,1) both',
              animationDelay: pressDelay,
            }}
          />
        )}
        <svg width="20" height="22" viewBox="0 0 20 22" style={{ display: 'block', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.55))' }}>
          <path d={ARROW} fill={SCENE.ink} stroke={SCENE.base} strokeWidth="1.4" strokeLinejoin="round" />
        </svg>
      </span>
    </span>
  );
}

/**
 * 文本选区高亮 —— 「鼠标划过这一句」的那道底色。
 *
 * 单独抽出来是因为两幕都要用：文学创作里划中一句话再改写，视觉创作里选中一块提示词。
 * 用 `::selection` 那种真实选区做不到——它要求真的有文本选择行为，而这里是演给人看的。
 */
export function SelectionSweep({
  active,
  /** 从 0 到 1 的展开进度；给动画用，不给它就一次铺满 */
  progress = 1,
  hue,
  /** 给指针当落点用的名字。标在**行内内容**上，不是外面的块级容器 ——
   *  指针要停在划到的那个字后面，而不是段落框右边的空白里 */
  targetId,
  children,
}: {
  active: boolean;
  progress?: number;
  hue: string;
  targetId?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="relative">
      <span
        aria-hidden
        className="absolute pointer-events-none"
        style={{
          left: '-2px', top: '-1px', bottom: '-1px',
          width: active ? `calc(${Math.round(progress * 100)}% + 4px)` : 0,
          background: hue,
          borderRadius: '3px',
          transition: 'width .62s cubic-bezier(.32,.72,.24,1), opacity .3s ease',
          opacity: active ? 1 : 0,
        }}
      />
      <span data-cursor-target={targetId} className="relative">{children}</span>
    </span>
  );
}
