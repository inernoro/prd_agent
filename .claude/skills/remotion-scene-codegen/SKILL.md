# Remotion Scene Code Generation — 视频场景代码生成技能

为视频 Agent 的 LLM 代码生成提供 Remotion 知识上下文。当需要优化视频场景的视觉表现时，将此技能的知识作为系统提示词注入 LLM Gateway，让大模型能生成高质量的 Remotion 场景代码。

## 触发词

- "优化场景"、"升级动效"、"美化视频"
- "remotion codegen"、"scene code"
- "场景代码生成"

## 用途

本技能有两个作用：

1. **AI 助手参考**：当你（Claude）需要编写或优化 prd-video 中的场景组件时，参考此文档中的 Remotion API、组件库和动效工具函数
2. **LLM Gateway 系统提示词**：将本技能的核心知识嵌入到 `video-agent.scene.codegen::code` AppCallerCode 的请求中，让大模型为每个分镜生成定制化的 Remotion JSX 代码

## Remotion 核心 API

### 帧与时间

```typescript
import { useCurrentFrame, useVideoConfig, interpolate, spring, Easing } from "remotion";

const frame = useCurrentFrame();            // 当前帧号（从 0 开始）
const { fps, durationInFrames, width, height } = useVideoConfig();  // 30fps, 1920x1080

// 线性插值
const opacity = interpolate(frame, [0, 30], [0, 1], {
  extrapolateLeft: "clamp",
  extrapolateRight: "clamp",
});

// 弹性动画
const scale = spring({ frame, fps, config: { damping: 12, mass: 0.5, stiffness: 100 } });

// 缓动曲线
Easing.out(Easing.cubic)    // 减速出场
Easing.inOut(Easing.quad)   // 平滑进出
Easing.elastic(1)           // 弹性
Easing.bounce               // 弹跳
Easing.back(1.7)            // 回弹
```

### 媒体组件

```typescript
import { Audio, Img, AbsoluteFill, Sequence } from "remotion";

<Audio src={audioUrl} />              // 音频播放
<Img src={imageUrl} />                // 图片（自动预加载）
<AbsoluteFill>...</AbsoluteFill>      // 全屏绝对定位容器
<Sequence from={30} durationInFrames={60}>  // 时间段控制
  <ChildComponent />
</Sequence>
```

### 转场（TransitionSeries）

```typescript
import { TransitionSeries, linearTiming, springTiming } from "@remotion/transitions";
import { slide } from "@remotion/transitions/slide";
import { fade } from "@remotion/transitions/fade";
import { wipe } from "@remotion/transitions/wipe";
```

## 项目动效工具库（animations.ts）

所有场景可直接 import 使用：

### 基础入场/退场
| 函数 | 参数 | 返回 | 用途 |
|------|------|------|------|
| `springIn(frame, fps, delay?, config?)` | frame, fps, delay=0 | 0→1 spring | 弹性入场 |
| `fadeIn(frame, startFrame, duration)` | frame, start, dur | 0→1 | 渐入 |
| `fadeOut(frame, startFrame, duration)` | frame, start, dur | 1→0 | 渐出 |
| `slideInFromBottom(frame, fps, delay?)` | frame, fps, delay=0 | 60→0 (px) | 底部滑入 |
| `sceneFadeOut(frame, durationInFrames, fadeFrames?)` | frame, dur, fade=15 | 1→0 | 场景标准退出 |

### 文字动画
| 函数 | 用途 |
|------|------|
| `typewriterCount(frame, text, fps, startFrame?, charsPerSec?)` | 打字机效果，返回应显示字符数 |
| `counterValue(frame, target, duration, startFrame?)` | 数字滚动动画 |

### 交错动画
| 函数 | 用途 |
|------|------|
| `staggerIn(frame, fps, index, staggerFrames?, baseDelay?, config?)` | 列表项交错弹性入场 |
| `waveIn(frame, index, total, startFrame?, duration?)` | 波浪式柔和入场 |

### 弹性/物理
| 函数 | 用途 |
|------|------|
| `elasticIn(frame, fps, delay?)` | 弹性过冲 |
| `bounceIn(frame, startFrame, duration)` | 弹跳落地 |
| `backIn(frame, startFrame, duration)` | 回弹入场 |

### 循环动画
| 函数 | 用途 |
|------|------|
| `pulse(frame, period?, min?, max?)` | 呼吸脉冲 |
| `float(frame, ampY?, ampX?, speed?, seed?)` | 浮动悬停 {x, y} |
| `rotate(frame, degPerSec?, fps?)` | 持续旋转 |
| `glowPulse(frame, period?, min?, max?)` | 发光脉冲 |

### 空间动画
| 函数 | 用途 |
|------|------|
| `circularMotion(frame, radius, speed?, offset?)` | 圆弧运动 {x, y} |
| `easedProgress(frame, startFrame, duration, easing?)` | 缓动进度 0→1 |

### 视觉效果
| 函数 | 用途 |
|------|------|
| `shimmerScan(frame, period?, delay?)` | 光泽扫描位置 (-20→120%) |
| `ripple(frame, startFrame, duration, maxRadius?)` | 涟漪扩散 {radius, opacity} |

### 电影级效果
| 函数 | 用途 |
|------|------|
| `kenBurns(frame, duration, config?)` | Ken Burns 缩放平移 {scale, x, y} |
| `vignetteOpacity(frame, startFrame?, fadeIn?)` | 暗角强度 |
| `cameraZoom(frame, duration, start?, end?)` | 摄像机推进 |
| `energyRing(frame, period?, maxR?, delay?)` | 能量环扩散 {radius, opacity} |
| `flowingDot(frame, period?, delay?)` | 光点沿路径 0→1 |
| `focusScale(isActive, frame, fps, activeFrame)` | 焦点缩放 |
| `cursorBlink(frame, period?)` | 光标闪烁 0/1 |

## 可复用组件库

### Background
```typescript
<Background scene={scene} durationInFrames={durationInFrames} />
```
渲染场景背景（纯色渐变 / AI 生成图片 + Ken Burns + 暗角效果）。

### ParticleField
```typescript
<ParticleField count={40} color="rgba(0,212,255,0.3)" speed={0.5} />
```
粒子场背景装饰。

### AnimatedText
```typescript
<AnimatedText text="标题" delay={0} fontSize={72} color="#fff" />
```
带弹性入场的文字。

### GlassCard
```typescript
<GlassCard delay={5}>
  <p>内容</p>
</GlassCard>
```
毛玻璃卡片容器，弹性入场。

### CodeBlock
```typescript
<CodeBlock code={codeString} language="javascript" delay={10} />
```
语法高亮代码块（带光标闪烁和行号）。

### CompareCard
```typescript
<CompareCard side="before" items={[...]} delay={0} accent="#color" />
```
对比卡片（左右比较用）。

### StepFlow
```typescript
<StepFlow steps={["步骤1", "步骤2"]} activeIndex={currentStep} />
```
步骤流程图组件。

### PathDraw
```typescript
<PathDraw d="M 0 0 L 100 100" color="#00d4ff" duration={30} delay={0} />
```
SVG 路径描边动画。

### NumberCounter
```typescript
<NumberCounter target={95} suffix="%" delay={10} />
```
数字滚动计数器。

### ProgressBar
```typescript
<ProgressBar progress={0.75} color="#22c55e" delay={5} />
```
进度条组件。

## 色彩系统

```typescript
import { COLORS, getSceneAccentColor } from "../utils/colors";

COLORS.bg.primary      // "#0a0a1a" 深色主背景
COLORS.bg.secondary    // "#111128" 次级背景
COLORS.neon.blue       // "#00d4ff" 霓虹蓝
COLORS.neon.purple     // "#a855f7" 霓虹紫
COLORS.neon.green      // "#22c55e" 霓虹绿
COLORS.neon.pink       // "#ec4899" 霓虹粉
COLORS.neon.orange     // "#f97316" 霓虹橙
COLORS.neon.cyan       // "#06b6d4" 霓虹青
COLORS.text.primary    // "#ffffff"
COLORS.text.secondary  // "rgba(255,255,255,0.7)"
COLORS.text.muted      // "rgba(255,255,255,0.4)"
COLORS.glass.bg        // "rgba(255,255,255,0.05)"
COLORS.glass.border    // "rgba(255,255,255,0.1)"

getSceneAccentColor("intro")  // → "#00d4ff"
getSceneAccentColor("code")   // → "#06b6d4"
```

## 8 种场景类型及其设计原则

| 类型 | 场景 | 视觉重点 | 关键动效 |
|------|------|----------|----------|
| `intro` | 开场 | 标题居中 + 副标题 + 粒子 | 能量脉冲环、扫描光、标题辉光 |
| `concept` | 概念讲解 | 文字卡片 + 关键词 | 3D 翻转入场、打字机效果、时间线进度条 |
| `steps` | 步骤流程 | 步骤卡片 + 连线 + 进度 | 流光圆点连线、SVG 环形进度、焦点缩放 |
| `code` | 代码展示 | 代码块 + 行号高亮 | 3D 透视倾斜、光标闪烁、活跃行高亮 |
| `comparison` | 对比 | 左右对比卡 + VS 中间 | 天平倾斜、交错飞入、VS 弹跳能量 |
| `diagram` | 架构图 | 节点 + 连线 + 中心元素 | 能量粒子流动、中心波纹、节点浮动 |
| `summary` | 总结 | 数据可视化 + 要点列表 | 三环进度、完成辉光爆发、百分比弹跳 |
| `outro` | 结尾 | CTA + 致谢 | 光晕扩散环、字幕滚动 |

## 场景代码编写规则

### 必须遵循

1. **纯 React + inline style**：不使用 CSS 文件，所有样式内联
2. **帧驱动动画**：所有动画基于 `useCurrentFrame()` 和 `interpolate` / `spring`，不使用 CSS 动画或 requestAnimationFrame
3. **30fps 基准**：所有时间计算基于 30fps（如 1 秒 = 30 帧）
4. **1920x1080**：画布尺寸固定
5. **AbsoluteFill 分层**：每个视觉层用 `<div style={{ position: 'absolute', ...}}>` 或 `<AbsoluteFill>`
6. **深色主题**：背景色 `#0a0a1a`，文字白色，强调色用霓虹色系
7. **退场淡出**：每个场景最后 15 帧使用 `sceneFadeOut` 做统一淡出

### 视觉设计原则

1. **层次分明**：背景层 → 装饰层 → 内容层 → 前景效果层
2. **动静结合**：主内容有进场动画，背景有持续微动效（粒子、Ken Burns）
3. **节奏感**：元素交错入场（staggerIn），不要同时出现
4. **呼吸感**：使用 pulse/glowPulse 让静态元素有生命力
5. **电影感**：cameraZoom 缓慢推进 + vignetteOpacity 暗角
6. **克制**：动效服务于内容，不喧宾夺主

### 禁止

1. **禁止使用 CSS 动画** (@keyframes, animation, transition)
2. **禁止使用 setTimeout / setInterval**
3. **禁止使用外部字体**（Remotion 需要本地字体或 Google Fonts 注册）
4. **禁止硬编码时长**（使用 `durationInFrames` 参数）

## SceneData 输入接口

每个场景组件接收：

```typescript
interface SceneData {
  index: number;              // 镜头序号
  topic: string;              // 主题标题
  narration: string;          // 旁白文本
  visualDescription: string;  // 画面描述（可用于提取关键词）
  durationSeconds: number;    // 时长秒数
  durationInFrames: number;   // 帧数（= seconds × 30）
  sceneType: SceneType;       // 场景类型
  backgroundImageUrl?: string;// AI 生成的背景图
  audioUrl?: string;          // TTS 语音 URL
}
```

## 示例：生成 Concept 场景代码片段

```typescript
import React from "react";
import { useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { Background } from "../components/Background";
import { ParticleField } from "../components/ParticleField";
import { COLORS } from "../utils/colors";
import { springIn, sceneFadeOut, staggerIn, cameraZoom, glowPulse } from "../utils/animations";
import type { SceneData } from "../types";

export const ConceptScene: React.FC<{ scene: SceneData }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const fadeOutOpacity = sceneFadeOut(frame, durationInFrames);
  const zoom = cameraZoom(frame, durationInFrames, 1.0, 1.06);

  // 从旁白文本提取段落
  const paragraphs = scene.narration.split(/[。！？]/).filter(Boolean);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", opacity: fadeOutOpacity }}>
      <div style={{ transform: `scale(${zoom})`, width: "100%", height: "100%", position: "absolute" }}>
        <Background scene={scene} durationInFrames={durationInFrames} />
        <ParticleField count={30} color="rgba(168,85,247,0.2)" />
      </div>

      {/* 内容层 */}
      <div style={{ position: "absolute", inset: 0, padding: "80px 100px", display: "flex", flexDirection: "column", justifyContent: "center" }}>
        {/* 标题 */}
        <h1 style={{
          fontSize: 56,
          fontWeight: 800,
          color: COLORS.text.primary,
          opacity: springIn(frame, fps, 5),
          transform: `translateY(${interpolate(springIn(frame, fps, 5), [0, 1], [30, 0])}px)`,
        }}>
          {scene.topic}
        </h1>

        {/* 交错入场的内容卡片 */}
        {paragraphs.map((p, i) => {
          const progress = staggerIn(frame, fps, i, 8, 15);
          return (
            <div key={i} style={{
              marginTop: 20,
              padding: "16px 24px",
              background: COLORS.glass.bg,
              border: `1px solid ${COLORS.glass.border}`,
              borderRadius: 12,
              opacity: progress,
              transform: `translateX(${interpolate(progress, [0, 1], [-40, 0])}px)`,
            }}>
              <p style={{ fontSize: 24, color: COLORS.text.secondary, margin: 0 }}>
                {p}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
};
```

## AppCallerCode

视频场景代码生成使用专属 AppCallerCode：

```
video-agent.scene.codegen::code
```

该 Code 类型的 LLM 调用配合本技能的系统提示词，让大模型在了解 Remotion API 和项目组件库的基础上，为每个分镜生成定制化的高质量视觉代码。
