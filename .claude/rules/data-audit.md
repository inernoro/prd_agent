---
globs: ["prd-api/src/**/Models/**/*.cs", "prd-api/src/**/Controllers/**/*.cs"]
---

# 数据关系审计原则

当实体 A 新增对实体 B 的引用关系，必须审计所有访问实体 B 的端点，确保权限校验覆盖新关系。

> **根因案例**：`Session.DocumentIds` 引用了补充文档，但 `DocumentsController` 等端点仍只查 `Group.PrdDocumentId`，导致补充文档无法预览。

## 审计清单

新增数据关系时（Model 新增 `List<string> xxxIds`、新增外键、新增"A 拥有 B"逻辑）：

- [ ] Grep 实体 B 的所有消费端点
- [ ] 逐个检查权限校验是否覆盖新访问路径
- [ ] 检查硬编码假设（`== id` 是否应改为 `Contains(id)`）
- [ ] 检查反向路径（删除 A 时 B 的引用是否需清理）

## 典型触发场景

| 变更类型 | 审计动作 |
|----------|----------|
| Model 新增 `List<string> XxxIds` | Grep 被引用实体的所有 Controller |
| 新增"A 包含 B"关系 | 检查 B 的 CRUD 端点 |
| 单引用改为多引用 | `== id` 改为 `Contains(id)` |
