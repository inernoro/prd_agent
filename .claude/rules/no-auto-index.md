---
paths:
  - "prd-api/src/**/*.cs"
---

# 禁止自动创建 MongoDB 索引

**一句话**：应用启动时禁止自动建 MongoDB 索引，索引需求写进文档交给 DBA 手动执行。
**什么时候撞上**：想给新集合加索引，或看到启动路径上有建索引的代码。

应用启动时禁止自动创建任何 MongoDB 索引。所有索引由 DBA 手动创建。

## 规则

1. `MongoDbContext` 构造函数中 `CreateIndexes()` 已注释，禁止取消注释
2. 禁止在任何 `IHostedService`、`BackgroundService`、启动逻辑中调用 `Indexes.CreateOne` / `Indexes.CreateMany`
3. 新增索引需求：更新 `doc/guide.platform.mongodb-indexes.md`，由 DBA 手动执行
4. 索引定义源码保留在 `MongoDbContext.CreateIndexes()` 中作为参考（不执行）

## 原因

自动创建索引在以下场景会导致问题：
- 索引冲突导致应用启动失败（`IndexOptionsConflict`）
- 大集合上建索引阻塞写入，影响生产环境
- 多副本集环境下索引创建需要滚动执行，不能由应用触发
