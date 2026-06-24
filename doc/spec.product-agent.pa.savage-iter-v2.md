# 毒舌秘书 v2 迭代升级方案

| 字段 | 值 |
|---|---|
| **类型** | spec |
| **状态** | 开发中 |
| **版本** | v2.0 |
| **日期** | 2026-05-26 |
| **appKey** | pa-agent |
| **关联** | `doc/spec.pa-agent-savage-upgrade.md`（v1.0 / v1.1 基线） |

---

## 1. 管理摘要

毒舌秘书 v1 已经把"人格"立住了：MBB 顾问语气、四象限自动归类、毒舌一句。v2 解决一个核心痛点——**它只记得当前会话，每次都像第一次见面**——并在 UI 入口上把"毒舌秘书"做得跟视觉创作智能体一样有版面感。

本次迭代分三轨：

| 轨 | 范围 | 用户感知 |
|---|---|---|
| **A 卡片入口** | 首页智能体网格 + AI 百宝箱卡片 + 资源上传 | 第一眼看到毒舌秘书是"有内容的"，hover 有光带，运维可以替换静图 / 视频 |
| **B 跨会话画像** | 新 Mongo 集合 `pa_user_profile` + Prompt 注入 + 画像面板 | 秘书"记得"你的角色、节奏、惯用项目；它说"你 5/12 说过 IMP 项目"不是装的 |
| **C 任务复盘** | 新 endpoint `/api/pa-agent/review/run`（SSE） + 看板复盘按钮 | 一键拿到"上周数字 + 没干完的原因 + 下周建议"的毒舌点评 |

---

## 2. 产品定位

毒舌秘书的差异化是**对你狠** + **记得住**。v1 解决了"狠"，v2 解决"记得住"。

| 项 | v1 (2026-05-10) | v2 (本次) |
|---|---|---|
| 人格 | MBB 风格 + 五条信条 | 同 v1（**不动 prompt 核心人格**） |
| 上下文 | 单会话 20 条消息 | + 跨会话画像（角色 / 节奏 / 持久事实） |
| 任务管理 | 创建 / 四象限 / 子步骤 | + 一键复盘点评 |
| 入口 | 百宝箱条目（无封面） | 首页 + 百宝箱 inline 插画卡片 + 可上传覆盖 |

---

## 3. 用户场景

### 场景 1：跨会话记忆（B 轨）

- 周一对话："帮我跟一下 IMP 项目"——毒舌秘书拆解后**额外**输出 `update_profile`：`{ "op": "add", "kind": "project", "text": "负责 IMP 项目" }`
- 周三开新会话："今天有什么"——秘书第一句就带上"IMP 项目本周末要交付，先看 Q1"
- 用户在画像面板看到这条 memory，标为 `auto`，可一键删除或编辑

### 场景 2：上周复盘（C 轨）

- 周五 17:00，用户在看板顶部点【复盘 · 上周】
- Drawer 弹出，SSE 阶段提示「正在统计 → 正在点评 → 正在出建议」
- 输出三段：数字（含毒舌一句）/ 没干完的为什么 / 下周 next action
- 完成后落 PaSession（`Type='review'`），用户可以历史回看

### 场景 3：首页第一眼（A 轨）

- 首页打开，「毒舌秘书」卡片显示一张内联 SVG 插画（金字塔 + 四象限 + 琥珀/青色），不依赖 CDN
- 鼠标 hover：背景轻微放大、一条光带从左到右扫过、四周内发光
- 运维上传 `agent.pa-agent.image` PNG 后，刷新即变成静图 + hover 视频（与视觉创作智能体行为完全一致）

---

## 4. 核心能力（端到端）

### 4.1 SystemPrompt 协议扩展（向前兼容）

System prompt 顶部新增一块（用 `__PA_PROFILE_BLOCK__` 占位符；profile 空时整块不渲染）：

```
# 用户画像（来自历史对话，仅在影响回复时引用）
- 称呼偏好：{PreferredAddress 或 直呼姓名}
- 工作节奏：{8:30-23:00，周末活跃} 等
- 完美主义倾向：高（直接 callout 拖延信号）
- 持久事实：
  1. 我是产品经理（来自 2026-05-10）
  2. 负责 IMP 项目（来自 2026-05-12）
```

任务 JSON 协议保持不变（仍是 `save_task`）。**新增第二个独立 fenced block**，向后兼容（不输出就当无）：

```json
{
  "action": "update_profile",
  "confidence": "auto" | "suggest",
  "patches": [
    { "op": "add", "kind": "role", "text": "产品经理" },
    { "op": "set", "field": "rhythm.weekendActive", "value": true },
    { "op": "set", "field": "preferences.preferredAddress", "value": "玉哥" }
  ]
}
```

- `auto`：直接落盘 `Source=auto`，下一次 chat 立即生效
- `suggest`：落盘 `Source=suggest`，在画像面板等用户确认；不参与 prompt 注入
- 注入裁剪：相关条目按 LRU + Source 优先级（manual > auto > suggest 已确认）取前 10 条 ≤ 1500 字

### 4.2 复盘提示词（独立）

不复用 chat prompt，避免主人格污染：

```
你是毒舌秘书的「复盘模式」。规则同主人格（MECE / 毒舌 / 不堆鸡汤 / 无 emoji），
本次只做：复盘 + 下一步建议。

输入：
- 时段：{range} ({startDate} ~ {endDate})
- 统计：{aggregateJson}
- 未完成高优任务：{topPendingJson}

输出按下列顺序，不要题外话：

## 数字
完成 X / 新增 Y / 逾期 Z / 取消 W（一句话毒舌点评）

## 没干完的为什么
逐条点出 Q1/Q2 未完成项 + 推断卡点；不替用户瞎猜，只问关键问题

## 下周建议
3-5 个 next action，每项含象限 + 一句毒舌一句

末尾以问题收尾：「下周第一件事是哪个？」
```

### 4.3 复盘流程

1. `POST /api/pa-agent/review/run { range, startDate?, endDate? }`
2. 后端先聚合（**纯数据，零 LLM**）：各象限的 pending/done/archived 计数、新增/完成/逾期清单、当前 Q1 / Q2 高优 pending 任务
3. 用复盘 SystemPrompt + 聚合 JSON 作为 user message 调 `_gateway.CreateClient("pa-agent.review::chat", "chat", ...)`
4. SSE 阶段事件：`stage: aggregating` → `stage: scoring` → `stage: suggesting` → 流式 `delta` → `done`
5. 完成后：创建 `PaSession { Type='review', Title='复盘 · 5月19日-5月26日' }` + 一条 `assistant` 角色的 `PaMessage`，方便用户历史回看

---

## 5. 架构（数据 + 接口）

### 5.1 新增 Mongo 集合 `pa_user_profile`

```csharp
public class PaUserProfile {
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string UserId { get; set; } = "";        // unique
    public string DisplayNameCache { get; set; } = "";
    public PaWorkRhythm Rhythm { get; set; } = new();
    public List<PaMemoryEntry> Memories { get; set; } = new();
    public PaUserPreferences Preferences { get; set; } = new();
    public DateTime LastActiveAt { get; set; } = DateTime.UtcNow;
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
public class PaWorkRhythm {
    public int? TypicalStartHour { get; set; }
    public int? TypicalEndHour { get; set; }
    public bool WeekendActive { get; set; }
    public string? PerfectionismLevel { get; set; }   // low / mid / high
}
public class PaMemoryEntry {
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Kind { get; set; } = "fact";        // role / project / fact / preference
    public string Text { get; set; } = "";            // ≤ 60 字
    public string Source { get; set; } = "manual";    // auto / suggest / manual
    public string Status { get; set; } = "active";    // active / archived
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime? UpdatedAt { get; set; }
}
public class PaUserPreferences {
    public string? PreferredAddress { get; set; }
    public List<string> ForbiddenTopics { get; set; } = new();
    public string SavageLevel { get; set; } = "default"; // gentle / default / sharp
}
```

索引（由 DBA 手动加，登记在 `doc/guide.mongodb-indexes.md`）：
- `{ UserId: 1 }` unique

### 5.2 PaSession 复用，加 `Type` 字段

```csharp
public class PaSession {
    // ... 已有字段
    public string Type { get; set; } = "chat";  // chat | review (新增，默认 chat 向后兼容)
}
```

兜底（snapshot-fallback 原则）：旧数据 Type 缺失 → 反序列化默认 "chat" → 现有 UI 不破。

### 5.3 接口清单

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/pa-agent/profile` | 读取当前用户画像（不存在返回空骨架） |
| PUT | `/api/pa-agent/profile` | 整体更新（rhythm / preferences / memories） |
| POST | `/api/pa-agent/profile/memories` | 手动添加一条 memory |
| POST | `/api/pa-agent/profile/memories/{id}/confirm` | 把 `suggest` 转 `manual` |
| DELETE | `/api/pa-agent/profile/memories/{id}` | 软删（status=archived） |
| POST | `/api/pa-agent/review/run` | 流式复盘 SSE（事件：`stage` / `delta` / `done` / `error`） |
| GET | `/api/pa-agent/sessions?type=review` | 历史复盘列表（复用现有 sessions 接口，加 type query） |

### 5.4 AppCaller 注册

| AppCallerCode | 用途 |
|---|---|
| `pa-agent.chat::chat` | 已存在，主对话 |
| `pa-agent.review::chat`（新） | 复盘 LLM 调用 |

---

## 6. 关联设计

| 模块 | 文件 |
|---|---|
| 后端 Controller | `prd-api/src/PrdAgent.Api/Controllers/Api/PaAgentController.cs` |
| 后端 Model | `prd-api/src/PrdAgent.Core/Models/PaUserProfile.cs`（新） |
| 后端 DbContext | `prd-api/src/PrdAgent.Infrastructure/Database/MongoDbContext.cs` |
| 后端 AppCaller | `prd-api/src/PrdAgent.Core/Models/AppCallerRegistry.cs` |
| 前端 Service | `prd-admin/src/services/real/paAgentService.ts` |
| 前端页面 | `prd-admin/src/pages/pa-agent/PaAgentPage.tsx` 等 |
| 前端卡片 | `prd-admin/src/components/agent-card-art/PaAgentCardArt.tsx`（新）<br>`prd-admin/src/pages/AgentLauncherPage.tsx` `FeaturedCard`<br>`prd-admin/src/pages/ai-toolbox/components/ToolCard.tsx` |
| 前端 Store | `prd-admin/src/stores/toolboxStore.ts`（补 `kind` + `permission`） |
| 前端槽位 | `prd-admin/src/lib/homepageAssetSlots.ts`（加 pa-agent） |

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| LLM 误抽 profile 污染未来对话 | suggest 默认不入注入；用户可一键删除；每条带来源 + 创建时间，可审计 |
| profile 注入过长占用 token | 取前 10 条 ≤ 1500 字硬约束，按 LRU + Source 优先级裁剪 |
| 复盘聚合扫一周任务表慢 | 任务表已有 `{ UserId, CreatedAt }` 索引；预计 < 100ms；LLM 流式不阻塞 |
| `update_profile` JSON 解析失败 | try/catch 包裹，失败时只 log，不影响主对话 |
| PaSession Type=review 旧数据兼容 | MongoDB 缺失字段 → C# 默认值 "chat" → 现有过滤逻辑不破 |
| 卡片资源 CDN 不可达 | 默认走 inline SVG 插画；上传只是"覆盖"不是"必要"|

---

## 8. 验收

5 条 v1 验收（spec.product-agent.pa.savage-upgrade.md §五）不退化。新增：

| # | 场景 | 期望 |
|---|---|---|
| 6 | 用户说"我是 PM"，开新会话问"今天看什么" | 回复体现 PM 角色 |
| 7 | 画像面板手动加一条 + 删一条 | 立即生效；下次 chat 体现 |
| 8 | 看板点【复盘 · 上周】 | 流式 3 段输出（数字/原因/建议），末尾问题收尾 |
| 9 | 当周无任务时复盘 | 输出"上周你没在系统里留下任何任务——这不是清净，是没盘" |
| 10 | 首页打开 pa-agent 卡片 hover | 看到光带 + scale + 内发光（无 CDN 也跑） |
| 11 | 运维上传 `agent.pa-agent.image` | 卡片自动切静图 |
| 12 | 上传 `.video` MP4 后 hover | 切播视频 |
| 13 | 移动端首页 | pa-agent 出现（v1 时不出现） |

---

## 9. 范围控制（防 scope creep）

- 不动现有 5 条 v1 验收用例的人格 prompt
- 不动任务 JSON 协议 confidence 语义
- 不引入日历 / 邮件 / 推送 / 多用户共享
- 不重写 UI 布局
- 不引入新图表库（用 inline SVG）
