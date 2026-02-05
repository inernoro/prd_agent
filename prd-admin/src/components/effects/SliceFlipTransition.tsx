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
 * 点击按钮触发图片切换，通过水波纹从按钮位置扩散实现过渡动画
 * 借鉴 RippleImageTransition 的水波纹效果
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
  const [rippleDirection, setRippleDirection] = useState<'left' | 'right'>('right');

  // 水波纹圆环配置 - 9个圆环，从按钮位置扩散
  const circleCount = 9;
  const circles = Array.from({ length: circleCount }, (_, i) => ({
    index: i + 1,
    radius: 20 + i * 80,
    delay: (i + 1) * 0.05,
  }));

  const handleSwitch = useCallback(
    (target: 'A' | 'B') => {
      if (isAnimating || activeImage === target) return;
      setIsAnimating(true);
      // 切换到 B 从右边扩散，切换到 A 从左边扩散
      setRippleDirection(target === 'B' ? 'right' : 'left');
      setActiveImage(target);
      // 动画完成后解锁（缩短时间）
      setTimeout(() => setIsAnimating(false), 1000);
    },
    [isAnimating, activeImage]
  );

  return (
    <div className={`ripple-switch-container ${className}`} style={{ width, height }}>
      {/* 左侧水波纹 SVG */}
      <svg
        className={`ripple-switch-svg ripple-switch-svg-left ${rippleDirection === 'left' && isAnimating ? 'active' : ''}`}
        width={width}
        height={height}
      >
        {circles.map((c) => (
          <circle
            key={`left-${c.index}`}
            className={`ripple-switch-circle ${isAnimating && rippleDirection === 'left' ? 'animate' : ''}`}
            cx={34}
            cy="49%"
            r={c.radius}
            style={{ transitionDelay: `${c.delay}s` }}
          />
        ))}
      </svg>

      {/* 右侧水波纹 SVG */}
      <svg
        className={`ripple-switch-svg ripple-switch-svg-right ${rippleDirection === 'right' && isAnimating ? 'active' : ''}`}
        width={width}
        height={height}
      >
        {circles.map((c) => (
          <circle
            key={`right-${c.index}`}
            className={`ripple-switch-circle ${isAnimating && rippleDirection === 'right' ? 'animate' : ''}`}
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
          className={`ripple-switch-slide ${activeImage === 'A' ? 'active' : ''} ${isAnimating ? 'animating' : ''}`}
          style={{ backgroundImage: `url(${imageA})` }}
        />
        <div
          className={`ripple-switch-slide ${activeImage === 'B' ? 'active' : ''} ${isAnimating ? 'animating' : ''}`}
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
