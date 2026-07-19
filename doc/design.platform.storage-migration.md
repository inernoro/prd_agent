# 平台存储切换与资产登记设计 · 设计

> **版本**：v2.0 | **日期**：2026-07-17 | **状态**：已落地

## 一、管理摘要

- **解决什么问题**：文件分散在不同业务集合和对象存储中，切换 Provider 时容易遗漏资产、系统图标和历史 URL。
- **当前能力**：统一存储接口支持本地、腾讯云 COS 和 Cloudflare R2；登记装饰器记录写入与删除事实；系统资产通过声明清单检查和同步。
- **尚未具备**：面向全部用户资产的一键跨 Provider 迁移和全库 URL 自动改写。
- **设计原则**：先登记、再盘点、后迁移；迁移必须可验证、可续传、可回滚，不能把设计步骤写成已实现功能。

## 1. 目标与边界

### 1.1 目标

- 所有新资产通过 `IAssetStorage` 进入统一存储边界。
- 保存资产操作事实，支持按 Provider、业务域和归属范围盘点。
- 切换 Provider 时优先保证新写入和系统资产可用。
- 为后续用户资产迁移提供可靠清单和校验依据。

### 1.2 非目标

- 不保证登记簿覆盖接入前的全部历史资产。
- 不把修改 `ASSETS_PROVIDER` 等同于历史数据已经迁移。
- 不在当前实现中自动扫描和改写所有 MongoDB URL 字段。
- 不允许通过文档中的示例命令绕过鉴权或删除保护。

## 2. Provider 选择

应用启动时由存储配置选择 Provider：

| Provider | 选择值 | 用途 |
|----------|--------|------|
| 本地存储 | `local` | 本地开发或明确配置的本地环境 |
| 腾讯云 COS | `tencentCos` | 已配置 COS 凭据和公开访问域名的环境 |
| Cloudflare R2 | `cloudflareR2` | 已配置 R2 凭据和公开访问域名的环境 |

`ASSETS_PROVIDER` 可显式指定 Provider；未指定时由启动配置按可用凭据选择。具体选择逻辑以 `Program.cs` 为准，文档不复制密钥变量和值。

Provider 切换只影响切换后的读写实现。历史记录中保存的完整 URL 仍指向原 Provider，除非另行执行并验证迁移。

## 3. 统一存储与登记链路

| 层 | 职责 |
|----|------|
| `IAssetStorage` | 统一保存、读取、删除和 URL 构造边界 |
| 具体 Provider | 实现本地、COS 或 R2 的对象操作 |
| `RegistryAssetStorage` | 包装真实 Provider，并记录资产操作事实 |
| `asset_registry` | 保存 Provider、对象 key、哈希、业务域、类型和归属等信息 |

登记簿是迁移清单和审计依据，不是业务实体的替代品。业务集合仍负责资产与用户、消息、任务或文档之间的关系。

## 4. 资产归属

| Scope | 含义 | 处理原则 |
|-------|------|----------|
| `system` | 系统图标、默认头像、内置皮肤等 | 仅由明确清单或精确路径识别 |
| `user` | 用户上传的图片、文档、附件和字体 | 默认归属，避免误判为系统资产 |
| `generated` | AI 生成的图片、音频和视频 | 由生成链路显式标记 |
| `log` | 日志、审计和诊断产物 | 按日志域或显式标记识别 |

归属用于盘点、保留策略和迁移分批，不直接授予访问权限。用户资产仍必须经过业务鉴权。

## 5. 系统资产同步

部分系统图标和动画曾由人工上传，没有经过统一保存接口，因此不会自然出现在登记簿中。`SystemAssetManifest` 维护这类资产的声明清单，`StorageSyncController` 提供清单查询、缺失检查和受控同步入口。

系统资产同步遵循以下顺序：

1. 在目标 Provider 配置完成后读取声明清单。
2. 以只读或 dry-run 方式检查目标端缺失项。
3. 从明确的可信源复制缺失资产。
4. 逐项验证目标对象可读。
5. 确认系统页面无缺图后，才把新 Provider 作为默认写入端。

新增内置图标、封面、视频或皮肤时，必须同步维护 `SystemAssetManifest`。清单数量以代码为准，文档不固化容易漂移的统计值。

## 6. 用户资产迁移设计

用户资产迁移是独立实施任务，当前仅定义安全契约：

| 阶段 | 必须产物 |
|------|----------|
| 盘点 | 按对象 key 去重的源资产清单、未登记历史资产清单 |
| 预演 | 对象数量、总大小、按 scope 和业务域分组的 dry-run 报告 |
| 复制 | 可续传的逐对象结果，限制并发，不覆盖来源事实 |
| 校验 | 大小或哈希校验、目标端可读性检查、失败清单 |
| 引用迁移 | 明确到集合与字段的 URL 更新计划和回滚记录 |
| 切换 | 新写入端切换、历史页面抽样和持续错误监控 |

只有复制与引用校验均通过，才能宣布某一批资产迁移完成。登记簿记录缺失、正文内嵌 URL 和第三方外链都必须单独识别，不能假设只替换域名即可完成迁移。

## 7. 安全约束

- 迁移默认 dry-run，执行模式必须显式开启。
- 默认不删除源对象；源清理是迁移验收后的独立操作。
- 每个对象保存源 Provider、目标 Provider、校验结果和失败原因。
- URL 更新保存前后值，支持按批次回滚。
- 用户资产误分风险以保护用户为先，无法判断时归为 `user`。
- 迁移工具不得把访问密钥、签名 URL 或用户内容写入普通日志。

## 8. 当前实现入口

| 能力 | 事实入口 |
|------|----------|
| 存储接口 | `prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/IAssetStorage.cs` |
| 登记装饰器 | `prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/RegistryAssetStorage.cs` |
| 登记模型 | `prd-api/src/PrdAgent.Core/Models/AssetRegistryEntry.cs` |
| 系统资产清单 | `prd-api/src/PrdAgent.Infrastructure/Services/AssetStorage/SystemAssetManifest.cs` |
| 系统资产同步 API | `prd-api/src/PrdAgent.Api/Controllers/Api/StorageSyncController.cs` |
| Provider 装配 | `prd-api/src/PrdAgent.Api/Program.cs` |
| MongoDB 集合入口 | `prd-api/src/PrdAgent.Infrastructure/Data/MongoDbContext.cs` |

## 9. 验收标准

- 新写入和删除操作能在登记簿中追溯。
- 三种 Provider 的选择结果与启动配置一致。
- 切换 Provider 后，系统资产缺失可被发现并受控补齐。
- 历史用户资产未迁移时，系统明确显示其仍由旧 URL 提供。
- 任何迁移工具在 dry-run、续传、校验和回滚方面满足本设计约束。

## 关联文档

- `doc/design.platform.image-ref-and-persistence.md`
- `doc/design.platform.workspace.md`
- `doc/debt.platform.md`
