# 应用调用者幂等初始化设计

## 核心原则

1. **幂等性**：多次初始化不会重复创建，不会覆盖用户配置
2. **兼容性**：保留用户已有的模型配置和自定义设置
3. **统一策略**：初始化和扫描使用同一套机制

## 设计方案

### 1. 应用标识结构

采用分层应用标识：`{AppName}.{Module}.{Action}`

**示例**：
- `PrdDesktop.Chat.SendMessage` - 桌面端聊天发送消息
- `PrdAdmin.Chat.SendMessage` - 管理后台聊天发送消息
- `PrdDesktop.PRD.Analyze` - 桌面端 PRD 分析
- `OpenPlatform.Proxy.Chat` - 开放平台代理聊天

### 2. 静态注册表管理

**文件**: `prd-api/src/PrdAgent.Core/Models/AppCallerRegistry.cs`

```csharp
public static class AppCallerRegistry
{
    public static class PrdDesktop
    {
        public static class Chat
        {
            [AppCallerMetadata(
                "桌面端-聊天消息",
                "用户在桌面端发送聊天消息",
                ModelTypes = new[] { ModelTypes.Chat },
                Category = "Chat"
            )]
            public const string SendMessage = "PrdDesktop.Chat.SendMessage";
        }
    }
}
```

**优点**：
- ✅ 编译时类型安全
- ✅ 集中管理，易于查找
- ✅ 支持反射自动发现
- ✅ 通过 Attribute 扩展元数据

### 3. 幂等初始化策略

**端点**: `POST /api/v1/admin/init/default-apps`

**逻辑**：

```csharp
foreach (var def in AppCallerRegistrationService.GetAllDefinitions())
{
    var existing = await _db.LLMAppCallers.Find(a => a.AppCode == def.AppCode).FirstOrDefaultAsync();
    
    if (existing != null)
    {
        // 应用已存在
        bool needsUpdate = false;
        
        // 只更新元数据（DisplayName、Description）
        if (existing.DisplayName != def.DisplayName)
        {
            existing.DisplayName = def.DisplayName;
            needsUpdate = true;
        }
        
        // 如果是自动注册的应用且没有自定义需求，可以更新默认需求
        if (existing.IsAutoRegistered && (existing.ModelRequirements == null || existing.ModelRequirements.Count == 0))
        {
            existing.ModelRequirements = def.ModelTypes.Select(mt => new AppModelRequirement
            {
                ModelType = mt,
                Purpose = $"用于{def.DisplayName}",
                IsRequired = true
            }).ToList();
            needsUpdate = true;
        }
        
        if (needsUpdate)
        {
            existing.UpdatedAt = DateTime.UtcNow;
            await _db.LLMAppCallers.ReplaceOneAsync(a => a.Id == existing.Id, existing);
            updated.Add(def.AppCode);
        }
        else
        {
            skipped.Add(def.AppCode);
        }
        
        continue;
    }
    
    // 创建新应用
    var app = new LLMAppCaller
    {
        AppCode = def.AppCode,
        DisplayName = def.DisplayName,
        Description = def.Description,
        ModelRequirements = def.ModelTypes.Select(mt => new AppModelRequirement
        {
            ModelType = mt,
            Purpose = $"用于{def.DisplayName}",
            IsRequired = true,
            ModelGroupId = null // 使用默认分组
        }).ToList(),
        IsAutoRegistered = false // 初始化的应用标记为非自动注册
    };
    
    await _db.LLMAppCallers.InsertOneAsync(app);
    created.Add(def.AppCode);
}

return Ok(new {
    created,
    updated,
    skipped,
    total = definitions.Count,
    message = $"创建 {created.Count} 个，更新 {updated.Count} 个，跳过 {skipped.Count} 个"
});
```

### 4. 保护用户配置的规则

| 场景 | 行为 |
|------|------|
| 应用不存在 | 创建新应用，使用默认配置 |
| 应用已存在 + 用户已配置模型 | **不覆盖**，只更新元数据 |
| 应用已存在 + 自动注册 + 无配置 | 更新为默认配置 |
| 应用已存在 + 手动创建 | **不覆盖**，完全保留用户配置 |

### 5. 全局扫描（未来实现）

**端点**: `POST /api/v1/admin/init/scan`

**原理**：
1. 从 `LlmRequestLog` 中扫描所有出现过的 `AppCallerCode`
2. 与已注册应用对比，发现未登记的应用
3. 自动创建应用记录，标记为 `IsAutoRegistered = true`

**前置条件**：
- `LlmRequestLog` 需要添加 `AppCallerCode` 字段
- 业务代码需要改造成使用 `SmartModelScheduler`

## 使用场景

### 场景 1：首次初始化

1. 用户点击"初始化默认应用"
2. 系统创建所有预定义应用
3. 返回：`创建 13 个，更新 0 个，跳过 0 个`

### 场景 2：重复初始化（无修改）

1. 用户再次点击"初始化默认应用"
2. 系统检测到所有应用已存在且无需更新
3. 返回：`创建 0 个，更新 0 个，跳过 13 个`

### 场景 3：用户自定义后重新初始化

1. 用户修改了 `PrdDesktop.Chat.SendMessage` 的模型配置
2. 用户点击"初始化默认应用"
3. 系统检测到该应用已存在且有用户配置
4. **不覆盖用户配置**，只更新 DisplayName/Description（如果有变化）
5. 返回：`创建 0 个，更新 1 个，跳过 12 个`

### 场景 4：新增应用后初始化

1. 开发者在 `AppCallerRegistry` 中添加了新应用
2. 用户点击"初始化默认应用"
3. 系统创建新应用，保留已有应用
4. 返回：`创建 1 个，更新 0 个，跳过 13 个`

## 前端交互

### 初始化按钮

```typescript
const handleInitDefaultApps = async () => {
  const confirmed = await systemDialog.confirm({
    title: '确认初始化',
    message: '此操作将创建/更新默认应用，已有配置不会被覆盖。确定继续？',
  });
  if (!confirmed) return;

  try {
    const token = useAuthStore.getState().token;
    const response = await fetch(`${API_BASE}/admin/init/default-apps`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });

    const result = await response.json();
    systemDialog.success('初始化成功', result.data.message);
    await loadData();
  } catch (error) {
    systemDialog.error('初始化失败', String(error));
  }
};
```

### 显示结果

```
初始化成功
创建 2 个，更新 1 个，跳过 10 个
```

## 优势

1. **安全性**：不会意外覆盖用户配置
2. **灵活性**：支持增量更新，可以随时添加新应用
3. **可维护性**：集中管理应用定义，易于查找和修改
4. **类型安全**：编译时检查，避免拼写错误
5. **可扩展性**：通过 Attribute 轻松添加元数据

## 后续计划

1. **完成后端实现**：修复 `AdminInitController.cs` 的编译错误
2. **增强日志系统**：在 `LlmRequestLog` 添加 `AppCallerCode` 字段
3. **改造业务代码**：使用 `SmartModelScheduler` 并传入 `appCallerCode`
4. **实现全局扫描**：从日志中自动发现未注册的应用
5. **前端优化**：显示更详细的初始化结果（哪些创建、哪些更新、哪些跳过）
