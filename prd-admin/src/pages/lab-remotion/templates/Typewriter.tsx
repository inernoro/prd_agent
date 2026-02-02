import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';

export interface TypewriterProps {
  text?: string;
  textColor?: string;
  backgroundColor?: string;
  cursorColor?: string;
  typingSpeed?: number;
}

export const typewriterDefaults: TypewriterProps = {
  text: 'Hello, World!\nWelcome to Remotion.',
  textColor: '#00ff00',
  backgroundColor: '#1a1a2e',
  cursorColor: '#00ff00',
  typingSpeed: 3,
};

export function Typewriter({
  text = 'Hello, World!\nWelcome to Remotion.',
  textColor = '#00ff00',
  backgroundColor = '#1a1a2e',
  cursorColor = '#00ff00',
  typingSpeed = 3,
}: TypewriterProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // 确保 text 不为 undefined
  const safeText = text || '';
  const safeSpeed = typingSpeed || 3;

  // 计算当前显示的字符数
  const charsToShow = Math.floor(frame / safeSpeed);
  const displayText = safeText.slice(0, charsToShow);

  // 光标闪烁
  const cursorVisible = Math.floor(frame / (fps / 2)) % 2 === 0;

  // 是否还在打字
  const isTyping = charsToShow < safeText.length;

  // 打字时光标不闪烁
  const showCursor = isTyping || cursorVisible;

  // 分割成行
  const lines = displayText.split('\n');

  // 终端风格的入场动画
  const terminalOpacity = interpolate(frame, [0, 10], [0, 1], {
    extrapolateRight: 'clamp',
  });

  const terminalScale = interpolate(frame, [0, 10], [0.95, 1], {
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill
      style={{
        backgroundColor,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        padding: 60,
      }}
    >
      {/* 终端窗口 */}
      <div
        style={{
          backgroundColor: 'rgba(0, 0, 0, 0.8)',
          borderRadius: 12,
          padding: 0,
          width: '80%',
          maxWidth: 900,
          boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
          opacity: terminalOpacity,
          transform: `scale(${terminalScale})`,
          overflow: 'hidden',
        }}
      >
        {/* 终端标题栏 */}
        <div
          style={{
            backgroundColor: 'rgba(255, 255, 255, 0.1)',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {/* 窗口按钮 */}
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              backgroundColor: '#ff5f56',
            }}
          />
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              backgroundColor: '#ffbd2e',
            }}
          />
          <div
            style={{
              width: 12,
              height: 12,
              borderRadius: '50%',
              backgroundColor: '#27ca3f',
            }}
          />
          <span
            style={{
              marginLeft: 'auto',
              marginRight: 'auto',
              color: 'rgba(255, 255, 255, 0.5)',
              fontSize: 14,
              fontFamily: 'monospace',
            }}
          >
            Terminal
          </span>
        </div>

        {/* 终端内容 */}
        <div
          style={{
            padding: '24px 24px 32px',
            minHeight: 200,
          }}
        >
          {/* 提示符 + 文字 */}
          <div
            style={{
              fontFamily: '"Fira Code", "SF Mono", Consolas, monospace',
              fontSize: 24,
              lineHeight: 1.6,
              color: textColor,
            }}
          >
            {lines.map((line, lineIndex) => (
              <div key={lineIndex} style={{ display: 'flex' }}>
                {/* 提示符 */}
                <span style={{ color: '#888', marginRight: 12 }}>
                  {lineIndex === 0 ? '❯' : ''}
                </span>

                {/* 文字内容 */}
                <span>
                  {line}
                  {/* 光标在最后一行 */}
                  {lineIndex === lines.length - 1 && showCursor && (
                    <span
                      style={{
                        display: 'inline-block',
                        width: 12,
                        height: 28,
                        backgroundColor: cursorColor,
                        marginLeft: 2,
                        animation: 'none',
                        verticalAlign: 'middle',
                        boxShadow: `0 0 10px ${cursorColor}`,
                      }}
                    />
                  )}
                </span>
              </div>
            ))}

            {/* 如果文字为空，也显示光标 */}
            {displayText === '' && showCursor && (
              <div style={{ display: 'flex' }}>
                <span style={{ color: '#888', marginRight: 12 }}>❯</span>
                <span
                  style={{
                    display: 'inline-block',
                    width: 12,
                    height: 28,
                    backgroundColor: cursorColor,
                    boxShadow: `0 0 10px ${cursorColor}`,
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 扫描线效果 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background:
            'repeating-linear-gradient(0deg, rgba(0,0,0,0.1) 0px, rgba(0,0,0,0.1) 1px, transparent 1px, transparent 3px)',
          pointerEvents: 'none',
        }}
      />

      {/* 边角光晕 */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background:
            'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.3) 100%)',
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
}
