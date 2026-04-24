# 涌现探索器 · 设计

> **版本**：v1.0 | **日期**：2026-04-07 | **状态**：已实现

## 一、管理摘要

- **解决什么问题**：团队在规划"下一步做什么"时缺少结构化的发散工具，头脑风暴结果散落在聊天记录和文档注释中
- **方案概述**：可视化涌现探索工具——从一颗种子（文档/方案/想法）出发，通过 AI 在三个维度上探索和组合，生长出功能树
- **业务价值**：让"下一步做什么"从拍脑袋变成有据可循的 AI 辅助决策
- **影响范围**：后端（EmergenceController + EmergenceService）、管理后台（/emergence 页面，React Flow 画布）
- **与文档空间的关系**：文档空间提供种子来源，涌现探索器消费种子内容

## 二、核心概念

### 三维涌现模型

| 维度 | 含义 | 锚点要求 | AI 温度 |
|------|------|---------|---------|
| **一维·探索** | 从一个节点向下展开子功能 | 必须有现实锚点（文档证据） | 0.7 |
| **二维·涌现** | 组合多个节点发现交叉价值 | 必须标注桥梁假设 | 0.7 |
| **三维·幻想** | 放宽约束，想象 3-5 年后 | 必须标注未知数 | 0.9 |

### 反向自洽原则

每个节点必须能顺着引用链回溯到种子文档。没有锚点的节点 = 幻觉。

```
节点 → GroundingContent → 种子文档中的具体段落
节点 → BridgeAssumptions → 组合成立的前提条件
节点 → MissingCapabilities → 需要但当前没有的能力（借用法则）
```

### 种子文档 = 主角

种子文档始终是 AI 分析的主上下文。系统能力扫描（InjectSystemCapabilities）是可选辅助。

## 三、数据模型

### EmergenceTree（涌现树）

| 字段 | 类型 | 说明 |
|------|------|------|
| Id | string | 主键 |
| Title | string | 树标题 |
| SeedContent | string | 种子内容（完整文本） |
| SeedSourceType | string | text / document / conversation / url |
| SeedSourceId | string? | 关联的文档条目 ID |
| InjectSystemCapabilities | bool | 是否注入系统能力 |
| NodeCount | int | 节点总数 |
| MaxDepth | int | 最大深度 |

### EmergenceNode（涌现节点）

| 字段 | 类型 | 说明 |
|------|------|------|
| Id | string | 主键 |
| TreeId | string | 所属树 |
| ParentId | string? | 直接父节点 |
| ParentIds | List\<string\> | 多父节点（涌现组合） |
| Title | string | 功能名称 |
| Description | string | 用户价值描述 |
| GroundingContent | string | 现实锚点 |
| GroundingType | string | document / capability / code / api |
| TechPlan | string? | 实现思路 |
| BridgeAssumptions | List\<string\> | 桥梁假设 |
| MissingCapabilities | List\<string\> | 缺失能力 |
| Dimension | int | 1/2/3 |
| NodeType | string | seed / capability / combination / fantasy |
| ValueScore | int | 价值评分 (1-5) |
| DifficultyScore | int | 难度评分 (1-5) |
| Status | string | idea / planned / building / done |

## 四、API 端点

| 方法 | 路径 | 用途 | 响应 |
|------|------|------|------|
| POST | /api/emergence/trees | 创建涌现树 | tree + seedNode |
| GET | /api/emergence/trees | 列出涌现树 | 分页列表 |
| GET | /api/emergence/trees/{id} | 获取树 + 全部节点 | tree + nodes |
| DELETE | /api/emergence/trees/{id} | 删除树（级联） | |
| PUT | /api/emergence/nodes/{id} | 更新节点 | |
| DELETE | /api/emergence/nodes/{id} | 删除节点（级联子树） | |
| POST | /api/emergence/nodes/{id}/explore | **SSE** 一维探索 | stage/node/error/done |
| POST | /api/emergence/trees/{id}/emerge | **SSE** 二维/三维涌现 | stage/node/error/done |
| GET | /api/emergence/trees/{id}/export | 导出 Markdown | markdown |

### SSE 事件格式

```
event: stage    → { stage, message }     // 阶段状态
event: node     → { EmergenceNode }      // 新生成的节点
event: error    → { message }            // LLM 错误详情
event: done     → { totalNew, error? }   // 完成
```

## 五、AppCallerCode

| Code | 用途 | 模型类型 |
|------|------|---------|
| `emergence-explorer.explore::chat` | 一维探索 | chat |
| `emergence-explorer.emerge::chat` | 二维/三维涌现 | chat |

需要在管理后台执行「初始化应用」（POST /api/settings/init/default-apps）注册到数据库。

## 六、前端架构

- **React Flow** — 节点/边可视化画布
- **useSseStream** — SSE 流式 hook，实时接收 stage/node/done 事件
- **toast** — 探索结果反馈（成功/失败/0 节点警告）
- **MiniMap** — 缩略导航

### 文档 → 涌现流转

```
文档空间 → 点击涌现按钮 → /emergence?seedSourceType=document&seedSourceId={id}&seedTitle={title}
涌现创建对话框 → 通过 getDocumentContent(sourceId) 拉取文档全文
→ 填入 seedContent → 创建涌现树 → 进入画布
```

## 七、关联设计文档

- `design.document-store.md` — 文档空间（涌现的种子来源）
- `design.system-emergence.md` — 系统涌现概念文档（涌现探索器是这个概念的具体实现）
- `.claude/rules/no-rootless-tree.md` — 无根之木禁令 + 借用法则
