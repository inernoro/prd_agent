# 技能系统统一设计 (Unified Skill System Design)

> **版本**：v1.0 | **日期**：2026-03-19 | **状态**：已落地

## 一、管理摘要

- **解决什么问题**：提示词（promptstages）和技能（skills）双轨并存，数据脱节、管理割裂、用户概念混乱
- **方案概述**：废弃 promptstages，统一到 skills 集合，启动时自动迁移数据，Admin 合并为单一 /skills 管理页面
- **业务价值**：单一数据源消除管理员编辑无效的问题，统一管理入口降低运维复杂度
- **影响范围**：prd-api 数据迁移服务、prd-admin 技能管理页面、prd-desktop 技能栏
- **预计风险**：中 — 涉及数据迁移和多端兼容，但已有启动时自动迁移 + 旧 API 兼容层兜底

## 1. 问题背景

### 1.1 旧架构：提示词与技能双轨制

PRD Agent 历史上存在两套独立系统管理"用户可触发的 AI 指令"：

| 维度 | 提示词系统 (promptstages) | 技能系统 (skills) |
|------|--------------------------|-------------------|
| 数据集合 | `promptstages` | `skills` |
| 管理入口 | Admin `/prompts` (PromptStagesPage) | Admin `/skills` (SkillsPage) |
| 创建方式 | 管理员手动配置 | 管理员手动 / 用户从对话提炼 |
| 客户端展示 | Desktop 按角色固定按钮列表 | Desktop 技能栏（可扩展） |
| 数据模型 | `{ promptKey, role, order, title, promptTemplate }` | `{ skillKey, title, execution, input, output, visibility, ... }` |

### 1.2 核心痛点

1. **数据脱节**：后端执行层已统一读 `skills` 集合，但 Admin 提示词页面仍写 `promptstages`，管理员编辑后执行层无感知
2. **功能碎片**：魔法棒（AI 优化）、拖拽排序等好特性仅存在于提示词页面，技能页面没有
3. **概念冗余**：用户需理解"提示词"和"技能"两个概念，实际是同一件事
4. **管理割裂**：系统指令、文学创作提示词、用户提示词、技能分散在两个页面管理

## 2. 设计目标

| 目标 | 衡量标准 |
|------|---------|
| 单一数据源 | 全链路（Admin → 后端 → 客户端）统一读写 `skills` 集合 |
| 单一管理入口 | Admin 只保留 `/skills` 页面，`/prompts` 重定向 |
| 功能超集 | 新页面包含旧页面所有能力 + 新增能力 |
| 零感知迁移 | 旧 `promptstages` 数据启动时自动迁移，旧路由自动重定向 |

## 3. 设计决策

### 3.1 数据迁移策略

**决策**：应用启动时自动迁移，不做离线脚本。

```
应用启动
  ↓
检查 promptstages 集合是否有数据
  ↓ 有
遍历每条 PromptEntry
  ↓
转换为 Skill 对象（映射字段 + 补全默认值）
  ↓
以 skillKey = promptKey 写入 skills 集合（跳过已存在的）
  ↓
标记迁移完成（不删除原数据，保留回退能力）
```

字段映射：

| promptstages 字段 | skills 字段 | 备注 |
|-------------------|-------------|------|
| `promptKey` | `skillKey` | 直接沿用 |
| `title` | `title` | |
| `promptTemplate` | `execution.promptTemplate` | |
| `role` (PM/DEV/QA) | `roles: [role]` | 单值变数组 |
| `order` | `order` | |
| — | `visibility: "system"` | 迁移来源默认为系统级 |
| — | `isBuiltIn: true` | 管理员配置的提示词标记为内置 |

### 3.2 客户端兼容

Desktop 端原 `/api/v1/prompts` 接口改为从 `skills` 集合读取并转换为旧格式返回，确保旧版客户端平滑过渡。

### 3.3 Admin 页面合并

**决策**：废弃 PromptStagesPage，功能迁移到 SkillsPage。

新 SkillsPage 四个 Tab：

```
[技能管理]  [系统指令]  [文学创作]  [模板市场]
```

| Tab | 来源 | 功能 |
|-----|------|------|
| 技能管理 | SkillsPage 原有 + 提示词页面迁移 | CRUD + 魔法棒 + 拖拽排序 |
| 系统指令 | 提示词页面 Tab2 | 按角色配置 system prompt（结构化/Raw 编辑） |
| 文学创作 | 提示词页面 Tab3 | 文学场景提示词 CRUD + 水印配置 |
| 模板市场 | SkillsPage 原有 | 9 个内置模板一键创建 |

## 4. 架构全景

### 4.1 数据流

```
┌──────────────┐         ┌──────────────┐         ┌──────────────┐
│  Admin 后台   │  CRUD   │              │  CRUD   │  Desktop     │
│  SkillsPage  ├────────→│  skills 集合  │←────────┤  用户自建    │
│  (system/    │         │  (唯一数据源) │         │  AI 提炼     │
│   public)    │         │              │         │  导入导出    │
└──────────────┘         └──────┬───────┘         └──────┬───────┘
                                │                         │
                                ▼                         ▼
                       ┌────────────────┐        ┌────────────────┐
                       │ Desktop 技能栏  │        │ Run/Worker     │
                       │ 按 role 过滤    │───────→│ 执行 + SSE 流  │
                       │ 按 order 排序   │        │                │
                       │ 按 pin 置顶     │        └────────────────┘
                       └────────────────┘
```

### 4.2 技能可见性模型

| visibility | 创建者 | 可见范围 | 可编辑 | 可删除 |
|------------|--------|---------|--------|--------|
| `system` | 管理员（Admin 后台） | 所有用户 | 仅管理员 | 仅管理员（非 builtIn） |
| `public` | 管理员（Admin 后台） | 所有用户 | 仅管理员 | 仅管理员 |
| `personal` | 用户（Desktop） | 仅创建者 | 仅创建者 | 仅创建者 |

### 4.3 技能数据模型

```typescript
interface Skill {
  skillKey: string;          // kebab-case 唯一标识
  title: string;             // 显示名称
  description: string;       // 一行描述
  icon?: string;             // emoji
  category: string;          // general | analysis | testing | development | ...
  tags: string[];
  roles: UserRole[];         // 空 = 全角色可用
  visibility: string;        // system | public | personal
  ownerUserId?: string;      // personal 技能的创建者
  order: number;             // 排序权重
  isEnabled: boolean;
  isBuiltIn: boolean;        // 不可被用户删除

  input: {
    contextScope: string;    // prd | all | current | none
    acceptsUserInput: boolean;
    acceptsAttachments: boolean;
    parameters: SkillParameter[];
  };

  execution: {
    promptTemplate: string;  // 核心提示词，支持 {{userInput}} 等占位符
    systemPromptOverride?: string;
    modelType: string;       // chat | vision | generation
    appCallerCode?: string;
  };

  output: {
    mode: string;            // chat | download | clipboard
    echoToChat: boolean;
    fileNameTemplate?: string;
    mimeType?: string;
  };

  usageCount: number;
  createdAt: string;
  updatedAt: string;
}
```

## 5. 用户故事

### 5.1 产品经理小王：从对话中沉淀技能

**前提**：小王正在用 PRD Agent 分析一份竞品文档，经过 3 轮对话后 AI 给出了结构优秀的竞品对比矩阵。

**流程**：

```
对话中 AI 回复一条高质量内容
  ↓
悬浮工具栏 → 点击「⚡ 保存为技能」
  ↓
SaveAsSkillModal → 选择要包含的对话轮次（可多选）
  ↓
点击「AI 提炼」
  ↓
后端 LLM 分析对话 → 提取：
  - promptTemplate（可复用的提示词模板）
  - title / description / category / icon（自动建议）
  - {{userInput}} 占位符（泛化用户输入）
  ↓
预览 SKILL.md 标准格式
  ↓
├→「保存为文件」→ 下载 .skill.md（兼容 Claude Code / Cursor / Copilot 等 14+ 平台）
└→「保存到账户」→ 写入 skills 集合 → 立即出现在聊天技能栏
```

**使用**：

下次小王在任意会话中点击聊天输入栏上方的「📊 竞品对比」技能按钮 → 填写对比维度 → 一键生成结构化矩阵。

### 5.2 管理员老李：统一管理所有技能

**旧痛点**：

```
/prompts 页面                    /skills 页面
├ Tab1: 用户提示词 → promptstages  ├ Tab1: 技能列表 → skills
├ Tab2: 系统指令                  └ Tab2: 模板市场
└ Tab3: 文学创作
      ↑ 写入 promptstages            ↑ 写入 skills
      执行层已不读这里!               执行层读这里
```

**新方案**：

```
/skills 页面（唯一入口）
├ Tab1: 技能管理 → skills（含魔法棒 + 拖拽排序）
├ Tab2: 系统指令（按 PM/DEV/QA 角色配置 system prompt）
├ Tab3: 文学创作（场景提示词 CRUD + 水印配置）
└ Tab4: 模板市场（9 个内置模板一键创建）
```

**老李的日常操作**：

1. **调优系统技能**：选中「需求审查」→ 编辑提示词 → 点魔法棒 AI 优化 → 对比预览 → 替换 → 保存
2. **调整顺序**：拖拽「测试用例」到第一位 → 自动持久化 → Desktop 端立即生效
3. **配置系统指令**：切到「系统指令」Tab → 选 PM 角色 → 结构化编辑 8 个维度 → 应用到 Raw → 保存
4. **管理文学提示词**：切到「文学创作」Tab → 按场景筛选 → CRUD 操作

## 6. 迁移前后对比

### 6.1 功能对照

| # | 能力 | 旧方式 | 新方式 |
|---|------|--------|--------|
| 1 | 管理员编辑提示词 | 提示词页面 → promptstages | 技能页面 → skills |
| 2 | 魔法棒 AI 优化 | 仅提示词页面 | 技能页面（执行配置区） |
| 3 | 拖拽排序 | 仅提示词页面 | 技能页面左侧列表 |
| 4 | 系统指令管理 | 提示词页面 Tab2 | 技能页面「系统指令」Tab |
| 5 | 文学创作管理 | 提示词页面 Tab3 | 技能页面「文学创作」Tab |
| 6 | 用户自建技能 | 不支持 | Desktop 保存为技能 / 技能管理器 |
| 7 | 跨平台导出 | 不支持 | SKILL.md 标准格式 |
| 8 | 旧路由兼容 | `/prompts` | 重定向到 `/skills` |
| 9 | 数据统一 | 两个集合 | 一个集合（启动迁移） |
| 10 | 执行一致性 | 执行层读 skills，编辑写 promptstages（脱节） | 全链路统一读写 skills |

### 6.2 废弃清单

| 废弃项 | 替代 | 状态 |
|--------|------|------|
| `PromptStagesPage.tsx` | `SkillsPage.tsx` | 路由已重定向，文件保留待删 |
| `/prompts` 路由 | 302 → `/skills` | 已生效 |
| `promptstages` 集合 | `skills` 集合 | 数据已迁移，集合保留兜底 |
| `getAdminPrompts` 写操作 | `updateAdminSkill` | Admin 不再写 promptstages |

## 7. SKILL.md 跨平台格式

技能可导出为标准 SKILL.md 格式，兼容 Claude Code、Cursor、GitHub Copilot 等 14+ 平台：

```markdown
---
name: competitive-analysis
description: "多维度竞品对比矩阵生成"
prd-agent:
  title: "竞品对比分析"
  icon: "📊"
  category: analysis
  context-scope: prd
  output-mode: chat
  roles: [PM]
---

请从以下维度对比当前产品与竞品的差异：
{{userInput}}

输出要求：
1. 使用 Markdown 表格，每个维度一行
2. 标注各项的"领先/持平/落后"状态
3. 最后给出整体差异化建议
```

- `name` + `description`：跨平台通用字段
- `prd-agent:` 命名空间：PRD Agent 专属扩展字段（其他平台忽略）
- YAML frontmatter 后的纯文本：提示词模板本体

## 8. 关键 API 端点

### 8.1 Admin API（管理后台调用）

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/skills` | GET | 列出所有技能（system + public） |
| `/api/skills` | POST | 创建技能 |
| `/api/skills/{skillKey}` | PUT | 更新技能 |
| `/api/skills/{skillKey}` | DELETE | 删除技能 |
| `/api/prompts/optimize/stream` | POST | 魔法棒 AI 优化（SSE 流） |

### 8.2 客户端 API（Desktop 调用）

| 端点 | 方法 | 用途 |
|------|------|------|
| `/api/prd-agent/skills` | GET | 列出可见技能（system + public + personal） |
| `/api/prd-agent/skills` | POST | 创建个人技能 |
| `/api/prd-agent/skills/{skillKey}/execute` | POST | 执行技能（创建 ChatRun） |
| `/api/prd-agent/skills/generate-from-conversation` | POST | AI 从多轮对话提炼技能草案 |
| `/api/prd-agent/skills/{skillKey}/export` | GET | 导出为 SKILL.md |
| `/api/prd-agent/skills/import` | POST | 从 SKILL.md 导入 |

## 9. 相关文档

| 文档 | 关联 |
|------|------|
| `design.server-authority.md` | Run/Worker 执行模型 |
| `.claude/rules/frontend-architecture.md` | 前端无业务状态原则 |
| `.claude/rules/app-identity.md` | appKey 硬编码规则 |
| `.claude/rules/llm-gateway.md` | LLM 调用必须通过 Gateway |
