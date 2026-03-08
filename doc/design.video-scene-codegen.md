# 视频场景代码生成（Scene Codegen）架构设计

> **版本**：v1.0 | **日期**：2026-03-08 | **状态**：已实现

## 1. 概述

Scene Codegen 是视频 Agent 的核心子系统，通过 LLM 为每个视频分镜生成定制化的 Remotion React 组件代码，替代硬编码的 8 种场景模板，实现"千镜千面"的视觉效果。

### 设计目标

- 每个分镜获得独特的视觉设计，而非千篇一律的模板
- 生成失败时无缝回退到硬编码组件，保证渲染不中断
- 与现有 Worker 轮询架构一致，无需新增基础设施

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    VideoGenRunWorker                         │
│                                                             │
│  ProcessScriptingAsync (路径 1)                              │
│    ├── LLM 生成分镜脚本 JSON                                  │
│    ├── 解析为 VideoGenScene[]                                 │
│    └── 所有分镜 CodeStatus = "running"  ← 自动触发            │
│                                                             │
│  ProcessSceneCodegenAsync (路径 7)                            │
│    ├── 找到 CodeStatus="running" 的分镜                       │
│    ├── 调用 ILlmGateway（系统提示词 + 分镜信息）                │
│    ├── 提取 TSX 代码 → 存入 scene.SceneCode                   │
│    └── CodeStatus = "done" | "error"                        │
│                                                             │
│  ProcessScenePreviewRenderAsync (路径 4) / ProcessRendering   │
│    ├── WriteGeneratedScenesToDisk()                          │
│    │   ├── 写入 Scene_{index}.tsx 到 generated/               │
│    │   └── 重新生成 index.ts 注册表                            │
│    ├── 构造 props JSON (hasGeneratedCode=true)                │
│    ├── npx remotion render ...                               │
│    └── CleanupGeneratedScenes()                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    prd-video (Remotion)                      │
│                                                             │
│  scenes/generated/                                          │
│    ├── index.ts          ← 注册表（require + try/catch）      │
│    ├── Scene_0.tsx       ← LLM 生成的组件                     │
│    ├── Scene_1.tsx                                           │
│    └── ...                                                  │
│                                                             │
│  SingleScene.tsx / TutorialVideo.tsx                         │
│    ├── 检查 scene.hasGeneratedCode                            │
│    ├── 查找 GENERATED_SCENES[scene.index]                    │
│    ├── 找到 → 使用 LLM 生成的组件                              │
│    └── 未找到 → 回退到 SCENE_MAP 硬编码组件                     │
└─────────────────────────────────────────────────────────────┘
```

## 3. 数据模型

### 3.1 VideoGenScene 新增字段

```csharp
// PrdAgent.Core/Models/VideoGenModels.cs
public class VideoGenScene
{
    // ... 原有字段 (Index, Topic, Narration, SceneType, etc.) ...

    /// LLM 生成的 Remotion 场景代码（完整 .tsx 组件代码）
    public string? SceneCode { get; set; }

    /// 场景代码生成状态：idle / running / done / error
    public string CodeStatus { get; set; } = "idle";
}
```

### 3.2 SceneData 前端类型

```typescript
// prd-video/src/types.ts
export interface SceneData {
  index: number;
  topic: string;
  narration: string;
  visualDescription: string;
  durationSeconds: number;
  durationInFrames: number;
  sceneType: SceneType;
  backgroundImageUrl?: string;
  audioUrl?: string;
  /** 是否有 LLM 生成的自定义场景代码 */
  hasGeneratedCode?: boolean;
}
```

### 3.3 状态机

```
CodeStatus 状态流转：

  idle ──(脚本生成完成)──→ running ──(LLM 成功)──→ done
                             │                      │
                             └──(LLM 失败)──→ error  │
                                                     ↓
                                            渲染时写入磁盘
```

## 4. 调用链路详解

### 4.1 触发时机

脚本生成完成后（`ProcessScriptingAsync`），在切换到 Editing 状态前，自动将所有分镜的 `CodeStatus` 设为 `"running"`：

```csharp
// VideoGenRunWorker.cs:839-843
// 触发场景代码生成：所有分镜的 CodeStatus 设为 running
foreach (var s in scenes)
{
    s.CodeStatus = "running";
}
```

**注意**：AutoRender 模式（工作流胶囊）不触发 codegen，直接进入 Rendering 状态。

### 4.2 Worker 轮询路径

Worker 的 `ExecuteAsync` 包含 7 条轮询路径，codegen 是路径 7：

| 路径 | 触发条件 | 处理方法 |
|------|----------|----------|
| 1 | Status=Queued | `ProcessScriptingAsync` — 分镜脚本生成 |
| 2 | Status=Rendering | `ProcessRenderingAsync` — 完整视频渲染 |
| 3 | Editing + 有 Generating 分镜 | `ProcessSceneRegenerationAsync` — 单条重试 |
| 4 | Editing + ImageStatus=running | `ProcessScenePreviewRenderAsync` — 单场景预览 |
| 5 | Editing + BackgroundImageStatus=running | `ProcessSceneBgImageGenerationAsync` — 背景图 |
| 6 | Editing + AudioStatus=running | `ProcessSceneAudioGenerationAsync` — TTS 语音 |
| **7** | **Editing + CodeStatus=running** | **`ProcessSceneCodegenAsync` — 场景代码生成** |

### 4.3 LLM 调用

```csharp
// AppCallerCode: "video-agent.scene.codegen::code"
// ModelType: "code"
var request = new GatewayRequest
{
    AppCallerCode = AppCallerRegistry.VideoAgent.Scene.Codegen,
    ModelType = ModelTypes.Code,
    RequestBody = new JsonObject
    {
        ["messages"] = new JsonArray
        {
            new JsonObject { ["role"] = "system", ["content"] = systemPrompt },
            new JsonObject { ["role"] = "user", ["content"] = userPrompt }
        }
    },
    Stream = false,
    TimeoutSeconds = 120
};

var response = await gateway.SendAsync(request, CancellationToken.None);
```

**前提条件**：需要在模型组管理 UI 中为 `video-agent.scene.codegen::code` 绑定可用的 Code 类型模型池。如果未绑定，Gateway 会尝试 Code 类型的默认模型池，再回退到 Legacy 调度。

### 4.4 系统提示词结构

系统提示词（`BuildSceneCodegenSystemPrompt`，约 150 行）包含以下知识板块：

| 板块 | 内容 |
|------|------|
| 技术约束 | 纯 inline style、帧驱动动画、30fps、1920x1080、深色主题 |
| 可用 import | Remotion 核心 API、项目动效工具库、色彩系统、10 个可复用组件 |
| 动效工具函数 | 16 个动画函数的签名和用途说明 |
| 色彩系统 | COLORS 常量表（霓虹色系 + 毛玻璃） |
| 可复用组件 | 10 个组件的 JSX 用法示例 |
| SceneData 接口 | 输入数据类型定义 |
| 8 种场景设计原则 | 每种 sceneType 的视觉重点和关键动效 |
| 输出要求 | export default、sceneFadeOut、只输出代码 |

**关键路径约束**：生成的文件在 `src/scenes/generated/`，所有 import 使用 `../../` 前缀（向上两级回到 `src/`）：

```typescript
// ✅ 正确（从 scenes/generated/ 出发）
import { springIn } from "../../utils/animations";
import { Background } from "../../components/Background";

// ❌ 错误（这是 scenes/ 下文件的路径）
import { springIn } from "../utils/animations";
```

### 4.5 代码写入磁盘

渲染前（预览或完整渲染），Worker 调用 `WriteGeneratedScenesToDisk`：

1. 遍历所有 `CodeStatus == "done"` 且 `SceneCode` 非空的分镜
2. 写入 `prd-video/src/scenes/generated/Scene_{index}.tsx`
3. 生成 `index.ts` 注册表：

```typescript
// Auto-generated by VideoGenRunWorker — DO NOT EDIT
import type React from "react";
import type { SceneData } from "../../types";

export type GeneratedSceneComponent = React.FC<{
  scene: SceneData;
  videoTitle?: string;
}>;

// try/require 隔离单个文件的编译错误
const registry: Record<number, GeneratedSceneComponent> = {};
try { const m = require("./Scene_0"); registry[0] = m.default || m.Scene || Object.values(m)[0]; } catch {}
try { const m = require("./Scene_3"); registry[3] = m.default || m.Scene || Object.values(m)[0]; } catch {}

export const GENERATED_SCENES = registry;
```

**设计要点**：
- `try/catch` 包裹每个 `require`，单个文件编译失败不影响其他场景
- `m.default || m.Scene || Object.values(m)[0]` 兼容多种导出方式
- 渲染完成后调用 `CleanupGeneratedScenes` 删除 `.tsx` 文件并恢复空注册表

### 4.6 前端组件加载

```typescript
// SingleScene.tsx — 单场景预览渲染
const GeneratedComponent = scene.hasGeneratedCode
  ? GENERATED_SCENES[scene.index]
  : undefined;

if (GeneratedComponent) {
  return <GeneratedComponent scene={scene} videoTitle={title} />;
}
// 兜底：使用硬编码场景组件
const SceneComponent = SCENE_MAP[scene.sceneType] ?? SCENE_MAP.concept;
return <SceneComponent scene={scene} videoTitle={title} />;
```

```typescript
// TutorialVideo.tsx — 完整视频序列
function getSceneComponent(scene: SceneData) {
  if (scene.hasGeneratedCode) {
    const generated = GENERATED_SCENES[scene.index];
    if (generated) return generated;
  }
  return SCENE_MAP[scene.sceneType] ?? SCENE_MAP.concept;
}
```

## 5. 容错与回退策略

### 三层回退

```
LLM 生成的定制组件
  ↓ (生成失败 / 编译错误 / require 异常)
SCENE_MAP 硬编码组件（按 sceneType 匹配）
  ↓ (未知 sceneType)
ConceptScene（通用兜底）
```

### 错误处理

| 阶段 | 错误场景 | 处理方式 |
|------|----------|----------|
| LLM 调用 | Gateway 超时 / 模型不可用 | CodeStatus="error"，渲染时跳过 |
| 代码提取 | LLM 返回空内容或非代码 | CodeStatus="error" |
| 文件写入 | 磁盘写入失败 | WriteGeneratedScenesToDisk 异常传播 |
| Webpack 编译 | 生成的 TSX 语法错误 | `try/catch` 在 index.ts 中捕获，该场景回退 |
| React 渲染 | 组件运行时异常 | Remotion 渲染进程报错（需人工处理） |
| 清理 | 文件删除失败 | 仅 Warning 日志，不影响业务 |

## 6. 文件清单

### 后端（C#）

| 文件 | 关键内容 |
|------|----------|
| `PrdAgent.Core/Models/VideoGenModels.cs` | `SceneCode`, `CodeStatus` 字段 |
| `PrdAgent.Core/Models/AppCallerRegistry.cs` | `VideoAgent.Scene.Codegen = "video-agent.scene.codegen::code"` |
| `PrdAgent.Api/Services/VideoGenRunWorker.cs` | 路径 7 轮询、`ProcessSceneCodegenAsync`、`BuildSceneCodegenSystemPrompt`、`WriteGeneratedScenesToDisk`、`CleanupGeneratedScenes`、`ExtractCodeFromLlmResponse` |

### 前端（TypeScript / Remotion）

| 文件 | 关键内容 |
|------|----------|
| `prd-video/src/types.ts` | `hasGeneratedCode` 可选字段 |
| `prd-video/src/scenes/generated/index.ts` | 自动生成的注册表（默认为空） |
| `prd-video/src/SingleScene.tsx` | 优先 `GENERATED_SCENES[index]`，兜底 `SCENE_MAP` |
| `prd-video/src/TutorialVideo.tsx` | `getSceneComponent()` 同样的优先级逻辑 |

### 目录结构

```
prd-video/src/
├── scenes/
│   ├── IntroScene.tsx        ← 硬编码场景（8 个）
│   ├── ConceptScene.tsx
│   ├── ...
│   └── generated/            ← LLM 生成的场景代码
│       ├── index.ts          ← 注册表（Worker 自动生成）
│       ├── Scene_0.tsx       ← 渲染前写入，渲染后清理
│       └── Scene_1.tsx
├── components/               ← 可复用组件（10 个）
├── utils/
│   ├── animations.ts         ← 动效工具库（16 个函数）
│   └── colors.ts             ← 色彩常量
└── types.ts
```

## 7. 配置前提

| 配置项 | 说明 | 操作位置 |
|--------|------|----------|
| Code 类型模型池 | 为 `video-agent.scene.codegen::code` 绑定模型 | 模型组管理 UI → 新建 Code 类型模型组 |
| VideoAgent:RemotionProjectPath | Remotion 项目路径（可选，默认自动推导） | appsettings.json |

## 8. 数据流时序图

```
用户点击 "生成视频"
       │
       ▼
┌──── Queued ────┐
│ ProcessScripting│ → LLM 生成分镜 JSON
│   (路径 1)      │ → 解析为 VideoGenScene[]
│                 │ → 所有 CodeStatus = "running"
└──── Editing ───┘
       │
       ▼ (Worker 下次轮询)
┌──── Editing ───┐
│ProcessCodegen  │ → 逐个处理 CodeStatus="running" 的分镜
│   (路径 7)      │ → LLM 生成 TSX 代码
│                 │ → 存入 scene.SceneCode
│                 │ → CodeStatus = "done"
└────────────────┘
       │
       ▼ (用户点击 "渲染分镜")
┌──── Editing ───┐
│ProcessPreview  │ → WriteGeneratedScenesToDisk
│   (路径 4)      │ → npx remotion render (SingleScene)
│                 │ → CleanupGeneratedScenes
└────────────────┘
       │
       ▼ (用户点击 "渲染" 完整视频)
┌──── Rendering ─┐
│ProcessRendering│ → WriteGeneratedScenesToDisk
│   (路径 2)      │ → npx remotion render (TutorialVideo)
│                 │ → CleanupGeneratedScenes
└──── Completed ─┘
```

## 9. 与其他子系统的关系

| 子系统 | 关系 |
|--------|------|
| 分镜脚本生成（路径 1） | 上游：脚本完成后自动触发 codegen |
| TTS 语音合成（路径 6） | 并行：codegen 和 TTS 同时进行，互不阻塞 |
| 背景图生成（路径 5） | 并行：codegen 和背景图同时进行 |
| 分镜预览渲染（路径 4） | 下游：渲染时从 MongoDB 读取 SceneCode 写入磁盘 |
| 完整视频渲染（路径 2） | 下游：同上 |
| 工作流胶囊（AutoRender） | 隔离：AutoRender 模式跳过 codegen，直接渲染 |
| LLM Gateway | 依赖：通过 Gateway 调度到 Code 类型模型 |
