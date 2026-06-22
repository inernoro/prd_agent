# 赋码采集关联智能体（CCAS Agent）· 设计

> **版本**：v1.0 | **日期**：2026-06-15 | **状态**：已落地 | **appKey**：`ccas-agent` | **路由**：`/ccas-agent`
>
> CCAS = 赋码采集关联（Code/Collect/Associate System）。聚焦产线赋码业务，提供三件套能力：PRD 文档生成 + 设备素材库 + 流程示意图。由魏喜胜主导开发。

---

## 一、管理摘要

- **解决什么问题**：产线赋码项目需要快速产出 PRD 文档、生成设备样式素材、制作流程示意图，三类产物过去各自为政，无统一入口
- **方案概述**：单页 Agent（三 Tab）聚合三件套，AI 辅助生成全程流式推送
- **影响范围**：新增 `ccas-agent` 系列 Controller + 前端 `/ccas-agent` 页面 + 百宝箱入口
- **状态**：已在百宝箱注册（`wip: true`，待真人验收后转正式）

---

## 二、三件套能力

### 2.1 PRD 文档生成（PRD Tab）

AI 根据用户输入的业务场景，流式生成符合赋码业务规范的 PRD 文档草稿。

**2026-06-14 增强：多轮改稿**

- 后端新增 `POST /api/ccas-agent/prd/revise/stream`（SSE）
- 用户在 PRD Tab 底部可通过「改稿助手」对已生成的文档整篇流式修订
- 典型场景：初稿生成后针对某段给出修改方向，AI 基于全文上下文重写

### 2.2 设备素材库（Equipment Tab）

按设备类型 + 样式组合管理设备效果图资产，支持 AI 生图与本地上传两种入库方式。

**2026-06-14 增强：本地上传**

- 后端新增 `POST /api/ccas-agent/equipment/upload`（multipart）
- 前端设备素材库 Tab 新增上传按钮，支持上传本地图片直接入库
- 补充 Tab 描述文案，说明 AI 生图与本地上传两种来源

### 2.3 流程示意图（Diagram Tab）

AI 根据业务描述生成关联关系流程图（ReactFlow 画布），支持节点分组与连线编辑。

---

## 三、数据设计

| 集合 | 用途 |
|------|------|
| `ccas_equipment_assets` | 设备素材（AI 生成 + 本地上传，含 url/mime/style） |
| `ccas_flow_diagrams` | 流程示意图（nodesJson/edgesJson/groupsJson） |
| `ccas_prd_sessions` | PRD 生成会话（流式生成记录） |

---

## 四、接口设计

### PRD 生成

| 方法 | 路径 | 用途 |
|------|------|------|
| POST | `/api/ccas-agent/prd/stream` | 首次流式生成 PRD（SSE） |
| POST | `/api/ccas-agent/prd/revise/stream` | 多轮改稿（SSE，传入全文 + 修改指令） |

### 设备素材库

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/ccas-agent/equipment` | 分页列表 |
| POST | `/api/ccas-agent/equipment/generate/stream` | AI 生图（SSE） |
| POST | `/api/ccas-agent/equipment/upload` | 本地上传（multipart） |
| DELETE | `/api/ccas-agent/equipment/{id}` | 删除 |
| POST | `/api/ccas-agent/equipment/{id}/favorite` | 收藏/取消收藏 |

### 流程示意图

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/ccas-agent/flow-diagrams` | 历史列表 |
| POST | `/api/ccas-agent/flow-diagrams/stream` | AI 生成（SSE） |
| PUT | `/api/ccas-agent/flow-diagrams/{id}` | 保存编辑 |
| DELETE | `/api/ccas-agent/flow-diagrams/{id}` | 删除 |

### 元数据

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/ccas-agent/meta` | 获取模板/样式/关联模式枚举 |

---

## 五、关联文档

- `changelogs/2026-05-22_ccas-agent-v0.md`（已注册，v0 首发）
- `changelogs/2026-06-15_ccas-equipment-upload.md`（设备素材本地上传）
- `changelogs/2026-06-15_ccas-prd-revise-chat.md`（PRD 多轮改稿）
- `.claude/rules/server-authority.md`（SSE 流必须走 Run/Worker 解耦）
- `.claude/rules/llm-gateway.md`（LLM 调用统一入口）
