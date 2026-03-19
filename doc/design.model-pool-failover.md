# 模型池故障转移与自动探活设计

> **状态**：待评审 | **作者**：AI | **日期**：2026-03-19
>
> 关联文档：`design.model-pool.md`（三级调度基础架构）

---

## 1. 背景与问题

### 1.1 现状痛点

上游 API（如 nanobanana）频繁出现抖动和偶发假死，当前系统存在三个核心问题：

| # | 问题 | 影响 |
|---|------|------|
| 1 | **死了不活** | 模型被标记为 Unavailable 后永远不会自动恢复，必须管理员手动进入管理后台点"重置健康"按钮 |
| 2 | **降级无感知** | 所有模型池耗尽时，用户只收到冰冷的错误消息，不知道发生了什么 |
| 3 | **配置繁琐** | 配置带降级链的模型池需要手动创建多个池并绑定 AppCaller，步骤多且易出错 |

### 1.2 现有健康管理机制

```
连续失败 3 次 → Degraded（降权，优先级下降但仍可用）
连续失败 5 次 → Unavailable（完全跳过）
任意一次成功 → 立即恢复为 Healthy
```

**关键缺陷**：一旦所有端点都变为 Unavailable，没有任何正常流量能到达它们 → 永远无法通过"成功一次即恢复"来自愈。这是一个**死锁**。

---

## 2. 设计方案

### 2.1 自动探活（Health Probe）

#### 核心思路

新增 `ModelPoolHealthProbeService`（BackgroundService），周期性对不健康模型发送轻量级探活请求。利用**伴随探活**（piggyback probe）方式：当有正常请求经过时顺带探活，避免无意义的空请求浪费。无正常流量时使用**独立探活**（standalone probe）。

#### 探活流程

```
每 60s 扫描一次所有 ModelGroup
  └─ 筛选含 Unavailable 或 Degraded 模型的池
      └─ 对每个不健康端点：
          ├─ 检查冷却期（上次探活 < 2min → 跳过）
          ├─ 检查并发锁（已有探活进行中 → 跳过）
          └─ 发送探活请求（轻量 chat: "hi"）
              ├─ 成功 → 重置为 Healthy + 写探活成功日志
              └─ 失败 → 保持原状 + 写探活失败日志
```

#### 竞态控制

```csharp
// 每个端点一把锁，避免多个周期/多个请求同时探活
ConcurrentDictionary<string, byte> _probing = new();

// TryAdd 成功 = 获得探活权
if (!_probing.TryAdd(endpointKey, 0)) return; // 已有探活进行中
try { await DoProbe(...); }
finally { _probing.TryRemove(endpointKey, out _); }
```

#### 探活请求特征

| 字段 | 值 |
|------|----|
| AppCallerCode | `system.health-probe::chat` |
| Prompt | `{"messages": [{"role": "user", "content": "hi"}]}` |
| MaxTokens | 1 |
| TimeoutSeconds | 15 |
| 日志标记 | `IsHealthProbe = true` |

#### 配置项（appsettings.json）

```json
{
  "ModelPool": {
    "HealthProbe": {
      "Enabled": true,
      "IntervalSeconds": 60,
      "CooldownSeconds": 120,
      "ProbeTimeoutSeconds": 15,
      "MaxConcurrentProbes": 5
    }
  }
}
```

### 2.2 故障通知与恢复通知

#### 触发时机

| 事件 | 动作 |
|------|------|
| 模型池所有端点 Unavailable | 创建/更新 "pool-exhausted:{poolId}" 通知 |
| 探活恢复了至少一个端点 | 创建/更新 "pool-recovered:{poolId}" 通知，关闭对应 exhausted 通知 |

#### 通知去重

利用 `AdminNotification.Key` 字段实现幂等：

```csharp
// 同一个 pool 的故障通知只保留最新一条
var key = $"pool-exhausted:{poolId}";
var existing = await _db.AdminNotifications
    .Find(n => n.Key == key && n.Status == "open")
    .FirstOrDefaultAsync();

if (existing != null)
{
    // 更新消息内容和时间，而非新建
    await _db.AdminNotifications.UpdateOneAsync(
        n => n.Id == existing.Id,
        Builders<AdminNotification>.Update
            .Set(n => n.Message, newMessage)
            .Set(n => n.UpdatedAt, DateTime.UtcNow));
}
else
{
    await _db.AdminNotifications.InsertOneAsync(notification);
}
```

#### 通知内容

**故障通知**（Level: warning）：
```
标题：模型池 "{poolName}" 全部不可用
内容：模型池 "{poolName}"（{modelType}）中 {count} 个端点全部失败。
      系统已启动自动探活，恢复后将自动通知。
      失败端点：{model1}@{platform1}（连续失败 {n} 次）, ...
```

**恢复通知**（Level: success）：
```
标题：模型池 "{poolName}" 已恢复
内容：模型池 "{poolName}" 中 {model} 已通过探活恢复为健康状态。
      故障持续时间：{duration}。
```

#### 面向请求失败用户的通知

当 Gateway 发现 `ModelResolutionResult.Success == false`（所有模型不可用）时：
1. 记录请求上下文中的 `UserId`
2. 以 `TargetUserId` 创建用户级通知（Key = `"pool-unavailable-user:{userId}:{modelType}"`）
3. 恢复后自动关闭该用户的故障通知

### 2.3 快捷模型池配置

#### API 端点

```
POST /api/mds/model-groups/quick-setup
```

#### 请求体

```json
{
  "name": "GPT-4o 对话池（带降级）",
  "modelType": "chat",
  "isDefaultForType": false,
  "strategy": 2,  // Sequential - 顺序降级
  "models": [
    { "modelId": "gpt-4o", "platformId": "platform-001", "priority": 1 },
    { "modelId": "gpt-4o-mini", "platformId": "platform-001", "priority": 2 },
    { "modelId": "claude-3-haiku", "platformId": "platform-002", "priority": 3 }
  ],
  "bindToAppCallerCode": "prd-agent.chat::chat"  // 可选：自动绑定 AppCaller
}
```

#### 处理逻辑

1. 创建 ModelGroup（strategy 推荐 Sequential）
2. 如指定 `bindToAppCallerCode`，自动更新对应 `LLMAppCaller.ModelRequirements`
3. 返回创建后的完整 ModelGroup（含 ID）

---

## 3. 日志设计

### 3.1 探活请求日志标记

在 `LlmRequestLog` 新增字段：

```csharp
/// <summary>是否为健康探活请求（后台自动发送，非用户触发）</summary>
public bool? IsHealthProbe { get; set; }
```

在 `LlmLogStart` record 新增参数：

```csharp
bool? IsHealthProbe = null
```

### 3.2 日志过滤

管理后台 LLM 日志列表默认隐藏 `IsHealthProbe == true` 的记录，但提供筛选开关"显示探活请求"。

### 3.3 探活日志内容

| 字段 | 值 |
|------|----|
| AppCallerCode | `system.health-probe::chat` |
| RequestType | 与被探活模型的 ModelType 一致 |
| IsHealthProbe | `true` |
| QuestionText | `"[Health Probe] hi"` |
| UserId | `null`（系统请求） |

---

## 4. 关键文件变更清单

| 操作 | 文件 | 说明 |
|------|------|------|
| **新增** | `Infrastructure/ModelPool/ModelPoolHealthProbeService.cs` | BackgroundService 主体 |
| **新增** | `Infrastructure/ModelPool/IPoolFailoverNotifier.cs` | 故障/恢复通知接口 |
| **新增** | `Infrastructure/ModelPool/PoolFailoverNotifier.cs` | 通知实现（AdminNotification） |
| **修改** | `Core/Models/LlmRequestLog.cs` | 新增 `IsHealthProbe` 字段 |
| **修改** | `Core/Interfaces/ILlmRequestLogWriter.cs` | `LlmLogStart` 新增 `IsHealthProbe` 参数 |
| **修改** | `Infrastructure/LlmGateway/LlmGateway.cs` | SendAsync 中传递 IsHealthProbe |
| **修改** | `Api/Controllers/Api/ModelGroupsController.cs` | 新增 quick-setup 端点 |
| **修改** | `Api/Program.cs` | 注册 ModelPoolHealthProbeService |
| **修改** | `Infrastructure/LlmGateway/ModelResolver.cs` | 检测全池耗尽时触发通知 |

---

## 5. 行业方案对比

| 方案 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| **Circuit Breaker**（Polly/Resilience4j） | 成熟、标准化 | 需引入外部依赖；半开态需定时器 | 微服务间调用 |
| **Active Health Check**（本方案） | 与现有 ModelGroup 机制紧密集成；无外部依赖 | 探活请求有成本 | LLM API 场景（少量端点，高价值恢复） |
| **Passive Recovery**（超时自愈） | 实现最简单 | 盲目恢复可能导致连续失败 | 端点偶发抖动 |
| **伴随探活**（Piggyback） | 零额外成本 | 无流量时无法恢复 | 高流量场景 |

**本方案选择**：Active Health Check + 并发控制 + 冷却期，在保证恢复速度的同时最小化探活成本。

---

## 6. 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 探活请求本身消耗 API 额度 | 中 | 低 | MaxTokens=1，冷却期 120s，最大并发 5 |
| 探活请求冲刷正常日志 | 低 | 中 | IsHealthProbe 标记 + 默认隐藏 |
| 并发探活导致锁竞争 | 低 | 低 | ConcurrentDictionary TryAdd 无锁实现 |
| 全池耗尽通知风暴 | 中 | 中 | Key 幂等去重，同一池只保留一条 |
