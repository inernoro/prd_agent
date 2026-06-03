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
