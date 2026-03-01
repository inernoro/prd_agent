import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { springIn, typewriterCount } from "../utils/animations";
import { COLORS } from "../utils/colors";

/** 代码块（打字机效果） */
export const CodeBlock: React.FC<{
  code: string;
  language?: string;
  delay?: number;
  charsPerSecond?: number;
}> = ({ code, language = "typescript", delay = 0, charsPerSecond = 20 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cardProgress = springIn(frame, fps, delay);
  const visibleChars = typewriterCount(frame, code, fps, delay + 10, charsPerSecond);
  const displayText = code.substring(0, visibleChars);

  // 闪烁光标
  const showCursor = visibleChars < code.length && Math.floor(frame / 15) % 2 === 0;

  return (
    <div
      style={{
        opacity: Math.min(cardProgress, 1),
        transform: `scale(${0.95 + 0.05 * cardProgress})`,
        borderRadius: 12,
        overflow: "hidden",
        background: "#1e1e2e",
        border: `1px solid ${COLORS.glass.border}`,
      }}
    >
      {/* 标题栏 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 16px",
          background: "rgba(255,255,255,0.03)",
          borderBottom: `1px solid ${COLORS.glass.border}`,
        }}
      >
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f57" }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#febc2e" }} />
        <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#28c840" }} />
        <span style={{ marginLeft: 12, fontSize: 13, color: COLORS.text.muted }}>{language}</span>
      </div>
      {/* 代码内容 */}
      <pre
        style={{
          margin: 0,
          padding: 24,
          fontSize: 18,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          color: COLORS.neon.cyan,
          lineHeight: 1.6,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {displayText}
        {showCursor && <span style={{ color: COLORS.neon.blue }}>|</span>}
      </pre>
    </div>
  );
};
