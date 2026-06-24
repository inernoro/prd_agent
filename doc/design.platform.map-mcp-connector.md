# MAP MCP 连接器 · 设计

> **版本**：v1.1 | **日期**：2026-06-16 | **状态**：开发中

## 一、管理摘要（30 秒看懂）

我们要让 MAP 系统变成一个 **MCP 连接器（connector）**——就像 GitHub、Slack 在 Claude / Codex 里那样，用户在客户端"连接器"列表里加一行，Claude 就能直接调用 MAP 内部的各种 Agent 能力（生成周报、修复缺陷、搜索/上传技能等）。

关键判断：**这不是一套新业务，而是给已有的开放接口加一层"协议翻译"。** MAP 已经建好了三块根基——`AgentOpenEndpoint` 登记表（谁在哪个路径开放了什么接口）、`sk-ak-*` 长效密钥、`agent.{key}:{action}` scope 鉴权。MCP 连接器要做的，就是把这张登记表"翻译"成 MCP 协议里的工具清单，再把 Claude 的工具调用"翻译"回对真实接口的 HTTP 请求。鉴权、权限、限流全部复用现有机制，**一行权限模型都不用重写**。

本期范围：**只做远程 `/mcp` 端点（Streamable HTTP 传输）**。用户在 Claude / Codex 里填一个网址 + 一把 `sk-ak-*` 密钥即可连上。本地 stdio 代理包留作后续兜底，不在本期。

| 维度 | 结论 |
|------|------|
| 面向对象 | 外部 AI 客户端（Claude Desktop / Claude 自定义连接器 / Codex 等支持 MCP 的工具） |
| 传输方式 | Streamable HTTP（单端点 `POST /mcp`，JSON-RPC 2.0） |
| 鉴权 | 复用 `sk-ak-*` AgentApiKey + scope，Bearer header 直传（v1）；OAuth 留作 v2 |
| 工具来源 | `agent_open_endpoints` 集合动态生成，登记一条接口 = 多一个 MCP 工具，零额外代码 |
| 业务侵入 | 零。网关只翻译协议，真实接口的 `[RequireScope]` 仍是最终权限闸门 |

---

## 二、背景：MCP 是什么，我们差在哪

MCP（Model Context Protocol）是 Claude / Codex 这类客户端用来"发现并调用外部能力"的标准协议。一个 MCP server 对客户端只暴露三类核心动作：

- `initialize`：握手，声明"我支持工具能力"
- `tools/list`：把"我有哪些工具、每个工具收什么参数"告诉客户端
- `tools/call`：客户端要调某个工具时，把参数发来，server 执行后返回结果

MAP 现在对外开放能力的四套接口（OpenAI 网关、海鲜市场开放 API、Agent 开放接口、OpenPlatform 对话代理）**全部是普通 REST/SSE**，没有一套说 MCP。所以今天 Claude / Codex 无法把 MAP"加进连接器列表"。差的就是这一层协议适配——而不是底层能力。

这套设计严格遵循项目的"借用法则"（`no-rootless-tree.md`）：MCP 连接器不重建任何鉴权或业务逻辑，只借用已有的 `AgentOpenEndpoint` + `sk-ak` 这两根现成的桩。

---

## 三、目标与非目标

**目标**

1. 提供一个远程 MCP 端点，能被 Claude 自定义连接器 / Codex 通过 URL + 密钥接入
2. 把已登记、且当前密钥有权访问的 `AgentOpenEndpoint` 动态映射成 MCP 工具
3. 工具调用透传到真实接口，结果按 MCP 规范包装返回
4. 前端"接入 AI"弹窗增加一种"MCP 连接"接入方式，给出可复制的连接配置

**非目标（本期不做）**

- 本地 stdio 代理包（npx 壳）——留作 v2 兼容旧客户端
- OAuth 2.0 授权流——v1 用 Bearer 密钥直传，v2 再升级到标准 OAuth
- MCP 的 `resources` / `prompts` 能力——v1 只做 `tools`
- 为每个工具自动推断严格 JSON Schema——v1 用宽松 schema（见第六节债务）

---

## 四、用户场景：用户怎么连上

以"让 Claude 帮我生成周报"为例，走一遍完整路径：

1. 用户在 MAP 后台"接入 AI"弹窗，选"MCP 连接"方式，一键生成一把 `sk-ak-*` 密钥（按需勾选 scope，比如 `agent.report-agent:call`）。弹窗直接给出连接配置：端点 URL + 密钥。
2. 用户在 Claude（自定义连接器）或 Codex 里贴上这份配置，连接成功。
3. Claude 自动调 `tools/list`，看到一个叫 `report-agent__call` 的工具，描述写着"生成团队周报"。
4. 用户对 Claude 说"帮我生成本周周报"，Claude 调 `tools/call`，MCP 网关校验这把密钥确实持有 `agent.report-agent:call`，把请求透传到 `/api/report/weekly/generate`，结果返回给 Claude。
5. 用户在 MAP 后台登记了新的开放接口（比如缺陷修复），**无需任何代码改动**，Claude 下次 `tools/list` 就会自动多出这个工具。

这条链路里，MCP 网关全程不碰"谁能干什么"——那是真实接口的 `[RequireScope]` 在管。网关只负责"协议长什么样"。

---

## 五、架构设计

### 5.1 总体结构

```
Claude / Codex ──MCP(JSON-RPC over Streamable HTTP)──► POST /mcp (新增网关)
                                                          │
            ┌─────────────────────────────────────────────┤
            │ initialize  → 声明 tools 能力                 │
            │ tools/list  → 读 agent_open_endpoints,        │
            │               按当前 key 的 scope + 白名单过滤  │
            │ tools/call  → 回环 HTTP 调真实接口            │
            └─────────────────────────────────────────────┤
                                                          ▼
                          复用现有：ApiKeyAuthenticationHandler（sk-ak 鉴权）
                                    AgentOpenEndpoint（接口登记表）
                                    [RequireScope]（真实接口的权限闸门）
```

### 5.2 鉴权：复用 sk-ak，网关只读取身份

MCP 客户端发请求时带 `Authorization: Bearer sk-ak-xxx`。这把密钥经现有 `ApiKeyAuthenticationHandler` 解析后，会在 `ClaimsPrincipal` 上注入 `boundUserId` 和若干 `scope` claim——MCP 网关直接读这些 claim 即可，**不需要自己验密钥**。

因此网关端点声明：

```csharp
[ApiController]
[Route("mcp")]
[Authorize(AuthenticationSchemes = "ApiKey")]
public class McpGatewayController : ControllerBase { ... }
```

网关里拿到的 `scope` claim 集合，决定了 `tools/list` 能看到哪些工具、`tools/call` 能不能放行。

### 5.3 工具来源：内置 + 动态两类

网关的 `tools/list` 合并两个来源：

- **内置工具（curated built-in）**：海鲜市场 / 知识库这类走固定 scope（`marketplace.skills:read`、`document-store:read`）的稳定能力，在 `McpBuiltinTools` 里声明（name + description + 固定 scope + method + path 模板 + 参数定义）。它们不在 `AgentOpenEndpoint` 登记表里（那张表的 scope 强制 `agent.*` 格式），所以单列一类。MVP 首批就是这一类：海鲜市场搜索/详情 + 知识库列库/列条目/读正文，共 5 个工具。
- **动态工具**：从 `agent_open_endpoints` 登记表生成，走 `agent.{key}:{action}` scope。后台登记一条接口 = 自动多一个工具，零代码。

两类工具最终都通过同一条"回环转发 Bearer"的调用路径（5.4）落到真实接口，鉴权口径一致。

### 5.3.1 动态工具映射：一条登记 = 一个工具

`tools/list` 时，网关查 `agent_open_endpoints`，对每条满足下面三个条件的记录生成一个 MCP 工具：

1. `IsActive == true`
2. 该记录的 `RequiredScopes` 与当前密钥持有的 scope 有交集（OR 语义，和 `RequireScopeAttribute` 一致）
3. `AllowedCallerUserIds` 为空，或包含当前密钥的 `boundUserId`（沿用反向白名单语义）

映射规则：

| MCP 工具字段 | 来源 |
|---|---|
| `name` | `{AgentKey}__{action}`（action 取自 scope 尾段），需匹配 MCP 名称正则 `^[a-zA-Z0-9_-]{1,64}$` |
| `description` | `Title` + `Description` 拼接 |
| `inputSchema` | 从 `RequestExampleJson` 推断顶层字段为可选 + `additionalProperties: true`（宽松，见债务） |

`AgentKey` 是 kebab（`[a-z0-9-]`），action 是 `[a-z0-9-_]`，用 `__` 连接后天然满足 MCP 名称正则。

### 5.4 工具调用：回环到真实接口

`tools/call` 收到调用后，网关做两件事：

1. **再次校验 scope**（防御性，和 list 同口径），不通过返回 MCP 错误
2. **回环 HTTP**：用同一把 `sk-ak` 密钥，按登记的 `HttpMethod` + `Path` 向自身 base URL 发请求，body = 客户端给的参数

选回环 HTTP 而非进程内直调，理由是**零业务逻辑复制**：真实接口的 `[Authorize(ApiKey)]` + `[RequireScope]` + Controller 逻辑原封不动复用，密钥一致天然过闸。代价是多一跳网络（本机回环，可忽略）。

返回结果包装成 MCP 的 `content`（`type: "text"`，body 为 JSON 文本）。HTTP 非 2xx 时映射成 MCP 工具错误（`isError: true`），把真实接口的错误信息透传给 Claude，让它能自我纠错。

### 5.5 传输与会话

- 端点：`POST /mcp` 接收 JSON-RPC 请求，按 MCP Streamable HTTP 规范返回 `application/json`（单响应）或 `text/event-stream`（需要流时）。v1 工具均为一次性返回，用 `application/json` 即可。
- 会话：v1 **无状态**——每个 POST 凭 Bearer 独立鉴权，不签发 `Mcp-Session-Id`。MCP 规范允许 server 不维护会话。这让网关可水平扩展、无内存态，契合 `server-authority.md`。
- 能力声明：`initialize` 仅声明 `tools`（含 `listChanged: false`，因为工具列表随登记表变化但不主动推送）。

### 5.6 协议实现选型（待定，需第二节决策）

两条路，倾向用官方 SDK：

| 方案 | 说明 | 取舍 |
|---|---|---|
| **A. 官方 `ModelContextProtocol` C# SDK** | 用官方 SDK 处理 JSON-RPC 帧 / 握手 / Streamable HTTP，我们只提供"动态工具列表 + 调用处理器" | 协议正确性有保障，但需验证它能否与我们的 `ApiKey` 鉴权方案 + 从 DB 动态出工具良好集成 |
| **B. 手写最小 JSON-RPC 处理器** | 自己解析 `initialize`/`tools/list`/`tools/call` 三个方法 | 表面积极小（就三个方法），可控；但要自己跟进 MCP 规范演进 |

建议：**先按 A 做技术验证**，若 SDK 在"自定义鉴权 + 动态工具"上有摩擦，退到 B（成本可控）。这一步在 MVP 编码前用半天 spike 定。

---

## 六、数据与接口设计

### 6.1 现有模型够用，仅一处可选增强

`AgentOpenEndpoint` 现有字段（`AgentKey` / `Title` / `Description` / `HttpMethod` / `Path` / `RequiredScopes` / `AllowedCallerUserIds` / `RequestExampleJson` / `ResponseExampleJson` / `IsActive`）已经足够驱动 MCP 工具生成，**本期不强制改模型**。

唯一可选增强（建议作为债务，非本期阻塞）：新增 `InputSchemaJson` 字段，让 Agent 作者登记时能写标准 JSON Schema，替代从示例推断的宽松 schema。

### 6.2 新增端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/mcp` | `ApiKey`（sk-ak Bearer） | MCP 主端点，处理 JSON-RPC |
| GET | `/api/mcp`（可选） | `ApiKey` | 服务端推流通道，v1 返回 405 |

> 端点必须挂在 `/api/` 前缀下：CDS 反向代理（nginx）把 `/api/*` 转给 .NET 后端，其余路径转给前端 SPA。早期挂在顶级 `/mcp` 时被前端兜底页接走（返回 index.html 200），后端控制器收不到 —— 改为 `/api/mcp` 后才可达。MCP 客户端连接 URL 即 `https://<域名>/api/mcp`。
| GET | `/api/open/document-store/stores` | `ApiKey` + scope | 知识库工具回环目标：列出本人知识库 |
| GET | `/api/open/document-store/stores/{storeId}/entries` | `ApiKey` + scope | 列出条目（扁平含嵌套） |
| GET | `/api/open/document-store/entries/{entryId}/content` | `ApiKey` + scope | 读条目正文 |

> 知识库工具不能直接回环到 `DocumentStoreController` 的 `stores/entries`：那些在 `AdminControllerScanner.PublicRoutes` 里（给 JWT 普通用户），跳过 scope→身份注入，其 `GetRequiredUserId()` 只读 `sub`，sk-ak 无 `sub` 会 401。故新增 `DocumentStoreOpenApiController`（`/api/open/document-store`），走与海鲜市场开放接口一致的 `ApiKey + RequireScope + boundUserId` 模式，可见性取 `CanReadStoreAsync` 的安全子集（owner ‖ public ‖ team-shared）。海鲜市场工具回环到既有 `/api/open/marketplace/skills`（同模式，无需新建）。

### 6.3 谁能用网关

不引入额外的"mcp 专用 scope"。**任何有效的 `sk-ak` 密钥都能连 `/mcp`**，但 `tools/list` 只返回该密钥 scope 覆盖到的工具；没有任何匹配工具时返回空列表。这样最简单，也符合"密钥能看到什么 = 它被授权了什么"。

---

## 七、前端：接入方式三选一

复用现有"接入 AI"弹窗（`prd-admin/src/pages/marketplace/SkillOpenApiDialog.tsx` 体系），在接入方式里增加"MCP 连接"：

- 展示远程端点 URL（由 cdscli 预览域名 / 生产域名拼 `/mcp`）
- 一键生成 / 选择 `sk-ak` 密钥（复用 `AgentApiKeysController` 既有创建流）
- 给出可复制的连接配置片段（Claude 自定义连接器填法 + Codex 配置填法）
- 一句话说明"在 MAP 后台登记新接口后，这里的工具会自动出现，无需改配置"

严格遵守项目规则：无 emoji、加载态用 MAP Loader、模态走 createPortal + inline height（`frontend-modal.md`）。

---

## 八、安全与边界

| 关注点 | 处理 |
|---|---|
| 越权 | 网关不绕过 `[RequireScope]`——回环调用仍过真实接口的 scope 闸门，双重校验 |
| 身份注入 | 沿用现有设计：`sk-ak` 不注入 `sub/NameIdentifier`，避免最小权限 key 越权成 owner（见 `ApiKeyAuthenticationHandler` 注释） |
| 反向白名单 | `AllowedCallerUserIds` 在 list 和 call 两端都生效 |
| 限流 | 回环到真实接口时，真实接口已有的按 key 限流（OpenApi 网关那套）自然生效；`/mcp` 自身可后续加桶 |
| 注入内容 | 工具返回内容来自真实接口，Claude 侧按外部数据处理；网关不解释、不执行返回体 |
| 过期提示 | `sk-ak` 宽限期 / 临期响应头（`X-AgentApiKey-Expiring*`）由鉴权处理器自动带上，MCP 客户端可读 |

---

## 九、实施阶段

| 阶段 | 内容 | 产出 |
|---|---|---|
| P0 spike | 官方 C# MCP SDK 与 ApiKey 鉴权 + 动态工具的集成验证 | 选定方案 A 或 B |
| P1 MVP | `/mcp` 端点 + `initialize`/`tools/list`/`tools/call` + 回环调用 + 海鲜市场 + 知识库内置工具（5 个）+ 动态工具框架 | 后端可被真实 MCP 客户端连上并调用 |
| P2 前端 | "接入 AI"弹窗增加 MCP 连接方式 + 连接配置生成 | 用户自助接入 |
| P3 加固 | 错误映射完善、`/mcp` 自身限流、集成测试（模拟 JSON-RPC 帧断言工具列表与调用） | 可上线 |
| v2（不在本期） | 本地 stdio 代理包、OAuth 授权流、`InputSchemaJson` 严格 schema、`resources`/`prompts` | 后续迭代 |

---

## 十、关联文档与规则

- `doc/design.skill.marketplace-open-api.md` —— Agent 开放接口 + AgentApiKey 的上游设计（本设计建在其 P3 基础设施之上）
- `doc/design.open-platform.open-api.md` —— OpenAI 兼容网关（同源鉴权范式参照）
- `.claude/rules/no-rootless-tree.md` —— 借用法则：MCP 连接器借用现成桩，不重建
- `.claude/rules/server-authority.md` —— 无状态网关 + 服务端权威
- `.claude/rules/app-caller-registry.md` —— 若回环调用涉及新 LLM caller，需登记
- `.claude/rules/frontend-modal.md` —— 接入弹窗的布局硬约束

---

## 十一、待用户确认的开放问题

1. **域名**：MCP 端点对外用预览域名还是固定生产域名？（影响前端连接配置生成）
2. **协议实现**：是否同意先 spike 官方 C# SDK，不行再手写（第 5.6 节）？
3. **首批工具**：MVP 先把哪个已登记的 `AgentOpenEndpoint` 作为打通样例（周报生成 / 缺陷修复 / 海鲜市场搜索）？
