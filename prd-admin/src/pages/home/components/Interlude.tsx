import { Reveal } from './Reveal';
import { useParallax } from './scrollRhythm';
import { SCENE, inkTone } from '../scenes/sceneTokens';

/**
 * Interlude —— 幕间换气。
 *
 * 九幕连着排，每一幕都是「标题 + 一块面板」，读到第四幕眼睛就麻了 —— 不是哪一幕
 * 做得不好，是**没有停顿**。变体（`SceneVariant`）能让每幕长得不一样，但解决不了
 * 「一直在给你看东西」这件事。
 *
 * 所以插两页什么都不给看的：通栏、无面板、无边框，只有一句大字和一行小字。
 * 它同时干两件事 —— 让眼睛歇一拍，以及把上下文串起来（上面讲完了什么、
 * 下面要讲什么）。
 *
 * 层次上它是**最深的一层**：视差速度给到 -0.09（比任何一幕的引言都快），
 * 滚过它的时候会明显感到这块比左右两幕"远"，于是它读起来像背景板而不是又一幕。
 */

interface InterludeProps {
  /** 品类色相：取下一幕的色，视觉上就是"下面要讲这个" */
  hue: number;
  kicker: string;
  title: string;
  note?: string;
  id?: string;
}

export function Interlude({ hue, kicker, title, note, id }: InterludeProps) {
  const tone = inkTone(hue);
  const ref = useParallax<HTMLDivElement>({ speed: -0.09 });

  return (
    <section
      id={id}
      className="relative px-4 sm:px-6 py-16 md:py-24"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      {/* 一条贯穿的细线：换气页没有面板，靠它把左右两幕在视觉上接住 */}
      <div
        aria-hidden
        className="absolute left-0 right-0 top-0 h-px pointer-events-none"
        style={{ background: `linear-gradient(90deg, transparent, ${tone.border} 22%, ${tone.border} 78%, transparent)` }}
      />
      <div ref={ref} className="max-w-[1080px] mx-auto flex flex-col items-center text-center gap-5">
        <Reveal offset={16} duration={1600}>
          <span
            className="inline-flex items-center gap-2 uppercase"
            style={{
              fontFamily: 'var(--font-terminal)',
              fontSize: '15px',
              letterSpacing: '0.2em',
              color: SCENE.inkFaint,
            }}
          >
            <span className="block w-[5px] h-[5px] rounded-full" style={{ background: tone.solid }} />
            {kicker}
          </span>
        </Reveal>

        <Reveal offset={24} duration={2000} delay={90}>
          <p
            style={{
              fontFamily: 'var(--font-display)',
              fontSize: 'clamp(1.6rem, 3.6vw, 2.6rem)',
              fontWeight: 500,
              lineHeight: 1.4,
              letterSpacing: '-0.02em',
              color: SCENE.inkSoft,
              // 28ch 而非 24ch：ch 按 '0' 的宽度算，中文字形更宽，
              // 24ch 会把「东西」两个字挤到第二行单独站着
              maxWidth: '28ch',
            }}
          >
            {title}
          </p>
        </Reveal>

        {note && (
          <Reveal offset={12} duration={1600} delay={200}>
            <p style={{ fontSize: '12.5px', lineHeight: 1.8, color: SCENE.inkFaint, maxWidth: '40em' }}>
              {note}
            </p>
          </Reveal>
        )}
      </div>
    </section>
  );
}
