# 账户数据共享 设计方案

> **版本**：v1.1 | **日期**：2026-03-13 | **状态**：开发中

## 一、问题背景

当前系统中，用户的工作空间、提示词配置、参考图配置等数据完全绑定在个人账户下，无法在用户之间流转。这导致以下实际问题：

- **人员交接困难**：成员离开团队时，其积累的工作空间和配置无法移交给接替者，只能手动重建
- **新人上手慢**：资深用户无法将自己的模板/配置直接分享给新成员，只能口头指导或截图

如果不解决，每次人员变动都会造成数据资产丢失和重复劳动。

## 二、设计目标

| 目标 | 说明 | 非目标 |
|------|------|--------|
| 点对点深拷贝 | 发送方选择数据项 → 接收方确认接受 → 系统深拷贝到接收方账户 | 不做实时协作或共享引用（数据拷贝后各自独立） |
| 接收方确认机制 | 接收方必须主动接受才执行拷贝，不允许自动转入 | 不做批量推送（不支持一次给多人发送） |
| 可扩展的数据类型 | 通过 `SourceType` 注册新的可共享类型，初期支持工作空间/提示词/参考图 | 不做跨系统数据共享 |

## 三、核心设计决策

### 决策 1：深拷贝 vs 引用共享

**结论**：采用深拷贝，拷贝后发送方和接收方各自持有独立副本。

| 方案 | 优势 | 劣势 | 判定 |
|------|------|------|------|
| A. 深拷贝 | 数据独立、无耦合、删除不影响对方 | 占用额外存储空间 | 采纳 |
| B. 引用共享 | 节省存储、数据同步更新 | 权限控制复杂、删除级联风险、与现有 OwnerUserId 体系冲突 | 否决 |

**理由**：系统所有数据模型都基于 `OwnerUserId` 单一所有权设计，引用共享需要大范围改造权限体系，成本远高于存储开销。

### 决策 2：创建入口使用 Dialog 而非内嵌面板

**结论**：使用模态对话框创建共享请求，而非替换右侧详情面板。

| 方案 | 优势 | 劣势 | 判定 |
|------|------|------|------|
| A. Dialog 模态框 | 保留列表上下文、创建是聚焦任务 | 弹窗遮罩 | 采纳 |
| B. 右侧面板替换 | 无遮罩 | 丢失列表上下文、与详情面板复用增加状态管理复杂度 | 否决 |

**理由**：创建共享是低频操作，使用 Dialog 保留列表上下文更自然。

### 决策 3：appKey 展示名由后端提供

**结论**：遵循前端架构原则，`AppKeyDisplayName` 由后端写入时存储，前端直接展示。

**理由**：避免前端维护业务数据映射表，保持"前端仅作为指令发送者与状态观察者"的原则。

## 四、整体架构

```
[DataSharingPage]
    ├── 创建 Dialog → POST /api/account/data-transfers
    ├── 列表 (收到/发出) → GET /api/account/data-transfers?direction=
    └── 详情面板 → Accept/Reject/Cancel 操作
         ↓
[AccountDataTransferController]
    ├── 创建 → 写入 account_data_transfers (status=pending)
    │         → 发送通知给接收方
    ├── 接受 → status=processing → 逐项深拷贝 → completed/partial/failed
    └── 拒绝/取消 → 更新状态 + 通知
```

### 关键交互流程

1. 发送方 → 选择数据项 + 接收用户 → 创建共享请求（status=pending）
2. 系统 → 发送通知给接收方（含深链接）
3. 接收方 → 点击"接受" → 系统逐项执行深拷贝 → 更新为 completed/partial/failed
4. 系统 → 发送结果通知给发送方

### 状态流转

| 当前状态 | 触发事件 | 目标状态 | 备注 |
|----------|----------|----------|------|
| pending | 接收方接受 | processing | 开始逐项深拷贝 |
| pending | 接收方拒绝 | rejected | 通知发送方 |
| pending | 发送方取消 | cancelled | - |
| pending | 超过 7 天 | expired | 自动过期 |
| processing | 全部成功 | completed | - |
| processing | 部分成功 | partial | Result 中记录明细 |
| processing | 全部失败 | failed | - |

## 五、数据设计

### 新增集合

| 集合 | 用途 | 关键索引 |
|------|------|----------|
| `account_data_transfers` | 存储共享请求及执行状态 | `SenderUserId + CreatedAt desc`、`ReceiverUserId + CreatedAt desc` |

### 核心字段

**AccountDataTransfer**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| Id | string | 是 | 唯一标识 |
| SenderUserId | string | 是 | 发送方用户 ID |
| SenderUserName | string | 是 | 发送方名称快照 |
| ReceiverUserId | string | 是 | 接收方用户 ID |
| ReceiverUserName | string | 是 | 接收方名称快照 |
| Items | List\<DataTransferItem\> | 是 | 共享数据项列表 |
| Status | string | 是 | pending / processing / completed / rejected / expired / cancelled / partial / failed |
| Message | string | 否 | 发送方附言 |
| Result | DataTransferResult | 否 | 执行结果摘要 |
| ExpiresAt | DateTime | 是 | 过期时间（默认 7 天） |

**DataTransferItem**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| SourceType | string | 是 | workspace / literary-prompt / ref-image-config |
| SourceId | string | 是 | 源数据 ID |
| DisplayName | string | 是 | 创建时的名称快照 |
| AppKey | string | 否 | 应用标识 |
| AppKeyDisplayName | string | 否 | 应用展示名（后端写入） |
| PreviewInfo | string | 否 | 预览信息（如"47 张图片"） |
| CloneStatus | string | 是 | pending / success / failed / source_missing |
| CloneError | string | 否 | 失败原因 |

### 可共享类型注册

| SourceType | 源集合 | 深拷贝范围 |
|------------|--------|-----------|
| `workspace` | image_master_workspaces | 工作空间 + 全部 ImageAssets + 全部 Messages + Canvas |
| `literary-prompt` | literary_prompts | 提示词内容（fork 式拷贝） |
| `ref-image-config` | reference_image_configs | 配置 + 图片 URL 引用 |

## 六、接口设计

| 方法 | 路径 | 用途 | 备注 |
|------|------|------|------|
| POST | `/api/account/data-transfers` | 创建共享请求 | 新增 |
| GET | `/api/account/data-transfers` | 列表查询（direction=sent/received） | 新增 |
| GET | `/api/account/data-transfers/{id}` | 查看详情 | 新增 |
| POST | `/api/account/data-transfers/{id}/accept` | 接受并执行深拷贝 | 新增 |
| POST | `/api/account/data-transfers/{id}/reject` | 拒绝 | 新增 |
| POST | `/api/account/data-transfers/{id}/cancel` | 发送方取消 | 新增 |
| GET | `/api/account/data-transfers/my-workspaces` | 获取发送方工作空间列表 | 新增 |
| GET | `/api/account/data-transfers/my-configs` | 获取发送方配置列表 | 新增 |

## 七、影响范围

| 影响模块 | 变更内容 | 风险等级 |
|----------|----------|----------|
| 新增 Controller | AccountDataTransferController | 低（独立新增） |
| 通知系统 | 新增 3 种通知类型（创建/接受结果/拒绝） | 低（使用现有 AdminNotification） |
| 工作空间相关集合 | 深拷贝时读取 image_master_workspaces / image_assets / image_master_messages / image_master_canvases | 中（需确保拷贝完整性） |
| 前端 prd-admin | 新增 DataSharingPage（左右分栏 + 创建 Dialog） | 低（独立页面） |

## 八、关键约束与风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 工作空间深拷贝数据量大（数百张图片） | 中 | 拷贝耗时长，可能超时 | 逐项拷贝 + 记录每项 CloneStatus，支持 partial 状态 |
| 源数据在拷贝前被删除 | 低 | 部分项拷贝失败 | CloneStatus 标记为 source_missing，不阻塞其他项 |
| 过期请求堆积 | 低 | 存储增长 | ExpiresAt 字段 + 定期清理策略 |
| 发送方和接收方权限校验 | - | 数据泄露 | 所有端点校验 SenderUserId/ReceiverUserId 与当前用户匹配 |
