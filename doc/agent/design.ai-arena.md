# AI 竞技场 (AI Arena) - 设计方案

> **版本**: v3.0 | **日期**: 2026-02-24
>
> **v3.0 变更**: 用户页与管理页完全分离 + 盲评模式（参考 arena.ai）。
> **v2.0 变更**: 废弃自动扫描方案，改为管理员手动配置槽位。

## 1. 需求概述

### 1.1 核心体验

用户进入独立的 AI 竞技场页面，输入问题后系统将问题并行发送给多个 AI 模型。**响应以匿名形式（助手 A / 助手 B / ...）展示**，用户先阅读回答内容，手动点击"揭晓模型"后才显示每个助手对应的真实模型名称。

### 1.2 两个独立界面

| 界面 | 路由 | 受众 | 定位 |
|------|------|------|------|
| **用户对战页** | `/arena` | 所有用户 | 盲评对战 + 聊天体验 |
| **管理配置页** | `/lab?tab=arena` | 管理员 | 槽位/分组 CRUD 管理 |

### 1.3 与 arena.ai 对标

| 维度 | arena.ai | 我们的竞技场 |
|------|----------|------------|
| 对战模式 | 2 个模型对战 | N 个模型同时对战（管理员配置） |
| 匿名展示 | 助手 A / 助手 B | 助手 A / B / C / ... |
| 揭晓机制 | 投票后揭晓 | 用户手动点击揭晓（v1 不做投票） |
| 历史记录 | 左侧边栏 | 左侧边栏 |
| 多轮追问 | 支持 | v1 仅单轮 |

## 2. 槽位 (Slot) 机制（不变）

### 2.1 设计理念

```
┌──────────────────────────────────────────────────────┐
│  竞技场不关心"系统里配了哪些模型"                         │
│  竞技场只关心"管理员放了哪些选手到擂台上"                  │
│                                                      │
│  槽位 = 擂台上的一个参赛席位                              │
│  管理员填充槽位 = 把一个 AI 选手安排到席位上               │
│  槽位只需要：平台 + 模型名 + 显示名                       │
│  不依赖 llm_models 表，不污染现有模型管理                  │
└──────────────────────────────────────────────────────┘
```

### 2.2 数据模型

**新增 MongoDB 集合：`arena_slots`**

```typescript
interface ArenaSlot {
  id: string;
  displayName: string;         // "GPT-4o"（揭晓后展示）
  platformId: string;          // 关联平台 ID
  modelId: string;             // 平台侧模型标识
  group: string;               // 所属分组 key
  sortOrder: number;
  enabled: boolean;
  avatarColor?: string;        // "#10a37f"
  description?: string;        // "OpenAI 旗舰模型"
  createdBy: string;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**新增 MongoDB 集合：`arena_groups`**

```typescript
interface ArenaGroup {
  id: string;
  key: string;                 // "global-frontier"
  name: string;                // "全球前沿"
  description?: string;
  sortOrder: number;
  icon?: string;
  createdBy: string;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**新增 MongoDB 集合：`arena_battles`**（对战记录）

```typescript
interface ArenaBattle {
  id: string;
  userId: string;              // 发起用户
  prompt: string;              // 用户提问
  groupKey: string;            // 使用的分组
  responses: ArenaBattleResponse[];
  revealed: boolean;           // 是否已揭晓
  createdAt: DateTime;
}

interface ArenaBattleResponse {
  slotId: string;
  label: string;               // "助手 A" / "助手 B" / ...
  displayName: string;         // 揭晓后显示 "GPT-4o"
  platformId: string;
  modelId: string;
  content: string;             // 完整回答文本
  ttftMs?: number;
  totalMs?: number;
  status: 'done' | 'error';
  errorMessage?: string;
}
```

## 3. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│  用户侧                                                      │
│                                                             │
│  /arena (独立页面)                                            │
│  ┌─────────────┬───────────────────────────────────────┐    │
│  │ 侧边栏       │              主区域                     │    │
│  │ ┌─────────┐ │  ┌─────────────────────────────────┐  │    │
│  │ │新建对战   │ │  │ 用户提问 (右对齐气泡)              │  │    │
│  │ ├─────────┤ │  │                                 │  │    │
│  │ │搜索      │ │  │ ┌──────────┐ ┌──────────┐      │  │    │
│  │ ├─────────┤ │  │ │ 助手 A   │ │ 助手 B   │ ...  │  │    │
│  │ │历史记录   │ │  │ │ (匿名)   │ │ (匿名)   │      │  │    │
│  │ │· 今天     │ │  │ │ 流式输出 │ │ 流式输出 │      │  │    │
│  │ │· 昨天     │ │  │ └──────────┘ └──────────┘      │  │    │
│  │ │· 更早     │ │  │                                 │  │    │
│  │ └─────────┘ │  │          [揭晓模型]               │  │    │
│  │             │  ├─────────────────────────────────┤  │    │
│  │             │  │ 输入框: 请输入问题...      [发送]  │  │    │
│  │             │  └─────────────────────────────────┘  │    │
│  └─────────────┴───────────────────────────────────────┘    │
│                         │                                    │
│                         │ SSE Stream                         │
│                         ▼                                    │
│              POST /api/lab/model/runs/stream (复用)           │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  管理侧                                                      │
│                                                             │
│  /lab?tab=arena (实验室的一个Tab)                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 分组管理 + 槽位 CRUD (与 v2.0 设计相同)                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                         │                                    │
│                         ▼                                    │
│              CRUD /api/lab/arena/groups & /slots              │
└─────────────────────────────────────────────────────────────┘
```

## 4. 后端设计

### 4.1 ArenaController（管理侧 CRUD）

路由前缀：`/api/lab/arena`，权限：`lab.read` / `lab.write`

```csharp
[ApiController]
[Route("api/lab/arena")]
[Authorize]
[AdminController("lab", AdminPermissionCatalog.LabRead, WritePermission = AdminPermissionCatalog.LabWrite)]
public class ArenaController : ControllerBase
{
    // ─── 分组 CRUD ───
    [HttpGet("groups")]         // 列出所有分组（含组内槽位）
    [HttpPost("groups")]        // 创建分组
    [HttpPut("groups/{id}")]    // 更新分组
    [HttpDelete("groups/{id}")] // 删除分组（级联删除组内槽位）

    // ─── 槽位 CRUD ───
    [HttpGet("slots")]              // 列出槽位（可按 group 过滤）
    [HttpPost("slots")]             // 创建槽位
    [HttpPut("slots/{id}")]         // 更新槽位
    [HttpDelete("slots/{id}")]      // 删除槽位
    [HttpPut("slots/{id}/toggle")]  // 快速启用/禁用

    // ─── 用户侧聚合 ───
    [HttpGet("lineup")]    // 返回当前阵容（仅 enabled=true）
    [HttpGet("battles")]   // 查询用户历史对战记录
}
```

### 4.2 Lineup 接口（用户侧）

```typescript
// GET /api/lab/arena/lineup
interface ArenaLineup {
  groups: ArenaLineupGroup[];
  totalSlots: number;
}

interface ArenaLineupGroup {
  key: string;               // "global-frontier"
  name: string;              // "全球前沿"
  slots: ArenaLineupSlot[];
}

interface ArenaLineupSlot {
  id: string;                // 槽位 ID
  platformId: string;        // 发起调用需要
  modelId: string;           // 发起调用需要
  // 注意：不返回 displayName！盲评模式下前端不知道模型身份
}
```

**关键**：lineup 接口**不返回 displayName**。前端只拿到 `platformId + modelId`，用于发起 SSE 流。在前端侧，每个 slot 被随机分配为 "助手 A / B / C ..."。

### 4.3 揭晓接口

```typescript
// POST /api/lab/arena/reveal
// Body: { battleId: string } 或 { slotIds: string[] }
// 返回每个 slotId → displayName 的映射
interface ArenaRevealResponse {
  reveals: Array<{
    slotId: string;
    displayName: string;     // "GPT-4o"
    platformName: string;    // "OpenAI"
    avatarColor?: string;    // "#10a37f"
    description?: string;    // "OpenAI 旗舰模型"
  }>;
}
```

用户点击"揭晓模型"后，前端调此接口拿到真实身份，再更新卡片 header。

### 4.4 对战记录保存

```typescript
// POST /api/lab/arena/battles
// 在 runDone 后自动保存对战记录
interface SaveBattleRequest {
  prompt: string;
  groupKey: string;
  responses: Array<{
    slotId: string;
    label: string;        // "助手 A"
    content: string;
    ttftMs?: number;
    totalMs?: number;
    status: 'done' | 'error';
    errorMessage?: string;
  }>;
}

// GET /api/lab/arena/battles?page=1&pageSize=20
// 返回用户的历史对战列表（用于侧边栏）
```

### 4.5 AppCallerCode

```csharp
public static class Arena
{
    [AppCallerMetadata(
        displayName: "AI竞技场-对战",
        description: "AI竞技场盲评对战",
        ModelTypes: new[] { ModelTypes.Chat },
        Category: "Arena"
    )]
    public const string Query = "prd-agent-web.arena.query::chat";
}
```

### 4.6 复用 ModelLab RunStream

对战发起时，前端调用现有 `POST /api/lab/model/runs/stream`：

```json
{
  "promptText": "用户的问题",
  "models": [
    { "platformId": "plt_openai", "modelId": "gpt-4o", "modelName": "gpt-4o" },
    { "platformId": "plt_anthropic", "modelId": "claude-3-5-sonnet", "modelName": "claude-3-5-sonnet" }
  ],
  "params": { "maxConcurrency": 20, "repeatN": 1 }
}
```

前端收到 SSE 事件后，**不使用事件中的模型名**，而是按 slotId → label 映射展示为 "助手 A / B / C"。

## 5. 用户页前端设计

### 5.1 新增文件

```
prd-admin/src/pages/arena/
├── ArenaPage.tsx                  # 用户对战页（独立路由 /arena）
└── components/
    ├── ArenaSidebar.tsx            # 左侧边栏：新建对战 + 历史记录
    ├── ArenaBattlePanel.tsx        # 主对战区域
    ├── ArenaResponsePanel.tsx      # 单个匿名助手的响应面板
    ├── ArenaRevealOverlay.tsx      # 揭晓动效 overlay
    └── ArenaComposer.tsx           # 底部输入框
```

### 5.2 用户页布局

```
┌─────────────────────────────────────────────────────────────────────┐
│ [≡]  AI 竞技场                              分组: [全球前沿 ▾]  [⚙]  │
├────────────┬────────────────────────────────────────────────────────┤
│            │                                                        │
│  新建对战   │                                                        │
│  ─────────  │    ┌────────────────────────────────────────────┐     │
│  搜索...    │    │                                            │     │
│  ─────────  │    │  用户                                      │     │
│            │    │  ┌──────────────────────────────────────┐  │     │
│  今天       │    │  │ 请解释一下量子计算的基本原理            │  │     │
│  · 量子计算  │    │  └──────────────────────────────────────┘  │     │
│  · 黑洞问题  │    │                                            │     │
│            │    │  ┌───────────────────┐ ┌─────────────────┐ │     │
│  昨天       │    │  │ 助手 A             │ │ 助手 B           │ │     │
│  · 代码优化  │    │  │                   │ │                 │ │     │
│            │    │  │ 量子计算是一种利用  │ │ 量子计算是基于   │ │     │
│  更早       │    │  │ 量子力学原理进行   │ │ 量子力学中量子   │ │     │
│  · ...     │    │  │ 信息处理的计算方式  │ │ 比特的叠加和纠   │ │     │
│            │    │  │ ...               │ │ 缠效应的新型计   │ │     │
│            │    │  │                   │ │ 算范式...        │ │     │
│            │    │  │            [展开]  │ │          [展开]  │ │     │
│            │    │  └───────────────────┘ └─────────────────┘ │     │
│            │    │                                            │     │
│            │    │  ┌───────────────────┐ ┌─────────────────┐ │     │
│            │    │  │ 助手 C             │ │ 助手 D           │ │     │
│            │    │  │                   │ │                 │ │     │
│            │    │  │ 量子计算与传统计算  │ │ ···正在思考中     │ │     │
│            │    │  │ 最大的不同在于...  │ │                 │ │     │
│            │    │  │            [展开]  │ │                 │ │     │
│            │    │  └───────────────────┘ └─────────────────┘ │     │
│            │    │                                            │     │
│            │    │           ┌──────────────────┐             │     │
│            │    │           │  👁 揭晓模型身份   │             │     │
│            │    │           └──────────────────┘             │     │
│            │    │                                            │     │
│            │    └────────────────────────────────────────────┘     │
│            │                                                        │
│            ├────────────────────────────────────────────────────────┤
│            │  ┌──────────────────────────────────────────┐ [发送]  │
│            │  │ 输入你的问题...                            │         │
│            │  └──────────────────────────────────────────┘         │
└────────────┴────────────────────────────────────────────────────────┘
```

### 5.3 揭晓前 vs 揭晓后

**揭晓前**（盲评状态）：

```
┌───────────────────┐
│ 助手 A        [展开] │
│ ─────────────────  │
│                    │
│ 量子计算是一种利用  │
│ 量子力学原理进行   │
│ 信息处理的计算方式  │
│ ...               │
│                    │
│ [复制]             │
└───────────────────┘
```

- Header 仅显示 **"助手 A"**，无任何模型身份提示
- 无平台标签、无颜色、无图标
- 所有卡片外观完全一致，避免暗示

**揭晓后**（点击"揭晓模型身份"）：

```
┌───────────────────┐
│ ■ 助手 A → GPT-4o  │
│   OpenAI     [展开] │
│ ─────────────────  │
│                    │
│ 量子计算是一种利用  │
│ 量子力学原理进行   │
│ 信息处理的计算方式  │
│ ...               │
│                    │
│ TTFT: 82ms | 1.2s │
│ [复制]             │
└───────────────────┘
```

- Header 变为 **"助手 A → GPT-4o"**，带平台标签和主题色
- 性能指标（TTFT、总耗时）揭晓后才显示
- 揭晓动画：卡片轻微震动 + 标签翻转效果

### 5.4 交互流程

```
用户对战流程：

1. 进入 /arena 页面
2. 自动加载 lineup（拿到槽位列表，但不含模型名）
3. 用户选择分组（默认"全部"）
4. 用户输入问题，点击"发送"或按 Enter
5. 前端为每个槽位分配匿名标签：助手 A / B / C / D ...
   - 分配顺序随机打乱（避免"第一个永远是 GPT"的暗示）
6. 调用 POST /api/lab/model/runs/stream 发起并行请求
7. SSE 事件驱动卡片更新：
   - modelStart → 卡片出现（显示"助手 X - 正在思考..."）
   - delta → 流式追加文本
   - modelDone → 标记完成（但仍然匿名）
   - modelError → 显示"助手 X - 回答失败"
   - runDone → 所有模型完成
8. 所有模型完成后，"揭晓模型身份"按钮高亮可点击
9. 用户点击揭晓 → 调用 POST /api/lab/arena/reveal
10. 卡片 header 播放揭晓动画，显示真实模型名 + 性能指标
11. 对战记录自动保存到 arena_battles
```

### 5.5 侧边栏历史

```
┌────────────┐
│  新建对战    │  ← 清空当前对话，开始新一轮
│  ──────────  │
│  🔍 搜索...  │  ← 按提问内容搜索
│  ──────────  │
│  今天        │
│  · 量子计算   │  ← 显示 prompt 摘要（前20字）
│  · 黑洞问题   │
│  ──────────  │
│  昨天        │
│  · 代码优化   │
│  · React性能  │
│  ──────────  │
│  更早        │
│  · ...      │
└────────────┘
```

点击历史记录 → 加载对应的 battle 数据 → 渲染回答（已揭晓的保持揭晓状态）

### 5.6 路由注册

```typescript
// App.tsx
<Route path="/arena" element={
  <RequirePermission perm="access">
    <ArenaPage />
  </RequirePermission>
} />
```

**不在 LabPage 内**，而是独立的一级路由。导航菜单中作为独立入口。

### 5.7 状态管理

```typescript
interface ArenaPageState {
  // 阵容
  lineup: ArenaLineup | null;
  selectedGroupKey: string | 'all';

  // 当前对战
  currentBattleId: string | null;
  prompt: string;
  isRunning: boolean;
  revealed: boolean;              // 是否已揭晓

  // 匿名映射（前端生成，随机打乱）
  slotLabelMap: Map<string, string>;  // slotId → "助手 A"

  // 响应面板
  panels: Map<string, ArenaPanel>;

  // 揭晓数据
  revealData: Map<string, RevealInfo> | null;

  // 历史
  battles: ArenaBattle[];
  battlesLoading: boolean;
}

interface ArenaPanel {
  slotId: string;
  label: string;               // "助手 A"（匿名标签）
  status: 'waiting' | 'streaming' | 'done' | 'error';
  text: string;
  ttftMs: number | null;
  totalMs: number | null;
  errorMessage: string | null;
}

interface RevealInfo {
  displayName: string;         // "GPT-4o"
  platformName: string;        // "OpenAI"
  avatarColor?: string;
  description?: string;
}
```

## 6. 管理页前端设计

### 6.1 位置

在 LabPage.tsx 新增 "AI 竞技场" Tab（管理员看到的配置入口）：

```diff
+ { key: 'arena', label: 'AI 竞技场', icon: <Swords size={14} /> },
```

### 6.2 管理页组件

```
prd-admin/src/pages/lab-arena/
├── ArenaConfigTab.tsx             # Lab Tab 内的管理页
└── components/
    ├── ArenaGroupList.tsx          # 分组列表（可折叠）
    ├── ArenaSlotCard.tsx           # 槽位卡片（编辑/删除/启用禁用）
    ├── ArenaGroupDialog.tsx        # 新建/编辑分组弹窗
    └── ArenaSlotDialog.tsx         # 新建/编辑槽位弹窗
```

### 6.3 管理页布局

```
┌───────────────────────────────────────────────────────────────┐
│ [试验车间] [大模型实验室] [桌面实验室] [特效展示] [AI 竞技场]      │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  竞技场选手管理                                    [+ 新建分组]  │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │ ▼ 全球前沿 (4 个选手)                         [编辑] [删除] │ │
│  │                                                         │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐  │ │
│  │  │ ■ GPT-4o │ │ ■ Claude │ │ ■ Gemini │ │ ■ Grok   │  │ │
│  │  │ OpenAI   │ │ Anthro.  │ │ Google   │ │ xAI      │  │ │
│  │  │ gpt-4o   │ │ claude.. │ │ gemini.. │ │ grok-2   │  │ │
│  │  │ ✓ 启用   │ │ ✓ 启用   │ │ ✓ 启用   │ │ ✓ 启用   │  │ │
│  │  │[编辑][删] │ │[编辑][删] │ │[编辑][删] │ │[编辑][删] │  │ │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘  │ │
│  │                                               [+ 添加]  │ │
│  │                                                         │ │
│  │ ▼ 国产前沿 (3 个选手)                         [编辑] [删除] │ │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐               │ │
│  │  │DeepSeek  │ │ Qwen-Max │ │ 豆包      │               │ │
│  │  │ ✓ 启用   │ │ ✓ 启用   │ │ ✗ 禁用   │               │ │
│  │  └──────────┘ └──────────┘ └──────────┘               │ │
│  │                                               [+ 添加]  │ │
│  │                                                         │ │
│  │ ▶ 推理专精 (3 个选手)                         [编辑] [删除] │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  提示：用户在 /arena 页面对战时，模型名称以匿名方式展示            │
│  （助手 A / B / C ...），用户手动点击后才揭晓真实身份。             │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 6.4 添加槽位弹窗

```
┌──────────────────────────────────┐
│ 添加选手                          │
├──────────────────────────────────┤
│                                  │
│ 显示名称 *                        │
│ ┌──────────────────────────────┐ │
│ │ GPT-4o                       │ │
│ └──────────────────────────────┘ │
│                                  │
│ 平台 *                           │
│ ┌──────────────────────────────┐ │
│ │ ▾ 选择平台                    │ │  ← 从 llm_platforms 下拉
│ └──────────────────────────────┘ │
│                                  │
│ 模型标识 *                        │
│ ┌──────────────────────────────┐ │
│ │ gpt-4o                       │ │  ← 手动输入，自由填写
│ └──────────────────────────────┘ │
│ 提示：填写平台侧的模型 ID          │
│                                  │
│ 卡片颜色                          │
│ ┌──────────────────────────────┐ │
│ │ [#10a37f] ■                  │ │  ← 揭晓后显示的主题色
│ └──────────────────────────────┘ │
│                                  │
│ 描述                              │
│ ┌──────────────────────────────┐ │
│ │ OpenAI 旗舰多模态模型          │ │
│ └──────────────────────────────┘ │
│                                  │
│           [取消]      [确认添加]   │
└──────────────────────────────────┘
```

## 7. 盲评核心机制

### 7.1 匿名标签分配

```typescript
// 前端在发起对战时随机分配标签
const LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

function assignLabels(slots: ArenaLineupSlot[]): Map<string, string> {
  // 1. 复制 slots 数组
  const shuffled = [...slots];
  // 2. Fisher-Yates 随机打乱
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  // 3. 按打乱后顺序分配 A/B/C...
  const map = new Map<string, string>();
  shuffled.forEach((slot, idx) => {
    map.set(slot.id, `助手 ${LABELS[idx]}`);
  });
  return map;
}
```

**为什么前端打乱**：避免用户通过响应顺序猜测模型身份。每次对战分配都不同。

### 7.2 信息隔离策略

| 阶段 | 前端知道什么 | 前端展示什么 |
|------|------------|------------|
| 加载阵容 | slotId, platformId, modelId | 无（不展示阵容详情） |
| 发起对战 | 同上 | 仅"正在发送到 N 个 AI..." |
| 流式响应 | SSE 事件中的 itemId | **"助手 A / B / C ..."** |
| 揭晓前 | 内存中有 modelId（发请求必需） | **严格不展示** |
| 揭晓后 | displayName, platformName, color | 完整身份 + 性能指标 |

**注意**：前端发请求时必须知道 `platformId + modelId`（否则无法调用 SSE 接口），但 UI 层严格不暴露这些信息。盲评的"盲"是 UI 层面的匿名化，不是加密。

### 7.3 揭晓动效

```
揭晓前:                        揭晓后:
┌──────────────┐              ┌──────────────┐
│  助手 A       │  ──翻转──▶  │ ■ GPT-4o     │
│              │              │   OpenAI     │
│  (无颜色)     │              │  (绿色主题)   │
└──────────────┘              └──────────────┘

动画序列：
1. 所有卡片同时轻微缩小 (scale 0.98)
2. 卡片 header 区域翻转动画 (rotateX)
3. 翻转后显示真实模型名 + 平台 + 主题色
4. 卡片恢复原大小 + 弹性动画
5. 性能指标 (TTFT/耗时) 从底部滑入
```

## 8. 数据流

```
                  ┌──────────────┐
                  │   用户输入    │
                  │ "什么是量子计算" │
                  └──────┬───────┘
                         │
                         ▼
              ┌─────────────────────┐
              │   ArenaPage.tsx     │
              │ 1. 随机打乱 slots    │
              │ 2. 分配 助手A/B/C   │
              │ 3. 构建 models[]    │
              └──────────┬──────────┘
                         │ POST /api/lab/model/runs/stream
                         ▼
              ┌─────────────────────┐
              │  ModelLabController │
              │  RunStream()       │
              └──────────┬──────────┘
                         │ 并行调度
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
      ┌─────────┐  ┌─────────┐  ┌─────────┐
      │  Slot 1 │  │  Slot 2 │  │  Slot 3 │
      │ (gpt-4o)│  │(claude) │  │(deepseek)│
      └────┬────┘  └────┬────┘  └────┬────┘
           │             │             │
           ▼             ▼             ▼
      ┌──────────────────────────────────────┐
      │        SSE 事件流                      │
      │                                      │
      │  前端收到 delta 事件时：                 │
      │  - 不看 modelName                      │
      │  - 只按 itemId → slotId → label 映射   │
      │  - 展示为 "助手 A: 量子计算是..."        │
      └──────────────────┬───────────────────┘
                         │
                         ▼
              ┌─────────────────────┐
              │ ArenaBattlePanel    │
              │                    │
              │ [助手A] [助手B]     │  ← 匿名展示
              │ [助手C] [助手D]     │
              │                    │
              │  [👁 揭晓模型身份]   │  ← 用户手动触发
              └──────────┬──────────┘
                         │ POST /api/lab/arena/reveal
                         ▼
              ┌─────────────────────┐
              │ 揭晓动画            │
              │ 助手A → GPT-4o     │
              │ 助手B → Claude     │
              │ 助手C → DeepSeek   │
              │ 助手D → Qwen       │
              └─────────────────────┘
```

## 9. 实现步骤

### Phase 1: 后端

1. MongoDbContext 注册 `arena_slots`、`arena_groups`、`arena_battles`
2. ArenaController 实现 CRUD + lineup + reveal + battles 端点
3. AppCallerRegistry 注册 `Arena.Query`

### Phase 2: 前端 - 管理页

4. services 层新增 Arena 管理 API
5. ArenaConfigTab.tsx + 分组/槽位 CRUD 组件
6. LabPage.tsx 新增 Tab 入口

### Phase 3: 前端 - 用户页

7. services 层新增 lineup / reveal / battles API
8. ArenaPage.tsx 主页面（路由、布局）
9. ArenaSidebar.tsx 侧边栏（历史记录）
10. ArenaBattlePanel.tsx 对战区域（匿名卡片 + 揭晓）
11. ArenaComposer.tsx 底部输入框
12. App.tsx 注册 `/arena` 路由 + 导航菜单入口

## 10. 权限

| 操作 | 权限 |
|------|------|
| 访问用户对战页 `/arena` | `access`（基础权限） |
| 管理页配置槽位/分组 | `lab.write` |
| 查看管理页 | `lab.read` |

## 11. 数据库变更

| 集合名 | 用途 |
|--------|------|
| `arena_groups` | 分组配置 |
| `arena_slots` | 选手槽位 |
| `arena_battles` | 对战记录 |

## 12. 不做的事情 (Out of Scope v1)

- **不做投票/评分** — v1 仅做匿名展示 + 手动揭晓
- **不做 ELO 排行** — 没有投票就没有排行
- **不做多轮对话** — v1 仅单轮
- **不做自定义 system prompt** — 纯净对比
- **不做加密隔离** — 盲评是 UI 层匿名化，前端内存中有 modelId（发请求必需）

## 13. 验收标准

### 13.1 冒烟测试 (API)

脚本位置：`scripts/smoke-test-arena.sh`

```bash
AI_ACCESS_KEY=xxx bash scripts/smoke-test-arena.sh
```

覆盖 12 个端点，链式调用（前一步 ID 传给后续请求）：

| 步骤 | 端点 | 验证点 |
|------|------|--------|
| 1 | `POST /api/lab/arena/groups` | 创建分组，返回 id |
| 2 | `GET /api/lab/arena/groups` | 列表包含新创建的分组 |
| 3 | `PUT /api/lab/arena/groups/{id}` | 更新名称成功 |
| 4 | `POST /api/lab/arena/slots` | 创建槽位 A，关联分组 |
| 5 | `POST /api/lab/arena/slots` | 创建槽位 B |
| 6 | `GET /api/lab/arena/slots?group=` | 按分组过滤，返回 2 个槽位 |
| 7 | `PUT /api/lab/arena/slots/{id}/toggle` | 禁用槽位 B |
| 8 | `GET /api/lab/arena/lineup` | **核心：返回中不含 displayName（盲评不泄漏）** |
| 9 | `POST /api/lab/arena/reveal` | 传入 slotIds，返回 displayName + platformName |
| 10 | `POST /api/lab/arena/battles` | 保存对战记录 |
| 11 | `GET /api/lab/arena/battles` | 查询历史对战列表 |
| 12 | `DELETE slots + groups` | 清理测试数据 |

**关键断言**：步骤 8 会自动检测 lineup 响应中是否意外包含 `displayName`，如果泄漏则测试失败。

### 13.2 页面测试 (UI)

#### A. 管理配置页（`/lab?tab=arena`）

| # | 测试场景 | 操作 | 预期结果 |
|---|---------|------|---------|
| A1 | Tab 入口 | 进入实验室页面 | 看到"AI 竞技场"Tab |
| A2 | 新建分组 | 点击"新建分组"，填写名称和 key | 分组出现在列表中 |
| A3 | 新建槽位 | 在分组内点击"+"，填写显示名/平台/模型标识 | 槽位卡片出现在分组下 |
| A4 | 平台下拉 | 添加槽位时点击平台下拉 | 显示所有已配置的 `llm_platforms` |
| A5 | 模型标识自由输入 | 输入任意字符串如 `my-custom-model` | 不校验是否在 llm_models 中存在，直接保存 |
| A6 | 启用/禁用切换 | 点击槽位的启用开关 | 状态切换，禁用的槽位显示灰色 |
| A7 | 编辑槽位 | 修改显示名称和颜色 | 保存后卡片更新 |
| A8 | 删除槽位 | 删除一个槽位 | 卡片从列表移除 |
| A9 | 删除分组 | 删除整个分组 | 分组及其下所有槽位一起消失 |
| A10 | 空状态 | 没有任何分组时 | 显示引导提示"创建第一个分组" |

#### B. 用户对战页（`/arena`）

| # | 测试场景 | 操作 | 预期结果 |
|---|---------|------|---------|
| B1 | 页面加载 | 访问 `/arena` | 左侧边栏 + 中间聊天区 + 底部输入框 |
| B2 | 空状态 | 管理员未配置任何槽位 | 提示"暂无可用模型，请联系管理员配置" |
| B3 | 分组切换 | 点击不同的分组 chip | 切换当前分组 |
| B4 | 发起对战 | 输入问题，按 Enter 或点击发送 | 用户消息右对齐气泡出现，下方出现 N 个面板 |
| B5 | **匿名展示** | 对战进行中 | 面板标题仅显示"助手 A / B / C ..."，**无模型名/平台名/颜色** |
| B6 | **随机打乱** | 连续发起两次相同对战 | "助手 A"对应的模型不一定相同 |
| B7 | 流式输出 | 对战进行中 | 每个面板实时追加文本，有打字效果 |
| B8 | 错误处理 | 某个模型调用失败 | 对应面板显示"助手 X - 回答失败" |
| B9 | 全部完成 | 所有模型返回完毕 | "揭晓模型身份"按钮高亮可点击 |
| B10 | **揭晓** | 点击"揭晓模型身份" | 翻转动画 → header 变为"助手 A → GPT-4o" + 平台标签 + 主题色 + TTFT/耗时 |
| B11 | 揭晓不可逆 | 已揭晓的对战 | 刷新页面后仍然显示揭晓后的状态 |
| B12 | 展开面板 | 点击某面板的"展开"按钮 | 全屏查看该助手的完整回答（Markdown 渲染） |
| B13 | 复制回答 | 点击"复制" | 回答文本复制到剪贴板 |
| B14 | 历史记录 | 侧边栏显示 | 按日期分组显示历史对战（今天/昨天/更早） |
| B15 | 加载历史 | 点击侧边栏某条记录 | 主区域加载该对战的问题和回答 |
| B16 | 新建对战 | 点击"新建对战" | 清空当前区域，回到初始状态 |
| B17 | 搜索历史 | 在侧边栏搜索框输入关键词 | 按提问内容过滤历史记录 |

#### C. 盲评安全性验证（最重要）

| # | 测试场景 | 操作 | 预期结果 |
|---|---------|------|---------|
| C1 | **Network 面板检查** | 打开 DevTools → Network，发起对战 | lineup 接口响应中无 displayName 字段 |
| C2 | **SSE 事件检查** | 查看 SSE 事件流 | delta 事件中不包含可识别的模型名称 |
| C3 | **DOM 检查** | 揭晓前右键检查面板 DOM | 无 data-model / data-name 等暗示属性 |
| C4 | **揭晓时机** | 对战未完成时 | "揭晓"按钮禁用，不可点击 |
| C5 | **揭晓才有身份** | 揭晓前查看页面所有文本 | 任何位置都不出现模型真实名称 |

### 13.3 验收通过标准

```
冒烟测试:
  □ smoke-test-arena.sh 全部 ✅ 通过
  □ 盲评泄漏检测通过（lineup 无 displayName）

管理配置页:
  □ A1-A10 全部通过

用户对战页:
  □ B1-B17 全部通过
  □ 核心盲评: B5(匿名) + B6(随机) + B10(揭晓) 必须通过

盲评安全:
  □ C1-C5 全部通过（这是竞技场最核心的验收项）
```

## 14. 后续演进方向 (Future)

| 方向 | 说明 |
|------|------|
| 投票 → 揭晓 | 用户投票"哪个回答更好" → 投票后自动揭晓 |
| ELO 排行榜 | 基于投票数据计算模型 ELO 分数 |
| 盲评 2 选 1 | 每次只抽 2 个模型对战（经典 LMSYS 模式） |
| 多轮追问 | 选定一个助手继续追问 |
| 分享对战 | 生成对战结果分享链接 |
| Token 成本 | 揭晓后显示每个模型的 token 消耗 |
| 拖拽排序 | 管理页槽位支持拖拽调整 |
