# AI 竞技场 (AI Arena) - 设计方案

> **版本**: v2.0 | **日期**: 2026-02-24 | **位置**: 实验室 → 新增 Tab
>
> **v2.0 变更**: 废弃自动扫描方案，改为**管理员手动配置槽位**。
> 原因：自动扫描 (1) 按字符串匹配分组不够智能 (2) 与现有模型配置耦合会污染模型设置。

## 1. 需求概述

在实验室中新增"AI 竞技场"功能，用户输入一个问题后**一键发送到管理员预配置的顶级 AI 模型**，实时并行获取流式响应，在可视化面板中横向对比所有模型的回答质量、速度和特点。

### 与现有"大模型实验室"的区别

| 维度 | 大模型实验室 (LlmLabTab) | AI 竞技场 (ArenaLabTab) |
|------|------------------------|------------------------|
| **定位** | 专业测试工具（测速/意图/格式） | 一键对比体验工具 |
| **模型选择** | 手动从模型选择器逐一勾选 | 管理员预配置槽位，用户一键使用 |
| **响应展示** | 摘要预览 + 性能指标为主 | **完整流式文本并排展示** |
| **交互** | 实验配置 → 运行 → 查看结果 | 输入问题 → 一键发送 → 实时阅读 |
| **模型数据** | 依赖 llm_models 注册表 | **独立的 arena_slots 集合，不污染现有配置** |
| **目标用户** | 模型运维/调参人员 | 产品/业务/好奇心驱动的所有人 |

## 2. 核心设计：槽位 (Slot) 机制

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
  id: string;                  // MongoDB ObjectId
  displayName: string;         // 展示名称，如 "GPT-4o"
  platformId: string;          // 关联的平台 ID（用于获取 API Key/URL）
  modelId: string;             // 平台侧模型标识，如 "gpt-4o"
  group: string;               // 所属分组 key，如 "global-frontier"
  sortOrder: number;           // 组内排序
  enabled: boolean;            // 是否启用
  avatarColor?: string;        // 卡片主题色（可选），如 "#10a37f"
  description?: string;        // 简短描述（可选），如 "OpenAI 旗舰模型"
  createdBy: string;           // 创建者 adminId
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

**新增 MongoDB 集合：`arena_groups`**

```typescript
interface ArenaGroup {
  id: string;                  // MongoDB ObjectId
  key: string;                 // 唯一标识，如 "global-frontier"
  name: string;                // 显示名称，如 "全球前沿"
  description?: string;        // 描述
  sortOrder: number;           // 分组排序
  icon?: string;               // 图标标识（可选）
  createdBy: string;
  createdAt: DateTime;
  updatedAt: DateTime;
}
```

### 2.3 分组与槽位的关系

```
arena_groups (管理员定义分组)
├── "全球前沿" (global-frontier)
│   ├── Slot: GPT-4o          → platformId: "plt_openai",   modelId: "gpt-4o"
│   ├── Slot: Claude 3.5      → platformId: "plt_anthropic", modelId: "claude-3-5-sonnet-20241022"
│   ├── Slot: Gemini 2.0      → platformId: "plt_google",   modelId: "gemini-2.0-flash"
│   └── Slot: Grok            → platformId: "plt_xai",      modelId: "grok-2"
│
├── "国产前沿" (china-frontier)
│   ├── Slot: DeepSeek V3     → platformId: "plt_deepseek", modelId: "deepseek-chat"
│   ├── Slot: Qwen-Max        → platformId: "plt_qwen",     modelId: "qwen-max"
│   ├── Slot: 豆包             → platformId: "plt_doubao",   modelId: "doubao-pro-32k"
│   └── Slot: GLM-4           → platformId: "plt_zhipu",    modelId: "glm-4"
│
├── "推理专精" (reasoning)
│   ├── Slot: o3               → platformId: "plt_openai",   modelId: "o3"
│   ├── Slot: DeepSeek R1      → platformId: "plt_deepseek", modelId: "deepseek-reasoner"
│   └── Slot: QwQ              → platformId: "plt_qwen",     modelId: "qwq-32b-preview"
│
└── (管理员可随时新建更多分组...)
```

### 2.4 为什么用独立集合而不是复用 lab-groups

| 方面 | 复用 lab-groups | 独立 arena_slots + arena_groups |
|------|----------------|-------------------------------|
| 数据隔离 | 与实验室模型集合混在一起 | 完全独立，互不影响 |
| 权限控制 | lab-groups 是 per-admin 的 | arena 配置是全局共享的 |
| 数据结构 | 没有分组概念，没有 displayName/color | 为竞技场量身定制 |
| 生命周期 | 跟随实验删除 | 持久配置，不会丢失 |

## 3. 整体架构

```
┌──────────────────────────────────────────────────────────┐
│                  LabPage.tsx (新增第5个Tab)                │
│ [试验车间] [大模型实验室] [桌面实验室] [特效展示] [AI竞技场]    │
└──────────────────────────┬───────────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │    ArenaLabTab.tsx       │
              │  两个模式：                │
              │  1. 对战模式（用户使用）    │
              │  2. 配置模式（管理员配置）  │
              └────────────┬────────────┘
                           │
       ┌───────────────────┼───────────────────┐
       │                   │                   │
       ▼                   ▼                   ▼
 [Arena 配置 API]    [ModelLab RunStream]  [Arena 槽位 API]
 (分组+槽位 CRUD)    (复用现有 SSE)        (读取选手列表)
```

## 4. 后端设计

### 4.1 新增 Controller：ArenaController

遵循项目的 **App Identity 原则**，竞技场配置作为独立 Controller：

```csharp
[ApiController]
[Route("api/lab/arena")]
[Authorize]
[AdminController("lab", AdminPermissionCatalog.LabRead, WritePermission = AdminPermissionCatalog.LabWrite)]
public class ArenaController : ControllerBase
{
    // ─────── 分组 CRUD ───────

    // GET  /api/lab/arena/groups
    // 返回所有分组（按 sortOrder 排序），每个分组包含其下的槽位列表
    [HttpGet("groups")]
    public async Task<IActionResult> ListGroups(CancellationToken ct);

    // POST /api/lab/arena/groups
    // 创建分组 { key, name, description?, sortOrder }
    [HttpPost("groups")]
    public async Task<IActionResult> CreateGroup([FromBody] CreateArenaGroupRequest req, CancellationToken ct);

    // PUT  /api/lab/arena/groups/{id}
    // 更新分组
    [HttpPut("groups/{id}")]
    public async Task<IActionResult> UpdateGroup(string id, [FromBody] UpdateArenaGroupRequest req, CancellationToken ct);

    // DELETE /api/lab/arena/groups/{id}
    // 删除分组（同时删除组内所有槽位）
    [HttpDelete("groups/{id}")]
    public async Task<IActionResult> DeleteGroup(string id, CancellationToken ct);

    // ─────── 槽位 CRUD ───────

    // GET  /api/lab/arena/slots?group={groupKey}
    // 获取指定分组（或全部）的槽位列表
    [HttpGet("slots")]
    public async Task<IActionResult> ListSlots([FromQuery] string? group, CancellationToken ct);

    // POST /api/lab/arena/slots
    // 添加槽位 { displayName, platformId, modelId, group, sortOrder, avatarColor?, description? }
    [HttpPost("slots")]
    public async Task<IActionResult> CreateSlot([FromBody] CreateArenaSlotRequest req, CancellationToken ct);

    // PUT  /api/lab/arena/slots/{id}
    // 更新槽位
    [HttpPut("slots/{id}")]
    public async Task<IActionResult> UpdateSlot(string id, [FromBody] UpdateArenaSlotRequest req, CancellationToken ct);

    // DELETE /api/lab/arena/slots/{id}
    // 删除槽位
    [HttpDelete("slots/{id}")]
    public async Task<IActionResult> DeleteSlot(string id, CancellationToken ct);

    // PUT  /api/lab/arena/slots/{id}/toggle
    // 快速启用/禁用槽位
    [HttpPut("slots/{id}/toggle")]
    public async Task<IActionResult> ToggleSlot(string id, CancellationToken ct);

    // ─────── 聚合查询（用户侧使用） ───────

    // GET  /api/lab/arena/lineup
    // 返回当前"出场阵容"：所有已启用的分组 + 分组内已启用的槽位
    // 只返回 enabled=true 的数据，供前端用户侧直接使用
    [HttpGet("lineup")]
    public async Task<IActionResult> GetLineup(CancellationToken ct);
}
```

### 4.2 Lineup 聚合接口（用户侧核心接口）

```typescript
// GET /api/lab/arena/lineup 返回结构
interface ArenaLineup {
  groups: ArenaLineupGroup[];
  totalSlots: number;
}

interface ArenaLineupGroup {
  key: string;               // "global-frontier"
  name: string;              // "全球前沿"
  description?: string;
  slots: ArenaLineupSlot[];
}

interface ArenaLineupSlot {
  id: string;
  displayName: string;       // "GPT-4o"
  platformId: string;
  platformName: string;      // join 平台表拿到的名称
  modelId: string;           // "gpt-4o"
  avatarColor?: string;      // "#10a37f"
  description?: string;
}
```

### 4.3 AppCallerCode 注册

在 `AppCallerRegistry.cs` 的 `Admin` 类中新增：

```csharp
public static class Arena
{
    [AppCallerMetadata(
        displayName: "AI竞技场-全球问答",
        description: "AI竞技场一键询问所有模型",
        ModelTypes: new[] { ModelTypes.Chat },
        Category: "Lab"
    )]
    public const string Query = "prd-agent-web.arena.query::chat";
}
```

### 4.4 复用现有 RunStream

对战时前端调用 `POST /api/lab/model/runs/stream`，将槽位信息转换为现有的 `ModelLabSelectedModel` 格式：

```json
{
  "promptText": "用户输入的问题",
  "models": [
    { "platformId": "plt_openai", "modelId": "gpt-4o", "modelName": "gpt-4o", "name": "GPT-4o" },
    { "platformId": "plt_anthropic", "modelId": "claude-3-5-sonnet-20241022", "modelName": "claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet" }
  ],
  "params": {
    "maxConcurrency": 20,
    "repeatN": 1
  }
}
```

槽位的 `displayName` 映射到 `name` 字段，这样 SSE 事件中的 `displayName` 就是管理员配置的友好名称。

## 5. 前端设计

### 5.1 新增文件

```
prd-admin/src/pages/lab-arena/
├── ArenaLabTab.tsx                 # 主组件（对战模式 + 配置入口）
└── components/
    ├── ArenaInput.tsx              # 输入区（问题 + 分组选择 + 发送按钮）
    ├── ArenaGrid.tsx               # 响应对比网格
    ├── ArenaResponseCard.tsx       # 单模型响应卡片
    └── ArenaConfigPanel.tsx        # 配置面板（分组管理 + 槽位管理）
```

### 5.2 UI 布局 - 对战模式（用户使用）

```
┌────────────────────────────────────────────────────────────┐
│ AI 竞技场                                    [⚙ 配置选手]   │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ 输入你的问题，一键询问全球顶级 AI ...                    │  │
│  │                                                      │  │
│  │                                          [⚡ 问所有AI] │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                            │
│  分组：[● 全部(12)] [○ 全球前沿(4)] [○ 国产前沿(4)]          │
│        [○ 推理专精(3)]                                     │
│                                                            │
├────────────────────────────────────────────────────────────┤
│  [响应对比区 - 自适应网格]                                    │
│                                                            │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────┐  │
│  │ ◉ GPT-4o        │  │ ◉ Claude 3.5    │  │ ◉ Gemini │  │
│  │ OpenAI          │  │ Anthropic       │  │ Google   │  │
│  │ ─────────────── │  │ ─────────────── │  │ ──────── │  │
│  │ TTFT: 82ms      │  │ TTFT: 65ms ⚡   │  │ ···加载中 │  │
│  │                 │  │                 │  │          │  │
│  │ GPT-4o 的回答   │  │ Claude 的回答   │  │          │  │
│  │ 正在流式输出... │  │ 正在流式输出... │  │          │  │
│  │                 │  │                 │  │          │  │
│  │ [复制] [展开]   │  │ [复制] [展开]   │  │          │  │
│  └─────────────────┘  └─────────────────┘  └──────────┘  │
│                                                            │
│  ┌─────────────────┐  ┌─────────────────┐  ┌──────────┐  │
│  │ ◉ DeepSeek V3   │  │ ◉ Qwen-Max     │  │ ✕ 豆包    │  │
│  │ DeepSeek        │  │ Alibaba        │  │ 429 限流 │  │
│  │ ─────────────── │  │ ─────────────── │  │ ──────── │  │
│  │ TTFT: 45ms ⚡⚡  │  │ TTFT: 120ms    │  │ 错误     │  │
│  └─────────────────┘  └─────────────────┘  └──────────┘  │
│                                                            │
├────────────────────────────────────────────────────────────┤
│ 统计: 6 模型 | 最快首字: DeepSeek V3 (45ms) | 平均: 88ms   │
└────────────────────────────────────────────────────────────┘
```

### 5.3 UI 布局 - 配置面板（管理员配置）

点击右上角"配置选手"按钮，弹出 Dialog 或侧面板：

```
┌──────────────────────────────────────────────────────┐
│ 竞技场选手配置                                  [关闭] │
├──────────────────────────────────────────────────────┤
│                                                      │
│  分组管理                                  [+ 新建分组] │
│  ┌────────────────────────────────────────────────┐  │
│  │ ▼ 全球前沿 (4个选手)                    [编辑][删除] │  │
│  │   ┌──────────┬──────────┬──────────┬─────┐    │  │
│  │   │ GPT-4o   │ Claude   │ Gemini   │ [+] │    │  │
│  │   │ OpenAI   │ Anthro.  │ Google   │     │    │  │
│  │   │ ✓ 启用   │ ✓ 启用   │ ✓ 启用   │     │    │  │
│  │   │ [编辑]   │ [编辑]   │ [编辑]   │     │    │  │
│  │   └──────────┴──────────┴──────────┴─────┘    │  │
│  │                                                │  │
│  │ ▼ 国产前沿 (4个选手)                    [编辑][删除] │  │
│  │   ┌──────────┬──────────┬──────────┬─────┐    │  │
│  │   │DeepSeek  │ Qwen-Max │ 豆包      │ [+] │    │  │
│  │   │DeepSeek  │ Alibaba  │ ByteDance│     │    │  │
│  │   │ ✓ 启用   │ ✓ 启用   │ ✗ 禁用   │     │    │  │
│  │   └──────────┴──────────┴──────────┴─────┘    │  │
│  │                                                │  │
│  │ ▶ 推理专精 (3个选手)                    [编辑][删除] │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

添加/编辑槽位弹窗：

```
┌──────────────────────────────┐
│ 添加选手                      │
├──────────────────────────────┤
│                              │
│ 显示名称 *                    │
│ ┌──────────────────────────┐ │
│ │ GPT-4o                   │ │
│ └──────────────────────────┘ │
│                              │
│ 平台 *                       │
│ ┌──────────────────────────┐ │
│ │ ▾ OpenAI (openai)        │ │  ← 下拉：从已配置的 llm_platforms 中选
│ └──────────────────────────┘ │
│                              │
│ 模型标识 *                    │
│ ┌──────────────────────────┐ │
│ │ gpt-4o                   │ │  ← 手动输入，自由填写
│ └──────────────────────────┘ │
│ 提示：填写平台侧的模型 ID      │
│                              │
│ 卡片颜色                      │
│ [#10a37f] ■                  │  ← 可选，色块预览
│                              │
│ 描述                          │
│ ┌──────────────────────────┐ │
│ │ OpenAI 旗舰多模态模型      │ │  ← 可选
│ └──────────────────────────┘ │
│                              │
│         [取消]    [确认添加]   │
└──────────────────────────────┘
```

**关键点**：
- 平台从 `llm_platforms` 下拉选择（保证有 API Key 可用）
- 模型标识**手动输入**，不依赖 `llm_models` 表（自由填写任何模型名）
- 显示名称管理员自定义（可以写中文、品牌名等）

### 5.4 ArenaResponseCard 状态机

```
[waiting] → [streaming] → [done]
              ↓
           [error]
```

每张卡片独立展示：
- **Header**: 显示名 + 平台标签 + 卡片主题色 + 状态指示器
- **Metrics**: TTFT（首字延迟）、Total（总耗时）、字符数
- **Body**: 完整流式文本（支持 Markdown 渲染）
- **Footer**: [复制] [展开全屏] 操作

### 5.5 交互流程

```
对战流程：
1. 用户进入 AI 竞技场 Tab
2. 自动调用 GET /api/lab/arena/lineup 获取出场阵容
3. 默认选中"全部"，展示所有分组的选手
4. 用户输入问题
5. 点击"问所有 AI"
6. 前端将 lineup 槽位转换为 ModelLabSelectedModel[]
7. 调用 POST /api/lab/model/runs/stream（复用现有接口）
8. SSE 事件驱动卡片状态更新
9. runDone → 更新统计栏

配置流程：
1. 管理员点击"配置选手"
2. 弹出配置面板
3. 可以：新建分组 / 编辑分组 / 删除分组
4. 可以：添加槽位 / 编辑槽位 / 删除槽位 / 启用禁用槽位
5. 保存后立即生效（下次对战使用新阵容）
```

### 5.6 LabPage.tsx 改动

```diff
- type LabTab = 'workshop' | 'llm' | 'desktop' | 'showcase';
+ type LabTab = 'workshop' | 'llm' | 'desktop' | 'showcase' | 'arena';

  <TabBar items={[
    { key: 'workshop', label: '试验车间', icon: <FlaskConical size={14} /> },
    { key: 'llm', label: '大模型实验室', icon: <Sparkles size={14} /> },
    { key: 'desktop', label: '桌面实验室', icon: <Monitor size={14} /> },
    { key: 'showcase', label: '特效展示', icon: <Wand2 size={14} /> },
+   { key: 'arena', label: 'AI 竞技场', icon: <Swords size={14} /> },
  ]} />

+ {tab === 'arena' && <ArenaLabTab />}
```

## 6. 数据流

```
                  ┌──────────────┐
                  │   用户输入    │
                  │  "什么是量子计算"│
                  └──────┬───────┘
                         │
                         ▼
              ┌─────────────────────┐
              │  ArenaLabTab.tsx    │
              │  lineup → models[]  │  ← 将槽位转换为 ModelLabSelectedModel
              └──────────┬──────────┘
                         │ POST /api/lab/model/runs/stream
                         ▼
              ┌─────────────────────┐
              │  ModelLabController │
              │  RunStream()       │
              └──────────┬──────────┘
                         │ 并行调度 (SemaphoreSlim)
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
      ┌─────────┐  ┌─────────┐  ┌─────────┐
      │ GPT-4o  │  │ Claude  │  │DeepSeek │  ... N 个模型
      │ OpenAI  │  │Anthropic│  │DeepSeek │
      │ Client  │  │ Client  │  │ Client  │
      └────┬────┘  └────┬────┘  └────┬────┘
           │             │             │
           ▼             ▼             ▼
      ┌──────────────────────────────────┐
      │     SSE 事件流 (text/event-stream) │
      │                                  │
      │  event: model                    │
      │  data: {"type":"modelStart",     │
      │         "displayName":"GPT-4o"}  │  ← 使用管理员配置的显示名
      │                                  │
      │  event: model                    │
      │  data: {"type":"delta",          │
      │         "content":"量子计算是..."}  │
      │                                  │
      │  event: model                    │
      │  data: {"type":"modelDone",...}  │
      └──────────────┬───────────────────┘
                     │
                     ▼
           ┌─────────────────┐
           │  ArenaGrid.tsx  │
           │  N 张响应卡片     │
           │  实时流式更新     │
           └─────────────────┘
```

## 7. 状态管理

前端使用组件内 `useState` / `useRef` 管理，不引入新 Store：

```typescript
interface ArenaState {
  // 输入
  prompt: string;
  selectedGroupKey: string | 'all';  // 选中的分组

  // 阵容数据（来自 /lineup）
  lineup: ArenaLineup | null;
  lineupLoading: boolean;

  // 运行状态
  isRunning: boolean;
  runId: string | null;

  // 响应卡片
  cards: Map<string, ArenaCard>;  // key = itemId
}

interface ArenaCard {
  itemId: string;
  slotId: string;              // 关联的槽位 ID
  displayName: string;         // 管理员配置的显示名
  platformName: string;
  avatarColor?: string;        // 卡片主题色
  status: 'waiting' | 'streaming' | 'done' | 'error';
  ttftMs: number | null;
  totalMs: number | null;
  text: string;                // 累积的完整文本
  errorMessage: string | null;
}
```

## 8. 实现步骤

### Phase 1: 后端

1. **MongoDbContext** 注册 `arena_slots` 和 `arena_groups` 集合

2. **ArenaController** 实现全部端点
   - 分组 CRUD (groups)
   - 槽位 CRUD (slots)
   - 阵容聚合查询 (lineup)

3. **AppCallerRegistry** 注册 `Arena.Query`

### Phase 2: 前端

4. **services 层** 新增 Arena API 函数
   - `getArenaLineup()` — 获取出场阵容
   - `listArenaGroups()` / `createArenaGroup()` / `updateArenaGroup()` / `deleteArenaGroup()`
   - `listArenaSlots()` / `createArenaSlot()` / `updateArenaSlot()` / `deleteArenaSlot()` / `toggleArenaSlot()`

5. **ArenaLabTab.tsx** — 主组件（加载阵容 + 对战逻辑）

6. **ArenaInput.tsx** — 输入区

7. **ArenaGrid.tsx** + **ArenaResponseCard.tsx** — 响应网格

8. **ArenaConfigPanel.tsx** — 管理员配置面板（分组/槽位 CRUD）

### Phase 3: 集成

9. **LabPage.tsx** 添加 Tab 入口

10. 端到端测试

## 9. 权限

复用现有 Lab 权限：
- 查看竞技场 + 使用对战：`lab.read`
- 配置选手（槽位/分组管理）：`lab.write`

无需新增权限。

## 10. 数据库变更

| 集合名 | 用途 |
|--------|------|
| `arena_groups` | 竞技场分组配置 |
| `arena_slots` | 竞技场选手槽位 |

**不影响现有集合**，完全独立。

## 11. 不做的事情 (Out of Scope v1)

- **不自动扫描模型** — 全部由管理员手动配置
- **不新建运行 Controller** — 复用 ModelLabController.RunStream
- **不做投票/评分系统** — v1 仅做对比展示
- **不做多轮对话** — v1 只支持单轮问答
- **不做自定义 system prompt** — 使用空 system prompt（纯净对比）

## 12. 后续演进方向 (Future)

| 方向 | 说明 |
|------|------|
| 投票评分 | 用户对每个回答点赞/踩，形成模型 ELO 排名 |
| 盲评模式 | 隐藏模型名称，用户先评分再揭晓 |
| 多轮追问 | 对某个模型的回答继续追问 |
| 分享功能 | 生成对比结果的分享链接 |
| Token 成本对比 | 展示每个模型的 token 消耗和估算费用 |
| 槽位模板 | 提供"一键导入推荐阵容"的模板 |
| 拖拽排序 | 分组和槽位支持拖拽调整顺序 |
