import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { Reveal } from '../components/Reveal';
import { SCENE, SCENE_KEYFRAMES, inkTone } from './sceneTokens';

/**
 * SceneFrame —— 四幕「真实面板」场景共用的外壳。
 *
 * 每一幕的版式都是同一件事：左边一段编辑式引言（品类点 + eyebrow + 大标题 + 一句描述），
 * 下面是一整块**按真实产品面板复刻**的展示区，底部一行注记说明这块在讲什么。
 *
 * 之所以抽出来：四幕的引言排版一模一样，散着写必然各自漂移（间距、字号、
 * 色相点的大小）。这里是它们的唯一定义处。
 */

const KEYFRAMES_ID = 'map-scene-keyframes';

/** 场景动画的 @keyframes 只注入一次。 */
function useSceneKeyframes() {
  useEffect(() => {
    if (document.getElementById(KEYFRAMES_ID)) return;
    const style = document.createElement('style');
    style.id = KEYFRAMES_ID;
    style.textContent = SCENE_KEYFRAMES;
    document.head.appendChild(style);
  }, []);
}

interface SceneFrameProps {
  /** 品类色相（墨系色带的度数） */
  hue: number;
  eyebrow: string;
  /** 标题的强调后半句 —— 用品类色染色 */
  title: ReactNode;
  description: ReactNode;
  /** 面板下方的一行注记：这块在讲什么、可以怎么玩 */
  note?: ReactNode;
  /** 面板本体 */
  children: ReactNode;
  /** 面板高度（桌面）——各幕不同，由调用方给 */
  panelStyle?: CSSProperties;
  id?: string;
}

export function SceneFrame({
  hue,
  eyebrow,
  title,
  description,
  note,
  children,
  panelStyle,
  id,
}: SceneFrameProps) {
  useSceneKeyframes();
  const tone = inkTone(hue);

  return (
    <section id={id} className="relative py-14 md:py-20 px-4 sm:px-6" style={{ fontFamily: 'var(--font-body)' }}>
      <div className="max-w-[1280px] mx-auto">
        {/* ── 引言：左标题 / 右描述，宽屏并排，窄屏堆叠 ── */}
        <Reveal offset={20} duration={1600}>
          <div className="flex flex-col lg:flex-row lg:items-end gap-5 lg:gap-10 mb-8 md:mb-10">
            <div className="shrink-0">
              <div
                className="flex items-center gap-2 uppercase"
                style={{
                  fontFamily: 'var(--font-terminal)',
                  fontSize: '15px',
                  letterSpacing: '0.18em',
                  color: SCENE.inkFaint,
                }}
              >
                <span
                  className="block w-[5px] h-[5px] rounded-full shrink-0"
                  style={{ background: tone.solid }}
                />
                {eyebrow}
              </div>
              <h2
                className="mt-2.5 font-medium"
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'clamp(1.75rem, 3.2vw, 2.3rem)',
                  lineHeight: 1.34,
                  letterSpacing: '-0.02em',
                  color: SCENE.ink,
                }}
              >
                {title}
              </h2>
            </div>
            <p
              className="lg:pb-1.5"
              style={{
                fontSize: '13.5px',
                lineHeight: 1.8,
                color: SCENE.inkMid,
                maxWidth: '29em',
              }}
            >
              {description}
            </p>
          </div>
        </Reveal>

        {/* ── 面板本体 ── */}
        <Reveal offset={36} duration={2200} delay={120}>
          <div
            className="relative overflow-hidden rounded-2xl"
            style={{
              border: `1px solid ${SCENE.edge}`,
              background: SCENE.canvas,
              boxShadow: SCENE.liftLg,
              ...panelStyle,
            }}
          >
            {/* 品类色渗光：左上角一小片，点明这一幕属于哪支色 */}
            <div
              className="absolute inset-0 pointer-events-none"
              style={{
                background: `radial-gradient(360px 190px at 5% 0%, ${tone.faint} 0%, transparent 100%)`,
              }}
            />
            {children}
          </div>
        </Reveal>

        {note && (
          <Reveal offset={12} duration={1600} delay={240}>
            <p
              className="mt-4"
              style={{ fontSize: '12px', lineHeight: 1.75, color: SCENE.inkFaint, maxWidth: '54em' }}
            >
              {note}
            </p>
          </Reveal>
        )}
      </div>
    </section>
  );
}

/**
 * 旁白条 —— 一幕在演的时候，告诉观众此刻在发生什么。
 *
 * 光让画面动起来还不够：没有旁白，一堆东西自己在变只会读成「乱动」。
 * 一行随节拍换的句子 + 一排节拍点，把它从「动画」变成「有人在给你演示」
 * （`expectation-management`：用户任何时刻都该知道现在在发生什么）。
 *
 * 换句时不做上下滚动，只做淡入 —— 文字位移在小字号上抖得厉害。
 */
export function BeatNarration({ beats, beat, hue }: { beats: string[]; beat: number; hue: number }) {
  const tone = inkTone(hue);
  return (
    <div
      className="flex items-center gap-3 flex-wrap"
      style={{ padding: '11px 16px', borderTop: `1px solid ${SCENE.hair}` }}
    >
      <span
        className="block w-[6px] h-[6px] rounded-full shrink-0 map-scene-anim"
        style={{ background: tone.solid, animation: 'mapSceneTwinkle 1.9s ease-in-out infinite' }}
      />
      {/* key 换了才会重播淡入；min-height 钉死，避免换句时整条抖一下 */}
      <span
        key={beat}
        className="min-w-0"
        style={{
          fontSize: '12.5px',
          lineHeight: 1.5,
          color: SCENE.inkSoft,
          animation: 'mapSceneBeatIn .42s cubic-bezier(.19,1,.22,1) both',
        }}
      >
        {beats[beat] ?? beats[beats.length - 1]}
      </span>
      <span className="ml-auto flex items-center gap-1.5 shrink-0">
        {beats.map((label, i) => (
          <span
            key={label}
            style={{
              width: i === beat ? '14px' : '5px',
              height: '5px',
              borderRadius: '999px',
              background: i === beat ? tone.solid : i < beat ? tone.border : SCENE.line,
              transition: 'width .35s cubic-bezier(.19,1,.22,1), background .35s ease',
            }}
          />
        ))}
      </span>
    </div>
  );
}

/** 场景里反复出现的 VT323 眉标（模型名 / 计时 / 状态）。 */
export function SceneMono({
  children,
  color = SCENE.inkFaint,
  size = 14,
  className,
  style,
}: {
  children: ReactNode;
  color?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      className={className}
      style={{
        fontFamily: 'var(--font-terminal)',
        fontSize: `${size}px`,
        letterSpacing: '0.1em',
        color,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

/** 24px 线性图标：场景里所有图标都走这一个（统一线宽与端点，避免各处漂移）。 */
export function SceneIcon({
  d,
  size = 14,
  strokeWidth = 1.8,
  style,
}: {
  d: string;
  size?: number;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0, ...style }}
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
