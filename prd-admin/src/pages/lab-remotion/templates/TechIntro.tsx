import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';
import { useMemo } from 'react';

export interface TechIntroProps {
  title?: string;
  subtitle?: string;
  primaryColor?: string;
  secondaryColor?: string;
}

export const techIntroDefaults: Required<TechIntroProps> = {
  title: 'REMOTION',
  subtitle: 'Create videos with React',
  primaryColor: '#00ffff',
  secondaryColor: '#ff00ff',
};

// 生成粒子数据
function generateParticles(count: number, seed: number) {
  const particles = [];
  for (let i = 0; i < count; i++) {
    const rand = (n: number) => ((seed * (i + 1) * n) % 1000) / 1000;
    particles.push({
      x: rand(17) * 100,
      y: rand(23) * 100,
      size: rand(7) * 3 + 1,
      speed: rand(13) * 0.5 + 0.2,
      delay: rand(31) * 30,
      opacity: rand(41) * 0.5 + 0.3,
    });
  }
  return particles;
}

// 生成网格线
function generateGridLines(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    position: (i / count) * 100,
    delay: i * 2,
  }));
}

export function TechIntro({
  title = techIntroDefaults.title,
  subtitle = techIntroDefaults.subtitle,
  primaryColor = techIntroDefaults.primaryColor,
  secondaryColor = techIntroDefaults.secondaryColor,
}: TechIntroProps) {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // 粒子和网格数据
  const particles = useMemo(() => generateParticles(50, 42), []);
  const horizontalLines = useMemo(() => generateGridLines(10), []);
  const verticalLines = useMemo(() => generateGridLines(15), []);

  // === 动画阶段 ===
  // 阶段1: 网格出现 (0-20帧)
  // 阶段2: 粒子浮动 (10-90帧)
  // 阶段3: 标题入场 (20-50帧)
  // 阶段4: 副标题入场 (35-60帧)
  // 阶段5: 光效扫描 (40-70帧)

  // 背景渐变动画
  const bgHue = interpolate(frame, [0, durationInFrames], [220, 260]);

  // 网格透明度
  const gridOpacity = interpolate(frame, [0, 20, 70, 90], [0, 0.3, 0.3, 0], {
    extrapolateRight: 'clamp',
  });

  // 标题动画
  const titleSpring = spring({
    frame: Math.max(0, frame - 20),
    fps,
    config: { damping: 12, stiffness: 100 },
  });
  const titleY = interpolate(titleSpring, [0, 1], [60, 0]);
  const titleOpacity = interpolate(frame, [20, 35], [0, 1], { extrapolateRight: 'clamp' });
  const titleScale = interpolate(titleSpring, [0, 1], [0.8, 1]);

  // 副标题动画
  const subtitleOpacity = interpolate(frame, [35, 50], [0, 1], { extrapolateRight: 'clamp' });
  const subtitleY = interpolate(frame, [35, 50], [20, 0], { extrapolateRight: 'clamp' });

  // 光效扫描
  const scanLineX = interpolate(frame, [40, 70], [-100, 200], { extrapolateRight: 'clamp' });
  const scanOpacity = interpolate(frame, [40, 55, 70], [0, 1, 0], { extrapolateRight: 'clamp' });

  // 外发光脉冲
  const glowPulse = Math.sin(frame * 0.15) * 10 + 20;

  // 整体淡出
  const fadeOut = interpolate(frame, [80, 90], [1, 0], { extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(ellipse at center, hsl(${bgHue}, 30%, 15%) 0%, hsl(${bgHue}, 40%, 5%) 100%)`,
        opacity: fadeOut,
        overflow: 'hidden',
      }}
    >
      {/* 网格层 */}
      <div style={{ position: 'absolute', inset: 0, opacity: gridOpacity, perspective: '500px' }}>
        {/* 水平线 */}
        {horizontalLines.map((line, i) => {
          const lineOpacity = interpolate(
            frame,
            [line.delay, line.delay + 10],
            [0, 0.6],
            { extrapolateRight: 'clamp' }
          );
          return (
            <div
              key={`h-${i}`}
              style={{
                position: 'absolute',
                left: 0,
                right: 0,
                top: `${line.position}%`,
                height: 1,
                background: `linear-gradient(90deg, transparent 0%, ${primaryColor}40 50%, transparent 100%)`,
                opacity: lineOpacity,
              }}
            />
          );
        })}
        {/* 垂直线 */}
        {verticalLines.map((line, i) => {
          const lineOpacity = interpolate(
            frame,
            [line.delay, line.delay + 10],
            [0, 0.4],
            { extrapolateRight: 'clamp' }
          );
          return (
            <div
              key={`v-${i}`}
              style={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${line.position}%`,
                width: 1,
                background: `linear-gradient(180deg, transparent 0%, ${secondaryColor}30 50%, transparent 100%)`,
                opacity: lineOpacity,
              }}
            />
          );
        })}
      </div>

      {/* 粒子层 */}
      <div style={{ position: 'absolute', inset: 0 }}>
        {particles.map((p, i) => {
          const particleY = (p.y + frame * p.speed) % 120 - 10;
          const particleOpacity = interpolate(
            frame,
            [p.delay, p.delay + 15],
            [0, p.opacity],
            { extrapolateRight: 'clamp' }
          );
          const particleScale = 1 + Math.sin(frame * 0.1 + i) * 0.3;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: `${p.x}%`,
                top: `${particleY}%`,
                width: p.size,
                height: p.size,
                borderRadius: '50%',
                background: i % 2 === 0 ? primaryColor : secondaryColor,
                opacity: particleOpacity,
                transform: `scale(${particleScale})`,
                boxShadow: `0 0 ${p.size * 2}px ${i % 2 === 0 ? primaryColor : secondaryColor}`,
              }}
            />
          );
        })}
      </div>

      {/* 光效扫描线 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${scanLineX}%`,
          width: 200,
          background: `linear-gradient(90deg, transparent 0%, ${primaryColor}60 50%, transparent 100%)`,
          opacity: scanOpacity,
          filter: 'blur(30px)',
        }}
      />

      {/* 主标题 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <h1
          style={{
            fontSize: 90,
            fontWeight: 900,
            fontFamily: 'system-ui, sans-serif',
            color: '#fff',
            margin: 0,
            letterSpacing: '0.1em',
            opacity: titleOpacity,
            transform: `translateY(${titleY}px) scale(${titleScale})`,
            textShadow: `
              0 0 ${glowPulse}px ${primaryColor},
              0 0 ${glowPulse * 2}px ${primaryColor}80,
              0 0 ${glowPulse * 3}px ${secondaryColor}40
            `,
          }}
        >
          {title}
        </h1>

        {/* 装饰线 */}
        <div
          style={{
            width: interpolate(titleSpring, [0, 1], [0, 300]),
            height: 2,
            background: `linear-gradient(90deg, transparent, ${primaryColor}, ${secondaryColor}, transparent)`,
            margin: '20px 0',
            opacity: titleOpacity,
          }}
        />

        {/* 副标题 */}
        <p
          style={{
            fontSize: 24,
            fontWeight: 300,
            fontFamily: 'system-ui, sans-serif',
            color: '#ffffff90',
            margin: 0,
            letterSpacing: '0.3em',
            textTransform: 'uppercase',
            opacity: subtitleOpacity,
            transform: `translateY(${subtitleY}px)`,
          }}
        >
          {subtitle}
        </p>
      </div>

      {/* 角落装饰 */}
      {[0, 1, 2, 3].map((corner) => {
        const cornerOpacity = interpolate(frame, [10 + corner * 5, 25 + corner * 5], [0, 0.8], {
          extrapolateRight: 'clamp',
        });
        const isTop = corner < 2;
        const isLeft = corner % 2 === 0;
        return (
          <div
            key={corner}
            style={{
              position: 'absolute',
              [isTop ? 'top' : 'bottom']: 30,
              [isLeft ? 'left' : 'right']: 30,
              width: 60,
              height: 60,
              borderTop: isTop ? `2px solid ${primaryColor}80` : 'none',
              borderBottom: !isTop ? `2px solid ${primaryColor}80` : 'none',
              borderLeft: isLeft ? `2px solid ${primaryColor}80` : 'none',
              borderRight: !isLeft ? `2px solid ${primaryColor}80` : 'none',
              opacity: cornerOpacity,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
}
