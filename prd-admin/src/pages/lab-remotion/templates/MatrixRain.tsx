import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { useMemo } from 'react';

export interface MatrixRainProps {
  charColor?: string;
  backgroundColor?: string;
  columnCount?: number;
  speed?: number;
}

export const matrixRainDefaults: MatrixRainProps = {
  charColor: '#00ff00',
  backgroundColor: '#000000',
  columnCount: 30,
  speed: 1.5,
};

// 生成随机字符
const getRandomChar = () => {
  const chars = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF';
  return chars[Math.floor(Math.random() * chars.length)];
};

// 生成列数据
interface ColumnData {
  x: number;
  speed: number;
  chars: string[];
  offset: number;
}

export function MatrixRain({
  charColor = '#00ff00',
  backgroundColor = '#000000',
  columnCount = 30,
  speed = 1.5,
}: MatrixRainProps) {
  const frame = useCurrentFrame();
  const { height, width } = useVideoConfig();

  // 生成列数据（只在组件挂载时生成一次）
  const columns = useMemo<ColumnData[]>(() => {
    const cols: ColumnData[] = [];
    const colWidth = width / columnCount;

    for (let i = 0; i < columnCount; i++) {
      const charCount = Math.floor(height / 20) + 5;
      cols.push({
        x: i * colWidth + colWidth / 2,
        speed: 0.5 + Math.random() * 1.5,
        chars: Array.from({ length: charCount }, () => getRandomChar()),
        offset: Math.random() * height,
      });
    }
    return cols;
  }, [columnCount, width, height]);

  return (
    <AbsoluteFill style={{ backgroundColor, overflow: 'hidden' }}>
      {columns.map((col, colIndex) => {
        const y = ((frame * speed * col.speed + col.offset) % (height + 400)) - 200;

        return (
          <div
            key={colIndex}
            style={{
              position: 'absolute',
              left: col.x,
              top: y,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              transform: 'translateX(-50%)',
            }}
          >
            {col.chars.map((char, charIndex) => {
              // 头部字符更亮
              const isHead = charIndex === 0;
              const brightness = interpolate(
                charIndex,
                [0, 5, col.chars.length],
                [1, 0.8, 0.1],
                { extrapolateRight: 'clamp' }
              );

              // 随机闪烁
              const flicker = Math.sin(frame * 0.5 + colIndex * 10 + charIndex) > 0.7 ? 1.2 : 1;

              // 每隔几帧随机改变字符
              const displayChar =
                (frame + colIndex * 3 + charIndex) % 7 === 0
                  ? getRandomChar()
                  : char;

              return (
                <span
                  key={charIndex}
                  style={{
                    color: isHead ? '#ffffff' : charColor,
                    fontSize: 18,
                    fontFamily: 'monospace',
                    lineHeight: '20px',
                    opacity: brightness * flicker,
                    textShadow: isHead
                      ? `0 0 10px ${charColor}, 0 0 20px ${charColor}`
                      : `0 0 5px ${charColor}`,
                  }}
                >
                  {displayChar}
                </span>
              );
            })}
          </div>
        );
      })}

      {/* 顶部渐变遮罩 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 100,
          background: `linear-gradient(to bottom, ${backgroundColor}, transparent)`,
        }}
      />

      {/* 底部渐变遮罩 */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 100,
          background: `linear-gradient(to top, ${backgroundColor}, transparent)`,
        }}
      />
    </AbsoluteFill>
  );
}
