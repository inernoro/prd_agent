/**
 * StatsStrip — 幕 2 · 极简数字横条
 *
 * Linear 风：巨大数字（单字重渐变到半透明白），下方极小标签大写。
 * 没有图标、没有边框、没有卡片，全靠字号和呼吸空间撑场。
 */

const STATS = [
  { value: '15+', label: '专业 Agent' },
  { value: '14', label: '集成大模型' },
  { value: '98', label: 'MongoDB 集合' },
  { value: '99.9%', label: '服务可用性' },
];

export function StatsStrip() {
  return (
    <section
      className="relative py-24 md:py-32 px-6 border-y border-white/5"
      style={{ fontFamily: 'var(--font-body)' }}
    >
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-y-14 gap-x-6">
          {STATS.map((s) => (
            <div key={s.label} className="text-center">
              <div
                className="font-medium bg-clip-text text-transparent"
                style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: 'clamp(3rem, 6vw, 5rem)',
                  lineHeight: 1,
                  letterSpacing: '-0.04em',
                  backgroundImage:
                    'linear-gradient(180deg, #ffffff 0%, rgba(255,255,255,0.45) 100%)',
                }}
              >
                {s.value}
              </div>
              <div
                className="mt-4 text-[10.5px] text-white/40 uppercase"
                style={{ fontFamily: 'var(--font-display)', letterSpacing: '0.24em' }}
              >
                {s.label}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
