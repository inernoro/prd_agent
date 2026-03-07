# 视频 TTS 语音接入 + 场景视觉升级 实施方案

## 需求概述

1. **TTS 语音接入**：通过 LLM Gateway 接入火山引擎 TTS，为视频生成添加语音旁白
2. **8 个场景视觉升级**：让视频画面更具电影感，减少 PPT 感

---

## Track A: TTS 语音接入

### A1. 数据模型扩展

**文件**: `prd-api/src/PrdAgent.Core/Models/VideoGenModels.cs`

`VideoGenScene` 新增字段：
```csharp
public string? AudioUrl { get; set; }           // TTS 生成的音频文件 URL
public string AudioStatus { get; set; } = "idle"; // idle | running | done | error
public string? AudioErrorMessage { get; set; }
```

`VideoGenRun` 新增字段：
```csharp
public string? VoiceId { get; set; }           // TTS 声音选择（用户可选）
public bool EnableTts { get; set; } = false;   // 是否启用 TTS
```

### A2. LLM Gateway TTS 支持

#### A2.1 添加 ModelType

**文件**: `prd-api/src/PrdAgent.Core/Models/LLMAppCaller.cs`

```csharp
public const string TTS = "tts";
// 更新 AllTypes 数组
```

#### A2.2 GatewayRawResponse 支持二进制

**文件**: `prd-api/src/PrdAgent.Infrastructure/LlmGateway/GatewayResponse.cs`

```csharp
public class GatewayRawResponse
{
    // 新增
    public byte[]? BinaryContent { get; init; }
}
```

#### A2.3 LlmGateway.SendRawAsync 读取二进制

**文件**: `prd-api/src/PrdAgent.Infrastructure/LlmGateway/LlmGateway.cs`

在 `SendRawAsync` 方法中，检测 Content-Type：
- 如果是 `audio/*` 或 `application/octet-stream`，读取为 `byte[]` → 存入 `BinaryContent`
- 如果是 `application/json` 或 `text/*`，读取为 `string` → 存入 `Content`

#### A2.4 OpenAI Adapter 添加 TTS 端点

**文件**: `prd-api/src/PrdAgent.Infrastructure/LlmGateway/Adapters/OpenAIGatewayAdapter.cs`

```csharp
"tts" => $"{baseUrl}/v1/audio/speech"
```

#### A2.5 注册 AppCallerCode

**文件**: `prd-api/src/PrdAgent.Core/Models/AppCallerRegistry.cs`

```csharp
public static class VideoAgent
{
    public static class Audio
    {
        public const string Tts = "video-agent.audio::tts";
    }
}
```

### A3. VideoGenRunWorker 新增 TTS 处理路径

**文件**: `prd-api/src/PrdAgent.Api/Services/VideoGenRunWorker.cs`

新增 **Path 6: TTS Audio Generation**

触发条件：`Status=Editing && EnableTts=true && 存在 AudioStatus=running 的场景`

处理流程：
1. 找到第一个 `AudioStatus=running` 的场景
2. 构建 `GatewayRawRequest`（ModelType="tts"，RequestBody 包含 narration 文本 + voice 参数）
3. 调用 `_gateway.SendRawAsync()`
4. 拿到 `BinaryContent`（音频字节）
5. 上传到 COS，获取 URL
6. 更新场景的 `AudioUrl` 和 `AudioStatus=done`
7. 发布 `scene.audio.done` SSE 事件

### A4. Remotion 音频集成

#### A4.1 类型扩展

**文件**: `prd-video/src/types.ts`

```typescript
export interface SceneData {
  // 新增
  audioUrl?: string;
}

export interface VideoData {
  // 新增
  enableTts?: boolean;
}
```

#### A4.2 TutorialVideo 添加 Audio 组件

**文件**: `prd-video/src/TutorialVideo.tsx`

在每个场景的 `TransitionSeries.Sequence` 内部，如果 `scene.audioUrl` 存在，添加 Remotion 的 `<Audio>` 组件：

```tsx
import { Audio } from "remotion";

// 在场景组件内部
{scene.audioUrl && <Audio src={scene.audioUrl} />}
```

#### A4.3 视频数据 JSON 传递音频 URL

**文件**: `prd-api/src/PrdAgent.Api/Services/VideoGenRunWorker.cs`

在 `ProcessRenderingAsync` 构建视频数据时，包含 `audioUrl` 字段。

### A5. API 端点扩展

**文件**: `prd-api/src/PrdAgent.Api/Controllers/Api/VideoAgentController.cs`

新增端点：
- `POST /runs/{runId}/scenes/{idx}/generate-audio` — 触发单个场景的 TTS 生成
- `POST /runs/{runId}/generate-all-audio` — 批量触发所有场景的 TTS 生成

创建 run 时新增参数：`enableTts`, `voiceId`

### A6. IVideoGenService 接口扩展

**文件**: `prd-api/src/PrdAgent.Core/Interfaces/IVideoGenService.cs`
**文件**: `prd-api/src/PrdAgent.Infrastructure/Services/VideoGenService.cs`

新增方法：
- `QueueSceneAudioGenerationAsync(runId, sceneIndex)` — 将场景标记为 audio running
- `QueueAllAudioGenerationAsync(runId)` — 批量标记

---

## Track B: 8 个场景视觉升级

### 设计理念

当前问题：所有场景都是"标题在上 + 文字在中间 + 粒子背景"的 PPT 布局。

升级方向：
1. **镜头感**：模拟摄像机推拉摇移（CSS transform scale/translate 持续变化）
2. **动态文字排版**：打字机效果、文字路径动画、渐显渐隐
3. **更好的视觉层次**：前景/中景/背景分离
4. **持续运动**：场景全程有微妙的运动，而不只是入场动画后静止
5. **当有 backgroundImageUrl 时**，让图片成为视觉主体，文字叠加其上

### B1. IntroScene 升级

- 添加缩放呼吸效果（整个场景 1.0→1.05 缓慢缩放）
- 标题采用逐字弹出 + 发光描边效果
- 添加底部扫描光线（从左到右匀速扫过）
- 粒子汇聚到标题文字位置

### B2. ConceptScene 升级

- 内容卡片采用 3D 翻转入场（rotateY）
- 段落采用打字机逐字效果（而非整段渐入）
- 添加左侧时间轴进度条动画
- 背景图模糊叠加时，前景文字加毛玻璃底板

### B3. StepsScene 升级

- 步骤节点改为环形进度动画
- 连接线改为粒子流动效果（点沿路径移动）
- 当前步骤放大聚焦，其他步骤缩小模糊
- 添加步骤切换的缩放过渡

### B4. CodeDemoScene 升级

- 代码块添加行号闪烁效果
- 打字效果加上光标闪烁
- 语法高亮颜色过渡（而非瞬间着色）
- 添加代码编辑器装饰元素（最小化/最大化按钮等）

### B5. ComparisonScene 升级

- 两列采用天平秤动画（一边下沉一边升起）
- VS 分隔线改为能量对撞效果
- 列表项逐条飞入（左右交替）
- 添加分数/评级动画

### B6. DiagramScene 升级

- 中心节点脉冲波纹扩散效果
- 连接线改为能量流动（光点沿线移动）
- 节点卡片悬浮旋转效果
- 关系图整体缓慢旋转

### B7. SummaryScene 升级

- 圆环进度改为多环嵌套（多个数据维度）
- 检查项完成时加粒子爆炸效果
- 数字计数器加大号字体 + 弹跳效果
- 添加总结高亮条带扫过

### B8. OutroScene 升级

- 星空汇聚效果（粒子从四面八方汇聚到中心 Logo）
- "感谢观看" 文字环形排列
- 添加光晕扩散效果
- 底部滚动字幕效果

### B9. Background 组件升级

- 当 backgroundImageUrl 存在时，使用 Ken Burns 效果（缓慢平移+缩放）
- 改善渐变过渡，更多层次
- 添加暗角效果（四角压暗）

---

## 文件变更清单

### 后端 (prd-api)

| 文件 | 操作 | 说明 |
|------|------|------|
| `Core/Models/VideoGenModels.cs` | 修改 | 添加 Audio 相关字段 |
| `Core/Models/LLMAppCaller.cs` | 修改 | 添加 ModelTypes.TTS |
| `Core/Models/AppCallerRegistry.cs` | 修改 | 注册 TTS AppCallerCode |
| `Core/Interfaces/IVideoGenService.cs` | 修改 | 添加 Audio 方法签名 |
| `Infrastructure/Services/VideoGenService.cs` | 修改 | 实现 Audio 方法 |
| `Infrastructure/LlmGateway/GatewayResponse.cs` | 修改 | 添加 BinaryContent |
| `Infrastructure/LlmGateway/LlmGateway.cs` | 修改 | SendRawAsync 支持二进制 |
| `Infrastructure/LlmGateway/Adapters/OpenAIGatewayAdapter.cs` | 修改 | TTS 端点映射 |
| `Api/Services/VideoGenRunWorker.cs` | 修改 | 新增 TTS 处理路径 |
| `Api/Controllers/Api/VideoAgentController.cs` | 修改 | 新增 TTS API 端点 |

### 前端 (prd-video)

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/types.ts` | 修改 | 添加 audioUrl 字段 |
| `src/TutorialVideo.tsx` | 修改 | 添加 Audio 组件 |
| `src/scenes/IntroScene.tsx` | 修改 | 视觉升级 |
| `src/scenes/ConceptScene.tsx` | 修改 | 视觉升级 |
| `src/scenes/StepsScene.tsx` | 修改 | 视觉升级 |
| `src/scenes/CodeDemoScene.tsx` | 修改 | 视觉升级 |
| `src/scenes/ComparisonScene.tsx` | 修改 | 视觉升级 |
| `src/scenes/DiagramScene.tsx` | 修改 | 视觉升级 |
| `src/scenes/SummaryScene.tsx` | 修改 | 视觉升级 |
| `src/scenes/OutroScene.tsx` | 修改 | 视觉升级 |
| `src/components/Background.tsx` | 修改 | Ken Burns + 暗角 |
| `src/utils/animations.ts` | 修改 | 新增动画工具函数 |

---

## 执行顺序

1. **Phase 1** (并行)
   - Track A: 数据模型 + Gateway TTS 支持 + Worker TTS 路径
   - Track B: 8 个场景视觉升级

2. **Phase 2**
   - Track A: Remotion 音频集成 + API 端点
   - Track B: Background 组件升级

3. **Phase 3**
   - C# 编译验证
   - 提交推送
