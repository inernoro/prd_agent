import { Reveal } from '../components/Reveal';
import { useLanguage } from '../contexts/LanguageContext';

/**
 * StatsStrip — 幕 2 · 极简大数字
 *
 * 数据来自 i18n 字典；每个数字独立 Reveal fade-up stagger 80ms。
 */
export function StatsStrip() {
  const { t } = useLanguage();

  return (
    <section
      className="relative py-28 md:py-36 px-6"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-y-16 gap-x-6">
          {t.stats.map((s, i) => (
            <Reveal key={s.label} delay={i * 80} offset={24}>
              <div className="text-center">
                <div
                  className="font-medium bg-clip-text text-transparent"
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontSize: 'clamp(3rem, 6.5vw, 5.25rem)',
                    lineHeight: 1,
                    letterSpacing: '-0.04em',
                    backgroundImage:
                      'linear-gradient(180deg, #ffffff 0%, rgba(255, 255, 255, 0.42) 100%)',
                  }}
                >
                  {s.value}
                </div>
                <div
                  className="mt-5 text-[10.5px] text-white/40 uppercase"
                  style={{ fontFamily: 'var(--font-terminal)', letterSpacing: '0.28em' }}
                >
                  {s.label}
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
