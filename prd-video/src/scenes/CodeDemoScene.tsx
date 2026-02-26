import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
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
      <Background accentColor={COLORS.neon.cyan} showGrid={false} />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "0 100px",
          maxWidth: 1500,
          width: "100%",
        }}
      >
        <div
          style={{
            opacity: Math.min(springIn(frame, fps, 5), 1),
            fontSize: 36,
            fontWeight: 700,
            color: COLORS.text.primary,
            marginBottom: 32,
            textShadow: `0 0 20px ${COLORS.neon.cyan}30`,
          }}
        >
          {scene.topic}
        </div>

        <CodeBlock code={codeContent} delay={10} charsPerSecond={25} />
      </div>
    </div>
  );
};
