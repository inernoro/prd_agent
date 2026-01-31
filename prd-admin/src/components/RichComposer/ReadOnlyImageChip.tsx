import React from 'react';

export interface ReadOnlyImageChipProps {
  canvasKey?: string;
  refId: number;
  src: string;
  label: string;
  ready?: boolean;
  className?: string;
  style?: React.CSSProperties;
  onClick?: (e: React.MouseEvent) => void;
}

export function ReadOnlyImageChip({
  src,
  label,
  ready = true, // 默认就绪（蓝色），聊天记录中通常是就绪状态
  className,
  style,
  onClick,
}: ReadOnlyImageChipProps) {
  // 截断标签
  const displayLabel = label.length > 8 ? `${label.slice(0, 6)}...` : label;

  // ready = 蓝色（就绪），!ready = 灰色（待选）
  const textOpacity = ready ? 0.88 : 0.6;
  const imgOpacity = ready ? 1 : 0.6;

  // 外层容器样式
  const containerStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    height: 20,
    padding: '0 6px 0 4px',
    margin: '0 2px',
    background: ready ? 'rgba(96, 165, 250, 0.18)' : 'rgba(156, 163, 175, 0.18)',
    border: `1px solid ${ready ? 'rgba(96, 165, 250, 0.35)' : 'rgba(156, 163, 175, 0.35)'}`,
    borderRadius: 4,
    verticalAlign: 'middle',
    cursor: onClick ? 'pointer' : 'default',
    userSelect: 'none',
    ...style,
  };

  return (
    <span className={className} style={containerStyle} onClick={onClick}>
      {/* 缩略图 */}
      <img
        src={src}
        alt=""
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          objectFit: 'cover',
          flexShrink: 0,
          border: '1px solid rgba(255,255,255,0.22)',
          opacity: imgOpacity,
        }}
      />
      {/* 标签 */}
      <span
        style={{
          fontSize: 11,
          fontWeight: 500,
          color: `rgba(255,255,255,${textOpacity})`,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: 80,
        }}
      >
        {displayLabel}
      </span>
    </span>
  );
}
