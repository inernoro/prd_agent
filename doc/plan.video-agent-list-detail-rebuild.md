# 视频创作智能体 — 列表/详情页全面重做交接

> **状态**：进行中 · 列表页（T1+T2）已完成并提交 `a7ee648`，详情页（T3-T9）待续
> **分支**：`claude/fix-videogen-rendering-WwNAk`
> **PR**：[#502](https://github.com/inernoro/prd_agent/pull/502)
> **创建**：2026-04-27 上一段 session 接近上下文上限前移交

---

## 起因（必读）

用户截图指出 `VideoStoryboardEditor` 当前页面**人类无法操作**，违反 `guided-exploration` / `zero-friction-input` 原则：

1. 顶部标题直渲了 yuque 复制时夹带的 `<!-- 这是一张图片，ocr 内容为：--> ![](https://cdn.nlark.com/yuque/0/2…)`
2. 10 个分镜 prompt 框全空但状态显示「已完成」（数据/状态不一致）
3. 没有视频预览区，看不到渲染产物
4. 默认值堆砌（经济·wan-2.6 / 5s 重复 10 次），新手无所适从
5. 没有批量渲染按钮，10 镜要点 10 次

`/human-verify` 已跑过完整魔鬼辩护 / 边界测试 / 用户场景模拟，结论是当前页面要**全部重做**。

## 用户拍板的设计

> "1、先进来是列表, 跟文学创作类似
> 2、点进去一个之后, 左侧是预览, 右侧是分镜
> 3、阶段设计类似, 也是上传, 拆分镜, 然后预览, 再导出"

外加两点确认：
- 「+ 创作」**保留下拉两选项**（高级 / 直出），不合并 tab
- 「一键渲染全部」**要弹确认框**显示预估成本（10 镜 × $0.04/秒 × 5s ≈ $2）

---

## 已完成（请勿重做）

### T1 · 标题净化工具 `prd-admin/src/pages/video-agent/titleUtils.ts`

```ts
export function sanitizeVideoTitle(raw, maxLen = 30): string
export function fallbackVideoTitle(createdAt): string  // 「视频草稿 · MM-DD HH:mm」
export function resolveVideoTitle(raw, createdAt, maxLen = 30): string  // 综合
```

剥：HTML 注释 `<!-- -->`、markdown 图片 `![](url)`、链接 `[text](url) → text`、裸 URL、标题井号、加粗下划线、折叠空白。

### T2 · VideoAgentPage 改纵向列表

- 砍掉 ShowcaseGrid 横滚 + HistoryDrawer 历史抽屉两入口（**列表即历史**）
- 新增 `RunListView` 纵向列表（最新在前），`RunListRow` 每行：缩略图 + 标题 + 状态徽章 + 时长 + 时间
- 标题统一走 `resolveVideoTitle()`，markdown 残渣彻底消失
- 7 种状态徽章：Queued/Scripting/Editing/Rendering/Completed/Failed/Cancelled
- 列表页活跃任务（任意 status ∈ 4 个活跃态）自动 5s 轮询；详情页时不在外层重复轮询
- 顶部按钮：详情态显示 `← 返回列表`，列表态隐藏；`+ 创作` 始终显示
- `CreateMenu` / `DirectCreateModal` / `StoryboardCreateModal` **保持不动**（已经是好的）

文件：`prd-admin/src/pages/video-agent/VideoAgentPage.tsx`（已 commit）

### 验证状态

- `pnpm tsc --noEmit` ✅
- `pnpm lint` 本次改动文件零新增告警 ✅
- 真人未走预览域名验收（CDS 自动部署 webhook 已触发）

---

## 待续清单（请按序执行）

### T3-T6 · 重写 `VideoStoryboardEditor.tsx`（最大块工作）

> 当前文件依然是 R4 修复版的全屏长列表，要彻底重写为左预览 / 右分镜分栏 + 阶段进度条

#### 目标布局

```
┌─ 阶段条 [1✓上传] [2✓拆分镜] [3●预览编辑] [4 导出] ──┐
│ ← 返回    净化标题    [⚡一键渲全部] [📦合成导出]   │
├──────────────────────────┬───────────────────────────┤
│  左：ScenePreviewPane     │  右：SceneListPane        │
│  (60% 宽，主体)           │  (40% 宽，导航)           │
│                          │                           │
│  [当前选中镜的视频 16:9]  │  ┌─ 镜头 1 (高亮) ──┐   │
│                          │  │ 缩略 + topic +    │   │
│  topic 标题              │  │ 状态徽章          │   │
│  prompt 折叠预览          │  └──────────────────┘   │
│  [⟳ 重写] [✨ 渲染]       │  镜头 2 ...              │
│  [⚙ 高级 (折叠模型/时长)] │  镜头 3 ...              │
│                          │  ...                       │
│  缺数据兜底警示条         │                           │
└──────────────────────────┴───────────────────────────┘
```

#### 子任务

- **T3**：分栏壳 + state（`selectedSceneIndex`，默认 0；切换镜头 = 点右侧）
- **T4**：`ScenePreviewPane`（左侧）
  - 大播放器 16:9（视频 / Rendering 占位 / 未渲染时大「✨ 渲染本镜」按钮 / 已 Done 但 videoUrl 缺失时「视频已丢失，重新渲染」）
  - topic + 状态徽章
  - prompt 默认单行预览，点开展开 textarea + onBlur 保存
  - 「⟳ 重写」「✨ 渲染」主按钮
  - 「⚙ 高级」点开抽屉/折叠区：模型 select（VIDEO_MODEL_TIERS + OPENROUTER_VIDEO_MODELS 去重）+ 时长 select
- **T5**：`SceneListPane`（右侧）
  - 每个镜头一张 mini 卡片：左小缩略图（视频/占位）+ topic + 状态徽章
  - 当前选中镜头粉色边框高亮
  - 失败镜显示 ⚠️ 角标
- **T6**：`PhaseBar` 顶部进度条
  - 4 段：上传 → 拆分镜 → 预览编辑 → 导出
  - 当前阶段映射规则：
    - status===Queued/Scripting → 第 2 段进行中
    - status===Editing && 任意 scene 是 Draft → 第 3 段进行中
    - status===Editing && 全部 scene Done && !videoAssetUrl → 第 4 段进行中（待导出）
    - status===Completed → 第 4 段完成
  - 已完成段可点回（仅视觉，暂不绑定行为）

#### 必须保留的能力（R4 修复，别删）

- 轮询恢复条件：`runActive || anySceneTransient`，不只看 run.status
- mutate 操作 `handleRender` / `handleRegenerate` 显式 `startPollIfNeeded`
- `loadRunRef` 让 setInterval 拿最新闭包

#### 文件改动

只动一个文件：`prd-admin/src/pages/video-agent/VideoStoryboardEditor.tsx`（约 350 行重写）。

如果太大可以拆出 `ScenePreviewPane.tsx` / `SceneListPane.tsx` / `PhaseBar.tsx` 三个子组件文件，但**不强制**——上千行单文件在本仓库是 OK 的（参见 `LiteraryAgentWorkspaceListPage.tsx` 772 行）。

---

### T7 · 批量渲染 + 成本确认弹窗

「⚡ 一键渲染全部」按钮位于详情页顶部，点击后弹确认 modal：

```
预估成本：约 $X.XX
- N 个镜头待渲染（M 已完成会跳过）
- 模型：wan-2.6（按每镜实际选定）
- 总时长：约 NNN 秒

⚠ OpenRouter 单镜约 1-3 分钟，全部完成约 N×2 分钟
[取消]  [确认渲染]
```

成本估算：
```ts
const COST_PER_SEC: Record<string, number> = {
  'alibaba/wan-2.6': 0.04,
  'alibaba/wan-2.7': 0.04,
  'bytedance/seedance-1-5-pro': 0.10,
  'bytedance/seedance-2.0-fast': 0.05,
  'bytedance/seedance-2.0': 0.10,
  'google/veo-3.1': 0.30,
  'openai/sora-2-pro': 0.30,
};
const totalCost = pendingScenes.reduce((sum, s) => {
  const model = s.model ?? run.directVideoModel ?? 'alibaba/wan-2.6';
  const dur = s.duration ?? run.directDuration ?? 5;
  return sum + (COST_PER_SEC[model] ?? 0.04) * dur;
}, 0);
```

确认后串行调 `renderVideoSceneReal(runId, sceneIndex)`，每镜间隔 200ms 避免后端 worker 抢锁。

附加：「失败重试 (N)」条件按钮，仅当存在 `status === 'Error'` 的镜时显示。

---

### T8 · 空数据兜底 + 状态/数据一致性

| 场景 | 当前行为 | 应有行为 |
|---|---|---|
| `run.scenes.length === 0 && status === 'Editing'` | 一片空白 | 大空状态卡：「LLM 拆分镜失败 / 未返回分镜，可重新拆分 / 返回列表」+ 两个按钮 |
| `scene.prompt` 为空 | 空 textarea | 左侧主区警示条 ⚠️ + 大按钮「让 AI 重新生成 prompt」（实际触发 `regenerateVideoSceneReal`） |
| `scene.status === 'Done' && !scene.videoUrl` | 绿章「已完成」+ 视频区不渲染 | 状态徽章降级为「视频已丢失」+ 按钮「重新渲染」 |
| `run.status === 'Completed' && !run.videoAssetUrl` | 列表显示绿章但无视频 | 列表行用占位图标，不是 16:9 黑块 |

---

### T9 · 删 HistoryDrawer

文件：`prd-admin/src/pages/video-agent/HistoryDrawer.tsx`

直接 `git rm`。VideoAgentPage 里已经移除了 import 和使用（T2 完成时一并清理）。

需检查是否有其他地方还引用：
```bash
grep -rn "HistoryDrawer" prd-admin/src/
```

应该零引用。

---

### T10 · 验证 + 提交

- `pnpm tsc --noEmit` 必须通过
- `pnpm lint` 本次改动文件零新增告警
- 写 changelog 碎片：`changelogs/2026-04-27_video-agent-list-detail-rebuild.md`
  ```
  | feat | prd-admin | 视频 Agent 改列表-详情两层结构（对齐文学创作）：列表纵向、详情左预览右分镜 + 阶段进度条 |
  | fix  | prd-admin | 标题净化：剥 yuque 复制夹带的 markdown/HTML 残渣 |
  | feat | prd-admin | 一键渲染全部 + 成本确认弹窗 + 失败重试条件按钮 |
  | feat | prd-admin | 空数据/状态-数据不一致兜底：scenes=[] 引导、prompt 缺失重写、Done w/o videoUrl 降级 |
  | chore| prd-admin | 删 HistoryDrawer.tsx，列表本身即历史 |
  ```
- commit message 必须中文（CLAUDE.md 规则 5.1）
- 提交后 push 触发 CDS 自动部署，预览域名 5 分钟内就位

---

## 不要做的事

1. **不要改后端**：`VideoGenRunWorker.cs` / `VideoGenService.cs` / 端点契约保持不动
2. **不要重新引入 Remotion**：上一段 session 已彻底移除，B-6（ffmpeg concat 多镜合成）作为单独迭代，本次重做不动
3. **不要改 `DirectCreateModal` / `StoryboardCreateModal` / `CreateMenu`**：T2 时已经过用户验收
4. **不要去 `/cds-deploy`**：项目已 link GitHub，push 即自动部署，告诉用户 5 分钟后访问 `https://claude-fix-videogen-rendering-wwnak.<root>` 即可
5. **不要创建额外文档**：除了 changelog 碎片不要写其他 .md

---

## 参考素材

- 文学创作列表参考：`prd-admin/src/pages/literary-agent/LiteraryAgentWorkspaceListPage.tsx`
- 模态框 3 硬约束：`.claude/rules/frontend-modal.md`（inline style 高度 + createPortal + min-h:0）
- 全高布局规则：`.claude/rules/full-height-layout.md`（h-full min-h-0 链）
- 引导性原则：`.claude/rules/guided-exploration.md`（3 秒内知道下一步）
- 零摩擦：`.claude/rules/zero-friction-input.md`

## 数据契约速查

```ts
// VideoGenRun 关键字段
{ id, status, mode: 'direct'|'storyboard',
  articleTitle, articleMarkdown, styleDescription,
  directVideoModel, directAspectRatio, directResolution, directDuration,
  scenes: VideoGenScene[],
  videoAssetUrl,           // 整段最终视频（B-6 阶段才会有）
  totalDurationSeconds,
  errorCode, errorMessage }

// VideoGenScene
{ index, topic, prompt,
  status: 'Draft'|'Generating'|'Rendering'|'Done'|'Error',
  errorMessage, model, duration, videoUrl, jobId, cost }

// run.status 转换
Queued → Scripting → Editing → (用户操作) → Rendering → Completed
                                          ↓
                                        Failed
```

## 端点速查

```ts
PUT  /api/video-agent/runs/:runId/scenes/:sceneIndex     // updateVideoSceneReal({prompt|model|duration|topic})
POST /api/video-agent/runs/:runId/scenes/:sceneIndex/regenerate  // regenerateVideoSceneReal
POST /api/video-agent/runs/:runId/scenes/:sceneIndex/render      // renderVideoSceneReal
GET  /api/video-agent/runs/:runId                                 // getVideoGenRunReal
```

---

## 最后

完成后向用户交付时**必须包含**（CLAUDE.md 规则 #9）：

```
【位置】百宝箱 / 左侧导航「视频创作智能体」
【路径】登录后首页 → 百宝箱 → 视频创作智能体（列表页）→ 点任一作品进入左预览右分镜详情
```

预览地址：`https://claude-fix-videogen-rendering-wwnak.<root>`（push 后 CDS webhook 自动 2-5 分钟就位）
