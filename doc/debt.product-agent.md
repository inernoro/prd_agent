---
type: debt
title: 产品管理智能体工程债务台账
status: active
updated: 2026-06-02
---

# 产品管理智能体（product-agent）债务台账

记录已知边界、TODO 留尾与后续可补项。P0 交付时的"已知边界"固化于此，避免下一个 session 失忆。

## P0 已知边界（地基波次交付时）

| # | 边界 | 说明 | 计划波次 |
|---|------|------|---------|
| 1 | 关系连边只能在创建/更新时填 id 数组 | 还没有"在版本详情里勾选需求/功能"的连边 UI | P1 |
| 2 | 缺陷追溯未打通 | 缺陷实体在 defect-agent，product-agent 侧暂无追溯引用字段写入路径 | P1 |
| 3 | 知识库未挂载 | Product/Version 的 KnowledgeStoreId 字段已留，但未接 DocumentStore 的 find-or-create | P1 |
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
