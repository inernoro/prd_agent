import React, { useMemo, useRef, useEffect, useState } from 'react';

export interface CssRainBackgroundProps {
  opacity?: number;
  rainCount?: number;
  color?: string;
}

/**
 * CSS 实现的下雨效果背景
 * 更轻量、更可靠，不依赖 Three.js
 */
export const CssRainBackground: React.FC<CssRainBackgroundProps> = ({
  opacity = 0.3,
  rainCount = 100,
  color = 'rgba(174, 194, 224, 0.8)',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  // 获取父容器尺寸
  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current?.parentElement) {
        const parent = containerRef.current.parentElement;
        setDimensions({
          width: parent.offsetWidth,
          height: parent.offsetHeight,
        });
      }
    };

    updateDimensions();
    window.addEventListener('resize', updateDimensions);
    
    // 使用 ResizeObserver 监听父容器尺寸变化
    const observer = new ResizeObserver(updateDimensions);
    if (containerRef.current?.parentElement) {
      observer.observe(containerRef.current.parentElement);
    }

    return () => {
      window.removeEventListener('resize', updateDimensions);
      observer.disconnect();
    };
  }, []);

  // 生成随机雨滴
  const raindrops = useMemo(() => {
    if (dimensions.height === 0) return [];
    return Array.from({ length: rainCount }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 2,
      duration: 0.5 + Math.random() * 0.5,
      size: 1 + Math.random() * 2,
    }));
  }, [rainCount, dimensions.height]);

  return (
    <div
      ref={containerRef}
      style={{ 
        position: 'absolute',
        top: 0,
        left: 0,
        width: dimensions.width || '100%',
        height: dimensions.height || '100%',
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: 0,
        background: 'linear-gradient(180deg, rgba(17, 17, 31, 0.6) 0%, rgba(17, 17, 31, 0.3) 100%)',
        opacity,
      }}
    >
      {/* 雨滴层 */}
      {raindrops.map((drop) => (
        <div
          key={drop.id}
          className="rain-drop"
          style={{
            position: 'absolute',
            left: `${drop.left}%`,
            top: '-20px',
            width: `${drop.size}px`,
            height: `${15 + drop.size * 5}px`,
            background: `linear-gradient(transparent, ${color})`,
            animationDelay: `${drop.delay}s`,
            animationDuration: `${drop.duration}s`,
            borderRadius: '0 0 2px 2px',
          }}
        />
      ))}

      {/* 雾气/云层效果 */}
      <div 
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          background: 'radial-gradient(ellipse at 50% 0%, rgba(100, 100, 180, 0.2) 0%, transparent 70%)',
        }}
      />

      {/* 动画定义 */}
      <style>{`
        @keyframes rainFall {
          0% {
            transform: translateY(0);
            opacity: 0;
          }
          10% {
            opacity: 1;
          }
          90% {
            opacity: 1;
          }
          100% {
            transform: translateY(${dimensions.height + 40}px);
            opacity: 0;
          }
        }
        .rain-drop {
          animation: rainFall linear infinite;
        }
      `}</style>
    </div>
  );
};
