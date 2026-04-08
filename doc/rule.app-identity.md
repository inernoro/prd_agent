# 应用身份定义规则（appKey + Feature + appCallerCode）

> 合并自原 `rule.app-key-definition.md` + `rule.app-feature-definition.md`

## 1. 层级关系

```
App (appKey)
  └─ Feature (应用子功能)
      └─ appCallerCode (调用大模型 key)
          └─ Model Group → Model
```

---

## 2. appKey（应用身份）

**定义**：区分应用身份的唯一标识，Controller 层必须硬编码。

**规则**：
- 使用 `kebab-case` 格式
- 禁止由前端传入
- 禁止在业务层动态拼接
- 每个应用拥有独立 Controller 层入口

**唯一性约束**：appKey 必须在以下三处一致且唯一：
- 前端路由
- `/mds` 接口
- `/api/mds` 文档

**已定义 appKey**：

| appKey | 应用名称 | 说明 |
|--------|---------|------|
| `prd-agent` | PRD Agent | PRD 智能解读与问答 |
| `visual-agent` | 视觉创作 Agent | 高级视觉创作工作区 |
| `literary-agent` | 文学创作 Agent | 文章配图、文学创作 |
| `defect-agent` | 缺陷管理 Agent | 缺陷提交与跟踪 |
| `video-agent` | 视频 Agent | 文章转视频教程 |
| `report-agent` | 周报管理 Agent | 周报创建、提交、审阅 |
| `review-agent` | 产品评审员 | 产品方案（如 .md）多维度评审 |
| `pr-review-prism` | PR审查棱镜 | PR/MR 变更专项审查（与产品评审员独立） |

**代码示例**：
```csharp
[ApiController]
[Route("api/visual-agent")]
public class VisualAgentController : ControllerBase
{
    private const string AppKey = "visual-agent";
}
```

---

## 3. Feature（应用子功能）

**定义**：应用内部可独立描述、独立配置模型的业务功能点。

**判定标准**：
- 隶属于某个 appKey
- 有明确输入输出
- 需要调用 LLM
- 需要独立的模型需求配置

---

## 4. appCallerCode（调用大模型 key）

### 4.1 格式

```
{app}.{feature}[.{subfeature}...]::modelType
```

- `::` 前为功能路径（`.` 分层），`::` 后为模型类型
- `app` 使用 `kebab-case`

### 4.2 模型类型（modelType）

`chat` | `intent` | `vision` | `generation` | `code` | `embedding` | `rerank`

### 4.3 示例

```
desktop.chat.sendmessage::chat
desktop.chat.sendmessage::intent
visual-agent.image::generation
literary-agent.content::chat
open-platform.proxy::chat
admin.prompts.optimize::chat
report-agent.generate::chat
report-agent.aggregate::chat
report-agent.polish::chat
```

---

## 5. 业务调用规则

业务层必须通过 `ILlmGateway` 获取客户端（已替代原 `ISmartModelScheduler`）：

```csharp
var request = new GatewayRequest
{
    AppCallerCode = "visual-agent.image::generation",
    ModelType = "generation",
    // ...
};
var response = await _gateway.SendAsync(request, ct);
```

### 自动注册

首次调用 `appCallerCode` 时，若未注册：
- 自动创建 `LLMAppCaller`
- 自动补默认 `ModelRequirement`
- 初始化机制只更新元信息，不覆盖用户已配置的模型需求
