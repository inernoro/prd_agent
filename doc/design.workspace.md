# design.workspace — CLI Agent 工作空间设计

> **核心原则**：不和智能体竞争，只做接入层。智能体负责生成，我们负责显示和控制。

## 问题

1. 遇到好的 CLI Agent（Claude Code、Aider、Bolt 等），如何快速接入？
2. 如何让 Agent 的输出在我们系统中友好显示和控制？
3. 不同 Agent 给用户的操作体验如何保持一致？

## 设计：统一接入协议

### 不管什么 Agent，对我们来说只有一件事

```
用户说话 → 我们传给 Agent → Agent 干活 → 我们显示结果 → 用户继续说话
```

这就是一个**对话**，和现有的 Session/Message 没有本质区别。区别只在于：
- 普通对话：LLM 直接回复文本
- 工作空间：Agent 回复文本 **+ 文件 + 预览页面**

### 核心模型：Workspace

```
Workspace = Session + 持久容器 + 产物目录
```

```csharp
public class Workspace
{
    public string Id { get; set; }
    public string UserId { get; set; }
    public string Name { get; set; }             // "我的产品页"
    public string ExecutorType { get; set; }      // "builtin-llm" | "docker" | "api"
    public string Status { get; set; }            // idle | running | completed | error
    
    // Agent 配置（创建时确定）
    public string? DockerImage { get; set; }       // docker 执行器用
    public string? ApiEndpoint { get; set; }       // api 执行器用
    public string? ContainerId { get; set; }       // 持久容器 ID
    
    // 通用配置
    public string Framework { get; set; }          // html/react/vue
    public string Style { get; set; }              // ui-ux-pro-max/minimal
    public string Spec { get; set; }               // none/spec/dri/dev/sdd
    
    // 状态
    public int RoundCount { get; set; }            // 已交互轮数
    public string? LatestOutputSiteId { get; set; } // 最新产物的 HostedSite ID
    public string? LatestOutputUrl { get; set; }    // 最新预览 URL
    
    public DateTime CreatedAt { get; set; }
    public DateTime? LastActiveAt { get; set; }
}
```

### 交互协议（三个 API 搞定）

```
POST /api/workspaces                    → 创建工作空间
POST /api/workspaces/{id}/chat          → 发送指令（SSE 流式响应）
GET  /api/workspaces/{id}               → 获取状态 + 历史 + 最新预览
```

就这三个。不需要更多。

#### POST /chat 的请求

```json
{
  "message": "生成一个产品展示页面，包含 Hero 区域和功能介绍"
}
```

#### POST /chat 的 SSE 响应

```
event: phase
data: {"phase": "thinking", "message": "分析需求…"}

event: phase
data: {"phase": "generating", "message": "生成页面…"}

event: log
data: {"text": "[agent] Creating src/App.tsx..."}

event: file
data: {"path": "index.html", "action": "created", "size": 4523}

event: preview
data: {"siteId": "xxx", "url": "https://xxx.cos.ap/index.html"}

event: done
data: {"round": 1, "filesChanged": 3, "previewUrl": "https://..."}
```

前端根据 event type 渲染不同组件：
- `phase` → 状态标签（思考中/生成中/完成）
- `log` → 终端日志区
- `file` → 文件变更列表
- `preview` → iframe 预览窗口
- `done` → 完成状态 + 汇总

### 快速接入协议（回答问题 1）

接入一个新 Agent 只需回答两个问题：

**Q1: Agent 怎么接收指令？**

| 方式 | 我们怎么做 |
|------|-----------|
| CLI stdin | `docker exec -i {containerId} sh -c "echo '{msg}' | agent-cli"` |
| CLI 参数 | `docker exec {containerId} agent-cli --prompt '{msg}'` |
| HTTP API | `POST {endpoint}/generate` body: `{prompt, context}` |
| 文件 | 写 `/workspace/prompt.txt`，Agent 自己监听 |

**Q2: Agent 怎么输出结果？**

| 方式 | 我们怎么做 |
|------|-----------|
| stdout | `docker logs -f` → 解析 → SSE |
| 文件 | 扫描 `/workspace/output/` → 收集 → 发布到 HostedSite |
| HTTP 响应 | 直接解析 response body |
| 结构化 JSON | 按字段分发到不同 SSE event type |

每种 Agent 对应一个**适配器**函数，就是 `ExecuteCliAgent_{Name}Async` 里的逻辑。所有适配器的输出统一为 SSE 事件流。

### 显示一致性（回答问题 2 和 3）

不管哪个 Agent，前端看到的都是：

```
┌──────────────────────────────────────────────┐
│  工作空间: 我的产品页                    [轮次 3] │
├──────────────────────────────────────────────┤
│                                              │
│  ┌─ 对话区 ──────────────────────────────┐   │
│  │ 👤 生成一个产品展示页面               │   │
│  │ 🤖 已生成，包含 Hero + 功能介绍       │   │
│  │ 👤 标题太小了，配色换蓝色             │   │
│  │ 🤖 已修改标题和配色                   │   │
│  │ 👤 加一个价格表                       │   │
│  │ 🤖 [生成中…]                          │   │
│  └───────────────────────────────────────┘   │
│                                              │
│  ┌─ 预览区 ──────────────────────────────┐   │
│  │                                       │   │
│  │         [iframe 实时预览]              │   │
│  │                                       │   │
│  └───────────────────────────────────────┘   │
│                                              │
│  ┌─ 输入区 ──────────────────────────────┐   │
│  │ [输入修改意见…]              [发送]    │   │
│  └───────────────────────────────────────┘   │
│                                              │
│  Agent: builtin-llm │ 框架: html │ 风格: Pro  │
└──────────────────────────────────────────────┘
```

**用户不需要知道后面是哪个 Agent**。对话区 + 预览区 + 输入区，所有 Agent 都一样。

### 和现有系统的关系

```
现有概念          工作空间对应
─────────        ─────────
Session          → Workspace
Message          → 复用（role=user/assistant）
Run/Worker       → 每轮 chat 是一个 Run
SSE afterSeq     → 复用
HostedSite       → 每轮产物发布到 HostedSite
SitePublisher    → 复用
```

工作空间不是新系统，是 Session + HostedSite 的**组合使用模式**。

### 容器生命周期

```
创建 Workspace → 首轮 chat 时启动容器（懒启动）
                 → 容器保持运行
多轮 chat      → docker exec 注入指令，复用同一容器
闲置 30 分钟   → 自动暂停容器（docker pause）
再次 chat      → 自动恢复（docker unpause）
手动关闭       → 销毁容器 + 保留 Workspace 记录
```

### 不做的事

- ❌ 不做 Agent 内核（留给 Agent 自己）
- ❌ 不做实时终端模拟（太复杂，用 SSE 日志流就够）
- ❌ 不做文件编辑器（Agent 自己改文件，我们只展示 diff）
- ❌ 不做多 Agent 编排（一个 Workspace 一个 Agent）
- ❌ 不和 Agent 的 UI 竞争（Aider 有自己的 TUI，我们不重建）
