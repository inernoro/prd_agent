import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { COLORS } from "../utils/colors";
import {
  springIn,
  typewriterCount,
  sceneFadeOut,
  cameraZoom,
  cursorBlink,
  pulse,
} from "../utils/animations";
import type { SceneData } from "../types";

/** 简单的语法着色 — 关键词高亮 */
function colorizeCode(line: string): React.ReactNode[] {
  const keywords =
    /\b(const|let|var|function|return|import|export|from|async|await|class|extends|new|if|else|for|while|switch|case|break|default|try|catch|throw|typeof|instanceof|this|null|undefined|true|false)\b/g;
  const strings = /(["'`])(?:(?=(\\?))\2.)*?\1/g;
  const comments = /(\/\/.*$|\/\*[\s\S]*?\*\/)/g;
  const numbers = /\b(\d+\.?\d*)\b/g;

  const tokens: { start: number; end: number; color: string }[] = [];

  let m: RegExpExecArray | null;
  while ((m = keywords.exec(line)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length, color: COLORS.neon.purple });
  }
  while ((m = strings.exec(line)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length, color: COLORS.neon.green });
  }
  while ((m = comments.exec(line)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length, color: COLORS.text.muted });
  }
  while ((m = numbers.exec(line)) !== null) {
    tokens.push({ start: m.index, end: m.index + m[0].length, color: COLORS.neon.orange });
  }

  tokens.sort((a, b) => a.start - b.start);

  const result: React.ReactNode[] = [];
  let pos = 0;
  for (const token of tokens) {
    if (token.start < pos) continue;
    if (token.start > pos) {
      result.push(<span key={`t-${pos}`}>{line.slice(pos, token.start)}</span>);
    }
    result.push(
      <span key={`c-${token.start}`} style={{ color: token.color }}>
        {line.slice(token.start, token.end)}
      </span>
    );
    pos = token.end;
  }
  if (pos < line.length) {
    result.push(<span key={`t-${pos}`}>{line.slice(pos)}</span>);
  }
  return result.length > 0 ? result : [<span key="full">{line}</span>];
}

export const CodeDemoScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const fadeOut = sceneFadeOut(frame, durationInFrames);

  const codeContent = scene.visualDescription.includes("```")
    ? scene.visualDescription.replace(/```\w*\n?/g, "").replace(/```/g, "").trim()
    : scene.narration;

  const showNarration = scene.visualDescription.includes("```");
  const narrationProgress = springIn(frame, fps, 50);

  // 打字机逐行显示
  const visibleChars = typewriterCount(frame, codeContent, fps, 15, 25);
  const displayText = codeContent.substring(0, visibleChars);
  const lines = displayText.split("\n");
  const showCursor = visibleChars < codeContent.length && cursorBlink(frame) === 1;

  // 当前活跃行
  const activeLine = lines.length - 1;

  // 卡片入场
  const cardProgress = springIn(frame, fps, 8);

  // 持续缩放
  const zoom = cameraZoom(frame, durationInFrames, 1.0, 1.04);

  // 行号闪烁效果 — 活跃行行号微脉冲
  const lineNumPulse = pulse(frame, 40, 0.6, 1.0);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: fadeOut,
      }}
    >
      <Background
        accentColor={COLORS.neon.cyan}
        showGrid={false}
        variant="diagonal"
        backgroundImageUrl={scene.backgroundImageUrl}
        noiseSeed="code"
      />
      <ParticleField count={40} accentColor={COLORS.neon.cyan} seed={303} speed={0.3} showTrails={false} />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "0 100px",
          maxWidth: 1500,
          width: "100%",
          transform: `scale(${zoom})`,
        }}
      >
        {/* 标题 */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 28 }}>
          <div
            style={{
              opacity: Math.min(springIn(frame, fps, 3), 1),
              width: 44,
              height: 44,
              borderRadius: 10,
              background: `${COLORS.neon.cyan}15`,
              border: `1px solid ${COLORS.neon.cyan}30`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              color: COLORS.neon.cyan,
              boxShadow: `0 0 16px ${COLORS.neon.cyan}25`,
            }}
          >
            {"</>"}
          </div>
          <div
            style={{
              opacity: Math.min(springIn(frame, fps, 5), 1),
              fontSize: 38,
              fontWeight: 700,
              color: COLORS.text.primary,
              textShadow: `0 0 24px ${COLORS.neon.cyan}30`,
            }}
          >
            {scene.topic}
          </div>
        </div>

        {/* 代码编辑器 */}
        <div
          style={{
            opacity: Math.min(cardProgress, 1),
            transform: `scale(${0.95 + 0.05 * cardProgress}) perspective(1000px) rotateX(${(1 - Math.min(cardProgress, 1)) * 5}deg)`,
            borderRadius: 14,
            overflow: "hidden",
            background: "#1e1e2e",
            border: `1px solid ${COLORS.glass.border}`,
            boxShadow: `0 8px 40px rgba(0,0,0,0.6), 0 0 20px ${COLORS.neon.cyan}10`,
          }}
        >
          {/* 标题栏 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "12px 18px",
              background: "rgba(255,255,255,0.03)",
              borderBottom: `1px solid ${COLORS.glass.border}`,
            }}
          >
            <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#ff5f57" }} />
            <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#febc2e" }} />
            <div style={{ width: 12, height: 12, borderRadius: "50%", background: "#28c840" }} />
            <span style={{ marginLeft: 16, fontSize: 13, color: COLORS.text.muted }}>
              typescript
            </span>
            {/* 右侧迷你地图装饰 */}
            <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              {[40, 60, 35, 50, 25].map((w, i) => (
                <div
                  key={i}
                  style={{
                    width: w * 0.3,
                    height: 2,
                    borderRadius: 1,
                    background: `${COLORS.neon.cyan}${i === activeLine % 5 ? "40" : "15"}`,
                  }}
                />
              ))}
            </div>
          </div>

          {/* 代码内容 */}
          <div
            style={{
              padding: "18px 0",
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              fontSize: 17,
              lineHeight: 1.8,
            }}
          >
            {lines.map((line, li) => {
              const isActive = li === activeLine && visibleChars < codeContent.length;
              return (
                <div
                  key={li}
                  style={{
                    display: "flex",
                    padding: "0 24px 0 0",
                    background: isActive ? `${COLORS.neon.cyan}08` : "transparent",
                    borderLeft: isActive
                      ? `3px solid ${COLORS.neon.cyan}80`
                      : "3px solid transparent",
                  }}
                >
                  {/* 行号 */}
                  <span
                    style={{
                      width: 54,
                      textAlign: "right",
                      paddingRight: 18,
                      color: isActive ? COLORS.neon.cyan : COLORS.text.muted,
                      fontSize: 14,
                      userSelect: "none",
                      flexShrink: 0,
                      opacity: isActive ? lineNumPulse : 0.4,
                    }}
                  >
                    {li + 1}
                  </span>
                  {/* 代码 — 语法着色 */}
                  <span
                    style={{
                      color: COLORS.neon.cyan,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                    }}
                  >
                    {colorizeCode(line)}
                    {li === lines.length - 1 && showCursor && (
                      <span
                        style={{
                          display: "inline-block",
                          width: 2,
                          height: 20,
                          background: COLORS.neon.blue,
                          marginLeft: 1,
                          verticalAlign: "text-bottom",
                          boxShadow: `0 0 6px ${COLORS.neon.blue}`,
                        }}
                      />
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* 旁白说明 */}
        {showNarration && (
          <div
            style={{
              opacity: Math.min(narrationProgress, 1) * 0.8,
              transform: `translateY(${(1 - narrationProgress) * 10}px)`,
              marginTop: 22,
              fontSize: 18,
              color: COLORS.text.secondary,
              lineHeight: 1.5,
              paddingLeft: 18,
              borderLeft: `3px solid ${COLORS.neon.cyan}40`,
            }}
          >
            {scene.narration}
          </div>
        )}
      </div>
    </div>
  );
};
