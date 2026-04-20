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
| **Phase 1** | 位置策略选择器（自动 / 每大标题 / 每小标题 / 尊重用户锚点）+ 用户锚点（文章内 `[IMG]` 占位符） | ✅ 已完成（2026-04-20） | `ArticleIllustrationEditorPage.tsx` 右侧配置栏第 4 个 pill |
| **Phase 2** | 策略持久化下沉到 workspace（目前存 sessionStorage），补后端 `positionStrategy` 字段 | 🔲 待启动 | `ArticleIllustrationWorkflow.cs` + `ImageMasterController.GenerateArticleMarkers` |
| **Phase 3** | 段落级操作：hover 某段 → 显示 `+ 加标记 / ✕ 删除标记 / ↻ 重生成`；新增 3 个端点 `POST/DELETE/regenerate markers/{markerIndex}` | 🔲 待启动 | `ImageMasterController.cs` 新增 3 个端点 + 前端段落悬浮菜单 |

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

### 未解决 / 下次别忘了

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
