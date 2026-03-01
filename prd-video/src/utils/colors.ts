export const COLORS = {
  // 主色调：深色科技感
  bg: {
    primary: "#0a0a1a",
    secondary: "#111128",
    gradient: ["#0a0a1a", "#1a1a3e", "#0a0a1a"],
  },
  // 霓虹色
  neon: {
    blue: "#00d4ff",
    purple: "#a855f7",
    green: "#22c55e",
    pink: "#ec4899",
    orange: "#f97316",
    cyan: "#06b6d4",
  },
  // 文本色
  text: {
    primary: "#ffffff",
    secondary: "rgba(255, 255, 255, 0.7)",
    muted: "rgba(255, 255, 255, 0.4)",
  },
  // 玻璃效果
  glass: {
    bg: "rgba(255, 255, 255, 0.05)",
    border: "rgba(255, 255, 255, 0.1)",
    highlight: "rgba(255, 255, 255, 0.15)",
  },
};

/** 根据场景类型返回强调色 */
export function getSceneAccentColor(sceneType: string): string {
  const map: Record<string, string> = {
    intro: COLORS.neon.blue,
    concept: COLORS.neon.purple,
    steps: COLORS.neon.green,
    code: COLORS.neon.cyan,
    comparison: COLORS.neon.orange,
    diagram: COLORS.neon.pink,
    summary: COLORS.neon.blue,
    outro: COLORS.neon.purple,
  };
  return map[sceneType] ?? COLORS.neon.blue;
}
