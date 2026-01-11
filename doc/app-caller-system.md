# 应用调用者系统说明

## 概述

应用调用者（App Caller）系统是智能模型调度系统的核心组件，用于识别和管理所有调用 LLM 服务的应用身份。

## 核心概念

### 1. 应用身份（App Caller）

每个调用 LLM 服务的功能点都应该有一个唯一的应用标识（`appCode`），例如：
- `chat.sendMessage` - 聊天消息
- `prd.analyze` - PRD 分析
- `imageGen.generate` - 图片生成
- `visualAgent.analyze` - 视觉 Agent 分析

### 2. 模型需求（Model Requirements）

每个应用可以声明自己需要哪些类型的模型，例如：
```json
{
  "appCode": "visualAgent.analyze",
  "modelRequirements": [
    {
      "modelType": "vision",
      "purpose": "分析图片内容",
      "isRequired": true
    },
    {
      "modelType": "chat",
      "purpose": "生成分析报告",
      "isRequired": true
    }
  ]
}
```

### 3. 模型分组（Model Groups）

模型按照类型组织成分组，每个分组包含多个模型，按优先级排序：
- 主模型优先使用
- 失败时自动降权，切换到备用模型
- 健康检查自动恢复

## 当前状态

### 已实现功能

1. **后端基础设施** ✅
   - `SmartModelScheduler` - 智能模型调度器
   - `ModelGroup` - 模型分组管理
   - `LLMAppCaller` - 应用调用者管理
   - `ModelSchedulerConfig` - 系统配置管理
   - 健康检查与自动降权/恢复机制

2. **管理后台 UI** ✅
   - 应用列表展示
   - 模型需求配置
   - 监控数据展示
   - 系统配置面板

3. **初始化功能** ✅
   - 一键创建默认应用
   - 一键创建默认分组
   - 一键迁移现有模型

### 待实现功能

1. **业务代码改造** ❌
   - 当前业务代码仍使用旧的 `ILLMClientFactory`
   - 需要改造为使用 `ISmartModelScheduler`
   - 需要在调用时传入 `appCallerCode`

2. **自动注册机制** ❌
   - 当业务代码首次调用时自动注册应用
   - 记录调用统计（总调用、成功、失败）

3. **全局扫描功能** ❌
   - 从 LLM 日志中扫描未注册的应用
   - 需要先在日志表中添加 `appCallerCode` 字段

## 为什么应用列表是空的？

### 原因

1. **业务代码未改造**：现有的聊天、PRD 分析等功能还没有使用新的调度系统
2. **没有初始化**：系统刚部署时，数据库中没有任何应用记录

### 解决方案

**方案 1：一键初始化（推荐）**

在"应用与分组管理"页面点击"初始化默认应用"按钮，系统会自动创建以下应用：

- `chat.sendMessage` - 聊天消息
- `chat.intentRecognition` - 意图识别
- `prd.analyze` - PRD 分析
- `prd.preview` - PRD 预览问答
- `gap.detect` - Gap 检测
- `gap.summarize` - Gap 总结
- `imageGen.generate` - 图片生成
- `imageGen.verify` - 图片验证
- `visualAgent.analyze` - 视觉 Agent 分析
- `literaryAgent.generate` - 文学 Agent 生成
- `openPlatform.proxy` - 开放平台代理

**方案 2：手动创建**

在页面上手动添加应用和配置模型需求。

**方案 3：等待自动注册（未来）**

当业务代码改造完成后，应用会在首次调用时自动注册。

## 全局扫描功能说明

### 设计原理

全局扫描功能的目的是从历史 LLM 调用日志中发现未注册的应用：

1. 扫描 `llm_request_logs` 集合
2. 提取所有出现过的 `appCallerCode`
3. 与已注册应用对比，找出缺失的
4. 自动创建这些应用（标记为 `isAutoRegistered: true`）

### 当前状态

**功能未实现**，原因：

1. **日志表缺少字段**：`llm_request_logs` 表中还没有 `appCallerCode` 字段
2. **业务代码未改造**：即使有字段，现有代码也不会填充这个字段

### 实现步骤（未来）

1. **第一步**：在 `LlmRequestLog` 模型中添加 `AppCallerCode` 字段
2. **第二步**：改造业务代码，在记录日志时填充 `appCallerCode`
3. **第三步**：实现扫描逻辑：
   ```csharp
   var distinctCodes = await _db.LlmRequestLogs
       .Distinct<string>("appCallerCode", Builders<LlmRequestLog>.Filter.Empty)
       .ToListAsync();
   
   var existingCodes = await _db.LLMAppCallers
       .Find(_ => true)
       .Project(a => a.AppCode)
       .ToListAsync();
   
   var newCodes = distinctCodes.Except(existingCodes).ToList();
   
   // 为每个 newCode 创建应用记录
   ```

## 使用指南

### 1. 初始化系统

访问"应用与分组管理"页面，点击"初始化默认应用"。

### 2. 配置模型需求

1. 选择一个应用
2. 点击"添加需求"
3. 选择模型类型（chat/intent/vision/image-gen 等）
4. 填写用途说明
5. 可选：绑定到特定分组（否则使用默认分组）

### 3. 监控健康状态

在右侧面板查看：
- 模型健康状态（健康/降权/不可用）
- 连续失败次数
- 健康分数
- 最后成功/失败时间

### 4. 模拟测试

使用"模拟降权"和"模拟恢复"按钮测试降权机制。

### 5. 调整系统配置

点击"系统配置"按钮，调整：
- 降权失败阈值
- 不可用失败阈值
- 健康检查间隔
- 自动恢复开关

## API 端点

### 应用管理

- `GET /api/v1/admin/app-callers` - 获取应用列表
- `POST /api/v1/admin/app-callers` - 创建应用
- `PUT /api/v1/admin/app-callers/{id}` - 更新应用
- `DELETE /api/v1/admin/app-callers/{id}` - 删除应用
- `POST /api/v1/admin/app-callers/scan` - 全局扫描（未实现）

### 分组管理

- `GET /api/v1/admin/model-groups` - 获取分组列表
- `POST /api/v1/admin/model-groups` - 创建分组
- `PUT /api/v1/admin/model-groups/{id}` - 更新分组
- `DELETE /api/v1/admin/model-groups/{id}` - 删除分组
- `GET /api/v1/admin/model-groups/{id}/monitoring` - 获取监控数据
- `POST /api/v1/admin/model-groups/{id}/simulate-downgrade` - 模拟降权
- `POST /api/v1/admin/model-groups/{id}/simulate-recover` - 模拟恢复

### 系统配置

- `GET /api/v1/admin/scheduler-config` - 获取系统配置
- `PUT /api/v1/admin/scheduler-config` - 更新系统配置

### 初始化

- `POST /api/v1/admin/init/default-apps` - 创建默认应用
- `POST /api/v1/admin/init/default-groups` - 创建默认分组
- `POST /api/v1/admin/init/migrate-models` - 迁移现有模型
- `POST /api/v1/admin/init/default-config` - 创建默认配置
- `POST /api/v1/admin/init/all` - 一键初始化

## 下一步计划

1. **改造业务代码**：将现有的 LLM 调用改为使用 `SmartModelScheduler`
2. **增强日志**：在日志中记录 `appCallerCode`
3. **实现扫描**：完成全局扫描功能
4. **性能优化**：添加缓存，减少数据库查询
5. **监控告警**：当模型不可用时发送告警
