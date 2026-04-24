import { MessageSquare, Cpu, Waves, Workflow } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Reveal } from '../components/Reveal';
import { SectionHeader } from '../components/SectionHeader';
import { useLanguage } from '../contexts/LanguageContext';
import type { HowStep } from '../i18n/landing';

/**
 * HowItWorks — 幕 5 · 三步流程（i18n 接入）
 *
 * 三张横排卡片；每一步分 3 级 stagger reveal（数字 → 标题 → demo 行）。
 */

const STEP_ICONS: LucideIcon[] = [MessageSquare, Cpu, Waves];
const STEP_ACCENTS = ['#6ee4ff', '#a78bfa', '#f472b6'];

export function HowItWorks() {
  const { t } = useLanguage();

  return (
    <section
      className="relative py-28 md:py-36 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-6xl mx-auto mb-20 md:mb-24">
        <SectionHeader
          Icon={Workflow}
          eyebrow={t.how.eyebrow}
          accent="#f472b6"
          title={t.how.title}
        />
      </div>

      <div className="max-w-6xl mx-auto">
        <div className="grid md:grid-cols-3 gap-4 md:gap-6 relative">
          <div
            className="hidden md:block absolute top-[90px] left-[16%] right-[16%] h-px pointer-events-none"
            style={{
              background:
                'linear-gradient(90deg, transparent 0%, rgba(167, 139, 250, 0.4) 20%, rgba(167, 139, 250, 0.4) 50%, rgba(244, 114, 182, 0.4) 80%, transparent 100%)',
            }}
          />

          {t.how.steps.map((step, i) => (
            <Reveal key={step.n} delay={i * 140} offset={24}>
              <StepCard
                step={step}
                Icon={STEP_ICONS[i]}
                accent={STEP_ACCENTS[i]}
              />
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function StepCard({
  step,
  Icon,
  accent,
}: {
  step: HowStep;
  Icon: LucideIcon;
  accent: string;
}) {
  const { n, title, description, demo } = step;
  return (
    <div
      className="relative p-6 rounded-2xl bg-white/[0.02] border backdrop-blur-sm"
      style={{ borderColor: 'rgba(255, 255, 255, 0.08)' }}
    >
      <div className="relative z-10 mb-6 flex items-center gap-4">
        <div
          className="w-12 h-12 rounded-xl flex items-center justify-center relative"
          style={{
            background: `linear-gradient(135deg, ${accent}22 0%, ${accent}08 100%)`,
            border: `1px solid ${accent}44`,
            boxShadow: `0 0 32px -8px ${accent}`,
          }}
        >
          <Icon className="w-5 h-5" style={{ color: accent }} />
        </div>
        <div
          className="text-[44px] font-light leading-none"
          style={{
            fontFamily: 'var(--font-display)',
            color: `${accent}40`,
            letterSpacing: '-0.04em',
          }}
        >
          {n}
        </div>
      </div>

      <h3
        className="text-[22px] text-white font-medium mb-3"
        style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.01em' }}
      >
        {title}
      </h3>

      <p className="text-[13px] text-white/60 leading-[1.7] mb-6">{description}</p>

      <div
        className="px-3.5 py-2.5 rounded-lg bg-black/30 border border-white/[0.06] font-mono text-[11px] text-white/65"
        style={{ letterSpacing: '0.01em' }}
      >
        <span className="select-none" style={{ color: accent }}>
          ›{' '}
        </span>
        {demo}
      </div>
    </div>
  );
}
