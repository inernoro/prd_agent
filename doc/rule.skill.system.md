# 技能系统规则与创建

## 1. 目标

- 统一技能（Skill）的数据模型、创建规范和执行流程
- 指导 AI 和开发者正确创建高质量技能
- 约束技能的可见性、权限、安全边界

---

## 2. 核心概念

### 2.1 什么是技能

技能是一个**可复用的 AI 执行单元**，封装了：
- **输入**：上下文范围 + 用户补充输入 + 参数
- **执行**：提示词模板 + 系统提示词 + LLM 路由
- **输出**：对话 / 文件下载 / 剪贴板

用户在客户端点击技能 → 自动注入上下文 → 执行提示词 → 返回结果。

### 2.2 与通用大模型"技能"的区别

| 维度 | 通用大模型（GPTs/插件） | PRD Agent 技能 |
|------|------------------------|---------------|
| 上下文 | 无，需手动粘贴 | 自动注入 PRD/对话上下文（`contextScope`） |
| 执行配置 | 仅提示词 | 提示词 + 系统提示词覆盖 + Gateway 路由 + 模型偏好 |
| 输出模式 | 仅对话 | 对话 / 文件下载 / 剪贴板，支持同时回显 |
| 工具链 | 无 | `ToolChain` 后处理步骤（如自动创建缺陷单） |
| 权限控制 | 无 | 按角色（PM/DEV/QA）限制可见性 |
| 安全性 | 提示词暴露 | 执行配置（`Execution`）仅服务端持有，不下发客户端 |
| 部署 | 云端公共 | 私有化部署，数据不出域 |

### 2.3 层级关系

```
技能系统
├── 可见性分级
│   ├── system   — 管理员创建，所有人可见，不可删除
│   ├── public   — 管理员创建，所有人可见，可删除
│   └── personal — 用户自建，仅自己可见
├── 角色过滤
│   └── Roles[] 为空 = 全部角色可用；非空 = 仅指定角色可见
└── 执行流程
    └── 客户端调用 → Controller 组装 → Run/Worker 异步执行 → SSE 流式返回
```

---

## 3. 数据模型

### 3.1 核心字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `SkillKey` | string | 是 | 全局唯一标识，kebab-case，如 `prd-review` |
| `Title` | string | 是 | 技能名称，简洁明了，如 "PRD 需求审查" |
| `Description` | string | 是 | 一句话描述用途，帮助用户理解何时使用 |
| `Icon` | string | 否 | emoji 图标，如 `🔍`、`🧪`、`💻` |
| `Category` | string | 是 | 分类标识（见 3.2） |
| `Tags` | string[] | 否 | 标签，用于搜索和过滤 |
| `Visibility` | string | 是 | `system` / `public` / `personal` |
| `Roles` | UserRole[] | 否 | 空 = 全部角色；非空 = 指定角色 |
| `Order` | int | 是 | 排序号，数字越小越靠前 |
| `IsEnabled` | bool | 是 | 是否启用 |
| `IsBuiltIn` | bool | 是 | 是否内置（内置技能不可被用户删除） |
| `UsageCount` | int | 自动 | 使用次数，执行时自动递增 |

### 3.2 分类定义

| Category 值 | 中文标签 | 典型场景 |
|-------------|---------|---------|
| `analysis` | 分析 | 需求审查、竞品分析、风险评估、用户故事拆分 |
| `testing` | 测试 | 测试用例生成、验收标准、回归测试清单 |
| `development` | 开发 | 技术方案、API 文档、数据库设计、代码审查 |
| `general` | 通用 | 摘要生成、翻译、格式转换等通用任务 |
| `workflow` | 工作流 | 代码转工作流等自动化场景 |

### 3.3 输入配置（Input）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `ContextScope` | string | `"prd"` | 上下文范围（见 3.3.1） |
| `AcceptsUserInput` | bool | `false` | 是否接受用户附加文本 |
| `UserInputPlaceholder` | string? | null | 用户输入占位提示文案 |
| `AcceptsAttachments` | bool | `false` | 是否接受附件上传 |
| `Parameters` | SkillParameter[] | `[]` | 可配置参数列表（见 3.3.2） |

#### 3.3.1 上下文范围（ContextScope）

| 值 | 含义 | 适用场景 |
|----|------|---------|
| `prd` | 注入当前 PRD 文档全文 | 需求审查、测试用例生成、技术方案 |
| `all` | 注入会话全部消息 | 需要完整对话历史的分析任务 |
| `current` | 仅当前轮对话 | 简单问答、翻译 |
| `none` | 不注入任何上下文 | 独立任务（如代码转工作流） |

**选择原则**：
- 与 PRD 内容相关的技能 → `prd`
- 需要对话上下文的技能 → `all` 或 `current`
- 独立任务（用户提供全部输入）→ `none`

#### 3.3.2 参数定义（SkillParameter）

```json
{
  "key": "codeUrl",
  "label": "代码仓库地址",
  "type": "text",
  "defaultValue": "",
  "required": true,
  "options": []
}
```

支持类型：`text` | `select` | `number` | `boolean`

### 3.4 执行配置（Execution）

> **安全约束**：执行配置仅服务端持有，**永远不下发客户端**，防止提示词泄露。

| 字段 | 类型 | 说明 |
|------|------|------|
| `PromptTemplate` | string | 提示词模板，支持 `{{变量}}` 占位符 |
| `SystemPromptOverride` | string? | 系统提示词覆盖（null = 使用默认角色系统提示词） |
| `AppCallerCode` | string? | LLM Gateway 路由标识（遵循 `core/rule.app-identity.md`） |
| `ModelType` | string | 模型类型偏好，默认 `"chat"` |
| `ExpectedModel` | string? | 期望模型提示（如 `"gpt-4o"`），仅作调度参考 |
| `ToolChain` | SkillToolStep[] | 后处理工具链（见 3.4.2） |

#### 3.4.1 提示词模板规范

**变量语法**：`{{varName}}`，执行时从 `Parameters` 或内置变量替换。

**内置变量**：

| 变量 | 来源 |
|------|------|
| `{{userInput}}` | 用户附加文本输入 |
| `{{prdContent}}` | PRD 文档内容（contextScope=prd 时） |

**编写原则**：

```
✅ 好的提示词模板：
  - 明确输出格式（表格/列表/Markdown 章节）
  - 分步骤指令（1. 2. 3.）
  - 指定输出维度和深度
  - 包含角色设定（如"你是资深测试工程师"）

❌ 差的提示词模板：
  - "帮我分析一下" → 太模糊，无输出格式约束
  - 超长无结构文本 → 难以维护和迭代
  - 硬编码具体项目信息 → 无法复用
```

**示例 — PRD 需求审查**：

```
请对当前 PRD 文档进行全面审查，包括：
1. 需求完整性检查 — 是否有遗漏的功能点或边界条件
2. 逻辑一致性验证 — 前后描述是否矛盾
3. 技术可行性评估 — 是否存在技术难以实现的需求
4. 边界条件分析 — 异常场景和极端情况是否覆盖
5. 改进建议 — 按优先级排序

输出格式：
每个维度用 ## 标题，问题用 ❌ 标记，建议用 💡 标记。
```

**示例 — 带参数的技能**：

```
分析以下代码仓库，将核心逻辑转换为工作流定义：

仓库地址：{{codeUrl}}

{{userInput}}

输出格式：YAML 工作流定义，包含步骤名称、输入输出、条件分支。
```

#### 3.4.2 工具链（ToolChain）

工具链定义技能执行后的后处理步骤：

```json
[
  {
    "toolKey": "create-defect",
    "config": { "templateId": "default" },
    "optional": true
  }
]
```

可用 toolKey：`chat` | `download` | `clipboard` | `create-defect`

`optional: true` 表示该步骤失败不中断整体流程。

### 3.5 输出配置（Output）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `Mode` | string | `"chat"` | 输出模式：`chat` / `download` / `clipboard` |
| `FileNameTemplate` | string? | null | 下载模式文件名（如 `{{title}}-report.md`） |
| `MimeType` | string? | null | 下载模式 MIME（如 `text/markdown`） |
| `EchoToChat` | bool | `false` | 非 chat 模式是否同时在对话中回显 |

**选择原则**：
- 大多数技能 → `chat`（直接在对话中展示）
- 生成报告/文档类 → `download`（同时 `echoToChat: true`）
- 生成代码片段 → `clipboard`（方便粘贴到 IDE）

---

## 4. SkillKey 命名规范

### 4.1 格式

```
{场景}-{动作}  或  {动作}-{对象}
```

- 使用 `kebab-case`
- 长度 3~50 字符
- 全局唯一

### 4.2 示例

| SkillKey | Title | 说明 |
|----------|-------|------|
| `prd-review` | PRD 需求审查 | 场景-动作 |
| `testcase-gen` | 测试用例生成 | 对象-动作 |
| `tech-evaluation` | 技术方案评估 | 对象-动作 |
| `user-story-split` | 用户故事拆分 | 对象-动作 |
| `api-doc-gen` | API 文档生成 | 对象-动作 |
| `risk-assessment` | 风险评估报告 | 对象-动作 |
| `workflow-from-code` | 代码转工作流 | 动作-来源 |

### 4.3 禁止

- 禁止使用中文、空格、大写字母
- 禁止与已有 `SkillKey` 重复
- 禁止使用过于通用的名称（如 `analysis`、`check`）

---

## 5. 可见性与权限

### 5.1 可见性矩阵

| Visibility | 创建者 | 可见范围 | 可编辑 | 可删除 |
|------------|--------|---------|--------|--------|
| `system` | 管理员 | 所有用户（角色过滤） | 仅管理员 | 仅 `IsBuiltIn=false` 的系统技能 |
| `public` | 管理员 | 所有用户（角色过滤） | 仅管理员 | 仅管理员 |
| `personal` | 用户自己 | 仅创建者 | 仅创建者 | 仅创建者（非 IsBuiltIn） |

### 5.2 角色过滤规则

```
Roles = []        → 所有角色可见
Roles = [PM]      → 仅 PM 角色可见
Roles = [QA, DEV] → QA 和 DEV 可见
ADMIN 角色        → 无视角色过滤，始终可见
```

### 5.3 选择建议

| 场景 | Visibility | IsBuiltIn | Roles |
|------|-----------|-----------|-------|
| 核心通用技能（如 PRD 审查） | `system` | `true` | `[]` |
| 特定角色技能（如测试用例生成） | `system` | `true` | `[QA]` |
| 管理员创建的实验性技能 | `public` | `false` | `[]` |
| 用户自定义提示词 | `personal` | `false` | — |

---

## 6. 执行流程

### 6.1 时序图

```
客户端                    PrdAgentSkillsController           ChatRunWorker
  │                              │                              │
  │  POST /execute               │                              │
  │  { sessionId, userInput }    │                              │
  │ ─────────────────────────▶   │                              │
  │                              │                              │
  │                     1. 权限校验（personal → owner check）      │
  │                     2. 从 DB 获取完整 Skill（含 Execution）    │
  │                     3. 替换 {{变量}} → resolvedPromptTemplate │
  │                     4. 构建 RunMeta + InputJson               │
  │                     5. 存入事件流 + 入队 Worker               │
  │                     6. 递增 UsageCount（异步）                │
  │                              │                              │
  │  ◀── { runId }               │                              │
  │                              │   ── 出队 ──▶                │
  │                              │                     7. 读取 InputJson
  │                              │                     8. 组装 messages[]
  │                              │                     9. 调用 LLM Gateway
  │                              │                    10. SSE 流式返回
  │  ◀─── SSE stream ────────────────────────────────────────── │
```

### 6.2 关键行为

- **客户端只发 `skillKey` + `sessionId`**，不发提示词内容（安全隔离）
- **执行配置服务端组装**：`PromptTemplate` 仅服务端读取，客户端无法获取
- **Run/Worker 异步解耦**：技能执行通过 `ChatRunWorker` 异步处理，支持断线重连
- **UsageCount 异步递增**：不阻塞主流程

### 6.3 客户端可覆盖项

客户端执行时可覆盖（但不可覆盖提示词和系统提示词）：

| 可覆盖字段 | 说明 |
|-----------|------|
| `ContextScopeOverride` | 临时切换上下文范围 |
| `OutputModeOverride` | 临时切换输出模式 |
| `Parameters` | 填入参数值 |
| `UserInput` | 用户附加文本 |
| `AttachmentIds` | 附件 ID 列表 |

---

## 7. API 端点

### 7.1 管理后台（Admin）

路由前缀：`/api/skills`，需要 `SkillsRead` / `SkillsWrite` 权限。

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/skills?visibility=` | 列出系统 + 公共技能 |
| GET | `/api/skills/{skillKey}` | 获取技能详情（含执行配置） |
| POST | `/api/skills` | 创建技能 |
| PUT | `/api/skills/{skillKey}` | 更新技能 |
| DELETE | `/api/skills/{skillKey}` | 删除技能 |

### 7.2 客户端（PRD Agent）

路由前缀：`/api/prd-agent/skills`，硬编码 `appKey = "prd-agent"`。

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/api/prd-agent/skills?role=` | 列出可见技能（**不含** Execution 配置） |
| POST | `/api/prd-agent/skills` | 创建个人技能 |
| PUT | `/api/prd-agent/skills/{skillKey}` | 更新个人技能 |
| DELETE | `/api/prd-agent/skills/{skillKey}` | 删除个人技能 |
| POST | `/api/prd-agent/skills/{skillKey}/execute` | 执行技能 |
| POST | `/api/prd-agent/skills/migrate-prompts` | 迁移旧版 PromptEntry |

---

## 8. 创建技能检查清单

创建一个新技能时，逐项确认：

### 8.1 基本信息

- [ ] `Title` 是否简洁明了（5~15 字）
- [ ] `Description` 是否一句话说清用途
- [ ] `SkillKey` 是否遵循 kebab-case 且全局唯一
- [ ] `Icon` 是否选择了与用途匹配的 emoji
- [ ] `Category` 是否归入正确分类
- [ ] `Tags` 是否包含 2~5 个有助搜索的关键词

### 8.2 输入配置

- [ ] `ContextScope` 是否选择了最合适的范围（不要过大浪费 Token，不要过小缺失信息）
- [ ] `AcceptsUserInput` 是否按需开启（需要用户补充信息时才开）
- [ ] `Parameters` 是否定义了必要的可配置参数

### 8.3 执行配置

- [ ] `PromptTemplate` 是否包含明确的输出格式要求
- [ ] `PromptTemplate` 是否分步骤指令（避免笼统描述）
- [ ] `PromptTemplate` 中的 `{{变量}}` 是否与 Parameters 定义一致
- [ ] `SystemPromptOverride` 是否真的需要覆盖（大部分情况不需要）
- [ ] `ModelType` 是否匹配任务需求（文本=chat，图片分析=vision）

### 8.4 输出与权限

- [ ] `OutputMode` 是否匹配使用场景
- [ ] `Roles` 是否限定了正确的目标角色（不确定就留空）
- [ ] `Visibility` 是否选择了正确的级别

---

## 9. 预置模板参考

以下为系统推荐的标准技能模板，可直接使用或基于此修改：

### 9.1 分析类

| SkillKey | Title | Roles | ContextScope | 核心提示词要点 |
|----------|-------|-------|-------------|--------------|
| `prd-review` | PRD 需求审查 | PM | prd | 完整性 + 一致性 + 可行性 + 边界 + 改进建议 |
| `user-story-split` | 用户故事拆分 | PM | prd | 功能分组 + As a/I want/So that + 优先级 + 故事点 |
| `competitor-analysis` | 竞品对比分析 | 全部 | prd | 功能矩阵 + 差异化 + 缺口 + 改进建议 |
| `risk-assessment` | 风险评估报告 | PM | prd | 风险矩阵 + 应对策略 + 里程碑预警 |

### 9.2 测试类

| SkillKey | Title | Roles | ContextScope | 核心提示词要点 |
|----------|-------|-------|-------------|--------------|
| `testcase-gen` | 测试用例生成 | QA | prd | 正向 + 边界 + 异常 + 兼容 + 性能，表格格式 |
| `acceptance-criteria` | 验收标准生成 | QA, PM | prd | 功能/性能/安全/兼容/文档 DoD，复选框列表 |

### 9.3 开发类

| SkillKey | Title | Roles | ContextScope | 核心提示词要点 |
|----------|-------|-------|-------------|--------------|
| `tech-evaluation` | 技术方案评估 | DEV | prd | 复杂度 + 架构 + 数据模型 + API + 风险 + 工作量 |
| `api-doc-gen` | API 文档生成 | DEV | prd | RESTful 接口 + 参数 + 响应 + 错误码 |
| `db-design` | 数据库设计 | DEV | prd | ER 分析 + 集合结构 + 索引 + 迁移注意 |

### 9.4 工作流类

| SkillKey | Title | Roles | ContextScope | 核心提示词要点 |
|----------|-------|-------|-------------|--------------|
| `workflow-from-code` | 代码转工作流 | 全部 | none | 解析代码逻辑 → YAML 工作流定义，需参数 `codeUrl` |

---

## 10. 数据库与集合

| 集合 | 说明 |
|------|------|
| `skills` | 统一技能存储（新模型） |
| `prompt_stages` | 旧版提示词阶段（自动转换兼容） |
| `skill_settings` | 旧版技能设置（已废弃，仅 `/api/v1/skills` 兼容读取） |

---

## 11. 安全约束

| 约束 | 说明 |
|------|------|
| Execution 不下发客户端 | `GET /api/prd-agent/skills` 返回结果中 **剥离** Execution 字段 |
| 个人技能 owner 校验 | personal 技能执行/修改/删除必须校验 `OwnerUserId` |
| 管理端权限门控 | `/api/skills` 需要 `AdminPermissionCatalog.SkillsRead/Write` |
| 参数注入防护 | `{{变量}}` 替换在服务端完成，客户端无法控制模板本身 |

---

## 12. 废弃概念

| 废弃 | 替代 |
|------|------|
| `SkillSettings` / `SkillEntry` 模型 | `Skill` 统一模型 |
| `prompt_stages` 直接使用 | 通过 `SkillService` 自动转换为 `Skill` |
| `/api/v1/skills` 端点 | `/api/prd-agent/skills` |
| 前端 `SkillPanel` 直接读 `skill_settings` | 通过 `skills` 集合统一管理 |

---

## 13. 因果关系

```
1) 管理员在管理后台创建/配置技能
       ↓
2) 技能存入 skills 集合（含完整 Execution 配置）
       ↓
3) 客户端拉取技能列表（不含 Execution）→ 展示技能面板
       ↓
4) 用户点击技能 → 客户端发送 skillKey + sessionId + userInput
       ↓
5) 服务端读取完整技能 → 替换变量 → 构建 Run → 入队 Worker
       ↓
6) Worker 异步执行 → 调用 LLM Gateway → SSE 流式返回
       ↓
7) UsageCount 递增，结果持久化到消息历史
```
