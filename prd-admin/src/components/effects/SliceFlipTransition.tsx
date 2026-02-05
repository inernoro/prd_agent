import { useState, useCallback } from 'react';
import './SliceFlipTransition.css';

export interface SliceFlipTransitionProps {
  /** 图片A的URL */
  imageA: string;
  /** 图片B的URL */
  imageB: string;
  /** 宽度 */
  width?: number;
  /** 高度 */
  height?: number;
  /** 按钮A文字 */
  labelA?: string;
  /** 按钮B文字 */
  labelB?: string;
  /** 自定义类名 */
  className?: string;
}

/**
 * 水波纹切换过渡效果组件
 *
 * 动画流程：左荡漾（遮盖）→ 右荡漾（揭示新图）
 */
export function SliceFlipTransition({
  imageA,
  imageB,
  width = 400,
  height = 300,
  labelA = '方案 A',
  labelB = '方案 B',
  className = '',
}: SliceFlipTransitionProps) {
  const [activeImage, setActiveImage] = useState<'A' | 'B'>('A');
  const [isAnimating, setIsAnimating] = useState(false);
  // 动画阶段：'idle' | 'left' | 'right'
  const [animationPhase, setAnimationPhase] = useState<'idle' | 'left' | 'right'>('idle');

  // 水波纹圆环配置
  const circleCount = 9;
  const circles = Array.from({ length: circleCount }, (_, i) => ({
    index: i + 1,
    radius: 20 + i * 80,
    delay: (i + 1) * 0.04,
  }));

  const handleSwitch = useCallback(
    (target: 'A' | 'B') => {
      if (isAnimating || activeImage === target) return;
      setIsAnimating(true);

      // 阶段1：左荡漾（遮盖当前图）
      setAnimationPhase('left');

      // 阶段2：切换图片 + 右荡漾（揭示新图）
      setTimeout(() => {
        setActiveImage(target);
        setAnimationPhase('right');
      }, 450);

      // 动画结束
      setTimeout(() => {
        setAnimationPhase('idle');
        setIsAnimating(false);
      }, 900);
    },
    [isAnimating, activeImage]
  );

  return (
    <div className={`ripple-switch-container ${className}`} style={{ width, height }}>
      {/* 左侧水波纹 SVG - 阶段1：遮盖 */}
      <svg className="ripple-switch-svg" width={width} height={height}>
        {circles.map((c) => (
          <circle
            key={`left-${c.index}`}
            className={`ripple-switch-circle ${animationPhase === 'left' ? 'animate' : ''}`}
            cx={34}
            cy="49%"
            r={c.radius}
            style={{ transitionDelay: `${c.delay}s` }}
          />
        ))}
      </svg>

      {/* 右侧水波纹 SVG - 阶段2：揭示 */}
      <svg className="ripple-switch-svg" width={width} height={height}>
        {circles.map((c) => (
          <circle
            key={`right-${c.index}`}
            className={`ripple-switch-circle ${animationPhase === 'right' ? 'animate' : ''}`}
            cx={width - 33}
            cy="49%"
            r={c.radius}
            style={{ transitionDelay: `${c.delay}s` }}
          />
        ))}
      </svg>

      {/* 图片层 */}
      <div className="ripple-switch-slides">
        <div
          className={`ripple-switch-slide ${activeImage === 'A' ? 'active' : ''}`}
          style={{ backgroundImage: `url(${imageA})` }}
        />
        <div
          className={`ripple-switch-slide ${activeImage === 'B' ? 'active' : ''}`}
          style={{ backgroundImage: `url(${imageB})` }}
        />
      </div>

      {/* 按钮组 */}
      <div className="ripple-switch-buttons">
        <button
          className={`ripple-switch-btn ${activeImage === 'A' ? 'active' : ''}`}
          onClick={() => handleSwitch('A')}
          disabled={isAnimating}
        >
          <span className="ripple-switch-btn-dot" />
          {labelA}
        </button>
        <button
          className={`ripple-switch-btn ${activeImage === 'B' ? 'active' : ''}`}
          onClick={() => handleSwitch('B')}
          disabled={isAnimating}
        >
          <span className="ripple-switch-btn-dot" />
          {labelB}
        </button>
      </div>

      {/* 底部指示器 */}
      <div className="ripple-switch-indicators">
        <button
          className={`ripple-switch-indicator ${activeImage === 'A' ? 'active' : ''}`}
          onClick={() => handleSwitch('A')}
          disabled={isAnimating}
        />
        <button
          className={`ripple-switch-indicator ${activeImage === 'B' ? 'active' : ''}`}
          onClick={() => handleSwitch('B')}
          disabled={isAnimating}
        />
      </div>
    </div>
  );
}

export default SliceFlipTransition;
