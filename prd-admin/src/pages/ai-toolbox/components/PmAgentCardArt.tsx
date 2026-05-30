import { memo } from 'react';

/**
 * 项目管理智能体 (pm-agent) 卡片封面内联插画。
 * 无 CDN 资源时的品牌化封面：靛蓝渐变底 + 看板三列卡片 + 甘特进度条意象。
 * 纯 SVG/CSS，不依赖外部图片，暗/亮主题下都清晰。
 */
export const PmAgentCardArt = memo(function PmAgentCardArt() {
  const cols = [
    { x: 30, cards: [{ y: 78, c: '#60a5fa' }, { y: 100, c: '#60a5fa' }] },
    { x: 132, cards: [{ y: 78, c: '#fbbf24' }, { y: 100, c: '#fbbf24' }, { y: 122, c: '#fbbf24' }] },
    { x: 234, cards: [{ y: 78, c: '#34d399' }] },
  ];
  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ background: 'linear-gradient(135deg, #0c1733 0%, #15224c 45%, #123a52 100%)' }}
    >
      {/* 背景光斑 */}
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 20% 22%, rgba(96,165,250,0.30), transparent 55%)' }} />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 85% 80%, rgba(52,211,153,0.20), transparent 52%)' }} />

      <svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 w-full h-full">
        {/* 看板三列：列头 + 卡片 */}
        {cols.map((col, ci) => (
          <g key={ci}>
            <rect x={col.x} y={56} width={72} height={12} rx={4} fill="rgba(255,255,255,0.10)" />
            <rect x={col.x} y={58} width={20} height={8} rx={4} fill={col.cards[0].c} opacity={0.9} />
            {col.cards.map((card, idx) => (
              <rect key={idx} x={col.x} y={card.y} width={72} height={16} rx={5}
                fill="rgba(255,255,255,0.08)" stroke={card.c} strokeOpacity={0.55} strokeWidth={1} />
            ))}
          </g>
        ))}

        {/* 底部甘特进度条 */}
        <g>
          <rect x={30} y={158} width={120} height={9} rx={4.5} fill="#60a5fa" opacity={0.85} />
          <rect x={92} y={172} width={150} height={9} rx={4.5} fill="#fbbf24" opacity={0.8} />
          <rect x={170} y={186} width={120} height={9} rx={4.5} fill="#34d399" opacity={0.8} />
          {/* 今日竖线 */}
          <line x1={206} y1={150} x2={206} y2={196} stroke="#f87171" strokeOpacity={0.6} strokeWidth={1.5} strokeDasharray="3 3" />
        </g>
      </svg>
    </div>
  );
});
