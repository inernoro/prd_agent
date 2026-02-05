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
  /** 切片数量 */
  sliceCount?: number;
  /** 按钮A文字 */
  labelA?: string;
  /** 按钮B文字 */
  labelB?: string;
  /** 自定义类名 */
  className?: string;
}

/**
 * 切片翻转过渡效果组件
 *
 * 点击按钮触发图片切换，通过水平切片翻转实现炫酷过渡动画
 */
export function SliceFlipTransition({
  imageA,
  imageB,
  width = 400,
  height = 300,
  sliceCount = 8,
  labelA = '方案 A',
  labelB = '方案 B',
  className = '',
}: SliceFlipTransitionProps) {
  const [activeImage, setActiveImage] = useState<'A' | 'B'>('A');
  const [isAnimating, setIsAnimating] = useState(false);

  const sliceHeight = height / sliceCount;

  const handleSwitch = useCallback(
    (target: 'A' | 'B') => {
      if (isAnimating || activeImage === target) return;
      setIsAnimating(true);
      setActiveImage(target);
      // 动画完成后解锁
      setTimeout(() => setIsAnimating(false), sliceCount * 80 + 600);
    },
    [isAnimating, activeImage, sliceCount]
  );

  // 生成切片
  const slices = Array.from({ length: sliceCount }, (_, i) => ({
    index: i,
    top: i * sliceHeight,
    delay: i * 0.08,
  }));

  return (
    <div className={`slice-flip-container ${className}`} style={{ width, height }}>
      {/* 切片层 */}
      <div className="slice-flip-slices">
        {slices.map((slice) => (
          <div
            key={slice.index}
            className={`slice-flip-slice ${activeImage === 'B' ? 'flipped' : ''}`}
            style={{
              height: sliceHeight,
              top: slice.top,
              transitionDelay: `${slice.delay}s`,
            }}
          >
            {/* 正面 - 图片A */}
            <div
              className="slice-flip-face slice-flip-front"
              style={{
                backgroundImage: `url(${imageA})`,
                backgroundPosition: `center ${-slice.top}px`,
                backgroundSize: `${width}px ${height}px`,
              }}
            />
            {/* 背面 - 图片B */}
            <div
              className="slice-flip-face slice-flip-back"
              style={{
                backgroundImage: `url(${imageB})`,
                backgroundPosition: `center ${-slice.top}px`,
                backgroundSize: `${width}px ${height}px`,
              }}
            />
          </div>
        ))}
      </div>

      {/* 光晕效果层 */}
      <div className={`slice-flip-glow ${isAnimating ? 'active' : ''}`} />

      {/* 按钮组 */}
      <div className="slice-flip-buttons">
        <button
          className={`slice-flip-btn ${activeImage === 'A' ? 'active' : ''}`}
          onClick={() => handleSwitch('A')}
          disabled={isAnimating}
        >
          <span className="slice-flip-btn-dot" />
          {labelA}
        </button>
        <button
          className={`slice-flip-btn ${activeImage === 'B' ? 'active' : ''}`}
          onClick={() => handleSwitch('B')}
          disabled={isAnimating}
        >
          <span className="slice-flip-btn-dot" />
          {labelB}
        </button>
      </div>

      {/* 状态指示 */}
      <div className="slice-flip-status">
        <span className={`slice-flip-status-label ${activeImage === 'A' ? 'active' : ''}`}>A</span>
        <div className="slice-flip-status-track">
          <div className={`slice-flip-status-thumb ${activeImage === 'B' ? 'right' : ''}`} />
        </div>
        <span className={`slice-flip-status-label ${activeImage === 'B' ? 'active' : ''}`}>B</span>
      </div>
    </div>
  );
}

export default SliceFlipTransition;
