---
title: 配图标记手动干预 —— 分阶段计划
type: plan
status: in-progress
owner: literary-agent
created: 2026-04-20
updated: 2026-04-20
branch: claude/manual-image-marking-control-GALGQ
---

# 配图标记手动干预 —— 分阶段计划

> 合并两位用户的诉求：「慕雪」想改生成配图标记的提示词让位置可控；缺陷报告想段落级增删改标记。两人本质上都是在表达：**自动生成的配图标记不符合我的意图，缺少手动控制能力**。

## 阶段 Roadmap

| 阶段 | 内容 | 状态 | 落地位置 |
|------|------|------|----------|
| **Phase 1** | 位置策略选择器（自动 / 每大标题 / 每小标题 / 尊重用户锚点） | ✅ 已完成（2026-04-20） | `ArticleIllustrationEditorPage.tsx` 右侧配置栏第 4 个 pill |
| **Phase 1.5** | 首次用户教程气泡（每账户一次，点「知道啦」后永不再弹） + 段落左侧 gutter 点击加锚点 + 段落右键菜单「在上方/下方插入配图」 + 相邻锚点段落绿色边框视觉反馈 | ✅ 已完成（2026-04-20） | 同上文件 + 后端 `LiteraryAgentPreferences.AnchorTutorialSeen` 字段 |
| **Phase 2** | 策略持久化下沉到 workspace（目前存 sessionStorage），补后端 `positionStrategy` 字段；服务端 `ArticleMarkerExtractor` 对 `[IMG]` 占位符做强约束识别（绕过 LLM 随机性） | 🔲 待启动 | `ArticleIllustrationWorkflow.cs` + `ImageMasterController.GenerateArticleMarkers` |
| **Phase 3** | 生成后段落级操作：hover 某段 → 显示 `+ 加标记 / ✕ 删除标记 / ↻ 重生成`；新增 3 个端点 `POST/DELETE/regenerate markers/{markerIndex}` | 🔲 待启动 | `ImageMasterController.cs` 新增 3 个端点 + 前端段落悬浮菜单 |

## Phase 1 落地记录（2026-04-20）

### 做了什么

在右侧配置栏「提示词 / 风格图 / 水印」之后追加第 4 个 pill ——「位置策略」，4 档可选：
- **自动**（默认，等价于原行为）
- **每大标题一张**
- **每小标题一张**
- **尊重用户锚点**（文章中手写 `[IMG]`、`[配图]`、`【插图位置】` 都识别）

选中非「自动」时，前端把对应的策略提示词（`POSITION_STRATEGY_OPTIONS[i].hint`）拼接到 `userInstruction` 前面，`anchor` 模式下 Gateway 的 `WrapForAnchorMode` 会自动再包一层输出格式约束，所以后端零改动。

### 为什么这样做（最小侵入）

- **无 DB schema 变更**：用 sessionStorage 存策略，工作区不变。Phase 2 下沉持久化时再建字段。
- **无后端改动**：现有 `userInstruction` 通道已支持任意文本，追加策略提示词即可。
- **尊重现有提示词模板**：用户选中的提示词模板内容依然完整发送，只是在前面多一段「位置策略」指令。

## Phase 1.5 落地记录（2026-04-20）

### 做了什么

针对用户反馈「用户锚点要更清晰」补充了三件事：

1. **一次性教程气泡**：用户首次进入编辑页时，右下角弹出一张玻璃卡片，解释「位置策略」「gutter 点锚点」「右键菜单」三种操作。点「知道啦」→ 后端 `LiteraryAgentPreferences.AnchorTutorialSeen = true`，之后永不再弹（跨会话、跨设备）。
2. **段落 gutter 快速加锚点**：phase=1 编辑阶段改为按空行分段逐段渲染。每段左侧有 24px gutter，hover 时出现绿色「+」按钮，点一下在此段**上方**插入 `[IMG]` 锚点段落，并自动切到「尊重用户锚点」策略。
3. **右键菜单**：在任一非锚点段落上右键 → 弹出「在此段上方插入配图 / 在此段下方插入配图」。菜单会在点击外部、滚动时自动收起。
4. **锚点视觉反馈（框框反应）**：
   - 锚点本身渲染为绿色 dashed pill「📍 此处将插入配图」，带 ✕ 移除按钮
   - 紧邻锚点的段落获得绿色实线边框 + 浅绿背景，明确告诉用户「这段上/下方会插图」

### 为什么这样做

- **gutter + 右键菜单双通道**：gutter 面向"我只想快速在段上方打点"的用户；右键面向"我要精确控制上/下方"的用户。用户 2、3 条诉求同时覆盖。
- **持久化用 `LiteraryAgentPreferences`**：教程 seen 状态不能用 sessionStorage（跨 tab 就丢了），必须走后端用户偏好。顺手把字段加进已有的 `LiteraryAgentPreferences` 对象，走现有 `updateLiteraryAgentPreferences` 通道，零端点新增。
- **按段落拆分 + 逐段 ReactMarkdown**：比引入 rehype 插件映射源码位置简单得多；代价是单独渲染某些跨段结构（如 setext 标题）会被打散，但对绝大多数文章（paragraph/heading/list/blockquote 为主）视觉一致。

### 未解决 / 下次别忘了（沿用下方原列表）

1. **策略未持久化到 workspace**：换浏览器/换设备会回到「自动」。Phase 2 要把 `PositionStrategy` 字段加到 `ArticleIllustrationWorkflow` 并走 `updateVisualAgentWorkspace` 持久化。
2. **用户锚点识别目前靠 LLM 自觉**：LLM 可能会忽略 `[IMG]` 占位符。Phase 2 要在服务端 `ArticleMarkerExtractor` 预扫描占位符，如命中则直接强制插入 `[插图]`，绕过 LLM 随机性。
3. **段落级增删改彻底缺席**：缺陷报告的核心诉求「删除单个标记 + 为某段重生成」还未做。Phase 3 新增：
   - `DELETE /workspaces/:id/article/markers/:index` — 删除指定标记
   - `POST /workspaces/:id/article/markers` — 为指定段落（用锚点定位）单独生成标记
   - `POST /workspaces/:id/article/markers/:index/regenerate` — 重新生成单个标记
4. **没有 E2E 验证**：本地无 .NET SDK，`pnpm tsc/lint` 虽然能过（见下方），但前端流程必须打开预览页面真人验收。

### 验收方式（Phase 1）

1. 打开预览分支 `https://claude-manual-image-marking-control-galgq.miduo.org`（`/preview` 技能自动生成）
2. 登录 → 左侧「文学创作」→ 选一篇已有文章工作区，或上传一篇新文章
3. 确认右侧配置栏底部的配置 pill 从 3 个变成 4 个，最右边是「📍 自动」
4. **测试 1 —— 每大标题一张**：点「📍」→ 选「每大标题一张」→ 点「生成配图标记」→ 观察只有一级标题后有 `[插图]`
5. **测试 2 —— 每小标题一张**：切到「每小标题一张」→ 重新生成 → 观察二/三级标题后都有
6. **测试 3 —— 尊重用户锚点**：文章内容中手写几个 `[IMG]` → 切到「尊重用户锚点」→ 重新生成 → 观察标记出现在 `[IMG]` 附近
7. **测试 4 —— 回归**：切回「自动」→ 重新生成 → 行为与上线前一致

## 下一次（无论谁来接手）怎么继续

**读这个文件 + 读 `ArticleIllustrationEditorPage.tsx` 里标注 `Phase 1:` 的代码** 就能 2 分钟接上。

推荐推进顺序：

1. **Phase 2 先做持久化**（简单，30 分钟）：
   - `ArticleIllustrationWorkflow.cs` 加 `string? PositionStrategy` 字段
   - `GenerateArticleMarkersRequest` 加 `string? PositionStrategy`
   - 前端 `setPositionStrategy` 改为 `updateVisualAgentWorkspace({ positionStrategy })`
   - 去掉 sessionStorage 读写
2. **Phase 2 再做锚点强约束**（中等，1-2 小时）：
   - 后端 `ArticleMarkerExtractor.cs` 加 `PreScanUserAnchors(content)`，识别 `[IMG]` / `[配图]` / `【插图位置】`
   - `GenerateArticleMarkers` 处理流程改为：先扫占位符 → 有则强制插入对应数量 `[插图]` → 再交给 LLM 补描述
3. **Phase 3 段落级增删改**（大，半天）：
   - 后端新增 3 个端点
   - 前端段落 hover 菜单 + 乐观更新
   - workflow version++ 逻辑要覆盖单标记操作

## 相关引用

- 原需求对话：见本分支首条用户消息（两位用户诉求 + 截图）
- 现有入口：`prd-admin/src/pages/literary-agent/ArticleIllustrationEditorPage.tsx`
- 现有生成逻辑：`prd-api/src/PrdAgent.Api/Controllers/Api/ImageMasterController.cs` → `GenerateArticleMarkers`
- 现有提示词模板：`prd-api/src/PrdAgent.Infrastructure/Prompts/Templates/ArticleIllustrationPrompt.cs` → `WrapForAnchorMode`
- 分支名约束（手动标记控制）：`claude/manual-image-marking-control-GALGQ`
