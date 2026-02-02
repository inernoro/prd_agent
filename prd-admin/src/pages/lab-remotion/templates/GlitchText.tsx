import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { useMemo } from 'react';

export interface GlitchTextProps {
  text?: string;
  textColor?: string;
  backgroundColor?: string;
  glitchIntensity?: number;
}

export const glitchTextDefaults: GlitchTextProps = {
  text: 'GLITCH',
  textColor: '#ffffff',
  backgroundColor: '#0a0a0a',
  glitchIntensity: 1,
};

export function GlitchText({
  text = 'GLITCH',
  textColor = '#ffffff',
  backgroundColor = '#0a0a0a',
  glitchIntensity = 1,
}: GlitchTextProps) {
  const frame = useCurrentFrame();
  useVideoConfig(); // 确保组件在 Remotion 上下文中

  // 生成随机偏移（基于帧数的伪随机）
  const noise = useMemo(() => {
    const seed = frame * 0.1;
    return {
      x1: Math.sin(seed * 17.3) * 10 * glitchIntensity,
      x2: Math.sin(seed * 23.7) * 10 * glitchIntensity,
      y1: Math.sin(seed * 31.1) * 3 * glitchIntensity,
      y2: Math.sin(seed * 41.9) * 3 * glitchIntensity,
      skew: Math.sin(seed * 13.7) * 2 * glitchIntensity,
      clip1: Math.abs(Math.sin(seed * 7.3)) * 50 + 25,
      clip2: Math.abs(Math.sin(seed * 11.1)) * 50 + 25,
    };
  }, [frame, glitchIntensity]);

  // 闪烁效果
  const shouldGlitch = Math.sin(frame * 0.5) > 0.3 || Math.sin(frame * 1.7) > 0.8;
  const strongGlitch = Math.sin(frame * 0.3) > 0.85;

  // 扫描线
  const scanlineY = (frame * 5) % 720;

  // 整体抖动
  const shakeX = shouldGlitch ? Math.sin(frame * 2.3) * 3 * glitchIntensity : 0;
  const shakeY = shouldGlitch ? Math.cos(frame * 2.7) * 2 * glitchIntensity : 0;

  // 入场动画
  const scale = interpolate(frame, [0, 10], [0.8, 1], {
    extrapolateRight: 'clamp',
  });
  const opacity = interpolate(frame, [0, 5], [0, 1], {
    extrapolateRight: 'clamp',
  });

  const textStyle: React.CSSProperties = {
    fontSize: 120,
    fontWeight: 900,
    fontFamily: 'Arial Black, sans-serif',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    position: 'relative',
  };

  return (
    <AbsoluteFill
      style={{
        backgroundColor,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        overflow: 'hidden',
      }}
    >
      {/* 扫描线 */}
      <div
        style={{
          position: 'absolute',
          top: scanlineY,
          left: 0,
          right: 0,
          height: 2,
          backgroundColor: 'rgba(255, 255, 255, 0.03)',
          pointerEvents: 'none',
        }}
      />

      {/* CRT 扫描线效果 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background:
            'repeating-linear-gradient(0deg, rgba(0,0,0,0.15) 0px, rgba(0,0,0,0.15) 1px, transparent 1px, transparent 2px)',
          pointerEvents: 'none',
        }}
      />

      {/* 主文字容器 */}
      <div
        style={{
          position: 'relative',
          transform: `translate(${shakeX}px, ${shakeY}px) scale(${scale})`,
          opacity,
        }}
      >
        {/* 红色通道偏移 */}
        <div
          style={{
            ...textStyle,
            color: 'transparent',
            position: 'absolute',
            left: shouldGlitch ? noise.x1 : 0,
            top: shouldGlitch ? noise.y1 : 0,
            textShadow: `0 0 0 rgba(255, 0, 0, 0.8)`,
            WebkitTextStroke: '2px rgba(255, 0, 0, 0.8)',
            clipPath: strongGlitch
              ? `inset(${noise.clip1}% 0 ${100 - noise.clip1 - 20}% 0)`
              : 'none',
            transform: shouldGlitch ? `skewX(${noise.skew}deg)` : 'none',
          }}
        >
          {text}
        </div>

        {/* 青色通道偏移 */}
        <div
          style={{
            ...textStyle,
            color: 'transparent',
            position: 'absolute',
            left: shouldGlitch ? noise.x2 : 0,
            top: shouldGlitch ? noise.y2 : 0,
            textShadow: `0 0 0 rgba(0, 255, 255, 0.8)`,
            WebkitTextStroke: '2px rgba(0, 255, 255, 0.8)',
            clipPath: strongGlitch
              ? `inset(${noise.clip2}% 0 ${100 - noise.clip2 - 20}% 0)`
              : 'none',
            transform: shouldGlitch ? `skewX(${-noise.skew}deg)` : 'none',
          }}
        >
          {text}
        </div>

        {/* 主文字 */}
        <div
          style={{
            ...textStyle,
            color: textColor,
            textShadow: `
              0 0 10px ${textColor},
              0 0 20px ${textColor},
              0 0 40px ${textColor}
            `,
          }}
        >
          {text}
        </div>

        {/* 随机横条 */}
        {strongGlitch && (
          <>
            <div
              style={{
                position: 'absolute',
                left: -50,
                right: -50,
                top: `${noise.clip1}%`,
                height: 8,
                backgroundColor: textColor,
                opacity: 0.8,
                transform: `translateX(${noise.x1 * 3}px)`,
              }}
            />
            <div
              style={{
                position: 'absolute',
                left: -50,
                right: -50,
                top: `${noise.clip2}%`,
                height: 4,
                backgroundColor: 'cyan',
                opacity: 0.6,
                transform: `translateX(${noise.x2 * 2}px)`,
              }}
            />
          </>
        )}
      </div>

      {/* 边角噪点 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%' height='100%' filter='url(%23noise)'/%3E%3C/svg%3E")`,
          opacity: 0.03,
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
}
