import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring } from 'remotion';

export interface BarChartProps {
  title?: string;
  barColor?: string;
  backgroundColor?: string;
  textColor?: string;
}

export const barChartDefaults: BarChartProps = {
  title: '2024 年度销售数据',
  barColor: '#3b82f6',
  backgroundColor: '#0f172a',
  textColor: '#e2e8f0',
};

// 预设数据
const DATA = [
  { label: 'Q1', value: 65 },
  { label: 'Q2', value: 85 },
  { label: 'Q3', value: 72 },
  { label: 'Q4', value: 95 },
];

export function BarChart({
  title = '2024 年度销售数据',
  barColor = '#3b82f6',
  backgroundColor = '#0f172a',
  textColor = '#e2e8f0',
}: BarChartProps) {
  // 从 barColor 提取基础色相 (简化处理，使用预设色相)
  const baseHue = barColor === '#3b82f6' ? 210 : 220;
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 标题入场
  const titleOpacity = interpolate(frame, [0, 15], [0, 1], {
    extrapolateRight: 'clamp',
  });
  const titleY = interpolate(frame, [0, 15], [-20, 0], {
    extrapolateRight: 'clamp',
  });

  // 最大值用于计算比例
  const maxValue = Math.max(...DATA.map((d) => d.value));

  return (
    <AbsoluteFill
      style={{
        backgroundColor,
        padding: 60,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* 标题 */}
      <h1
        style={{
          fontSize: 48,
          fontWeight: 700,
          color: textColor,
          textAlign: 'center',
          marginBottom: 40,
          opacity: titleOpacity,
          transform: `translateY(${titleY}px)`,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {title}
      </h1>

      {/* 图表容器 */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'center',
          gap: 40,
          paddingBottom: 60,
        }}
      >
        {DATA.map((item, index) => {
          // 每个柱子延迟入场
          const delay = index * 8;
          const barProgress = spring({
            frame: frame - delay - 15,
            fps,
            config: {
              damping: 12,
              stiffness: 80,
            },
          });

          const barHeight = (item.value / maxValue) * 350 * Math.max(0, barProgress);

          // 数值显示
          const valueOpacity = interpolate(
            frame,
            [delay + 30, delay + 40],
            [0, 1],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
          );

          const displayValue = Math.round(item.value * Math.max(0, barProgress));

          // 柱子颜色渐变
          const hue = interpolate(index, [0, DATA.length - 1], [baseHue, baseHue + 50]);

          return (
            <div
              key={item.label}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 12,
              }}
            >
              {/* 数值 */}
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 600,
                  color: textColor,
                  opacity: valueOpacity,
                  fontFamily: 'system-ui, sans-serif',
                }}
              >
                {displayValue}
              </div>

              {/* 柱子 */}
              <div
                style={{
                  width: 80,
                  height: barHeight,
                  background: `linear-gradient(180deg, hsl(${hue}, 70%, 60%) 0%, hsl(${hue}, 70%, 45%) 100%)`,
                  borderRadius: '8px 8px 0 0',
                  boxShadow: `0 0 20px hsla(${hue}, 70%, 50%, 0.3)`,
                  position: 'relative',
                  overflow: 'hidden',
                }}
              >
                {/* 光泽效果 */}
                <div
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: '50%',
                    background:
                      'linear-gradient(180deg, rgba(255,255,255,0.2) 0%, transparent 100%)',
                    borderRadius: '8px 8px 0 0',
                  }}
                />

                {/* 动态高光 */}
                <div
                  style={{
                    position: 'absolute',
                    top: -100,
                    left: -50,
                    width: 30,
                    height: 200,
                    background:
                      'linear-gradient(90deg, transparent, rgba(255,255,255,0.3), transparent)',
                    transform: `translateX(${frame * 3}px) rotate(20deg)`,
                  }}
                />
              </div>

              {/* 标签 */}
              <div
                style={{
                  fontSize: 24,
                  fontWeight: 500,
                  color: textColor,
                  opacity: 0.8,
                  fontFamily: 'system-ui, sans-serif',
                }}
              >
                {item.label}
              </div>
            </div>
          );
        })}
      </div>

      {/* 底部装饰线 */}
      <div
        style={{
          position: 'absolute',
          bottom: 100,
          left: 100,
          right: 100,
          height: 2,
          backgroundColor: 'rgba(255, 255, 255, 0.1)',
        }}
      />

      {/* 网格线 */}
      {[0.25, 0.5, 0.75, 1].map((ratio, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            bottom: 100 + ratio * 350,
            left: 80,
            right: 80,
            height: 1,
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            opacity: interpolate(frame, [10 + i * 5, 20 + i * 5], [0, 1], {
              extrapolateRight: 'clamp',
            }),
          }}
        />
      ))}
    </AbsoluteFill>
  );
}
