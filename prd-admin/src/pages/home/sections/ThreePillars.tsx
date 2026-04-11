import type { ReactNode } from 'react';
import { Layers, Network, Monitor, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Reveal } from '../components/Reveal';
import { SectionHeader } from '../components/SectionHeader';
import { useLanguage } from '../contexts/LanguageContext';
import type { Pillar } from '../i18n/landing';

/**
 * ThreePillars — 幕 · 三大支柱
 *
 * 对标 Linear.app 的 "A new species of product tool" 段落：
 *   · 顶部 eyebrow + 大编辑式标题 + 副标
 *   · 三列等宽 grid，每列：fig 标签 + 线框 wireframe 示意 +
 *     h3 标题 + 描述，列间有极细的竖向分割线
 *   · 宽容器 max-w-[1240px]，不拘束在中心
 *   · 单色 wireframe（白灰，不用 AI 紫），编辑性大于装饰性
 */

const PILLAR_ICONS: Record<string, LucideIcon> = {
  'one-workbench': Layers,
  'any-model': Network,
  'native-everywhere': Monitor,
};

export function ThreePillars() {
  const { t } = useLanguage();
  const titleParts = t.pillars.title.split('\n');

  return (
    <section
      className="relative py-28 md:py-40 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-[1240px] mx-auto">
        {/* Editorial header */}
        <div className="mb-20 md:mb-28">
          <SectionHeader
            Icon={Sparkles}
            eyebrow={t.pillars.eyebrow}
            accent="#cbd5e1"
            title={
              <>
                {titleParts[0]}
                {titleParts.length > 1 && (
                  <>
                    <br />
                    {titleParts[1]}
                  </>
                )}
              </>
            }
            subtitle={t.pillars.subtitle}
            subtitleMaxWidth="48rem"
          />
        </div>

        {/* Three-column grid */}
        <div className="grid md:grid-cols-3 relative">
          {/* 垂直分割线（仅 md+） */}
          <div
            className="hidden md:block absolute inset-y-0 left-1/3 w-px pointer-events-none"
            style={{
              background:
                'linear-gradient(180deg, transparent 0%, rgba(255, 255, 255, 0.08) 20%, rgba(255, 255, 255, 0.08) 80%, transparent 100%)',
            }}
          />
          <div
            className="hidden md:block absolute inset-y-0 left-2/3 w-px pointer-events-none"
            style={{
              background:
                'linear-gradient(180deg, transparent 0%, rgba(255, 255, 255, 0.08) 20%, rgba(255, 255, 255, 0.08) 80%, transparent 100%)',
            }}
          />

          {t.pillars.items.map((pillar, i) => (
            <Reveal key={pillar.id} delay={i * 160} offset={28}>
              <PillarColumn
                pillar={pillar}
                Icon={PILLAR_ICONS[pillar.id] ?? Layers}
              />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function PillarColumn({
  pillar,
  Icon,
}: {
  pillar: Pillar;
  Icon: LucideIcon;
}) {
  const { figLabel, title, description } = pillar;

  return (
    <div className="relative px-8 md:px-10 py-10 flex flex-col">
      {/* fig 标签 —— Linear 签名元素 */}
      <div
        className="text-[10px] uppercase text-white/35 mb-7"
        style={{
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.22em',
        }}
      >
        {figLabel}
      </div>

      {/* Wireframe illustration —— 单色，ghost outline */}
      <WireframeIllustration Icon={Icon} />

      {/* Title */}
      <h3
        className="text-white font-medium mt-10 mb-4"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 'clamp(1.25rem, 1.6vw, 1.625rem)',
          lineHeight: 1.2,
          letterSpacing: '-0.01em',
        }}
      >
        {title}
      </h3>

      {/* Description */}
      <p
        className="text-[13.5px] text-white/52 leading-[1.75]"
        style={{ fontFamily: 'var(--font-body)' }}
      >
        {description}
      </p>
    </div>
  );
}

/**
 * WireframeIllustration — 简约线框 3D 示意
 *
 * 用 Lucide icon 放大 + 外层 grid pattern 模拟 Linear 的 3D wireframe
 * 效果。不用真正的 3D，避免引入 three.js。
 */
function WireframeIllustration({ Icon }: { Icon: LucideIcon }): ReactNode {
  return (
    <div
      className="relative w-full aspect-[5/3] rounded-xl overflow-hidden flex items-center justify-center"
      style={{
        background:
          'linear-gradient(180deg, rgba(255, 255, 255, 0.02) 0%, rgba(255, 255, 255, 0) 100%)',
        border: '1px solid rgba(255, 255, 255, 0.06)',
      }}
    >
      {/* Grid pattern underneath */}
      <div
        className="absolute inset-0 opacity-60"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255, 255, 255, 0.05) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255, 255, 255, 0.05) 1px, transparent 1px)
          `,
          backgroundSize: '22px 22px',
          maskImage:
            'radial-gradient(ellipse 70% 65% at 50% 50%, black 0%, transparent 100%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 70% 65% at 50% 50%, black 0%, transparent 100%)',
        }}
      />

      {/* Center icon ghost */}
      <div
        className="relative z-10 flex items-center justify-center w-20 h-20 rounded-xl"
        style={{
          background:
            'linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.01))',
          border: '1px solid rgba(255, 255, 255, 0.12)',
          boxShadow: '0 8px 32px -8px rgba(0, 0, 0, 0.6), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
        }}
      >
        <Icon className="w-9 h-9" strokeWidth={1.25} style={{ color: 'rgba(226, 232, 240, 0.85)' }} />
      </div>

      {/* Corner ticks（fig 标注风） */}
      <Tick position="tl" />
      <Tick position="tr" />
      <Tick position="bl" />
      <Tick position="br" />
    </div>
  );
}

function Tick({ position }: { position: 'tl' | 'tr' | 'bl' | 'br' }) {
  const styles: Record<typeof position, React.CSSProperties> = {
    tl: { top: '10px', left: '10px' },
    tr: { top: '10px', right: '10px' },
    bl: { bottom: '10px', left: '10px' },
    br: { bottom: '10px', right: '10px' },
  };
  return (
    <div
      className="absolute w-3 h-3 pointer-events-none"
      style={{
        ...styles[position],
        borderTop:
          position === 'tl' || position === 'tr'
            ? '1px solid rgba(255, 255, 255, 0.22)'
            : undefined,
        borderBottom:
          position === 'bl' || position === 'br'
            ? '1px solid rgba(255, 255, 255, 0.22)'
            : undefined,
        borderLeft:
          position === 'tl' || position === 'bl'
            ? '1px solid rgba(255, 255, 255, 0.22)'
            : undefined,
        borderRight:
          position === 'tr' || position === 'br'
            ? '1px solid rgba(255, 255, 255, 0.22)'
            : undefined,
      }}
    />
  );
}
