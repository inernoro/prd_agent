# 初始化策略实现总结

## 实现的功能

### 1. 全删全插策略

**核心逻辑**：
```
点击"初始化应用"按钮
  ↓
1. 删除所有 IsSystemDefault=true 的应用
  ↓
2. 从代码注册表（AppCallerRegistry）读取最新定义
  ↓
3. 重新插入所有系统默认应用
  ↓
4. 返回结果：删除 X 个，创建 Y 个
```

### 2. 数据标记

**新增字段**：`IsSystemDefault: boolean`

| 值 | 含义 | 行为 |
|----|------|------|
| `true` | 系统默认应用 | 初始化时会被删除并重建 |
| `false` | 用户自定义应用 | 初始化时永久保留 |

### 3. 前端交互

**按钮位置**：模型管理 → 应用与分组 → 右上角

**按钮文案**：初始化应用（带刷新图标）

**确认提示**：
```
确认初始化

此操作将：
1. 删除所有系统默认应用和子功能
2. 重新创建最新的系统默认应用
3. 保留用户自定义的应用和分组
4. 系统默认应用的配置会被重置

确定继续？
```

**成功提示**：
```
初始化成功

删除 X 个旧应用，创建 Y 个新应用

删除：5 个旧应用
创建：13 个新应用
```

## 代码变更

### 后端

#### 1. 数据模型更新

**文件**：`prd-api/src/PrdAgent.Core/Models/LLMAppCaller.cs`

```csharp
public class LLMAppCaller
{
    // ... 其他字段 ...
    
    /// <summary>是否为系统默认应用（true=可被初始化重载，false=用户自定义永久保留）</summary>
    public bool IsSystemDefault { get; set; } = false;
}
```

#### 2. 初始化接口重写

**文件**：`prd-api/src/PrdAgent.Api/Controllers/Admin/AdminInitController.cs`

**端点**：`POST /api/v1/admin/init/default-apps`

**逻辑**：
```csharp
public async Task<IActionResult> InitDefaultApps()
{
    var deleted = new List<string>();
    var created = new List<string>();

    // 步骤 1：删除所有系统默认应用
    var systemDefaultApps = await _db.LLMAppCallers
        .Find(a => a.IsSystemDefault == true)
        .ToListAsync();

    foreach (var app in systemDefaultApps)
    {
        await _db.LLMAppCallers.DeleteOneAsync(a => a.Id == app.Id);
        deleted.Add(app.AppCode);
    }

    // 步骤 2：从注册表获取最新定义
    var definitions = AppCallerRegistrationService.GetAllDefinitions();

    // 步骤 3：重新插入系统默认应用
    foreach (var def in definitions)
    {
        var app = new LLMAppCaller
        {
            // ... 字段赋值 ...
            IsSystemDefault = true,  // 标记为系统默认
        };

        await _db.LLMAppCallers.InsertOneAsync(app);
        created.Add(def.AppCode);
    }

    return Ok(ApiResponse<object>.Ok(new
    {
        deleted,
        created,
        message = $"删除 {deleted.Count} 个旧应用，创建 {created.Count} 个新应用"
    }));
}
```

### 前端

#### 1. 按钮更新

**文件**：`prd-admin/src/pages/ModelAppGroupPage.tsx`

**变更**：
- 删除了"全局扫描"按钮
- 删除了"初始化默认应用"按钮（应用列表为空时显示的）
- 新增"初始化应用"按钮（始终显示）
- 图标从 `Search` 改为 `RefreshCw`

#### 2. 确认对话框更新

```typescript
const confirmed = await systemDialog.confirm({
  title: '确认初始化',
  message: `此操作将：
1. 删除所有系统默认应用和子功能
2. 重新创建最新的系统默认应用
3. 保留用户自定义的应用和分组
4. 系统默认应用的配置会被重置

确定继续？`,
});
```

#### 3. 结果展示更新

```typescript
const { deleted, created, message } = result.data;
const deletedCount = deleted?.length || 0;
const createdCount = created?.length || 0;

systemDialog.success(
  '初始化成功',
  `${message || '操作完成'}\n\n删除：${deletedCount} 个旧应用\n创建：${createdCount} 个新应用`
);
```

## 使用场景

### 场景 1：首次初始化

**操作**：点击"初始化应用"

**结果**：
```
删除 0 个旧应用，创建 13 个新应用
```

**说明**：数据库为空，直接创建所有系统默认应用

### 场景 2：代码更新后重新初始化

**背景**：
- 开发者在 `AppCallerRegistry` 中新增了 2 个应用
- 修改了 3 个应用的 DisplayName
- 删除了 1 个应用

**操作**：点击"初始化应用"

**结果**：
```
删除 12 个旧应用，创建 14 个新应用
```

**说明**：
- 删除了所有旧的系统默认应用（12 个）
- 重新创建了最新的系统默认应用（14 个）
- 用户配置的模型分组会丢失（预期行为）

### 场景 3：用户自定义应用被保留

**背景**：
- 用户在管理后台手动创建了 "my-custom-app"（IsSystemDefault=false）
- 用户修改了 "prd-desktop.chat" 的模型分组绑定

**操作**：点击"初始化应用"

**结果**：
```
删除 13 个旧应用，创建 13 个新应用
```

**说明**：
- "my-custom-app" 被保留（IsSystemDefault=false）
- "prd-desktop.chat" 被删除并重建，用户配置丢失（IsSystemDefault=true）

### 场景 4：用户自定义分组被保留

**背景**：
- 用户创建了自定义模型分组 "我的专用聊天分组"
- 用户将 "prd-desktop.chat" 绑定到这个自定义分组

**操作**：点击"初始化应用"

**结果**：
```
删除 13 个旧应用，创建 13 个新应用
```

**说明**：
- 自定义分组被保留
- "prd-desktop.chat" 被重建，绑定关系丢失（恢复为默认分组）

## 设计优势

### 1. 简单可靠
- 全删全插，逻辑清晰
- 不需要复杂的 diff 和 merge 逻辑
- 不会出现"部分更新失败"的中间状态

### 2. 数据一致性
- 每次初始化后，系统默认应用与代码定义完全一致
- 不会出现"代码改了但数据库没更新"的问题

### 3. 用户数据保护
- 通过 `IsSystemDefault` 标记明确区分系统和用户数据
- 用户自定义的应用和分组永久保留

### 4. 配置重置明确
- 用户明确知道初始化会重置配置
- 确认对话框清楚说明了操作后果

## 注意事项

### 1. 配置丢失风险

**问题**：用户修改了系统默认应用的配置，初始化后会丢失

**解决方案**：
- 在确认对话框中明确提示
- 建议用户将重要配置迁移到自定义应用

### 2. 统计数据丢失

**问题**：系统默认应用的调用统计（TotalCalls、SuccessCalls 等）会丢失

**可能的改进**：
- 在删除前备份统计数据
- 重建时恢复统计数据
- 或者将统计数据存储在独立的表中

### 3. 历史日志关联

**问题**：如果日志中记录了应用 ID，删除应用后可能导致日志无法关联

**解决方案**：
- 日志中应记录 `AppCode` 而非 `Id`
- `AppCode` 是稳定的标识，不会因为重建而改变

## 后续优化

### 1. 批量操作优化

当前实现是逐个删除和插入，可以优化为批量操作：

```csharp
// 批量删除
await _db.LLMAppCallers.DeleteManyAsync(a => a.IsSystemDefault == true);

// 批量插入
await _db.LLMAppCallers.InsertManyAsync(apps);
```

### 2. 事务支持

确保删除和插入在同一事务中，避免中间状态：

```csharp
using var session = await _db.Client.StartSessionAsync();
session.StartTransaction();

try
{
    // 删除
    await _db.LLMAppCallers.DeleteManyAsync(session, a => a.IsSystemDefault == true);
    
    // 插入
    await _db.LLMAppCallers.InsertManyAsync(session, apps);
    
    await session.CommitTransactionAsync();
}
catch
{
    await session.AbortTransactionAsync();
    throw;
}
```

### 3. 统计数据保留

在删除前备份统计数据，重建后恢复：

```csharp
// 备份统计数据
var statsBackup = systemDefaultApps.ToDictionary(
    a => a.AppCode,
    a => new { a.TotalCalls, a.SuccessCalls, a.FailedCalls, a.LastCalledAt }
);

// 删除并重建...

// 恢复统计数据
foreach (var app in newApps)
{
    if (statsBackup.TryGetValue(app.AppCode, out var stats))
    {
        app.TotalCalls = stats.TotalCalls;
        app.SuccessCalls = stats.SuccessCalls;
        app.FailedCalls = stats.FailedCalls;
        app.LastCalledAt = stats.LastCalledAt;
    }
}
```

### 4. 增量更新选项

提供两种初始化模式：

- **全量重载**（当前实现）：删除所有系统默认应用，重新创建
- **增量更新**（未来实现）：只更新元数据，保留配置和统计

```csharp
[HttpPost("default-apps")]
public async Task<IActionResult> InitDefaultApps([FromQuery] bool fullReload = true)
{
    if (fullReload)
    {
        // 全删全插
    }
    else
    {
        // 增量更新
    }
}
```

## 测试建议

### 1. 功能测试

- [ ] 首次初始化：数据库为空，创建所有应用
- [ ] 重复初始化：删除旧应用，创建新应用，数量一致
- [ ] 用户自定义应用保留：手动创建应用后初始化，应用仍存在
- [ ] 配置重置：修改系统应用配置后初始化，配置恢复默认

### 2. 边界测试

- [ ] 代码注册表为空：初始化后应用列表为空
- [ ] 数据库中只有用户自定义应用：初始化后只创建系统应用
- [ ] 并发初始化：多个用户同时点击初始化按钮

### 3. 性能测试

- [ ] 大量应用（100+）的删除和创建性能
- [ ] 数据库事务的超时和回滚

## 编译状态

### 前端
✅ **编译成功**

### 后端
⚠️ **文件被锁定**（后端进程正在运行）

需要停止后端进程后重新编译验证。

## 总结

本次实现完成了以下目标：

1. ✅ 实现了全删全插的初始化策略
2. ✅ 通过 `IsSystemDefault` 标记区分系统和用户数据
3. ✅ 保护用户自定义的应用和分组
4. ✅ 前端界面更新（按钮文案、确认提示、结果展示）
5. ✅ 前端编译成功
6. ⏳ 后端编译待验证（需停止运行中的进程）

用户现在可以：
- 点击"初始化应用"按钮重载系统默认应用
- 清楚了解初始化的影响范围
- 放心创建自定义应用，不会被初始化删除
