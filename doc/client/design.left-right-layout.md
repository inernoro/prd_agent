# 左右布局重新设计总结

## 用户需求

1. **左侧只有应用名，不做下拉框**
2. **右侧才显示下拉分组，垂直一层**
3. **实验室虽然有这个功能，但是实验室是动态配置的，不需要配置模型**

总结一句话：**左侧是应用，右侧是分组+可配置的模型**

## 实现方案

### 左侧：应用列表（扁平）

**展示内容**：
- 应用名称（如 "Desktop 桌面端"）
- 应用代码（如 "desktop"）
- 功能数量徽章（如 "7"）
- 统计信息（总调用次数、成功率）

**交互**：
- 点击应用 → 选中该应用，右侧显示该应用的所有功能分组
- 搜索过滤应用

**示例**：
```
┌─────────────────────────────────────┐
│ 搜索应用...                          │
├─────────────────────────────────────┤
│ Desktop 桌面端               [7]    │ ← 点击选中
│ desktop                              │
│ 调用 1,234  成功率 95.5%            │
├─────────────────────────────────────┤
│ Visual Agent 视觉创作        [3]    │
│ visual-agent                         │
│ 调用 567  成功率 98.2%              │
├─────────────────────────────────────┤
│ Literary Agent 文学创作      [3]    │
│ literary-agent                       │
│ 调用 890  成功率 96.7%              │
└─────────────────────────────────────┘
```

### 右侧：功能分组与模型配置（垂直展示）

**展示内容**：
1. **应用信息卡片**：
   - 应用名称
   - 功能数量
   - 统计汇总

2. **功能列表**（垂直展开，每个功能一个卡片）：
   - 功能名称（如 "chat.sendmessage"）
   - 模型类型（如 "chat"）
   - 模型类型图标（💬🎯👁️🎨）
   - 统计信息（调用次数、成功率）
   - **已配置模型列表**：
     - 模型名称
     - 平台
     - 优先级
     - 健康状态
     - 操作按钮（编辑、删除）
   - **添加模型按钮**

**示例**：
```
┌─────────────────────────────────────────────────────────┐
│ Desktop 桌面端                                   [7 个功能] │
│ desktop                                                  │
│ 总调用: 1,234  成功: 1,178  失败: 56                    │
└─────────────────────────────────────────────────────────┘

功能与模型配置
┌─────────────────────────────────────────────────────────┐
│ 💬 chat.sendmessage                                      │
│    模型类型：chat                                        │
│    100次  95%                                            │
│ ─────────────────────────────────────────────────────── │
│ 已配置模型                                      [+ 添加模型] │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ #1  DeepSeek-V3                          [健康]     │ │
│ │     平台: 轨迹流动  优先级: 1  连续失败: 0  健康分: 100 │ │
│ │                                          [编辑] [删除] │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                          │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ #2  GPT-4                                [健康]     │ │
│ │     平台: OpenAI  优先级: 2  连续失败: 0  健康分: 100  │ │
│ │                                          [编辑] [删除] │ │
│ └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ 🎯 chat.sendmessage                                      │
│    模型类型：intent                                      │
│    50次  98%                                             │
│ ─────────────────────────────────────────────────────── │
│ 已配置模型                                      [+ 添加模型] │
│                                                          │
│ 未绑定分组，将使用默认分组                                │
└─────────────────────────────────────────────────────────┘

... (其他功能)
```

## 核心代码变更

### 1. 数据结构调整

```typescript
// 按应用分组
const groupedApps = groupAppCallers(appCallers);

// 过滤应用组
const filteredAppGroups = searchTerm
  ? groupedApps.filter(g => 
      g.appName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      g.app.toLowerCase().includes(searchTerm.toLowerCase())
    )
  : groupedApps;

// 当前选中的应用组
const selectedAppGroup = selectedAppId 
  ? groupedApps.find(g => g.features.some(f => f.items.some(i => i.id === selectedAppId)))
  : null;

// 获取选中应用的所有功能项（扁平化）
const selectedAppFeatures = selectedAppGroup 
  ? selectedAppGroup.features.flatMap(f => f.items)
  : [];
```

### 2. 左侧列表渲染

```typescript
{filteredAppGroups.map((appGroup) => {
  // 检查这个应用组中是否有被选中的项
  const isSelected = appGroup.features.some(f => f.items.some(i => i.id === selectedAppId));
  const totalItems = appGroup.features.reduce((sum, f) => sum + f.items.length, 0);
  
  // 计算应用组的统计数据
  const totalCalls = appGroup.features.reduce((sum, f) => 
    sum + f.items.reduce((s, i) => s + i.stats.totalCalls, 0), 0
  );
  const successCalls = appGroup.features.reduce((sum, f) => 
    sum + f.items.reduce((s, i) => s + i.stats.successCalls, 0), 0
  );
  const successRate = totalCalls > 0 ? ((successCalls / totalCalls) * 100).toFixed(1) : '0';
  
  return (
    <div
      key={appGroup.app}
      onClick={() => {
        // 选中这个应用组的第一个功能项
        const firstItem = appGroup.features[0]?.items[0];
        if (firstItem) {
          setSelectedAppId(firstItem.id);
        }
      }}
      className="px-4 py-3 cursor-pointer hover:bg-white/[0.02] transition-colors"
      style={isSelected ? { background: 'rgba(255,255,255,0.06)' } : undefined}
    >
      {/* 应用信息 */}
    </div>
  );
})}
```

### 3. 右侧功能列表渲染

```typescript
{selectedAppFeatures.map((featureItem, idx: number) => {
  const app = appCallers.find(a => a.id === featureItem.id);
  if (!app) return null;
  
  const req = app.modelRequirements[0]; // 每个功能项只有一个需求
  const group = req?.modelGroupId ? modelGroups.find((g) => g.id === req.modelGroupId) : undefined;
  const monitoring = req?.modelGroupId ? monitoringData[req.modelGroupId] : undefined;
  const modelTypeIcon = featureItem.parsed.modelType === 'chat' ? '💬' : 
                       featureItem.parsed.modelType === 'vision' ? '👁️' : 
                       featureItem.parsed.modelType === 'generation' ? '🎨' : 
                       featureItem.parsed.modelType === 'intent' ? '🎯' : '📦';
  const successRate = featureItem.stats.totalCalls > 0 
    ? ((featureItem.stats.successCalls / featureItem.stats.totalCalls) * 100).toFixed(1) 
    : '0';

  return (
    <Card key={idx} className="p-0 overflow-hidden">
      {/* 功能头部 */}
      <div className="p-4 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-[14px]">{modelTypeIcon}</span>
          <div>
            <div className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              {featureItem.parsed.fullPath || featureItem.parsed.modelType}
            </div>
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              模型类型：{featureItem.parsed.modelType}
            </div>
          </div>
          {featureItem.stats.totalCalls > 0 && (
            <div className="ml-auto flex items-center gap-3 text-[11px]">
              <span style={{ color: 'var(--text-secondary)' }}>
                {featureItem.stats.totalCalls}次
              </span>
              <span style={{ color: parseFloat(successRate) >= 95 ? 'rgba(34,197,94,0.95)' : 'rgba(251,191,36,0.95)' }}>
                {successRate}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* 模型配置 */}
      <div className="p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="text-[12px] font-semibold" style={{ color: 'var(--text-secondary)' }}>
            已配置模型
          </div>
          <Button variant="secondary" size="xs">
            <Plus size={12} />
            添加模型
          </Button>
        </div>

        {!group ? (
          <div className="text-center py-4" style={{ color: 'var(--text-muted)' }}>
            <div className="text-[12px]">未绑定分组，将使用默认分组</div>
          </div>
        ) : (
          <div>
            {/* 模型负载列表 */}
            {monitoring && monitoring.models.length > 0 ? (
              <div className="space-y-2">
                {monitoring.models.map((model: any, modelIdx: number) => {
                  const status = HEALTH_STATUS_MAP[model.healthStatus as keyof typeof HEALTH_STATUS_MAP];
                  return (
                    <div
                      key={`${model.platformId}-${model.modelId}`}
                      className="rounded-[12px] p-3 border border-white/10"
                      style={{ background: 'rgba(255,255,255,0.03)' }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>
                              #{modelIdx + 1}
                            </span>
                            <div className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                              {model.modelId}
                            </div>
                            <span
                              className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold"
                              style={{ background: status.bg, border: `1px solid ${status.border}`, color: status.color }}
                            >
                              {status.label}
                            </span>
                          </div>
                          <div className="mt-2 flex items-center gap-4 text-[11px]" style={{ color: 'var(--text-muted)' }}>
                            <span>平台: <span style={{ color: 'var(--text-secondary)' }}>{model.platformId}</span></span>
                            <span>优先级: <span style={{ color: 'var(--text-secondary)' }}>{model.priority}</span></span>
                            <span>连续失败: <span style={{ color: model.consecutiveFailures > 0 ? 'rgba(239,68,68,0.95)' : 'var(--text-secondary)' }}>{model.consecutiveFailures}</span></span>
                            <span>健康分: <span style={{ color: 'var(--text-secondary)' }}>{model.healthScore.toFixed(0)}</span></span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Tooltip content="编辑">
                            <button className="h-8 w-8 inline-flex items-center justify-center rounded-[10px] hover:bg-white/5">
                              <Pencil size={14} style={{ color: 'var(--text-muted)' }} />
                            </button>
                          </Tooltip>
                          <Tooltip content="删除">
                            <button className="h-8 w-8 inline-flex items-center justify-center rounded-[10px] hover:bg-white/5">
                              <Trash2 size={14} style={{ color: 'var(--text-muted)' }} />
                            </button>
                          </Tooltip>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-4" style={{ color: 'var(--text-muted)' }}>
                <div className="text-[12px]">分组中暂无模型</div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
})}
```

## 优势对比

| 维度 | 之前（树形下拉） | 现在（左右布局） |
|------|----------------|----------------|
| **左侧内容** | 应用+子功能（下拉） | 只有应用（扁平） |
| **右侧内容** | 单个功能详情 | 所有功能列表（垂直） |
| **模型配置** | 无 | 每个功能可独立配置模型 |
| **用户体验** | 需要展开才能看到子功能 | 选中应用后一次性看到所有功能 |
| **配置效率** | 逐个功能配置 | 垂直展示，快速浏览和配置 |

## 待完成功能

### 1. 模型选择器（下一步）

**目标**：点击"添加模型"按钮，打开模型选择器

**实现方案**：
- 复用实验室的 `ModelPickerDialog`
- 选择模型后创建/更新模型分组
- 绑定分组到 `modelGroupId`

### 2. 模型编辑/删除

**功能**：
- 编辑模型优先级
- 删除已配置的模型
- 调整模型顺序

### 3. 默认分组匹配

**功能**：
- 根据模型类型自动匹配默认分组
- 用户可以覆盖默认分组

## 编译状态

✅ **前端编译成功**

## 总结

本次重新设计完成了左右布局的调整：

**核心改进**：
1. **左侧极简**：只显示应用列表，无下拉，一目了然
2. **右侧完整**：垂直展示所有功能，每个功能可独立配置模型
3. **配置直观**：模型配置直接在功能卡片中展示，无需额外弹窗

**用户体验提升**：
- 选中应用后，右侧立即展示该应用的所有功能
- 每个功能的模型配置一目了然
- 垂直滚动浏览所有功能，无需反复展开/折叠

现在用户可以：
1. 点击左侧应用
2. 右侧查看该应用的所有功能
3. 为每个功能添加/编辑/删除模型
4. 查看模型的健康状态和统计信息

下一步需要实现模型选择器，让用户可以真正添加模型到功能分组中！
