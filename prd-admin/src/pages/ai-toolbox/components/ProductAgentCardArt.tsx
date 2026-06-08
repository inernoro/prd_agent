import { memo, useEffect, useState } from 'react';
import './product-agent-card-art.css';

/**
 * 产品管理智能体 (product-agent) 卡片封面内联动效。
 * 主题：知识图谱链路 —— 产品-版本-需求-功能-缺陷-客户全链路串联。
 * 纯 SVG + CSS：连线数据流光 + 节点脉冲 + 彗星沿链流动 + 背景光晕漂移。
 * 悬停整体提速增亮；prefers-reduced-motion 下静止（彗星不渲染）。
 */
export const ProductAgentCardArt = memo(function ProductAgentCardArt() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const m = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduce(m.matches);
    const h = (e: MediaQueryListEvent) => setReduce(e.matches);
    m.addEventListener?.('change', h);
    return () => m.removeEventListener?.('change', h);
  }, []);

  // 六节点：产品-版本-需求-功能-缺陷-客户
  const nodes = [
    { x: 38, y: 64, c: '#a78bfa' },
    { x: 92, y: 116, c: '#818cf8' },
    { x: 152, y: 58, c: '#22d3ee' },
    { x: 210, y: 116, c: '#34d399' },
    { x: 262, y: 62, c: '#f472b6' },
    { x: 292, y: 128, c: '#fbbf24' },
  ];
  const chain = 'M38,64 Q65,110 92,116 T152,58 T210,116 T262,62 T292,128';
  // 交叉链路（图谱感，低透明）
  const cross = [
    'M38,64 L152,58',
    'M152,58 L262,62',
    'M92,116 L210,116',
  ];

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ background: 'linear-gradient(135deg, #1a1438 0%, #161a3e 45%, #0e2942 100%)' }}
    >
      {/* 背景漂移光晕 */}
      <div className="pa-art-orb absolute rounded-full" style={{ left: '8%', top: '10%', width: 150, height: 150, background: 'radial-gradient(circle, rgba(167,139,250,0.35), transparent 65%)', filter: 'blur(6px)' }} />
      <div className="pa-art-orb2 absolute rounded-full" style={{ right: '4%', bottom: '6%', width: 170, height: 170, background: 'radial-gradient(circle, rgba(34,211,238,0.28), transparent 65%)', filter: 'blur(6px)' }} />

      <svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" className="absolute inset-0 w-full h-full">
        <defs>
          <linearGradient id="paChainGrad" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#a78bfa" />
            <stop offset="50%" stopColor="#22d3ee" />
            <stop offset="100%" stopColor="#fbbf24" />
          </linearGradient>
          <filter id="paGlow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.4" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
          <path id="paChainPath" d={chain} fill="none" />
        </defs>

        {/* 交叉链路（底层，弱） */}
        {cross.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
        ))}

        {/* 主链路：底色 + 数据流光 */}
        <path d={chain} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth={2.5} strokeLinecap="round" />
        <path d={chain} fill="none" stroke="url(#paChainGrad)" strokeWidth={2} strokeLinecap="round" className="pa-art-flow" opacity={0.95} />

        {/* 节点：脉冲环 + 实心核 */}
        {nodes.map((n, i) => (
          <g key={i}>
            <circle cx={n.x} cy={n.y} r={7} fill="none" stroke={n.c} strokeWidth={1.6} className="pa-art-pulse" style={{ animationDelay: `${i * 0.32}s` }} />
            <circle cx={n.x} cy={n.y} r={4.5} fill={n.c} filter="url(#paGlow)" />
            <circle cx={n.x} cy={n.y} r={2} fill="#fff" opacity={0.85} />
          </g>
        ))}

        {/* 彗星：沿主链流动（reduced-motion 不渲染） */}
        {!reduce && (
          <circle r={3.4} fill="#ffffff" filter="url(#paGlow)">
            <animateMotion dur="3.4s" repeatCount="indefinite" rotate="auto">
              <mpath href="#paChainPath" />
            </animateMotion>
            <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.9;1" dur="3.4s" repeatCount="indefinite" />
          </circle>
        )}
      </svg>
    </div>
  );
});
