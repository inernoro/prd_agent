# 计划书：多图 AI 交互方案

> **状态**: 草案
> **创建日期**: 2026-01-29
> **关联文档**: design.inline-image-chat.md 第十章、第十一章

---

## 一、核心问题

### 1.1 问题描述

当用户引用多张图片时，AI 模型需要理解：

1. **顺序**：哪张图是第一张，哪张是第二张？
2. **角色**：哪张是要修改的目标图？哪张是风格参考？
3. **关联**：用户的文字描述与图片如何对应？

```
用户输入: "把 @img1 的背景换成 @img2 的风格"

AI 需要理解:
├── @img1 = 目标图 (要修改)
├── @img2 = 风格参考 (提供风格)
└── 操作 = 替换背景
```

### 1.2 为什么这是个问题

| 问题 | 描述 |
|------|------|
| 多模态模型的"图盲" | 单纯发送多图 URL，模型可能分不清顺序 |
| 意图模糊 | "融合两张图" - 谁是主体？谁是参考？ |
| 上下文丢失 | 图片的标签/描述信息可能没传给模型 |

---

## 二、业界做法调研

### 2.1 主流方案对比

| 平台 | 方案 | 优点 | 缺点 |
|------|------|------|------|
| **Midjourney** | 位置语法 + 权重 | 精确控制 | 学习曲线陡 |
| | `img1::0.5 img2::1.5` | | |
| **Leonardo** | 槽位拖放 | 直观 | 固定槽位 |
| | [Target][Reference][Style] | | |
| **GPT-4V/Claude** | 自然语言 + 图片索引 | 灵活 | 依赖描述 |
| | "第一张图...第二张图..." | | |
| **ControlNet** | 分通道输入 | 专业精确 | 复杂 |
| | depth/pose/edge 各一图 | | |

### 2.2 API 层面做法

**OpenAI Vision API**:
```json
{
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Compare these images" },
      { "type": "image_url", "image_url": { "url": "img1.jpg" } },
      { "type": "image_url", "image_url": { "url": "img2.jpg" } }
    ]
  }]
}
```
- 图片**按数组顺序**传递
- 模型**自动理解**为"第一张"、"第二张"

**Claude Vision API**:
```json
{
  "content": [
    { "type": "text", "text": "图1是目标，图2是参考" },
    { "type": "image", "source": { "type": "url", "url": "img1.jpg" } },
    { "type": "image", "source": { "type": "url", "url": "img2.jpg" } }
  ]
}
```
- 同样**按顺序**传递
- 可在 text 中**明确标注**角色

### 2.3 关键发现

> **重要**: 主流多模态模型 **默认按传入顺序** 理解图片，
> 但需要在 **prompt 中明确说明** 每张图的角色。

---

## 三、我们的方案设计

### 3.1 设计原则

```
┌─────────────────────────────────────────────────────────────────────┐
│                         核心原则                                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. 前端只收集数据，不做意图分析                                       │
│     → 避免前端代码膨胀，逻辑集中在后端                                 │
│                                                                     │
│  2. 单图场景走原有逻辑，多图场景才调用 Agent                           │
│     → 避免不必要的 API 调用，保持响应速度                              │
│                                                                     │
│  3. 图片顺序由用户决定（引用顺序 = 传入顺序）                           │
│     → 用户说 @img1 先，就把 img1 放第一个                              │
│                                                                     │
│  4. 角色由 AI 推断，用户可覆盖                                        │
│     → 默认第一张是 target，但用户说明会覆盖                            │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 方案对比

| 方案 | 描述 | 优点 | 缺点 | 选择 |
|------|------|------|------|------|
| **A: 纯规则推断** | 前端根据关键词推断角色 | 简单、快速 | 不够智能 | ❌ |
| **B: 后端 Agent** | 调用 LLM 分析意图 | 智能、准确 | 多一次 API | ✅ |
| **C: 用户显式标注** | 要求用户选择角色 | 精确 | 体验差 | ❌ |

**选择方案 B**: 后端 Agent 分析意图

### 3.3 数据流设计

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          多图场景数据流                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  用户输入: "把 @img1 和 @img2 融合"                                          │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 1: 前端收集数据 (resolveImageRefs)                             │    │
│  │                                                                     │    │
│  │  {                                                                  │    │
│  │    rawText: "把  和  融合",                                          │    │
│  │    refs: [                                                          │    │
│  │      { refId: 1, src: "...", label: "风景图", source: "chip" },     │    │
│  │      { refId: 2, src: "...", label: "人物图", source: "chip" }      │    │
│  │    ]                                                                │    │
│  │  }                                                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                        │                                    │
│                                        ↓                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 2: 判断是否需要意图分析                                         │    │
│  │                                                                     │    │
│  │  if (refs.length <= 1) {                                            │    │
│  │    // 单图：直接生成，不调用 Agent                                    │    │
│  │  } else {                                                           │    │
│  │    // 多图：调用意图分析 Agent                                        │    │
│  │  }                                                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                        │                                    │
│                                        ↓ (多图时)                           │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 3: 调用后端 Agent                                              │    │
│  │                                                                     │    │
│  │  POST /api/visual-agent/analyze-intent                              │    │
│  │  {                                                                  │    │
│  │    "text": "把 @img1 和 @img2 融合",                                 │    │
│  │    "imageRefs": [                                                   │    │
│  │      { "refId": 1, "url": "...", "label": "风景图" },               │    │
│  │      { "refId": 2, "url": "...", "label": "人物图" }                │    │
│  │    ]                                                                │    │
│  │  }                                                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                        │                                    │
│                                        ↓                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 4: Agent 返回结构化意图                                         │    │
│  │                                                                     │    │
│  │  {                                                                  │    │
│  │    "action": "blend",                                               │    │
│  │    "target": { "refId": 1 },                                        │    │
│  │    "references": [{ "refId": 2 }],                                  │    │
│  │    "enhancedPrompt": "将风景图(图1)与人物图(图2)融合...",             │    │
│  │    "imageOrder": [1, 2]  // 建议的图片传入顺序                        │    │
│  │  }                                                                  │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                        │                                    │
│                                        ↓                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  Step 5: 按顺序调用图像生成 API                                       │    │
│  │                                                                     │    │
│  │  - prompt: enhancedPrompt (包含角色说明)                             │    │
│  │  - images: 按 imageOrder 排序后传入                                   │    │
│  │  - 第一张图 = target, 后续 = reference                               │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 四、技术方案细节

### 4.1 前端改动

**位置**: `AdvancedVisualAgentTab.tsx` 的 `sendText` 函数

```typescript
const sendText = async (rawText: string, opts?: SendTextOpts) => {
  // 1. 解析图片引用
  const result = resolveImageRefs({ ... });
  if (!result.ok) return;

  // 2. 单图：原有逻辑
  if (result.refs.length <= 1) {
    const { requestText, primaryRef } = buildRequestText(result.cleanText, result.refs);
    await runFromText(result.cleanText, requestText, primaryRef, ...);
    return;
  }

  // 3. 多图：调用意图分析
  const intent = await analyzeImageIntent({
    text: result.cleanText,
    imageRefs: result.refs.map(r => ({
      refId: r.refId,
      url: r.src,
      label: r.label,
    })),
  });

  // 4. 使用增强后的 prompt 和排序后的图片
  await runFromText(
    result.cleanText,
    intent.enhancedPrompt,
    getImageByRefId(intent.target?.refId),
    ...,
    { imageOrder: intent.imageOrder }  // 传递排序信息
  );
};
```

### 4.2 后端 Agent 设计

**新增端点**: `POST /api/visual-agent/analyze-intent`

**Controller**:
```csharp
[HttpPost("analyze-intent")]
public async Task<IActionResult> AnalyzeIntent([FromBody] AnalyzeIntentRequest request)
{
    // 1. 构建 prompt
    var systemPrompt = _promptStageService.GetPrompt("visual-intent-analyzer");

    // 2. 调用 LLM
    var response = await _llmService.Chat(systemPrompt, request.ToUserMessage());

    // 3. 解析 JSON 响应
    var intent = JsonSerializer.Deserialize<IntentAnalysisResult>(response);

    return Ok(intent);
}
```

**Request/Response**:
```csharp
public class AnalyzeIntentRequest
{
    public string Text { get; set; }
    public List<ImageRefDto> ImageRefs { get; set; }
}

public class IntentAnalysisResult
{
    public string Action { get; set; }  // blend/replace/style_transfer/composite
    public RefIdRef? Target { get; set; }
    public List<RefIdRef> References { get; set; }
    public RefIdRef? StyleRef { get; set; }
    public string EnhancedPrompt { get; set; }
    public List<int> ImageOrder { get; set; }
    public double Confidence { get; set; }
}
```

### 4.3 Agent Prompt 模板

```
你是一个视觉创作意图分析助手。根据用户的输入和引用的图片，分析用户的创作意图。

## 用户输入
{text}

## 引用的图片
{imageRefs.map(r => `- @img${r.refId}: ${r.label || '(无描述)'}`).join('\n')}

## 任务
分析用户的意图，返回 JSON 格式：

```json
{
  "action": "blend|replace|style_transfer|composite|edit|generate",
  "target": { "refId": N } 或 null,
  "references": [{ "refId": N }, ...],
  "styleRef": { "refId": N } 或 null,
  "enhancedPrompt": "更清晰的指令，明确标注每张图的角色",
  "imageOrder": [refId1, refId2, ...],  // 图片传入模型的建议顺序
  "confidence": 0.0-1.0
}
```

## 角色定义
- **target**: 要修改的目标图
- **references**: 内容或素材参考图
- **styleRef**: 风格参考图

## 推断规则
1. "把A换成B" → A是target，B是reference
2. "A的风格+B的内容" → A是styleRef，B是target
3. "融合/合成" → 第一张是target，其余是reference
4. "参考A生成" → A是reference，无target（纯生成）

## enhancedPrompt 要求
- 在原文基础上，明确标注每张图的作用
- 使用 "图1(目标图)"、"图2(参考图)" 等标注
- 示例："将图1(目标图:风景图)的背景替换为图2(参考图:城市夜景)的风格"

## imageOrder 说明
- 返回图片传入模型的建议顺序（refId 列表）
- target 应该排在最前
- 纯生成场景（无target）按用户引用顺序
```

---

## 五、试验车间测试计划

### 5.1 新增测试区域

在 `WorkshopLabTab.tsx` 新增 **"多图意图测试"** 区域：

```
┌─────────────────────────────────────────────────────────────────┐
│  多图意图测试                                                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [测试用例按钮]  [测试用例按钮]  [测试用例按钮]                    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  输入框                                                      ││
│  │  (预填充测试用例)                                            ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                 │
│  [分析意图] ← 调用 analyzeIntent API (或 mock)                   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  意图分析结果:                                               ││
│  │  {                                                          ││
│  │    action: "blend",                                         ││
│  │    target: { refId: 1 },                                    ││
│  │    ...                                                      ││
│  │  }                                                          ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 测试用例

| 用例 | 输入 | 期望 action | 期望 target | 期望 refs |
|------|------|-------------|-------------|-----------|
| 替换背景 | "把@img1的背景换成@img2" | replace | 1 | [2] |
| 风格迁移 | "@img1的风格应用到@img2" | style_transfer | 2 | [] + styleRef=1 |
| 融合 | "融合@img1和@img2" | blend | 1 | [2] |
| 三图合成 | "@img1+@img2背景+@img3人物" | composite | 1 | [2,3] |
| 纯参考生成 | "参考@img1和@img2画一张" | generate | null | [1,2] |

---

## 六、实施步骤

### Phase 1: 试验车间验证

| 步骤 | 内容 | 状态 |
|------|------|------|
| 1.1 | WorkshopLabTab 新增多图测试区域 | ⏳ |
| 1.2 | Mock analyzeIntent 函数 | ⏳ |
| 1.3 | 手动测试各场景 | ⏳ |

### Phase 2: 后端 Agent 开发

| 步骤 | 内容 | 状态 |
|------|------|------|
| 2.1 | 新增 analyze-intent 端点 | ⏳ |
| 2.2 | 注册 visual-intent-analyzer prompt | ⏳ |
| 2.3 | 单元测试 | ⏳ |

### Phase 3: 前端集成

| 步骤 | 内容 | 状态 |
|------|------|------|
| 3.1 | sendText 增加多图分支 | ⏳ |
| 3.2 | 试验车间切换到真实 API | ⏳ |
| 3.3 | AdvancedVisualAgentTab 集成 | ⏳ |

### Phase 4: 用户验收

| 步骤 | 内容 | 状态 |
|------|------|------|
| 4.1 | 试验车间功能演示 | ⏳ |
| 4.2 | 实际场景测试 | ⏳ |
| 4.3 | 收集反馈并迭代 | ⏳ |

---

## 七、开放问题

### 7.1 待确认问题

| 问题 | 选项 | 建议 |
|------|------|------|
| 多图时 loading 提示 | A: 静默 / B: 显示"分析意图中" | B |
| 意图分析失败处理 | A: 回退到规则 / B: 报错 | A |
| confidence 阈值 | 低于多少时显示提示？ | 0.6 |
| 是否缓存意图结果 | 相同输入是否复用？ | 否（用户可能改了图） |

### 7.2 未来扩展

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 用户手动指定角色 | 下拉菜单选择 target/ref | P3 |
| 权重控制 | 类似 Midjourney 的 ::0.5 | P4 |
| 区域选择 (SAM) | 点击图片中的元素 | P4 |

---

## 八、风险与回滚

| 风险 | 影响 | 缓解 |
|------|------|------|
| Agent 推断不准 | 生成结果不符预期 | 回退到规则推断 |
| API 延迟增加 | 用户等待时间变长 | 显示分析进度 |
| 成本增加 | 每次多图多一次 LLM 调用 | 可配置关闭 |

---

## 附录：参考资料

- OpenAI Vision API: https://platform.openai.com/docs/guides/vision
- Claude Vision: https://docs.anthropic.com/claude/docs/vision
- Midjourney Multi-Prompts: https://docs.midjourney.com/docs/multi-prompts
- ControlNet: https://github.com/lllyasviel/ControlNet
