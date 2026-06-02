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
- P1（关系与追溯）：已交付——版本↔需求/功能连边 UI、需求↔客户/版本连边、缺陷追溯（trace/untrace/列出/可关联）、知识库 find-or-create 挂载（产品整体库 + 版本库，嵌入 DocumentStoreBrowser）。

## 已知边界

| # | 边界 | 说明 | 计划波次 |
|---|------|------|---------|
| 1 | ~~关系连边只能填 id 数组~~ | 已做连边 UI（版本/需求弹层多选 + 缺陷追溯选择器） | P1 已解决 |
| 2 | ~~缺陷追溯未打通~~ | 已加 DefectReport.Traced* 字段 + trace/untrace/列出端点 + 前端选择器 | P1 已解决 |
| 3 | ~~知识库未挂载~~ | 已 find-or-create（ProductKnowledgeRef scoping）+ 嵌入 DocumentStoreBrowser | P1 已解决 |
| 3b | 产品/版本知识库的非 owner 成员访问未授权 | DocumentStoreController 对 ProductKnowledgeRef 库未加"产品成员"访问判定（pm-agent 用 PmProjectId 做了）；当前仅 owner 能在文档空间端点读写，产品成员打开知识库 tab 可能被拒 | P2 |
| 4 | 知识图谱未实现 | 关系可视化（ReactFlow）未做 | P2 |
| 5 | 大版本升级申请表单未实现 | VersionUpgradeRequest 对象与可配置申请流程未建 | P2 |
| 6 | 表单/流程为"数据可配"但无可视化编辑器 | 模板与流程定义只能通过 API 传 JSON，前端没有拖拽编辑器 | P2 |
| 7 | 详情页字段未按自定义表单模板动态渲染 | P0 页面是固定字段骨架，FormData 动态表单渲染待接 | P1/P2 |
| 8 | 看板视图未实现 | 仅列表视图 | P2 |
| 9 | 后端未本地编译验证 | 沙箱无 dotnet SDK，依赖 push 后 CDS 自动部署验证编译 | 持续 |

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
