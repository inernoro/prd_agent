import { useEffect, useRef, useState } from 'react';
import './RippleImageTransition.css';

export interface RippleImageTransitionProps {
  images: string[];
  width?: number;
  height?: number;
  autoPlay?: boolean;
  interval?: number;
  className?: string;
}

/**
 * 图片水波纹切换过渡组件
 *
 * 功能：图片加载瞬间展示水波纹扩散动效
 *
 * @example
 * ```tsx
 * <RippleImageTransition
 *   images={['/img1.jpg', '/img2.jpg', '/img3.jpg']}
 *   width={681}
 *   height={384}
 *   autoPlay
 *   interval={5000}
 * />
 * ```
 */
export function RippleImageTransition({
  images,
  width = 681,
  height = 384,
  autoPlay = false,
  interval = 5000,
  className = '',
}: RippleImageTransitionProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);
  const [rippleDirection, setRippleDirection] = useState<'left' | 'right'>('right');
  const containerRef = useRef<HTMLDivElement>(null);

  // 切换到下一张
  const goNext = () => {
    if (isAnimating) return;
    setIsAnimating(true);
    setRippleDirection('right');
    setCurrentIndex((prev) => (prev + 1) % images.length);
    setTimeout(() => setIsAnimating(false), 1400);
  };

  // 切换到上一张
  const goPrev = () => {
    if (isAnimating) return;
    setIsAnimating(true);
    setRippleDirection('left');
    setCurrentIndex((prev) => (prev - 1 + images.length) % images.length);
    setTimeout(() => setIsAnimating(false), 1400);
  };

  // 自动播放
  useEffect(() => {
    if (!autoPlay) return;
    const timer = setInterval(goNext, interval);
    return () => clearInterval(timer);
  }, [autoPlay, interval, isAnimating]);

  // 键盘导航
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') goPrev();
      else if (e.key === 'ArrowRight') goNext();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAnimating]);

  const circleCount = 9;
  const circles = Array.from({ length: circleCount }, (_, i) => ({
    index: i + 1,
    radius: 20 + i * 80,
    delay: (i + 1) * 0.05,
  }));

  return (
    <div
      ref={containerRef}
      className={`ripple-image-container ${className}`}
      style={{ width, height }}
    >
      {/* 左侧水波纹 SVG */}
      <svg
        className={`ripple-svg ripple-svg-left ${rippleDirection === 'left' && isAnimating ? 'active' : ''}`}
        width={width}
        height={height}
      >
        {circles.map((c) => (
          <circle
            key={`left-${c.index}`}
            className={`ripple-circle ${isAnimating && rippleDirection === 'left' ? 'animate' : ''}`}
            cx={34}
            cy="49%"
            r={c.radius}
            style={{ transitionDelay: `${c.delay}s` }}
          />
        ))}
      </svg>

      {/* 右侧水波纹 SVG */}
      <svg
        className={`ripple-svg ripple-svg-right ${rippleDirection === 'right' && isAnimating ? 'active' : ''}`}
        width={width}
        height={height}
      >
        {circles.map((c) => (
          <circle
            key={`right-${c.index}`}
            className={`ripple-circle ${isAnimating && rippleDirection === 'right' ? 'animate' : ''}`}
            cx={width - 33}
            cy="49%"
            r={c.radius}
            style={{ transitionDelay: `${c.delay}s` }}
          />
        ))}
      </svg>

      {/* 图片列表 */}
      <div className="ripple-slides">
        {images.map((img, index) => (
          <div
            key={index}
            className={`ripple-slide ${index === currentIndex ? 'active' : ''} ${isAnimating ? 'animating' : ''}`}
            style={{ backgroundImage: `url(${img})` }}
          />
        ))}
      </div>

      {/* 左侧按钮 */}
      <button className="ripple-nav-btn ripple-nav-left" onClick={goPrev} disabled={isAnimating}>
        <svg viewBox="0 0 477.175 477.175" width="16" height="16">
          <path
            fill="currentColor"
            d="M145.188,238.575l215.5-215.5c5.3-5.3,5.3-13.8,0-19.1s-13.8-5.3-19.1,0l-225.1,225.1c-5.3,5.3-5.3,13.8,0,19.1l225.1,225c2.6,2.6,6.1,4,9.5,4s6.9-1.3,9.5-4c5.3-5.3,5.3-13.8,0-19.1L145.188,238.575z"
          />
        </svg>
      </button>

      {/* 右侧按钮 */}
      <button className="ripple-nav-btn ripple-nav-right" onClick={goNext} disabled={isAnimating}>
        <svg viewBox="0 0 477.175 477.175" width="16" height="16">
          <path
            fill="currentColor"
            d="M360.731,229.075l-225.1-225.1c-5.3-5.3-13.8-5.3-19.1,0s-5.3,13.8,0,19.1l215.5,215.5l-215.5,215.5c-5.3,5.3-5.3,13.8,0,19.1c2.6,2.6,6.1,4,9.5,4c3.4,0,6.9-1.3,9.5-4l225.1-225.1C365.931,242.875,365.931,234.275,360.731,229.075z"
          />
        </svg>
      </button>

      {/* 指示器 */}
      <div className="ripple-indicators">
        {images.map((_, index) => (
          <button
            key={index}
            className={`ripple-indicator ${index === currentIndex ? 'active' : ''}`}
            onClick={() => {
              if (isAnimating || index === currentIndex) return;
              setIsAnimating(true);
              setRippleDirection(index > currentIndex ? 'right' : 'left');
              setCurrentIndex(index);
              setTimeout(() => setIsAnimating(false), 1400);
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default RippleImageTransition;
