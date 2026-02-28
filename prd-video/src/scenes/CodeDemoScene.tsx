import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { FloatingShapes } from "../components/FloatingShapes";
import { CodeBlock } from "../components/CodeBlock";
import { COLORS } from "../utils/colors";
import { springIn } from "../utils/animations";
import type { SceneData } from "../types";

export const CodeDemoScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const fadeOut = interpolate(
    frame,
    [durationInFrames - 15, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // 使用 visualDescription 作为代码内容（如果含代码块），否则用 narration
  const codeContent = scene.visualDescription.includes("```")
    ? scene.visualDescription.replace(/```\w*\n?/g, "").replace(/```/g, "").trim()
    : scene.narration;

  // 旁白文字（如果代码来自 visualDescription，则显示 narration 作为说明）
  const showNarration = scene.visualDescription.includes("```");
  const narrationProgress = springIn(frame, fps, 50);

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
      <Background accentColor={COLORS.neon.cyan} showGrid={false} variant="diagonal" />
      <FloatingShapes accentColor={COLORS.neon.cyan} seed={303} intensity="low" />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "0 100px",
          maxWidth: 1500,
          width: "100%",
        }}
      >
        {/* 标题行：图标 + 标题 */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 28 }}>
          {/* 代码图标 */}
          <div
            style={{
              opacity: Math.min(springIn(frame, fps, 3), 1),
              width: 40,
              height: 40,
              borderRadius: 8,
              background: `${COLORS.neon.cyan}15`,
              border: `1px solid ${COLORS.neon.cyan}30`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 18,
              color: COLORS.neon.cyan,
            }}
          >
            {"</>"}
          </div>
          <div
            style={{
              opacity: Math.min(springIn(frame, fps, 5), 1),
              fontSize: 36,
              fontWeight: 700,
              color: COLORS.text.primary,
              textShadow: `0 0 20px ${COLORS.neon.cyan}30`,
            }}
          >
            {scene.topic}
          </div>
        </div>

        <CodeBlock code={codeContent} delay={10} charsPerSecond={25} />

        {/* 底部旁白说明 */}
        {showNarration && (
          <div
            style={{
              opacity: Math.min(narrationProgress, 1) * 0.8,
              transform: `translateY(${(1 - narrationProgress) * 10}px)`,
              marginTop: 20,
              fontSize: 18,
              color: COLORS.text.secondary,
              lineHeight: 1.5,
              paddingLeft: 16,
              borderLeft: `2px solid ${COLORS.neon.cyan}40`,
            }}
          >
            {scene.narration}
          </div>
        )}
      </div>
    </div>
  );
};
