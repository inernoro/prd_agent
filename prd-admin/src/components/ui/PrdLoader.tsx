import React from 'react';

/**
 * 基于 thirdparty/ref/load.html 的 CSS 加载动画（React 重写版）
 * - 只实现 loader 本体，不带页面背景
 * - 通过 size 控制尺寸，默认 44px
 */
export function PrdLoader({
  size = 44,
  className,
  style,
}: {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const px = Math.max(16, Math.round(size));
  const border = Math.max(2, Math.round(px / 22));

  return (
    <div
      className={className}
      style={{
        position: 'relative',
        width: px,
        height: px,
        borderRadius: '50%',
        perspective: 800,
        ...style,
      }}
      aria-label="加载中"
      role="status"
    >
      <style>{`
@keyframes prd-loader-rotate-one {
  0% { transform: rotateX(35deg) rotateY(-45deg) rotateZ(0deg); }
  100% { transform: rotateX(35deg) rotateY(-45deg) rotateZ(360deg); }
}
@keyframes prd-loader-rotate-two {
  0% { transform: rotateX(50deg) rotateY(10deg) rotateZ(0deg); }
  100% { transform: rotateX(50deg) rotateY(10deg) rotateZ(360deg); }
}
@keyframes prd-loader-rotate-three {
  0% { transform: rotateX(35deg) rotateY(55deg) rotateZ(0deg); }
  100% { transform: rotateX(35deg) rotateY(55deg) rotateZ(360deg); }
}
`}</style>

      <div
        style={{
          position: 'absolute',
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          borderRadius: '50%',
          left: '0%',
          top: '0%',
          animation: 'prd-loader-rotate-one 1s linear infinite',
          borderBottom: `${border}px solid rgba(239,239,250,0.95)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          borderRadius: '50%',
          right: '0%',
          top: '0%',
          animation: 'prd-loader-rotate-two 1s linear infinite',
          borderRight: `${border}px solid rgba(239,239,250,0.95)`,
        }}
      />
      <div
        style={{
          position: 'absolute',
          boxSizing: 'border-box',
          width: '100%',
          height: '100%',
          borderRadius: '50%',
          right: '0%',
          bottom: '0%',
          animation: 'prd-loader-rotate-three 1s linear infinite',
          borderTop: `${border}px solid rgba(239,239,250,0.95)`,
        }}
      />
    </div>
  );
}

