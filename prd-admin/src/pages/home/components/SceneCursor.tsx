import { useEffect, useRef, type CSSProperties } from 'react';
import { SCENE } from '../scenes/sceneTokens';

/**
 * 演示用的鼠标指针 —— 让每一幕看起来是「有人在操作」，而不是「东西自己在变」。
 *
 * 之前每一幕都是状态自己翻转：图凭空出现、文字凭空被选中。看的人能看出在动，
 * 但看不出**是谁让它动的**。补一枚会走位、会按下的指针，动作就有了主语。
 *
 * 三条约定：
 *
 * 1. **先走到，再发生**。指针到位与状态翻转之间留一拍，顺序是「移过去 → 按下 →
 *    然后那件事才发生」。反过来（东西先变、指针后到）比没有指针更假。
 * 2. **坐标用百分比**，跟着面板缩放走。面板在手机上会变窄，写死 px 会飘到框外。
 * 3. **`prefers-reduced-motion` 下整枚不渲染**：它纯粹是动效，关掉动效的人不需要
 *    一枚静止的箭头杵在画面中间（内容一个都不能少，但装饰可以少）。
 */

export interface CursorSpot {
  /** 落点，面板宽高的百分比 */
  x: number;
  y: number;
  /** 这一拍是否处于「按下」状态（画一圈按下波纹） */
  press?: boolean;
  /** 这一拍是否隐藏指针（比如还没开始操作，或已经离开面板） */
  hidden?: boolean;
}

/** 指针本体的箭头路径（macOS 风格实心箭头 + 描边，深浅底上都看得见）。 */
const ARROW = 'M3 2l14 10.2-6.1.5 3.4 6.7-2.6 1.3-3.4-6.8L3 18.6z';

export function SceneCursor({
  spot,
  /** 走位时长；跟着这一幕的节拍走，别比它自己那一拍还长 */
  travelMs = 460,
  style,
}: {
  spot: CursorSpot | null;
  travelMs?: number;
  style?: CSSProperties;
}) {
  // 这一拍有没有换落点。换了 → 波纹要等它走到再扩散，否则就成了「东西先响、
  // 指针后到」，比没有指针更假（见文件头第 1 条约定）。
  // 记上一拍的落点走 effect 而不是渲染期改 ref：StrictMode 会重复渲染，
  // 渲染期写 ref 的话第二遍就把「刚才在哪」冲成了「现在在哪」，moved 恒 false。
  const last = useRef<string | null>(null);
  const here = spot ? `${spot.x},${spot.y}` : null;
  const prev = last.current;
  useEffect(() => { last.current = here; }, [here]);
  const moved = here !== null && prev !== null && prev !== here;

  if (!spot) return null;
  const on = !spot.hidden;

  return (
    <span
      aria-hidden
      className="absolute pointer-events-none map-scene-anim"
      style={{
        left: `${spot.x}%`,
        top: `${spot.y}%`,
        // z 要压过面板里的卡片，但别压过旁白条
        zIndex: 20,
        opacity: on ? 1 : 0,
        transform: `translate(-2px, -2px) scale(${spot.press ? 0.88 : 1})`,
        transition: `left ${travelMs}ms cubic-bezier(.32,.72,.24,1), top ${travelMs}ms cubic-bezier(.32,.72,.24,1),`
          + ` opacity .32s ease, transform .18s ease`,
        ...style,
      }}
    >
      {/* 按下波纹：只在 press 那一拍出现，扩散一次就没 */}
      {spot.press && (
        <span
          className="absolute block rounded-full"
          style={{
            left: '-11px', top: '-11px', width: '30px', height: '30px',
            border: `1.5px solid ${SCENE.ink}`,
            animation: 'mapSceneCursorPress .5s cubic-bezier(.19,1,.22,1) both',
            animationDelay: moved ? `${travelMs}ms` : '0ms',
          }}
        />
      )}
      <svg width="20" height="22" viewBox="0 0 20 22" style={{ display: 'block', filter: 'drop-shadow(0 2px 4px rgba(0,0,0,.55))' }}>
        <path d={ARROW} fill={SCENE.ink} stroke={SCENE.base} strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
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
  children,
}: {
  active: boolean;
  progress?: number;
  hue: string;
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
      <span className="relative">{children}</span>
    </span>
  );
}
