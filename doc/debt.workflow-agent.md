# 工作流 Agent · 债务台账

> **版本**：v1.0 | **日期**：2026-05-06 | **状态**：维护中

## 总览

| 指标 | 当前值 |
|------|--------|
| open | 7 |
| in-progress | 0 |
| paid | 0 |

模块范围：`prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs`、`prd-admin/src/pages/workflow-agent/`、所有 `CapsuleTypes.*` 胶囊执行链路。本文件只覆盖工作流胶囊侧的债务；视频生成（OpenRouter 直出）的债务见 `debt.video-agent.md`。

---

## open 债务（按风险倒序）

### 1. video-to-text asr 模式：模型池绑定是手动一次性配置

**触发场景**：用户首次创建 ASR 工作流执行时。

**当前行为**：胶囊执行抛 `InvalidOperationException("ASR 模型调度失败: ... 请去模型池配置 video-agent.video-to-text::asr")`。错误信息明确，但用户得自己理解去管理后台「模型池」页绑定一个 `doubao-asr-stream` 模型才能继续。

**理想行为**：
- 选项 A：模板首次执行时 fallback 到 `video-agent.v2d.transcribe::asr`（已有 ASR 资源），而非直接抛错
- 选项 B：模板表单里加一个「使用现有 ASR 池」开关，让用户自选 caller code
- 选项 C：管理后台增加「未配置 caller 自动复用同分类 caller」开关

**估时**：1-2h（选项 A 最简单，加 try/fallback 即可）

**关联**：`prd-api/Services/CapsuleExecutor.cs ExecuteVideoToTextAsrAsync`、`AppCallerRegistry.VideoAgent.VideoToText.Asr`。

### 2. video-to-text asr 模式：maxItems 默认 4 是硬编码

**当前行为**：超出 maxItems 的条目原样透传不做转写，但用户可能期望全部转写。模板里 count 选项最大 6，如果用户在画布里手动改 count 到 10，maxItems 仍是 4 → 后 6 条没 transcript，海报内容缺失但不报错。

**理想行为**：
- 模板 build 时把 maxItems = count，但用户在画布编辑器里修改 count 后无自动同步
- 或者 maxItems 留空时自动等于 input 数组长度
- 或者前端在 itemsField 与 maxItems 不一致时给出黄色 warning chip

**估时**：30min（前端 warning chip 最简单）

**关联**：`prd-admin/src/pages/workflow-agent/workflowTemplates.ts` `tiktokCreatorToHomepageRichTemplate`。

### 3. video-to-text asr 模式：LLM hook 提炼无 LlmRequestContext

**当前行为**：沿用现有 video-to-text 旧规约，未走 `BeginScope`。`UserId` 由 workflow 执行时的 `__triggeredBy` 变量提供（自动化触发时是 `workflow-system`）。

**与规则的差异**：`.claude/rules/llm-gateway.md` 强制要求 LLM 调用前 `using var _ = ctx.BeginScope(...)` 设置 UserId。当前代码若引入用户级配额/告警会失效。

**风险等级**：低（workflow capsule 上下文已无强用户绑定，且现有 video-to-text/llm 模式也没设置）。

**估时**：30min（加 ILLMRequestContextAccessor 注入 + BeginScope 即可）

**关联**：`CapsuleExecutor.cs` 所有 `gateway.SendAsync` 调用点。

### 4. video-to-text asr 模式：转写失败兜底为空 transcript 透传

**当前行为**：视频不可达 / ffmpeg 失败 / ASR 失败时，item 仍保留原结构，仅 `transcript=""`。下游 weekly-poster-publisher 渲染 `ad-rich-text` 海报时会因 body 为空展示空白。

**理想行为**：
- 选项 A：失败的 item 跳过不入海报，logs 里记录跳过原因
- 选项 B：失败的 item 在 ad-rich-text 视图里降级到 ad-4-3 风格（cover 全 bleed + Play 按钮）
- 选项 C：在 PosterRichTextPageView 检测 body 为空时切到 PosterAdPageView 渲染

**估时**：1h（选项 C 最优，前端单文件改动）

**关联**：`prd-admin/components/weekly-poster/WeeklyPosterModal.tsx` `PosterRichTextPageView`。

### 5. video-to-text asr 模式：ffmpeg 依赖未检测

**当前行为**：CDS 容器有 ffmpeg，但本地 dev 镜像可能没有。`ExtractAudioWithFfmpegAsync` 启动失败抛 `InvalidOperationException("ffmpeg 启动失败")`，用户可能误以为是 ASR 模型问题。

**理想行为**：
- 胶囊执行前先 `which ffmpeg` 探测，缺失时给出明确错误「环境缺 ffmpeg，CDS 容器请重建，本地请 apt install ffmpeg」
- 或者 Dockerfile 显式声明 ffmpeg 是必需依赖

**估时**：30min

**关联**：`CapsuleExecutor.cs ExtractAudioWithFfmpegAsync`、`prd-api/Dockerfile`。

### 6. ad-rich-text 海报：用户点 Play 后无法回到 rich-text 视图

**当前行为**：`hasPlayed` 状态进入全屏视频后，用户必须翻页或关闭弹窗才能重置。无「返回」按钮。

**理想行为**：
- 选项 A：在全屏视频右上角加「< 返回详情」按钮
- 选项 B：视频播放结束后自动回到 rich-text 视图

**估时**：30min

**关联**：`WeeklyPosterModal.tsx PosterRichTextPageView`。

### 7. weekly-poster-publisher：count 与 maxItems 在多模板间不一致

**当前行为**：模板 build 时 `maxItems: count`，但用户在画布里改 count 不会自动同步 maxItems（两个字段独立维护）。

**理想行为**：
- 选项 A：在前端工作流编辑器加跨节点联动逻辑（count 改了同步到下游 video-to-text.maxItems）
- 选项 B：去掉 maxItems，video-to-text 默认处理所有 items（适配 N 条）

**估时**：1h（选项 A 复杂；选项 B 最简单但失去保护）

**关联**：`prd-admin/src/pages/workflow-agent/`（编辑器联动）、`CapsuleExecutor.cs ExecuteVideoToTextAsrAsync`。

---

## 待落地（Phase 2 任务 D 上线后追加）

任务 D（抖音 OAuth + cron 真订阅）落地后，预计会引入新债务：
- aweme_id 去重表的索引策略（按 user/account 分桶 vs 全局）
- OAuth token 续期失败的降级策略
- cron 漂移对 5 分钟轮询粒度的影响

待真正落地后再补本节。

---

## 相关文档

- `doc/plan.emergence-1-tiktok-douyin-poster.md`：涌现 1 主计划文档（Phase 1 + Phase 2 任务 A/B/C 已完成）
- `doc/debt.video-agent.md`：视频生成 Agent 债务（Remotion 已废弃路径）
- `.claude/rules/llm-gateway.md`：LlmRequestContext 强制要求（本文件 §3 关联）
- `.claude/rules/server-authority.md`：CancellationToken.None + Run/Worker 模式
