---
type: debt
title: 产品管理智能体工程债务台账
status: active
updated: 2026-06-02
---

# 产品管理智能体（product-agent）债务台账

记录已知边界、TODO 留尾与后续可补项。P0 交付时的"已知边界"固化于此，避免下一个 session 失忆。

## 进度

- P0（地基）：已交付（commit 0524446）。
- P1（关系与追溯）：已交付——版本↔需求/功能连边 UI、需求↔客户/版本连边、缺陷追溯、知识库 find-or-create 挂载。
- P2（图谱/升级/看板/权限）：已交付——知识图谱可视化（ReactFlow）、大版本升级申请可配置表单 + 状态流转、需求分级看板、知识库产品成员访问授权。

- P2-2（页面设计重构）：管理层总览左导航 shell + 仪表盘 + 跨产品表（已交付）；单产品视图改左导航 + 产品仪表盘（已交付）；全局设置：表单模板 + 流程模板可视化编辑器（已交付，全局默认 + 产品覆盖）。

## 已知边界

| # | 边界 | 说明 | 状态 |
|---|------|------|------|
| 1 | ~~关系连边只能填 id 数组~~ | 已做连边 UI | P1 已解决 |
| 2 | ~~缺陷追溯未打通~~ | DefectReport.Traced* + trace/untrace/列出 + 前端选择器 | P1 已解决 |
| 3 | ~~知识库未挂载~~ | find-or-create + 嵌入 DocumentStoreBrowser | P1 已解决 |
| 3b | ~~产品库非 owner 成员访问未授权~~ | DocumentStoreController 加 IsProductKnowledgeMemberAsync（产品 owner/成员可读写） | P2 已解决 |
| 4 | ~~知识图谱未实现~~ | ProductGraphCanvas（ReactFlow，列布局 + 类型着色 + 统一手势） | P2 已解决 |
| 5 | ~~大版本升级申请未实现~~ | VersionUpgradeRequest + CRUD + 状态流转 + 前端 tab | P2 已解决 |
| 8 | ~~看板视图未实现~~ | 需求分级看板（P0-P3 分列） | P2 已解决 |
| 6 | ~~表单/流程无可视化编辑器~~ | 全局设置已提供表单模板 + 流程模板可视化编辑器（全局默认 + 产品覆盖） | P2 已解决 |
| 7 | ~~详情页字段未按表单模板动态渲染~~ | 新建/详情页按生效模板动态渲染 FormData 字段；对象绑定流程后显示状态 + 流转按钮(WorkflowBar) | 已解决 |
| 8b | 图谱布局为简单列布局 | 未用 dagre 自动布局；节点多时同列堆叠较长，可后续接 autoLayout | 后续(小) |
| 11 | ~~跨产品总览图缺失~~ | 总览「图谱」已提供公司级产品→版本发布地图(ReactFlow,产品节点可下钻) | 已解决 |
| 12 | ~~产品内不能新建缺陷~~ | 产品缺陷 tab 可新建缺陷(写 defect_reports + 自动追溯产品) | 已解决 |
| 13 | ~~版本无流转/动态表单~~ | 版本自动绑定默认流程/模板，版本关系弹层显示流转条 + 动态字段 | 已解决 |
| 9 | 后端未本地编译验证 | 沙箱无 dotnet SDK，依赖 push 后 CDS 自动部署验证编译 | 持续 |
| 10 | ~~看板不可拖拽改状态~~ | 需求看板在有流程时按状态分列，支持拖拽卡片走合法流转改 CurrentState；无流程回退分级看板 | 已解决 |

## 索引登记需求（DBA）

新增集合的索引建议（按 `.claude/rules/no-auto-index.md`，应用不自动建，登记给 DBA，见 `doc/guide.mongodb-indexes.md`）：

- `products`：`{ OwnerId:1, IsDeleted:1, UpdatedAt:-1 }`、`{ MemberIds:1 }`
- `product_versions`：`{ ProductId:1, IsDeleted:1 }`
- `requirements`：`{ ProductId:1, IsDeleted:1 }`、`{ VersionIds:1 }`、`{ CustomerIds:1 }`
- `features`：`{ ProductId:1, IsDeleted:1 }`
- `feature_versions`：`{ ProductId:1, FeatureId:1 }`、`{ VersionId:1 }`
- `customers`：`{ ProductId:1, IsDeleted:1 }`
- `product_form_templates`：`{ EntityType:1, ProductId:1, IsDeleted:1 }`
- `product_workflow_definitions`：`{ EntityType:1, ProductId:1, IsDeleted:1 }`

## P0-P3 + P1 增量进度（2026-06-03）

P0/P1/P2/P3 四阶段研发全生命周期能力已交付（流转/处理人/缺陷转需求/评论时间线/通知/看板/SLA），另补齐 P0 三项（RTM 矩阵、富文本 XSS 净化、需求/功能父子层级）与 P1 两项（全局搜索、批量操作）。

| # | 能力 | 状态 |
|---|------|------|
| 14 | 默认流程开箱即用 + 处理人一等公民 + 我负责的 | P0 已交付 |
| 15 | 缺陷转需求 + SourceDefectId 溯源 | P1 已交付 |
| 16 | 评论 + 活动时间线(product_item_activities) + admin_notifications 通知 | P2 已交付 |
| 17 | 看板拖拽流转 + SLA(StateEnteredAt/SlaHours) + 流转自动认领(AutoAssignToActor) | P3 已交付 |
| 18 | RTM 需求可追溯矩阵(products/{id}/rtm) | 已交付 |
| 19 | 富文本渲染 XSS 净化(sanitizeHtml) | 已交付 |
| 20 | 需求/功能父子层级 UI(ParentId 编辑 + 列表树形缩进) | 已交付 |
| 21 | 全局搜索(search?keyword=，跨产品/需求/功能/客户/缺陷) | 已交付 |
| 22 | 批量操作(items/batch，批量删除/指派/改分级) | 已交付 |

## 仍未实现（按优先级，后续可补）

| 能力 | 优先级 | 说明 / 未做原因 |
|------|--------|----------------|
| 知识库 MRD/SRS/PRD 分型 | P1(暂缓) | 版本/产品知识库复用共享组件 `DocumentStoreBrowser`，文档空间无简洁「建文本条目」API（条目走文件上传 + updateDocumentContent 编辑），深改共享组件风险高且本环境无法 CDS 验证。当前用户已可在版本库自建并命名 MRD/SRS/PRD 文档，分型仅为约定便利。**未来最干净路径**：在 DocumentStore 实体加可选 `docType`(mrd/srs/prd) + DocumentStoreBrowser 增「按类型分组/快速新建标准文档」开关（避免污染非 product-agent 用法），或在 product-agent 侧加一个 find-or-create 三类条目的封装端点（依赖文档空间补 create-text-entry API）。 |
| 报表深度(燃尽图/迭代速度/版本进度) | P2 | 总览现为计数+饼图/柱图/漏斗；需基于状态流转历史(已有 product_item_activities 时间线可作数据源)算 burndown/velocity。 |
| 看板 WIP 限制 + 泳道 | P2 | 每列在制上限告警 + 按处理人/分级分泳道。 |
| 导入导出(Excel/CSV) | P2 | 需求批量导入 + 导出归档。 |
| @ 内联弹层 | P3 | 现为「选人 chips」，可升级为编辑器内 @ 触发浮窗。 |
| 图谱 dagre 自动布局 | P3 | 现为简单列布局(债务 8b)，节点多时堆叠，可接 dagre/ELK。 |
