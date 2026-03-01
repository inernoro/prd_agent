import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate } from "remotion";
import { Background } from "../components/Background";
import { FloatingShapes } from "../components/FloatingShapes";
import { COLORS } from "../utils/colors";
import { springIn } from "../utils/animations";
import type { SceneData } from "../types";

export const ComparisonScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  // 分割为两部分对比
  const parts = scene.narration.split(/[，。；]/).filter((s) => s.trim().length > 0);
  const mid = Math.floor(parts.length / 2);
  const leftContent = parts.slice(0, mid).join("，");
  const rightContent = parts.slice(mid).join("，");

  const fadeOut = interpolate(
    frame,
    [durationInFrames - 15, durationInFrames],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const leftProgress = springIn(frame, fps, 15);
  const rightProgress = springIn(frame, fps, 25);
  const vsProgress = springIn(frame, fps, 20);

  // 中间 VS 分隔线高度
  const dividerHeight = interpolate(frame, [20, 50], [0, 300], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

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
      <Background accentColor={COLORS.neon.orange} variant="default" backgroundImageUrl={scene.backgroundImageUrl} />
      <FloatingShapes accentColor={COLORS.neon.orange} seed={404} intensity="low" />

      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "0 100px",
          maxWidth: 1500,
          width: "100%",
        }}
      >
        {/* 标题 */}
        <div
          style={{
            opacity: Math.min(springIn(frame, fps, 5), 1),
            fontSize: 42,
            fontWeight: 700,
            color: COLORS.text.primary,
            marginBottom: 40,
            textAlign: "center",
            textShadow: `0 0 20px ${COLORS.neon.orange}30`,
          }}
        >
          {scene.topic}
        </div>

        {/* 对比卡片 */}
        <div style={{ display: "flex", gap: 32, width: "100%", alignItems: "stretch" }}>
          {/* 左侧 */}
          <div
            style={{
              flex: 1,
              opacity: Math.min(leftProgress, 1),
              transform: `translateX(${(1 - leftProgress) * -30}px)`,
              padding: 32,
              borderRadius: 16,
              background: COLORS.glass.bg,
              border: `1px solid ${COLORS.neon.orange}30`,
              position: "relative",
            }}
          >
            {/* 顶部色条 */}
            <div style={{ position: "absolute", top: 0, left: 20, right: 20, height: 3, borderRadius: "0 0 3px 3px", background: `linear-gradient(90deg, ${COLORS.neon.orange}, transparent)` }} />
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: COLORS.neon.orange,
                marginBottom: 16,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS.neon.orange }} />
              Before
            </div>
            <div style={{ fontSize: 20, color: COLORS.text.secondary, lineHeight: 1.6 }}>
              {leftContent || scene.narration}
            </div>
          </div>

          {/* VS 分隔 */}
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              opacity: Math.min(vsProgress, 1),
            }}
          >
            <div style={{ width: 2, height: dividerHeight * 0.4, background: `linear-gradient(180deg, transparent, ${COLORS.text.muted}40)`, borderRadius: 1 }} />
            <div
              style={{
                fontSize: 16,
                fontWeight: 800,
                color: COLORS.text.muted,
                background: `${COLORS.glass.bg}`,
                border: `1px solid ${COLORS.glass.border}`,
                padding: "6px 14px",
                borderRadius: 20,
                letterSpacing: "0.05em",
              }}
            >
              VS
            </div>
            <div style={{ width: 2, height: dividerHeight * 0.4, background: `linear-gradient(180deg, ${COLORS.text.muted}40, transparent)`, borderRadius: 1 }} />
          </div>

          {/* 右侧 */}
          <div
            style={{
              flex: 1,
              opacity: Math.min(rightProgress, 1),
              transform: `translateX(${(1 - rightProgress) * 30}px)`,
              padding: 32,
              borderRadius: 16,
              background: COLORS.glass.bg,
              border: `1px solid ${COLORS.neon.green}30`,
              position: "relative",
            }}
          >
            <div style={{ position: "absolute", top: 0, left: 20, right: 20, height: 3, borderRadius: "0 0 3px 3px", background: `linear-gradient(90deg, ${COLORS.neon.green}, transparent)` }} />
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: COLORS.neon.green,
                marginBottom: 16,
                textTransform: "uppercase",
                letterSpacing: "0.08em",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <div style={{ width: 8, height: 8, borderRadius: 2, background: COLORS.neon.green }} />
              After
            </div>
            <div style={{ fontSize: 20, color: COLORS.text.secondary, lineHeight: 1.6 }}>
              {rightContent || scene.visualDescription}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
