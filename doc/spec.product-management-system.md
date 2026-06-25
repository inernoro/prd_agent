---
type: spec
title: 产品管理系统（新仓库迁移版）信息架构与字段级规格
status: draft
updated: 2026-06-25
---

# 产品管理系统（新仓库迁移版）信息架构与字段级规格

> 本文档用于把现有 MAP「产品管理智能体（product-agent）」迁移到**新仓库**，适配**新技术规范 + 新 UI**，**移除全部 AI 能力**，并参考 **TAPD** 重新设计字段与流程。
> 范围：信息架构（对象关系 + 页面 IA）+ 核心功能 + **字段级数据建模**。不含具体技术栈选型与 UI 视觉稿（留给实现阶段，本文档是产品 + 数据契约）。
> 字段表的「类型」一律用**逻辑数据类型**（与语言无关）：`string` / `text`（长文本）/ `richtext`（富文本 HTML）/ `int` / `bool` / `datetime` / `enum` / `string[]`（ID 数组或标签数组）/ `object` / `object[]`（内嵌结构）/ `map<string,string>`（键值表）。

---

## 一、迁移基线与四条对齐结论

本文档基于 2026-06-25 与产品负责人的对齐结论编写：

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | AI 能力处理 | **整体删除**所有纯 AI 功能；依赖 AI 的环节改为人工（见第十一章移除清单） |
| 2 | 对象模型范围 | **保持现有 7 类对象**（产品 / 版本 / 需求 / 功能 / 客户 / 缺陷 / 知识库），仅借鉴 TAPD 的字段与流程，不引入迭代 / 任务 / 测试用例 |
| 3 | 缺陷定位 | **升级为一等对象**：完整字段 + 独立工作流，参考 TAPD 缺陷（不再只做追溯引用） |
| 4 | 文档粒度 | **含数据建模**：字段名 / 类型 / 必填 / 默认 / 枚举 / 来源 / 索引建议 |

迁移前后的关键变化一览：

| 维度 | 现状（旧仓库 product-agent） | 目标（新仓库） |
|------|------------------------------|----------------|
| 缺陷 | 复用 defect-agent，仅存 `Traced*` 追溯引用 | 一等对象，自带完整字段与工作流 |
| AI | 营销问策 / 需求 AI 填充 / 立项 Agent 评审 / 追溯关系分析 / AI 助手 / AI 摘要 / 缺陷 AI 审核 | 全部移除，改人工或删功能 |
| 知识库 | 复用平台 DocumentStore | 以挂载关系引用「文档/知识库模块」（新仓库自建或接入，见第八章） |
| 表单 / 流程引擎 | 元数据驱动，已落地 | 原样保留（核心资产） |
| UI / 技术栈 | React + .NET + MongoDB | 新技术规范 + 新 UI（实现阶段决定） |

---

## 二、设计原则

1. **自包含，不外挂**：新仓库不依赖旧平台的 defect-agent / review-agent。缺陷内建；评审改人工。知识库以「可替换的文档模块」对接，挂载关系字段化。
2. **通用引擎，最小 schema**：两类横切能力服务全部对象——**表单模板引擎**（`map FormData` + 字段定义）与**工作流定义引擎**（`CurrentState` + 统一流转端点）。只满足 7 类对象，不为假想场景过度抽象。
3. **运行时 SSOT 在后端**：工作流、表单、目录、导航顺序均可配置，但运行时真值是数据库里的定义 + 服务端校验；前端不硬编码 `switch(type)`，走注册表。
4. **零 AI，纯人工可控**：所有原 AI 自动化环节给出**人工等价路径**（手填 / 录入 / 模板预填），不留「等 AI」的空白等待。
5. **零摩擦输入**：能导入就不手敲（CSV / RTF 历史数据导入，相同外部 ID 更新而非重复造数）；空状态有下一步引导。
6. **负责人认领制**：产品 `OwnerIds` 可为空，导入默认不绑定登录用户；支持多负责人；无负责人显示「待认领」。
7. **软删除 + 反规范化计数**：所有主对象 `IsDeleted` 软删；列表计数 / 负责人名等冗余字段由写操作维护，读路径不二次拼业务规则。

---

## 三、信息架构

### 3.1 对象关系总览（RTM 主线）

```text
产品 Product（关系网的根）
  ├── 内部版本/立项 ProductInitiation（T 号，立项与人工三稿评审）
  ├── 正式版本/上线 ProductRelease（V 号，上线公告 + 功能清单 manifest）
  ├── 通用版本 ProductVersion（演进链 ParentVersionId，关联需求/功能版本）
  ├── 需求 Requirement（分级 P0-P3，父子分解）
  ├── 功能 Feature（+ FeatureVersion 功能版本化）
  ├── 缺陷 Defect（一等对象，TAPD 风格）
  ├── 客户 Customer（全局共享 + CustomerFollowUp 跟进时间线）
  ├── 团队（OwnerIds / AdminIds / MemberIds）
  └── 知识库（KnowledgeStoreId 挂载）

关系链（需求可追溯矩阵 RTM）：
  客户 ──提出──→ 需求 ──落成──→ 功能 ──纳入──→ 版本
  缺陷 ──追溯──→ 需求 / 功能 / 版本 / 产品
  知识库 ←──沉淀── 版本 / 产品
  大版本升级 ──聚合──→ 需求 + 功能 + 知识条目（VersionUpgradeRequest 审批）
```

### 3.2 横切能力（服务全部对象）

- **表单模板引擎**：`ProductFormTemplate`（按 `EntityType` 绑定）→ 实例的 `FormData`（key = 字段 Key）。
- **工作流定义引擎**：`ProductWorkflowDefinition`（状态 + 流转边）→ 实例的 `CurrentState`，统一 `POST /transition` 查表校验。
- **动态时间线**：`ProductItemActivity`（评论 / 流转 / 转交 / 创建记录）。
- **可配置目录**：等级（优先级 / 严重程度）、需求类型、产品类型、描述模板。

### 3.3 页面信息架构（IA）

**管理层总览（OverviewShell，跨产品）**

```
概览（仪表盘）→ 产品 → 需求 → 功能 → 版本 → 缺陷 → 客户 → 知识库 → 图谱 → 设置
```

**单产品视图（SingleProductView，数据 scoped 到 productId）**

```
工作台（我的待办）→ 概览 → 需求 → 功能 → 版本（立项 T / 上线 V）→ 缺陷 → 客户 → 团队 → 知识库 → 图谱 → 设置
```

**全局设置（七分类设置中心）**

```
表单模板 · 工作流模板 · 等级目录（优先级/严重程度）· 需求类型 · 产品类型 · 描述模板 · 权限
```

**入口**：左侧导航「产品管理」→ 选产品进入单产品视图，或进总览各区块。（移除原 AI 助手浮窗、营销问策入口。）

---

## 四、核心对象与字段建模

> 所有对象统一含审计字段：`Id`（主键，32 位无连字符 UUID）、`CreatedAt` / `UpdatedAt`（datetime，默认当前时间）、`IsDeleted`（bool，默认 false 软删）。下表为节省篇幅，对每个对象只在首次出现处展开这些通用字段，其余对象省略不重复列。

### 4.1 产品 Product（集合 `products`）

研发关系网的根。

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| Id | string | 主键 | 是 | UUID | — | PK |
| ProductNo | string | 产品编号 = 类型前缀 + 全局序号，如 `SYS-1007157` | 是 | 系统生成 | — | 唯一，编号规则见第九章 |
| Name | string | 产品名称 | 是 | — | — | — |
| Code | string | 产品短码 | 否 | null | — | — |
| Description | text | 产品描述/定位 | 否 | null | — | — |
| Grade | string | 产品分级（存 `ProductCategory.Id`） | 是 | `normal` | core/important/normal/experimental（可扩展，见 4.13） | — |
| CurrentState | string | 当前状态 Key | 否 | null | 对应绑定工作流的状态 | — |
| TemplateId | string | 绑定的表单模板 Id | 否 | null | — | FK→product_form_templates |
| WorkflowDefId | string | 绑定的工作流定义 Id | 否 | null | — | FK→product_workflow_definitions |
| FormData | map<string,string> | 自定义表单值（key = 字段 Key） | 否 | {} | — | 由表单引擎驱动 |
| KnowledgeStoreId | string | 产品整体知识库 Id | 否 | null | — | FK→知识库模块 |
| OwnerIds | string[] | 产品负责人（可多人，可为空＝待认领） | 否 | [] | — | FK→用户；运行时 SSOT |
| OwnerName | string | 负责人展示名（多人「、」拼接） | 否 | null | — | 反规范化冗余 |
| MemberIds | string[] | 产品成员 | 否 | [] | — | FK→用户 |
| AdminIds | string[] | 产品管理员（不变量：AdminIds ⊆ MemberIds） | 否 | [] | — | FK→用户 |
| VersionCount | int | 版本数 | 否 | 0 | — | 反规范化计数 |
| RequirementCount | int | 需求数 | 否 | 0 | — | 反规范化计数 |
| FeatureCount | int | 功能数 | 否 | 0 | — | 反规范化计数 |
| DefectCount | int | 缺陷数 | 否 | 0 | — | 反规范化计数 |
| CreatedAt / UpdatedAt | datetime | 审计时间 | 是 | now | — | — |
| IsDeleted | bool | 软删除 | 是 | false | — | 索引 |

> 索引建议：`{OwnerIds:1, IsDeleted:1, UpdatedAt:-1}`、`{MemberIds:1}`。
> 移除：旧 `OwnerId`（单负责人冗余字段）合并进 `OwnerIds`，不再单列。

### 4.2 通用版本 ProductVersion（集合 `product_versions`）

承载版本演进链与需求/功能版本关联（与 4.3/4.4 的 T/V 双轨并存：双轨管「立项-上线」流程，本实体管「版本演进 + 关联关系」）。

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| ProductId | string | 所属产品 | 是 | — | — | FK→products；索引 |
| VersionName | string | 版本名（如 v2.0 / 2026Q1） | 是 | — | — | — |
| Description | text | 版本目标/描述 | 否 | null | — | — |
| IsMajor | bool | 是否大版本（大版本走升级申请） | 否 | false | — | — |
| ParentVersionId | string | 父版本（演进链） | 否 | null | — | FK 自引用 |
| Lifecycle | enum | 版本生命周期 | 是 | `planning` | planning/developing/testing/released/deprecated | 绑定工作流后由 CurrentState 接管 |
| CurrentState | string | 当前状态 Key | 否 | null | — | — |
| PlannedReleaseAt | datetime | 计划发布时间 | 否 | null | — | — |
| ReleasedAt | datetime | 实际发布时间 | 否 | null | — | — |
| RequirementIds | string[] | 关联需求（N:N） | 否 | [] | — | FK→requirements |
| FeatureVersionIds | string[] | 包含的功能版本（N:N） | 否 | [] | — | FK→feature_versions |
| KnowledgeStoreId | string | 版本知识库（含 MRD/SRS/PRD） | 否 | null | — | FK→知识库模块 |
| TemplateId / WorkflowDefId | string | 表单/工作流绑定 | 否 | null | — | — |
| FormData | map<string,string> | 自定义表单值 | 否 | {} | — | — |
| OwnerId | string | 负责人 | 否 | "" | — | FK→用户 |
| SourceSystem / ExternalId | string | 历史导入来源 / 外部唯一 ID（幂等） | 否 | null | — | 导入去重 |

> 索引建议：`{ProductId:1, IsDeleted:1}`。

### 4.3 立项 ProductInitiation（T 轨，集合 `product_initiations`）

内部版本/立项：立项登记 + **人工三稿评审**（原 Agent 自动评审已改人工录入）。

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| ProductId | string | 所属产品 | 是 | — | — | FK→products |
| LinkedProductId | string | 关联的产品目录条目 | 否 | null | — | FK→products |
| TCode | string | 立项编号 `T{a}.{b}.{c}`（全库全局递增） | 否 | 系统生成 | — | 见第九章 |
| PlanName | string | 方案名称 | 是 | "" | — | — |
| RequirementDescription | text | 需求描述 | 否 | null | — | — |
| ProjectType | string | 项目类型 | 是 | `standard` | standard 等（可配置） | — |
| VersionType | string | 版本类型 | 是 | `minor` | major/minor 等 | — |
| CustomerSource | string | 客户来源 | 否 | null | — | — |
| DepartmentName | string | 部门名称 | 否 | null | — | — |
| PlanUrl | string | 方案链接 | 否 | null | — | — |
| RequirementIds | string[] | 关联需求 | 否 | [] | — | FK→requirements |
| Status | string | 立项状态 | 是 | `draft` | draft/... | 绑定工作流后由 CurrentState 接管 |
| **ReviewScore** | int | 评审分数（**人工录入**，原 Agent 评分改人工） | 否 | null | 0–100 | 见第十一章 |
| **ReviewPassed** | bool | 评审是否通过（**人工**） | 否 | null | — | — |
| ReviewComment | text | 评审意见（**人工**，新增替代 Agent 评语） | 否 | null | — | — |
| ReviewMeetingRequired | bool | 是否需开评审会 | 否 | null | — | — |
| MeetingDraftCount | int | 计划稿次总数 | 否 | null | 1–3 | — |
| MeetingDraftRounds | object[] | 线下评审会各稿次结果（见 4.3a） | 否 | [] | — | 人工回填 |
| FirstDraftMeetingAt / SecondDraftMeetingAt / ThirdDraftMeetingAt | datetime | 各稿会议时间 | 否 | null | — | — |
| ProjectAt / PlannedProjectAt | datetime | 立项时间 / 计划立项时间 | 否 | null | — | — |
| NeedUiDesign | bool | 是否需 UI 设计 | 否 | null | — | — |
| DevelopmentStatus | string | 开发状态 | 是 | `待开发` | 待开发/... | — |
| PrimaryOwnerId | string | 主负责人 | 否 | null | — | FK→用户 |
| ApprovalComment | text | 审批意见 | 否 | null | — | — |
| Remark | text | 备注 | 否 | null | — | — |
| CreatedBy | string | 创建人 | 是 | — | — | FK→用户 |
| SourceType | string | 来源类型 | 是 | `system` | — | — |
| LegacyData | map<string,string> | 历史遗留字段 | 否 | {} | — | 导入兜底 |

**移除（AI）**：`ReviewSubmissionId`（对接 review-agent）、`ReviewAttempts`（Agent 评审尝试记录）、`IsAiPoc`（如确为业务属性可保留为「是否 AI 项目」普通 bool，默认移除）。

#### 4.3a 立项评审会稿次 InitiationMeetingDraftRound（内嵌）

| 字段 | 类型 | 含义 | 必填 | 默认 | 备注 |
|---|---|---|---|---|---|
| Round | int | 稿次轮数 | 是 | 0 | 1/2/3 |
| HeldAt | datetime | 召开时间 | 否 | null | — |
| Passed | bool | 是否通过 | 否 | null | — |
| Notes | text | 评审记录 | 否 | null | — |

### 4.4 上线 ProductRelease（V 轨，集合 `product_releases`）

正式版本/上线：绑定已批准立项申领 V 号 + 功能清单 manifest + 上线公告。

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| ProductId | string | 所属产品 | 是 | — | — | FK→products |
| InitiationId | string | 关联立项 | 否 | null | — | FK→product_initiations |
| TCode | string | 立项编号（冗余） | 否 | null | — | — |
| VCode | string | 正式版本编号 `V{a}.{b}.{c}`（全局递增） | 是 | 系统生成 | — | 见第九章 |
| PlanName | string | 方案名称 | 是 | "" | — | — |
| ProjectType / VersionType | string | 项目/版本类型 | 是 | standard / minor | — | — |
| IsTemporaryOptimization | bool | 是否临时优化 | 否 | false | — | — |
| PlanUrl | string | 方案链接 | 否 | null | — | — |
| DepartmentName | string | 部门名称 | 否 | null | — | — |
| OwnerId | string | 负责人 | 否 | null | — | FK→用户 |
| OpenBrandScope | string | 开放品牌范围 | 是 | `上线全域开放` | — | — |
| RequirementIds | string[] | 关联需求 | 否 | [] | — | FK→requirements |
| TeamMemberIds | string[] | 团队成员 | 否 | [] | — | FK→用户 |
| PlannedReleaseAt / ReleasedAt | datetime | 计划/实际发布时间 | 否 | null | — | — |
| AnnouncementUrl | string | 上线公告链接 | 否 | null | — | — |
| Status | string | 上线状态 | 是 | `announcement_pending` | — | — |
| PreviousReleaseId | string | 上一正式版本（继承来源） | 否 | null | — | FK 自引用 |
| FeatureManifest | object[] | 功能清单（相对上版变更，见 4.4a） | 否 | [] | — | — |
| CreatedBy / SourceType / LegacyData | — | 同立项 | — | — | — | — |

#### 4.4a 功能清单条目 ReleaseFeatureItem（内嵌）

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 备注 |
|---|---|---|---|---|---|---|
| FeatureId | string | 关联功能 | 是 | "" | — | FK→features |
| ChangeType | enum | 相对上版变更类型 | 是 | `unchanged` | added/modified/deprecated/unchanged | — |
| ChangeNote | text | 变更说明 | 否 | null | — | — |

### 4.5 需求 Requirement（集合 `requirements`）

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| ProductId | string | 所属产品 | 是 | — | — | FK→products；索引 |
| RequirementNo | string | 需求 ID（纯数字全局递增，可保留外部 TAPD ID） | 是 | 系统生成 | — | 见第九章 |
| Title | string | 需求标题 | 是 | "" | — | — |
| Description | richtext | 需求描述/背景 | 否 | null | — | 富文本需 XSS 净化 |
| Grade | string | 需求分级（存 `ProductGradeOption` 优先级项） | 是 | `p2` | p0/p1/p2/p3（可配置） | — |
| ParentId | string | 父需求（分解层级） | 否 | null | — | FK 自引用 |
| CustomerIds | string[] | 关联客户（N:N） | 否 | [] | — | FK→customers；索引 |
| VersionIds | string[] | 关联版本（N:N，与版本 RequirementIds 双向） | 否 | [] | — | FK→product_versions；索引 |
| CurrentState | string | 当前状态 Key | 否 | null | — | — |
| TemplateId / WorkflowDefId | string | 表单/工作流绑定 | 否 | null | — | — |
| FormData | map<string,string> | 自定义表单值（含「需求类型」「需求来源」「产品缺陷」等） | 否 | {} | — | — |
| OwnerId | string | 负责人 | 否 | "" | — | FK→用户 |
| AssigneeId | string | 处理人 | 否 | null | — | FK→用户 |
| SourceDefectId | string | 来源缺陷（缺陷转需求溯源） | 否 | null | — | FK→defects |
| SourceSystem | string | 外部来源标识（rtf/csv/defect） | 否 | null | — | 导入溯源 |
| ExternalId | string | 外部需求 ID（导入幂等键） | 否 | null | — | 导入去重 |
| SourceUrl | string | 外部详情链接 | 否 | null | — | — |
| SourceSnapshot | object | 导入原始字段/人员/评论/时间快照（见 4.5a） | 否 | null | — | 状态中文兜底展示 |
| StateEnteredAt | datetime | 进入当前状态时间（SLA 计算） | 否 | null | — | — |

> 索引建议：`{ProductId:1, IsDeleted:1}`、`{VersionIds:1}`、`{CustomerIds:1}`。
> 需求来源（FormData）取值：客户反馈 / 内部规划 / 运营活动 / 竞品调研 / 其他（联动补充字段）。需求类型见 4.12。

#### 4.5a 需求导入快照 RequirementSourceSnapshot（内嵌，导入兜底）

| 字段 | 类型 | 含义 | 必填 | 默认 | 备注 |
|---|---|---|---|---|---|
| Status / Priority | string | 来源状态/优先级原文 | 否 | "" | 中文兜底 |
| Fields | map<string,string> | 来源原始字段 | 否 | {} | — |
| HandlerNames / DeveloperNames / CreatorNames / CcNames | string[] | 处理/开发/创建/抄送人姓名（快照非 ID） | 否 | [] | — |
| Comments | object[] | 来源评论（Author/Title/Content/CreatedAt） | 否 | [] | — |
| AttachmentIds | string[] | 附件 ID | 否 | [] | — |
| SourceCreatedAt / SourceModifiedAt / SourceCompletedAt | datetime | 来源时间 | 否 | null | — |
| ImportedFileName / ImportBatchId | string | 导入文件名/批次 | 否 | "" | — |
| ImportedAt | datetime | 导入时间 | 否 | now | — |

### 4.6 功能 Feature（集合 `features`）

持久跨版本实体。

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| ProductId | string | 所属产品 | 是 | — | — | FK→products；索引 |
| FeatureNo | string | 功能编号（正式版本清单内纯数字递增） | 是 | 系统生成 | — | 作用域见 OfficialReleaseId |
| Title | string | 功能名称 | 是 | "" | — | — |
| Description | richtext | 功能描述 | 否 | null | — | — |
| ModuleName | string | 所属功能模块/能力域 | 是 | "" | — | — |
| FeatureType | enum | 业务价值分类 | 是 | `basic` | basic/core/value_added | — |
| MainRequirementId | string | 主需求 | 是 | "" | — | FK→requirements |
| PlannedVersionId | string | 计划交付的版本 | 是 | "" | — | FK→product_versions |
| OfficialReleaseId | string | 正式上线记录（上线后回写） | 否 | null | — | FK→product_releases |
| KeyRules | text | 核心业务规则/边界 | 否 | "" | — | — |
| AcceptanceCriteria | text | 交付完成判定标准 | 否 | "" | — | — |
| Remark | text | 例外说明 | 否 | null | — | — |
| Grade | string | 功能分级 | 是 | `p2` | p0/p1/p2/p3 | — |
| ParentId | string | 父功能（模块分解层级） | 否 | null | — | FK 自引用 |
| StructureNodeId | string | 挂载的产品结构节点（功能骨架树，空=未归类） | 否 | null | — | FK→product_structure_nodes |
| RequirementIds | string[] | 实现的需求（N:N） | 否 | [] | — | FK→requirements |
| CurrentState | string | 当前状态 Key | 否 | null | — | — |
| TemplateId / WorkflowDefId | string | 表单/工作流绑定 | 否 | null | — | — |
| FormData | map<string,string> | 自定义表单值 | 否 | {} | — | — |
| OwnerId / AssigneeId | string | 负责人 / 处理人 | 否 | "" / null | — | FK→用户 |
| SourceSystem / ExternalId | string | 导入来源 / 外部唯一 ID | 否 | null | — | 导入去重 |
| StateEnteredAt | datetime | 进入当前状态时间（SLA） | 否 | null | — | — |

> 索引建议：`{ProductId:1, IsDeleted:1}`。

#### 4.6a 功能版本化 FeatureVersion（集合 `feature_versions`）

功能在某版本下的快照/变更。

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| ProductId | string | 所属产品 | 是 | — | — | FK→products |
| FeatureId | string | 关联功能 | 是 | "" | — | FK→features；索引 |
| VersionId | string | 关联产品版本 | 是 | "" | — | FK→product_versions；索引 |
| FeatureVersionLabel | string | 功能自身版本标签（如 1.2） | 否 | null | — | 区别于产品版本 |
| ChangeType | enum | 变更类型 | 是 | `added` | added/modified/deprecated | — |
| ChangeNote | text | 本版本变更说明 | 否 | null | — | — |
| CurrentState | string | 当前状态 Key | 否 | null | — | — |

> 索引建议：`{ProductId:1, FeatureId:1}`、`{VersionId:1}`。

### 4.7 缺陷 Defect（一等对象，集合 `defects`）— 本次重建重点

> 参考 TAPD 缺陷重建。**剔除原 defect-agent 的 AI 审核链路**（draft/reviewing/awaiting 等 AI 态、AI 字段提取、AI 自动解决、Vision 截图分析）。缺陷的 TAPD 扩展字段（公司/商户/影响范围等）统一走**表单引擎 FormData**（默认缺陷表单模板 = 第十章 TAPD 字段集），核心字段则单列为强类型字段。

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| Id | string | 主键 | 是 | UUID | — | PK |
| DefectNo | string | 缺陷 ID（纯数字全局递增，可保留外部 TAPD ID） | 是 | 系统生成 | — | 唯一 |
| ProductId | string | 所属产品 | 是 | — | — | FK→products；索引 |
| Title | string | 缺陷标题（**人工填写**，原 AI 提取删除） | 是 | "" | — | — |
| Description | richtext | 缺陷描述 | 否 | null | — | XSS 净化 |
| ReproSteps | richtext | 复现步骤 | 否 | null | — | TAPD 风格 |
| ExpectedResult | text | 期望结果 | 否 | null | — | — |
| ActualResult | text | 实际结果 | 否 | null | — | — |
| Severity | enum | 严重程度（四档，TAPD 对齐） | 否 | null | 致命/严重/一般/轻微 | 可配置目录 4.11 |
| Grade | string | 优先级（与严重度独立） | 否 | null | p0/p1/p2/p3 | 可配置 |
| DefectDivision | enum | 缺陷划分 | 否 | `缺陷` | 缺陷 / 非产品缺陷 | 非产品缺陷可转需求 |
| Status | string | 缺陷状态 | 是 | `new` | 见 4.7 工作流 | 绑定工作流后由 CurrentState 接管 |
| CurrentState | string | 当前状态 Key | 否 | `new` | — | — |
| WorkflowDefId | string | 绑定工作流定义 | 否 | `wf-default-defect` | — | — |
| TemplateId | string | 绑定缺陷表单模板 | 否 | null | — | FK→product_form_templates |
| FormData | map<string,string> | TAPD 扩展字段载体（公司/商户/影响范围…见第十章） | 否 | {} | — | 表单引擎驱动 |
| ReporterId | string | 创建人/报告人 | 是 | "" | — | FK→用户 |
| ReporterName | string | 报告人显示名 | 否 | null | — | 冗余 |
| AssigneeId | string | 处理人 | 否 | null | — | FK→用户；索引 |
| AssigneeName | string | 处理人显示名 | 否 | null | — | 冗余 |
| ResponsibleId | string | 责任人（TAPD 责任人） | 否 | null | — | FK→用户 |
| FeedbackPerson | string | 反馈人（外部反馈，自由文本/用户） | 否 | null | — | — |
| Resolution | text | 解决说明 | 否 | null | — | — |
| ResolvedById | string | 解决人 | 否 | null | — | FK→用户 |
| RejectReason | text | 拒绝原因 | 否 | null | — | — |
| RejectedById | string | 拒绝人 | 否 | null | — | FK→用户 |
| VerifiedById | string | 验收人 | 否 | null | — | FK→用户 |
| VerifyFailReason | text | 验收不通过原因 | 否 | null | — | — |
| CreatedAt | datetime | 创建时间 | 是 | now | — | — |
| IssueStartTime | datetime | 问题开始时间 | 否 | null | — | TAPD |
| FeedbackTime | datetime | 反馈时间 | 否 | null | — | TAPD |
| DueAt | datetime | 预计结束时间 | 否 | null | — | TAPD |
| SubmittedAt / ResolvedAt / ClosedAt / VerifiedAt | datetime | 提交/解决/关闭/验收时间 | 否 | null | — | — |
| Overdue | bool | 是否逾期 | 否 | null | — | 可由 DueAt 推断 |
| ValidReport | bool | 是否有效报告 | 否 | null | — | TAPD |
| IsHistorical | bool | 是否历史问题 | 否 | null | — | TAPD |
| TimelyFixed | bool | 是否及时处理 | 否 | null | — | TAPD |
| UrlLink | string | 相关 URL | 否 | null | — | TAPD |
| CompanyName | string | 公司名称 | 否 | null | — | TAPD 业务归因 |
| MerchantNo | string | 商户编号 | 否 | null | — | TAPD |
| IntroducedProject | string | 引入项目 | 否 | null | — | TAPD |
| ImpactScope | text | 影响范围 | 否 | null | — | TAPD |
| StructureParent | string | 结构归母 | 否 | null | — | TAPD |
| LogicAttribution | text | 逻辑归因 | 否 | null | — | TAPD |
| TracedRequirementId | string | 追溯到的需求 | 否 | null | — | FK→requirements |
| TracedVersionId | string | 追溯到的版本 | 否 | null | — | FK→product_versions |
| TracedFeatureId | string | 追溯到的功能 | 否 | null | — | FK→features |
| Attachments | object[] | 附件（见 4.7a） | 否 | [] | — | — |
| Versions | object[] | 缺陷版本历史（见 4.7b） | 否 | [] | — | — |
| SourceSystem / ExternalId | string | 导入来源 / 外部 ID | 否 | null | — | 导入去重 |
| FolderId | string | 所属文件夹（null=未分类） | 否 | null | — | FK→缺陷文件夹（可选） |

> 索引建议：`{ProductId:1, IsDeleted:1}`、`{AssigneeId:1, Status:1}`、`{TracedRequirementId:1}`。
> **TAPD 详情右侧属性栏展示顺序**（25 项，与 TAPD 查看页一致）见第十章 SidebarFieldKeys。
> 注：`TracedProductId` 即 `ProductId`（一等对象后产品归属直接落字段，无需独立追溯字段）。

**移除（AI）**：`RawContent`（AI 输入原文）、`StructuredData` 作为「AI 提取载体」的语义（改为表单引擎 FormData）、`MissingFields`（AI 缺失判定）、`IsAiResolved` / `ResolvedByAgentName`（AI 自动解决）、`TemplateId` 关联的 `AiSystemPrompt` / `AiPrompt`（AI 审核提示词）、`DefectMessage` 的 `Source=ai` / `AgentName` / `ExtractedFields`、`DefectAttachment.Description`（Vision 分析）。

#### 4.7a 缺陷附件 DefectAttachment（内嵌）

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 备注 |
|---|---|---|---|---|---|---|
| Id | string | 附件 ID | 是 | UUID | — | — |
| FileName | string | 文件名 | 是 | "" | — | — |
| FileSize | int | 文件大小（字节） | 是 | 0 | — | — |
| MimeType | string | MIME 类型 | 是 | "" | — | — |
| Url | string | 存储 URL | 是 | "" | — | — |
| ThumbnailUrl | string | 缩略图 URL | 否 | null | — | 图片类型 |
| UploadedAt | datetime | 上传时间 | 是 | now | — | — |
| Type | enum | 附件类型 | 是 | `file` | file/screenshot | 移除 log-request/log-error（AI 诊断产物） |

#### 4.7b 缺陷版本历史 DefectVersion（内嵌）

| 字段 | 类型 | 含义 | 必填 | 默认 | 备注 |
|---|---|---|---|---|---|
| Version | int | 版本号 | 是 | 0 | — |
| Title | string | 标题快照 | 否 | null | — |
| Snapshot | map<string,string> | 字段快照 | 否 | {} | 替代原 StructuredData |
| ModifiedBy / ModifiedByName | string | 修改人 / 名 | 是 | "" | FK→用户 |
| ModifiedAt | datetime | 修改时间 | 是 | now | — |
| ChangeNote | text | 修改说明 | 否 | null | — |

> 缺陷评论统一走 `ProductItemActivity`（EntityType=`defect`），不再单建 `DefectMessage`（其 AI 对话语义已删）。

### 4.8 客户 Customer（集合 `customers`，全局共享）

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| Name | string | 客户名称 | 是 | "" | — | — |
| Code | string | 客户短码 | 否 | null | — | — |
| Company | string | 所属公司/组织 | 否 | null | — | — |
| Contact | string | 联系方式（自由文本） | 否 | null | — | — |
| Description | text | 客户描述/备注 | 否 | null | — | — |
| Tags | string[] | 标签（行业/等级/来源） | 否 | [] | — | 标签非 ID |
| TemplateId | string | 表单模板 | 否 | null | — | — |
| FormData | map<string,string> | 自定义表单值 | 否 | {} | — | — |
| MerchantNo | string | 商户编号 | 否 | null | — | — |
| ShortName | string | 商户简称 | 否 | null | — | — |
| Status | string | 商户状态（正常/停用） | 否 | null | — | — |
| CertStatus | string | 认证状态 | 否 | null | 未认证/已认证/认证失败 | — |
| Region / Industry | string | 区域 / 行业 | 否 | null | — | — |
| OpenedAt / ExpireAt | datetime | 开户 / 过期时间 | 否 | null | — | — |
| OwnerId | string | 负责人 | 否 | "" | — | FK→用户 |

> 移除：旧 `ProductId`（客户已全局化，不再按产品绑定）。
> 移除（AI）：**营销问策**模块整体删除（原为客户维度的 AI 评估 + HTML 报告生成）。

#### 4.8a 客户跟进 CustomerFollowUp（集合 `customer_follow_ups`）

| 字段 | 类型 | 含义 | 必填 | 默认 | 备注 |
|---|---|---|---|---|---|
| CustomerId | string | 所属客户 | 是 | "" | FK→customers；索引 |
| Content | richtext | 跟进内容 | 是 | "" | — |
| CreatedByUserId | string | 创建人 | 是 | "" | FK→用户 |
| CreatedByName | string | 创建人显示名 | 否 | null | 冗余 |

### 4.9 大版本升级申请 VersionUpgradeRequest（集合 `version_upgrade_requests`）

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| ProductId | string | 所属产品 | 是 | — | — | FK→products |
| UpgradeNo | string | 申请编号（如 `UPG-2026-0001`） | 是 | 系统生成 | — | — |
| Title | string | 申请标题 | 是 | "" | — | — |
| Reason | text | 升级理由/背景 | 否 | null | — | — |
| FromVersionId | string | 源版本 | 否 | null | — | FK→product_versions |
| TargetVersionId | string | 目标版本（已建） | 否 | null | — | FK→product_versions |
| TargetVersionName | string | 目标版本名（未建时先填名） | 否 | null | — | — |
| RequirementIds | string[] | 关联需求 | 否 | [] | — | FK→requirements |
| FeatureIds | string[] | 关联功能 | 否 | [] | — | FK→features |
| KnowledgeEntryIds | string[] | 关联知识条目 | 否 | [] | — | FK→知识库条目 |
| Status | enum | 申请状态 | 是 | `draft` | draft/submitted/approved/rejected | 绑定工作流后由 CurrentState 接管 |
| CurrentState / TemplateId / WorkflowDefId / FormData / OwnerId | — | 同通用 | — | — | — | — |

### 4.10 动态时间线 ProductItemActivity（集合 `product_item_activities`）

所有对象共用的评论 / 流转 / 转交记录。

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| EntityType | string | 对象类型 | 是 | "" | product/version/requirement/feature/defect/customer/upgrade-request | — |
| EntityId | string | 对象 Id | 是 | "" | — | 索引 |
| ProductId | string | 所属产品（鉴权） | 是 | "" | — | — |
| Type | enum | 条目类型 | 是 | `comment` | comment/transition/assign/created/convert | — |
| ActorId | string | 操作人 | 是 | "" | — | FK→用户 |
| ActorName | string | 操作人显示名 | 否 | null | — | 冗余 |
| Content | richtext | 评论内容 | 否 | null | — | 系统活动可空 |
| FromValue / ToValue | string | 变更前/后值 | 否 | null | — | 状态/处理人文本 |
| Mentions | string[] | @提醒用户 | 否 | [] | — | FK→用户 |

---

## 五、通用表单引擎

### 5.1 表单模板 ProductFormTemplate（集合 `product_form_templates`）

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| Name | string | 模板名称 | 是 | "" | — | — |
| Description | text | 模板描述 | 否 | null | — | — |
| EntityType | enum | 适用对象类型 | 是 | `requirement` | product/version/requirement/feature/customer/upgrade-request/defect | — |
| Fields | object[] | 字段定义列表（见 5.2） | 是 | [] | — | 前端按此动态渲染 |
| IsDefault | bool | 是否该类型默认模板 | 否 | false | — | 同 EntityType 应唯一 |
| ProductId | string | 所属产品（空=全局复用） | 否 | null | — | — |
| CreatedBy | string | 创建人 | 是 | "" | — | FK→用户 |

> 索引建议：`{EntityType:1, ProductId:1, IsDeleted:1}`。

### 5.2 字段定义 ProductFormField（内嵌）

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 备注 |
|---|---|---|---|---|---|---|
| Key | string | 字段标识（FormData 的 key，唯一） | 是 | "" | — | 如 `background` |
| Label | string | 字段标签 | 是 | "" | — | 如「需求背景」 |
| Type | enum | 字段类型（决定控件+校验） | 是 | `text` | 见 5.3（13 种） | — |
| Required | bool | 是否必填 | 否 | false | — | — |
| Options | object[] | 可选项（Value/Label/Color） | 否 | null | — | select/multiselect/radio 用 |
| Placeholder | string | 占位提示 | 否 | null | — | — |
| HelpText | string | 字段帮助文案 | 否 | null | — | — |
| DefaultValue | string | 默认值（字符串化，前端按 Type 解析） | 否 | null | — | — |
| RelationEntityType | enum | 关联对象类型（Type=relation 时） | 否 | null | 同 EntityType 枚举 | 弹对应选择器 |
| Min / Max | string | 最小/最大值（数值/日期，字符串化） | 否 | null | — | — |
| SortOrder | int | 排序权重（小的在前） | 否 | 0 | — | — |

### 5.3 字段类型枚举（13 种）

| 值 | 含义 | 配套 |
|---|---|---|
| text | 单行文本 | — |
| textarea | 多行文本 | — |
| number | 数字 | Min/Max |
| select | 单选下拉 | Options |
| multiselect | 多选 | Options |
| radio | 单选按钮 | Options |
| checkbox | 勾选 | — |
| date | 日期 | — |
| datetime | 日期时间 | — |
| user | 选择系统用户 | — |
| relation | 关联其他产品对象 | RelationEntityType |
| richtext | 富文本 | — |
| file | 文件/附件 | — |

---

## 六、通用工作流引擎

### 6.1 工作流定义 ProductWorkflowDefinition（集合 `product_workflow_definitions`）

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 索引/备注 |
|---|---|---|---|---|---|---|
| Name | string | 流程名称 | 是 | "" | — | 如「标准需求流程」 |
| Description | text | 流程描述 | 否 | null | — | — |
| EntityType | enum | 适用对象类型 | 是 | `requirement` | 同 EntityType 枚举 | — |
| States | object[] | 状态节点列表（见 6.2） | 是 | [] | — | — |
| Transitions | object[] | 流转边列表（见 6.3） | 是 | [] | — | — |
| IsDefault | bool | 是否该对象默认流程 | 否 | false | — | — |
| ProductId | string | 所属产品（空=全局） | 否 | null | — | — |
| SeedRevision | int | 内置种子版本（低于代码版本且未自定义则被覆盖） | 否 | 0 | — | — |
| IsUserCustomized | bool | 管理员是否已自定义（true 禁止种子覆盖） | 否 | false | — | — |

> 索引建议：`{EntityType:1, ProductId:1, IsDeleted:1}`。初始状态取 `IsInitial=true` 的，否则取第一个。

### 6.2 状态节点 ProductWorkflowState（内嵌）

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 备注 |
|---|---|---|---|---|---|---|
| Key | string | 状态标识 | 是 | "" | — | 如 `new` |
| Label | string | 状态显示名 | 是 | "" | — | 如「待评审」 |
| Description | text | 状态说明 | 否 | null | — | — |
| Color | string | 状态颜色（CSS） | 否 | null | — | 看板/标签着色 |
| IsInitial | bool | 是否初始状态 | 否 | false | — | — |
| IsFinal | bool | 是否终态 | 否 | false | — | — |
| Category | enum | 看板分组 | 否 | null | todo/doing/done | 空则独立成列 |
| SortOrder | int | 排序 | 否 | 0 | — | — |
| SlaHours | int | SLA 时效（小时，空=不限） | 否 | null | — | 超时判定 |
| WipLimit | int | 看板在制上限（空=不限） | 否 | null | — | 超限告警 |

### 6.3 流转边 ProductWorkflowTransition（内嵌）

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 备注 |
|---|---|---|---|---|---|---|
| Key | string | 流转标识（格式 `{from}-to-{to}`） | 是 | "" | — | — |
| Label | string | 动作显示名（如「到已上线」） | 是 | "" | — | — |
| FromState | string | 源状态 Key（空=任意状态） | 否 | null | — | — |
| ToState | string | 目标状态 Key | 是 | "" | — | — |
| AllowedRoles | string[] | 允许触发角色（空=不限） | 否 | null | owner/creator/assignee/product_admin/member | 见 6.4 |
| RequireComment | bool | 是否需填流转备注 | 否 | false | — | 如驳回原因 |
| AutoAssignToActor | bool | 自动指派处理人给操作人（claim） | 否 | false | — | — |
| RequiredFieldKeys | string[] | 流转前必填字段 Key | 否 | null | title/assigneeId/grade/comment/versionIds/initiationId/releaseId | — |
| LinkEntityType | enum | 跨对象联动目标（缺陷转需求/需求转缺陷） | 否 | null | requirement/defect | — |

### 6.4 流转角色枚举

| 值 | 含义 |
|---|---|
| owner | 负责人 |
| creator | 创建人 |
| assignee | 处理人 |
| product_admin | 产品管理员 |
| member | 成员 |

### 6.5 内置默认工作流（开箱即用真值）

三套默认流程固定 Id，首次访问幂等 upsert；共用 7 个基础状态 + 各自终态。

| 流程 | 固定 Id | 终态补充 | 流转矩阵条数 |
|---|---|---|---|
| 需求 Requirement | `wf-default-requirement` | `to_defect`（转为缺陷，联动建缺陷） | 36 |
| 功能 Feature | `wf-default-feature` | `cancelled`（已下架，仅从「已上线」进入，可重开） | 36 |
| 缺陷 Defect | `wf-default-defect` | `to_requirement`（非产品缺陷，联动建需求） | 36 |

**7 个基础状态（需求/功能/缺陷共用）**：

| Key | Label | Category | Color | 初始/终态 | SLA(h) | WIP | 说明 |
|---|---|---|---|---|---|---|---|
| new | 待评审 | todo | #9ca3af | 初始 | 48 | — | 新提交，待评审 |
| planning | 待规划 | todo | #38bdf8 | — | 48 | — | 评审合理，待排期 |
| status_2 | 已立项 | todo | #60a5fa | — | — | — | 已出方案，待开发 |
| developing | 开发中 | doing | #f59e0b | — | 72 | 8 | 开发中，待上线 |
| resolved | 已上线 | done | #22c55e | 终态 | — | — | 已实现且已上线 |
| rejected | 已拒绝 | done | #ef4444 | 终态 | — | — | 评审认定不合理 |
| status_3 | 已排期 | todo | #a78bfa | — | — | — | 已申请立项，待评审 |

**需求流转矩阵**（from → to[]，`to_defect` 自动加到除「已上线」外的源状态）：

| From | To |
|---|---|
| new | planning, status_2, developing, resolved, rejected, status_3, to_defect |
| planning | new, status_2, developing, resolved, rejected, status_3, to_defect |
| status_2 | planning, developing, resolved, rejected, to_defect |
| developing | planning, status_2, resolved, rejected, to_defect |
| resolved | planning, status_2, developing, rejected |
| rejected | new, planning, to_defect |
| status_3 | status_2, developing, resolved, rejected, to_defect |

> 功能矩阵 = 需求矩阵剔除全部 `to_defect`，`resolved` 追加 `cancelled`，`cancelled → new/planning/status_2/developing/status_3`。
> 缺陷矩阵 = 需求矩阵剔除全部 `to_defect`，对应源状态追加 `to_requirement`。

**流转边内置默认**：

| 目标状态 | RequireComment | AutoAssign(claim) | AllowedRoles | RequiredFields | Link |
|---|---|---|---|---|---|
| resolved | — | — | product_admin, owner | — | — |
| status_3 | — | — | — | versionIds | — |
| developing | — | true | — | — | — |
| rejected | true | — | — | — | — |
| to_defect | true | — | — | — | defect |
| cancelled | true | — | — | — | — |
| to_requirement | true | — | — | — | requirement |

### 6.6 旧状态迁移映射（导入兜底）

| 来源 | 旧 Key → 新 Key |
|---|---|
| 需求 | pending→new, reviewed→planning, developing→developing, testing→developing, done→resolved, rejected→rejected |
| 功能 | planned→new, testing→developing, released→resolved, cancelled→cancelled |
| 缺陷（旧 defect-agent） | draft/reviewing/awaiting/submitted→new, assigned→planning, processing/verifying→developing, resolved→resolved, rejected/closed→rejected |

CSV/RTF 导入额外支持中文「已实现/已完成」→ resolved。

---

## 七、可配置目录

### 7.1 等级目录 ProductGradeOption（集合 `product_grade_options`）

统一管理「优先级」与「严重程度」两维度，按对象类型各一套。

| 字段 | 类型 | 含义 | 必填 | 默认 | 枚举/取值 | 备注 |
|---|---|---|---|---|---|---|
| Dimension | enum | 维度 | 是 | "" | priority / severity | — |
| EntityType | enum | 对象类型 | 是 | "" | requirement / feature / defect | — |
| Name | string | 等级名称 | 是 | "" | — | 如「P0 紧急」「致命」 |
| Color | string | 展示色 | 是 | `#60A5FA` | hex | — |
| Definition | text | 等级定义（**人工参考说明**，原「供 AI 识别」改人工） | 否 | "" | — | — |
| SortOrder | int | 排序 | 否 | 0 | — | — |
| IsBuiltin | bool | 是否内置（可改不可删） | 否 | false | — | — |

**内置默认项**：

| 维度 | 内置项（Name / 摘要） |
|---|---|
| priority | P0 紧急（立即处理，阻塞其他）/ P1 高（当前迭代优先）/ P2 中（常规排期）/ P3 低（后续迭代） |
| severity | 致命（崩溃/数据丢失）/ 严重（主功能受阻无绕行）/ 一般（局部异常有绕行）/ 轻微（细节瑕疵） |

### 7.2 需求类型目录 RequirementType（集合 `requirement_types`）

| 字段 | 类型 | 含义 | 必填 | 默认 | 备注 |
|---|---|---|---|---|---|
| Name | string | 类型名称（写入 `Requirement.FormData["需求类型"]`） | 是 | "" | — |
| Definition | text | 类型定义（人工参考） | 否 | "" | — |
| SortOrder | int | 排序 | 否 | 0 | — |
| IsBuiltin | bool | 是否内置 | 否 | false | — |

**内置 5 项**：新增功能 / 功能优化 / 性能优化 / 交互优化 / 其他。

### 7.3 产品类型目录 ProductCategory（集合 `product_categories`）

替代写死的产品分级枚举，`Product.Grade` 存本实体 Id。

| 字段 | 类型 | 含义 | 必填 | 默认 | 备注 |
|---|---|---|---|---|---|
| Name | string | 类型名称 | 是 | "" | 如「核心」 |
| Color | string | 展示色 | 是 | `#9ca3af` | — |
| NoPrefix | string | 产品编号前缀（如 SYS，空则按名推断） | 否 | null | 编号规则用 |
| SortOrder | int | 排序 | 否 | 0 | — |
| IsBuiltin | bool | 是否内置 | 否 | false | — |

**内置 4 项**：core 核心 / important 重要 / normal 普通 / experimental 实验。

### 7.4 描述模板 ProductDescTemplate（集合 `product_desc_templates`）

详情描述区可一键套用的富文本骨架（区别于表单字段集合）。

| 字段 | 类型 | 含义 | 必填 | 默认 | 备注 |
|---|---|---|---|---|---|
| EntityType | enum | 适用对象类型 | 是 | "" | 同 EntityType 枚举 |
| Name | string | 模板名称（如「用户故事」） | 是 | "" | — |
| Content | richtext | 模板内容（HTML 骨架） | 是 | "" | — |
| SortOrder | int | 排序 | 否 | 0 | — |
| CreatedBy | string | 创建人 | 是 | "" | FK→用户 |

### 7.5 产品结构节点 ProductStructureNode（集合 `product_structure_nodes`）

功能骨架树（功能挂载点）。

| 字段 | 类型 | 含义 | 必填 | 默认 | 备注 |
|---|---|---|---|---|---|
| ProductId | string | 所属产品 | 是 | — | FK→products |
| ParentId | string | 父节点（空=根） | 否 | null | FK 自引用 |
| Name | string | 节点名称 | 是 | "" | — |
| SortOrder | int | 排序 | 否 | 0 | — |

### 7.6 应用级设置 ProductAgentSettings（单例 `product_agent_settings`）

| 字段 | 类型 | 含义 | 必填 | 默认 | 备注 |
|---|---|---|---|---|---|
| Id | string | 固定单例 Id | 是 | `product-agent-settings` | — |
| AdminIds | string[] | 应用管理员 | 否 | [] | FK→用户 |
| UpdatedBy | string | 更新人 | 否 | "" | — |

---

## 八、知识库挂载（待新仓库决策）

现状复用平台 `DocumentStore`（产品挂整体库、版本挂版本库，MRD/SRS/PRD 以文档标签分型）。新仓库无 DocumentStore，需二选一：

- **方案 A（推荐）**：新仓库接入/自建一个轻量「文档/知识库模块」，本系统仅保留挂载关系字段（`Product.KnowledgeStoreId` / `ProductVersion.KnowledgeStoreId` / `VersionUpgradeRequest.KnowledgeEntryIds`），文档增删改查走该模块。
- **方案 B**：暂以「外链 URL」承载知识库（知识库字段降级为链接列表），不内建文档引擎。

> 此处需你拍板（见文末「待确认」）。本文档其余部分不依赖该决策。

知识库内容分型（标签）建议保留：MRD / SRS / PRD / 设计稿 / 会议纪要 / 测试用例。

---

## 九、编号规则

| 对象 | 规则 | 示例 |
|---|---|---|
| 产品 ProductNo | 类型前缀（ProductCategory.NoPrefix）+ 全局序号 | `SYS-1007157` |
| 需求 RequirementNo | 纯数字全局递增，导入保留外部 TAPD ID | `1056321` |
| 缺陷 DefectNo | 纯数字全局递增，导入保留外部 TAPD ID | `1098765` |
| 功能 FeatureNo | 正式版本清单内纯数字递增（作用域 = OfficialReleaseId） | `12` |
| 立项 TCode | `T{a}.{b}.{c}` 全库全局递增（与产品无关） | `T2.13.5` |
| 上线 VCode | `V{a}.{b}.{c}` 全库全局递增 | `V3.1.0` |
| 升级申请 UpgradeNo | `UPG-{年}-{序号}` | `UPG-2026-0001` |

> 导入幂等：同一 `SourceSystem + ExternalId` 重复导入为**更新**而非新建。

---

## 十、TAPD 缺陷字段集（默认缺陷表单模板）

> 来源 TAPD 缺陷字段目录。一等对象 Defect 的**核心字段**已强类型化（见 4.7），下列**扩展字段**进默认缺陷表单模板 `FormData`，与 TAPD 查看页右侧属性栏一致。

**详情页右侧属性栏展示顺序（SidebarFieldKeys，25 项）**：

```
缺陷ID → 状态 → 处理人 → 创建人 → 创建时间 → 严重程度 → 缺陷划分 → 责任人 →
是否逾期 → 有效报告 → 反馈人 → 公司名称 → 商户编号 → 引入项目 → 反馈时间 →
影响范围 → 结构归母 → 逻辑归因 → 问题开始时间 → 预计结束时间 → 解决时间 →
关闭时间 → URL链接 → 是否历史问题 → 及时处理
```

**严重程度映射（TAPD 五档 → 本系统四档）**：

| TAPD 原文 | → 本系统 |
|---|---|
| 紧急 | 致命 |
| 高 | 严重 |
| 中 | 一般 |
| 低 / 无关紧要 | 轻微 |

> 导入时把映射后等级写入 `Severity`，TAPD 原文镜像保留到 `FormData["TAPD严重程度"]` 以便回溯。
> 缺陷划分 `DefectDivision`（缺陷 / 非产品缺陷）与工作流终态 `to_requirement` 联动：判定为「非产品缺陷」时可转回需求池。

---

## 十一、移除的 AI 能力清单（含人工替代）

| # | 原 AI 能力 | 处理 | 人工替代 |
|---|---|---|---|
| 1 | 营销问策（客户维度 AI 评估 + HTML 报告 + 分享） | 整块删除 | 无（功能下线） |
| 2 | 需求 AI 智能填充（SSE） | 删除 | 手填 + 描述模板（ProductDescTemplate）一键套用 |
| 3 | 立项 Agent 评审打分（对接 review-agent） | 删除 | 人工录入 `ReviewScore` / `ReviewPassed` / `ReviewComment` + 线下三稿评审会记录 |
| 4 | 图谱追溯关系分析（relation-analysis SSE） | 删除 AI 分析 | 图谱保留**纯可视化**（节点+边+追溯链高亮，无 AI 解读） |
| 5 | AI 助手面板（ProductAssistantPanel） | 删除 | 无 |
| 6 | 对象 AI 摘要缓存（ProductItemSummary 实体） | 删除整实体 | 无（看详情原文） |
| 7 | 缺陷 AI 审核对话 / 字段提取（DefectMessage AI、MissingFields、StructuredData 提取） | 删除 | 人工填表（缺陷表单引擎）+ 普通评论（ProductItemActivity） |
| 8 | 缺陷 AI 自动解决（IsAiResolved / Agent） | 删除 | 人工解决 |
| 9 | 截图 Vision 分析（DefectAttachment.Description） | 删除 | 附件仅存储，不分析 |
| 10 | 等级/类型 Definition「供 AI 识别」 | 字段保留，语义改人工参考 | 人工填说明 |

> 连带删除的状态：缺陷工作流的 `draft` / `reviewing` / `awaiting`（AI 审核态）不再使用，缺陷初始态统一为 `new`。

---

## 十二、权限模型

| 角色 | 能力 |
|---|---|
| 应用管理员（ProductAgentSettings.AdminIds / 平台 admin） | 全产品可见、历史导入、应用配置 |
| 产品负责人（Product.OwnerIds） | 删产品、指派产品管理员、成员管理 |
| 产品管理员（Product.AdminIds） | 增删普通成员 |
| 产品成员（Product.MemberIds） | 访问单产品数据、参与流转 |

**权限点（3 级）**：`product.use`（使用）/ `product.manage`（模板/流程/目录管理、删除）/ `product.admin`（应用级配置、历史导入）。
工作流流转按 `AllowedRoles`（owner/creator/assignee/product_admin/member）+ 多负责人 `IsProductOwner` 逻辑校验。

---

## 十三、数据集合清单与索引建议（DBA）

> 按「应用不自动建索引」规范，索引登记给 DBA 手动建。

| 集合 | 用途 | 建议索引 |
|---|---|---|
| products | 产品 | `{OwnerIds:1,IsDeleted:1,UpdatedAt:-1}`、`{MemberIds:1}`、`{AdminIds:1}` |
| product_versions | 通用版本 | `{ProductId:1,IsDeleted:1}` |
| product_initiations | 立项 T | `{ProductId:1,IsDeleted:1}`、`{TCode:1}` |
| product_releases | 上线 V | `{ProductId:1,IsDeleted:1}`、`{VCode:1}` |
| requirements | 需求 | `{ProductId:1,IsDeleted:1}`、`{VersionIds:1}`、`{CustomerIds:1}` |
| features | 功能 | `{ProductId:1,IsDeleted:1}` |
| feature_versions | 功能版本 | `{ProductId:1,FeatureId:1}`、`{VersionId:1}` |
| defects | 缺陷 | `{ProductId:1,IsDeleted:1}`、`{AssigneeId:1,Status:1}`、`{TracedRequirementId:1}` |
| customers | 客户 | `{IsDeleted:1}`、`{Name:1}` |
| customer_follow_ups | 客户跟进 | `{CustomerId:1,CreatedAt:-1}` |
| version_upgrade_requests | 升级申请 | `{ProductId:1,IsDeleted:1}` |
| product_item_activities | 动态时间线 | `{EntityType:1,EntityId:1,CreatedAt:-1}` |
| product_form_templates | 表单模板 | `{EntityType:1,ProductId:1,IsDeleted:1}` |
| product_workflow_definitions | 工作流定义 | `{EntityType:1,ProductId:1,IsDeleted:1}` |
| product_grade_options | 等级目录 | `{Dimension:1,EntityType:1,IsDeleted:1}` |
| requirement_types | 需求类型 | `{IsDeleted:1}` |
| product_categories | 产品类型 | `{IsDeleted:1}` |
| product_desc_templates | 描述模板 | `{EntityType:1,IsDeleted:1}` |
| product_structure_nodes | 结构节点 | `{ProductId:1,ParentId:1}` |
| product_agent_settings | 应用设置（单例） | — |

---

## 十四、与 TAPD 的对齐对照

| TAPD 概念 | 本系统对应 | 说明 |
|---|---|---|
| 需求 Story | 需求 Requirement | 分级 + 父子分解 + 工作流 |
| 缺陷 Bug | 缺陷 Defect（一等对象） | 字段集对齐 TAPD（第十章） |
| 迭代 Iteration | 版本 ProductVersion + 立项/上线双轨 | 不单建迭代对象（决策 2） |
| 任务 Task | 不引入 | 决策 2 |
| 测试用例 | 不引入 | 决策 2 |
| 工作流自定义 | 通用工作流引擎 | 状态 + 流转边 + 角色 + SLA + WIP |
| 自定义字段 | 通用表单引擎 | 13 种字段类型 |
| Wiki / 文档 | 知识库挂载 | 见第八章 |
| 需求可追溯矩阵 | 客户→需求→功能→版本 + 缺陷追溯 | RTM 主线 |

---

## 十五、待确认事项

1. **知识库方案**（第八章）：A 自建轻量文档模块（推荐）/ B 仅外链 URL —— 影响知识库相关字段形态。
2. **立项 T / 上线 V 双轨是否全保留**：当前按 TAPD + 产品委员会流程保留；如新仓库简化，可只保留 ProductVersion 单轨 + 状态机表达立项/上线。
3. **`IsAiPoc` 等业务属性**：默认作为 AI 能力移除；若「是否 AI 项目」是真实业务标记，保留为普通字段。
4. **新技术规范细节**：是否需要本文档补充约定（如统一审计字段、软删除、ID 生成、富文本净化、分页规范）以便新仓库直接套用。

---

## 关联文档

- 旧仓库设计 SSOT：`doc/design.product-agent.md`
- 旧仓库债务台账：`doc/debt.product-agent.md`
- 设计理念整理：`下载/产品管理系统设计理念.md`
- 导入测试数据：`下载/产品管理系统-需求测试数据.csv`
