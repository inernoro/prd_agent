# 涌现 1 · TikTok / 抖音博主订阅 → 首页广告海报

> **系列定位**: 涌现 1（emergence-1）。本仓库的"涌现"系列指**借助平台已有砖块（工作流胶囊 + LLM Gateway + 周报海报弹窗 + COS / HomepageAsset）组合出的新功能**。本期是该系列首作。
>
> **状态**: Phase 1 已上线，Phase 2 任务 A/B/C 已落地（branch `claude/review-emergence-plan-Y8pOR`），任务 D（抖音 OAuth + cron 真订阅）待下一个智能体接手。
>
> **交接对象**: 下一个负责 Phase 2 任务 D（真订阅闭环）的智能体（人 / Cursor / Claude Code 均可）。

---

## 1. Phase 1 已交付（现状速览）

### 1.1 用户视角教程

#### 跑一次：手动触发

1. 登录预览 → 百宝箱 → 工作流 → 新建 → 选模板「TikTok / 抖音 博主订阅 → 首页广告海报」
2. 表单填两项必填 + 两项可选：
   - **TikHub API 密钥** (必填) — 从 https://tikhub.io 用户中心取，或填 `{{secrets.TIKHUB_API_KEY}}` 引用工作流密钥
   - **平台** — TikTok / 抖音 二选一
   - **博主 secUid / sec_user_id** (必填) — TikTok 默认填官方示例 `MS4wLjABAAAAv7iSuuXDJGDvJkmH_vz1qkDZYo1apxgzaxdBSeIuPiM`，可改
   - **展示几条作品** — 默认 4 条，对应海报 4 页轮播
3. 点击执行 → 几秒后刷新首页 → 登录弹窗就是 4:3 视频广告海报

#### 切换博主 / 平台

工作流编辑器里直接改「拉取博主视频列表」节点的 `secUid` / `platform` 字段，保存重跑即可。

#### 切换"主动播放" → "全自动定时拉"

把首节点 `manual-trigger` 删除，换成 `timer` 胶囊（cron 表达式如 `0 */6 * * *` 每 6 小时）。Cron 调度器目前在 `wip:true` 状态——具体能不能跑要看部署版本。如不可用，兜底用外部 cron 周期调 `POST /api/workflow-agent/workflows/{id}/run`。

### 1.2 技术视角架构

```
[手动触发] →  [tiktok-creator-fetch]  →  [weekly-poster-publisher]  →  WeeklyPoster (DB)
                ↓                            ↓                              ↓
            TikHub API                   写 4 页海报                   /api/weekly-posters/current
        app/v3 (TikTok) /              presentationMode='ad-4-3'          首页弹窗读取
        web (Douyin)                   imageUrl=videoUrl              <PosterAdPageView>
                                       secondaryImageUrl=coverUrl     渲染 4:3 ad 弹窗
```

### 1.3 关键文件清单

| 文件 | 职责 |
|---|---|
| `prd-api/src/PrdAgent.Api/Services/CapsuleExecutor.cs` | `ExecuteTiktokCreatorFetchAsync` (~5750-5950) + `NormalizeTiktokVideoItem` + `ExecuteHomepagePublisherAsync` + `ExecuteWeeklyPosterPublisherAsync` (~6260-6420) |
| `prd-api/src/PrdAgent.Core/Models/WorkflowModels.cs` | `CapsuleTypes.{TiktokCreatorFetch, HomepagePublisher, WeeklyPosterPublisher}` 常量 |
| `prd-api/src/PrdAgent.Core/Models/CapsuleTypeRegistry.cs` | 三个胶囊的 ConfigSchema / Slots 元数据 |
| `prd-api/src/PrdAgent.Core/Models/WeeklyPosterAnnouncement.cs` | 海报 Model（`PresentationMode` 字段是路由分发的关键） |
| `prd-admin/src/components/weekly-poster/WeeklyPosterModal.tsx` | `PosterAdPageView` 4:3 ad 视图 + `isVideoUrl` 路径级视频探测 |
| `prd-admin/src/pages/workflow-agent/workflowTemplates.ts` | `tiktokCreatorToHomepageTemplate` 模板定义 |
| `prd-admin/src/pages/workflow-agent/capsuleRegistry.tsx` | 三个胶囊前端图标/分类注册 |
| `prd-admin/src/services/real/weeklyPoster.ts` | `WeeklyPosterPresentationMode` type union（含 `'ad-4-3'`） |

### 1.4 三个新胶囊速查

| 胶囊 | 输入 | 输出 | 关键配置 |
|---|---|---|---|
| `tiktok-creator-fetch` | 触发（trigger）+ 配置 | items 数组 + firstItem | `platform`, `apiKey`, `secUid`, `count` |
| `homepage-publisher` | 媒体 URL JSON | 发布结果（slot/url/mime） | `slot` (card.* / agent.*.image / hero.*), `mediaType`, `sourceField` (JSONPath) |
| `weekly-poster-publisher` | items 数组 | posterId / pageCount | `presentationMode` (`ad-4-3` / `static`), `templateKey`, `accentColor`, `ctaText`, `ctaUrlField` |

### 1.5 重要踩坑记录（防 Phase 2 重蹈覆辙）

1. **TikHub `web/fetch_user_post` 上游 400**：连官方示例 secUid 也失败（TikTok web 限流），必须走 `app/v3/fetch_user_post_videos`。Douyin 走 `web/fetch_user_post_videos` 正常
2. **TikTok `cover` / `origin_cover` 是 HEIC**：浏览器不支持渲染。`dynamic_cover` 才是 WebP 动图，能直接用
3. **`<video poster={animated_webp}>` 渲染破图**：HTML5 `<video poster>` 只接静态图，动图 webp 用 `<img>` 独立层渲染才稳
4. **`tiktokcdn` host 同时服务视频和封面**：`isVideoUrl` 不能仅用 host 判定，必须用路径（`/video/tos/` 或 `/aweme/v{N}/play/`）
5. **`WeeklyPosterController` 缺 `[Authorize]`**：导致 AI Access Key 等 non-cookie 认证一律 401
6. **`HomepagePublisher` MIME 残留 octet-stream**：CDN 返回 `application/octet-stream` 时必须用 ext 反推 mime，否则 COS 上的对象 mime 错误，前端拒绝渲染

---

## 2. Phase 2 已交付（任务 A / B / C，2026-05-06）

### 2.1 交付总览

把 TikTok / 抖音视频从"只看封面 + 点开播放"升级到**"图文并茂的内容卡"**：视频先走真音频转写 + AI 提炼 hook & bullets，再渲染成左右双栏的图文混排海报，点 Play 才切回原 4:3 全 bleed 视频。Phase 1 的 `ad-4-3` 模板继续可用，零向下兼容破坏。

### 2.2 任务 A — `video-to-text` 胶囊新增 `asr` 模式

#### 入口与配置

`CapsuleExecutor.cs` 在 `ExecuteVideoToTextAsync` 主入口检测到 `extractMode == 'asr'` 时，分发到新增的 `ExecuteVideoToTextAsrAsync` 方法。新方法做四件事：
1. 检测输入形态（裸数组 / `{items: [...]}` / 单对象），统一规范成 `List<JsonElement> rawItems`
2. 解析 ASR 模型池一次（`AppCallerCode = video-agent.video-to-text::asr`，仅支持 `doubao-asr-stream` 转换器）
3. 对每个 item：HttpClient 下载视频 → ffmpeg 抽 16kHz mono wav 音轨 → `DoubaoStreamAsrService.TranscribeWithCallbackAsync` 流式转写
4. 若 `enableHookExtraction=true`，把转写文本和原标题再喂给 LLM Gateway（chat 模型，`AppCallerCode = video-agent.video-to-text::chat`），输出 JSON `{hook, bullets[3]}`，并拼成 markdown bullets `- xxx\n- xxx\n- xxx` 写到 `item.body`

新增 ConfigSchema 字段（`CapsuleTypeRegistry.VideoToText`）：

| Key | 默认 | 说明 |
|---|---|---|
| `extractMode` | `metadata` | 新增 `asr` 选项 |
| `videoUrlField` | `videoUrl` | 上游 item 取哪个字段做下载 URL（点号路径） |
| `itemsField` | `items` | 上游 JSON 哪个字段是数组（自动兜底单对象 / 裸数组） |
| `maxItems` | `4` | ASR 上限 1-20，防止单次工作流跑爆配额 |
| `enableHookExtraction` | `true` | 关闭后只输出原始转写不调 LLM |
| `hookSystemPrompt` | (空) | 留空走默认提示词；自定义时输出必须为严格 JSON |

#### 输出格式

数组输入 → `{items: [enriched...], firstItem: {...}, count, asrProcessed}`。每个 enriched item 在原字段基础上追加：
- `transcript` — ASR 全文（可能为空字符串，视频不可达时降级）
- `hook` — LLM 一句话钩子（≤ 14 字）
- `bullets` — string[] 三条要点（每条 ≤ 25 字）
- `body` — markdown bullets，可直接喂 ad-rich-text 海报

单对象输入 → 单个 enriched 对象（不包 items）。

#### 关键依赖（前置条件）

- 管理员需在模型池为 `AppCallerCode = video-agent.video-to-text::asr` 绑定一个 doubao-asr-stream 模型（复用 `DoubaoStreamAsrService` + `IModelResolver` 同款配置规约）
- 容器 host 需有 `ffmpeg` 二进制（CDS 容器已预装，本地 dev 需 `apt install ffmpeg`）

新增 `AppCallerRegistry.VideoAgent.VideoToText.Asr` 常量供管理后台模型池 picker 自动列出。

### 2.3 任务 B — 新海报版式 `ad-rich-text`

`prd-admin/components/weekly-poster/WeeklyPosterModal.tsx` 新增 `PosterRichTextPageView` 组件 + `PosterCarousel` 路由扩为三分支（`ad-4-3` / `ad-rich-text` / `static`）。

#### 视觉设计

4:3 弹窗骨架（与 `ad-4-3` 共享同款宽度公式 `min(960px, calc((100vh - 80px) * 1.333), calc(100vw - 64px))`）。内部布局：

```
┌────────────────────────────────────┐
│  [⭡ weekKey 角标]                  │
│  ┌──────────┐                      │
│  │ 9:16     │  Hook 大字           │
│  │ 动态封面  │  ──── (accent 分割) │
│  │ ＋ Play   │  • bullet 1          │
│  │ hover 浮层│  • bullet 2          │
│  │          │  • bullet 3          │
│  └──────────┘                      │
└────────────────────────────────────┘
```

- 左侧 44% 宽，竖屏 9:16 cover（适配 TikTok / 抖音 原生比例）
- 右侧 56%：weekKey 角标 + Hook h2（clamp 22-38px）+ accent 色分割条 + bullets markdown（descendant selector `[&_ul]:list-disc` 给 ReactMarkdown 加 list 样式）
- Cover 上 hover 浮层有 64px Play 按钮（仅有视频源时渲染）
- 点击 Play → `hasPlayed=true` → 切到与 `PosterAdPageView` 播放后视觉一致的全 bleed `<video controls autoplay>`

#### 字段映射（沿用 `ad-4-3` 约定，零 schema 变更）

| WeeklyPosterPage 字段 | 在 ad-rich-text 里的角色 |
|---|---|
| `imageUrl` | 视频 URL（点 Play 才播） |
| `secondaryImageUrl` | cover 静图/动图（左侧主体） |
| `title` | hook 大字（任务 A 写入 `item.hook`，发布器映射到这里） |
| `body` | bullets markdown（任务 A 写入 `item.body`，发布器透传） |
| `accentColor` | 分割条 + 角标色调 |

`weeklyPoster.ts` 类型联合追加 `'ad-rich-text'`。`WeeklyPosterAnnouncement.cs` 注释同步实际支持的三种模式。

### 2.4 任务 C — 串联 4 节点新模板

`prd-admin/pages/workflow-agent/workflowTemplates.ts` 新增 `tiktokCreatorToHomepageRichTemplate`：

```
手动触发
  ↓
tiktok-creator-fetch
  ↓ (items 数组)
video-to-text (extractMode=asr, maxItems=count, enableHookExtraction=true)
  ↓ ({items: [enriched], firstItem})
weekly-poster-publisher (presentationMode=ad-rich-text, accentColor=#ff0050)
```

`weekly-poster-publisher` 渲染 page 时新增 `item.hook` / `item.body` 优先通道（`CapsuleExecutor.cs ExecuteWeeklyPosterPublisherAsync`）：
- pageTitle ← `item.hook` > `item.title/desc/description/name` > `作品 #N`
- body ← `item.body` > `@author + #aweme + 截断 desc` 兜底

未提供 hook/body 字段时走原 Phase 1 兜底，`ad-4-3` 模板零回归。

模板表单提供 5 个输入字段（apiKey / platform / secUid / count / enableHook），count 选项里给出预估耗时（4 条约 2-3 分钟）。

### 2.5 关键文件改动

| 文件 | Phase 2 改动 |
|---|---|
| `prd-api/PrdAgent.Api/Services/CapsuleExecutor.cs` | `ExecuteVideoToTextAsync` 加 asr 分发；新增 `ExecuteVideoToTextAsrAsync` + `TryExtractJsonObject` + `ExtractAudioWithFfmpegAsync`；`ExecuteWeeklyPosterPublisherAsync` 加 hook/body 优先通道 |
| `prd-api/PrdAgent.Core/Models/AppCallerRegistry.cs` | 新增 `VideoAgent.VideoToText.Asr` 常量 |
| `prd-api/PrdAgent.Core/Models/CapsuleTypeRegistry.cs` | `VideoToText` 加 5 项 ASR 配置；`WeeklyPosterPublisher` 加 `ad-rich-text` 选项 |
| `prd-api/PrdAgent.Core/Models/WeeklyPosterAnnouncement.cs` | `PresentationMode` 注释同步实际三种模式 |
| `prd-admin/services/real/weeklyPoster.ts` | `WeeklyPosterPresentationMode` 联合追加 `'ad-rich-text'` |
| `prd-admin/components/weekly-poster/WeeklyPosterModal.tsx` | 新增 `PosterRichTextPageView`；`PosterCarousel` 扩为三分支路由 |
| `prd-admin/pages/workflow-agent/workflowTemplates.ts` | 新增 `tiktokCreatorToHomepageRichTemplate` 模板 |
| `changelogs/2026-05-06_emergence-1-phase-2-rich-text-poster.md` | Phase 2 完整变更碎片 |

### 2.6 已知边界 / 工程债务（待补）

落到 `doc/debt.video-agent.md`（如未来更通用，则该文件应改名）。当前 Phase 2 留尾：

1. **ASR 模型池绑定是手动**：用户首次跑 ASR 模板前必须去管理后台为 `video-agent.video-to-text::asr` 绑定 `doubao-asr-stream` 模型。绑定缺失时胶囊抛 `InvalidOperationException` 带明确指引（不会无声失败，但用户得自己看错误信息去配置）。可后续做"首次执行向导"或允许 fallback 到 `video-agent.v2d.transcribe::asr`
2. **maxItems 默认 4 是硬编码**：未对接配额计费，超出 4 条会截断不报错。生产化时需对接计费监控
3. **LLM hook 提炼无 LlmRequestContext**：沿用现有 video-to-text/llm 模式的旧规约，与 `.claude/rules/llm-gateway.md` 严格读法不一致（workflow capsule 上下文里 UserId 来自 `__triggeredBy` 变量，未走 `BeginScope`）。后续若引入用户级配额需要补
4. **ASR 失败兜底为空 transcript 透传**：可能导致 ad-rich-text 页面右侧 bullets 区域空白。已加日志，但前端无 fallback UI。可在 `PosterRichTextPageView` 里检测 `body` 为空时降级到 ad-4-3 风格
5. **ffmpeg 依赖未检测**：CDS 容器有 ffmpeg，本地 dev 镜像可能没有。`ExtractAudioWithFfmpegAsync` 启动失败抛异常，但用户可能误以为是 ASR 模型问题
6. **count 与 maxItems 分裂**：模板 build 时把 maxItems 设为 count，但用户在画布里改 count 不会自动改 maxItems（两个字段独立维护）
7. **rich-text 视图无切换返回**：用户点 Play 进入全屏视频后无法回到 rich-text 视图（必须关闭弹窗或翻页才能重置 `hasPlayed` 状态）

---

## 3. Phase 2 待做：任务 D — 抖音 OAuth 长 token + 真订阅

目前所有模板都靠手动触发。完整订阅闭环还差：

1. **抖音 OAuth 接入**：用户授权后拿到长效 token，存到 `external_authorizations` 集合（已有结构，可借用）
2. **定时调度**：cron 5 分钟查一次，新作品入库前比对去重 key（aweme_id）。当前 `timer` 胶囊在 `wip:true` 状态——具体能不能跑要看部署版本，否则需走外部 cron 调 `POST /api/workflow-agent/workflows/{id}/run`
3. **通知**：新作品发布时除了换海报，还可推送 station 内 admin notification
4. **去重表**：新增 `tiktok_creator_seen_aweme_ids` 集合或在工作流执行历史里做幂等检查

任务 D 是最大块（OAuth 单独就是 1-2 天工作量），独立性最强，不阻塞 Phase 2 任务 A/B/C 落地。

### 3.1 边界 / 不要做（Phase 2 沿用 Phase 1 红线）

- ❌ **不要碰 `card.* / agent.*.image / hero.*` 这些首页设计资产**——那是设计师手动维护的视觉位（CLAUDE.md 用户已明确要求）。运营内容只走 `weekly_posters` 集合
- ❌ **不要去掉 `[Authorize]` 装饰器** — 这是 admin controller 标配，去掉 AI Access Key 立刻 401
- ❌ **不要把 cover URL 当视频处理** — TikTok CDN host 共用，必须走路径级别检测 (`/video/tos/`)
- ❌ **不要在 `<video poster>` 里塞动图 webp** — Chromium 渲染破图占位符
- ❌ **不要让模板默认 `count > 4`**（rich-text 模板因 ASR 慢更要克制）

---

## 4. 交接给下一个智能体的步骤（含 Phase 2 验收）

### 4.1 第一次拉到这个任务时

```bash
# 1. 切到 Phase 2 分支看现状
git fetch origin claude/review-emergence-plan-Y8pOR
git checkout claude/review-emergence-plan-Y8pOR

# 2. 跑通 Phase 2 任务 A/B/C 验证你环境 OK
# - 打开 https://review-emergence-plan-y8por-claude-prd-agent.miduo.org/
# - 登录 → 工作流 → 新建 → 选「TikTok / 抖音 博主订阅 → 首页图文混排海报 (ASR)」
# - 填 TikHub key + 默认 secUid → 执行 → 等 2-3 分钟看节点逐步绿
# - 完成后登录主页应弹出图文混排海报，左动图 + 右 hook + bullets

# 3. 读这份文档 + 关键文件
cat doc/plan.emergence-1-tiktok-douyin-poster.md
# 看 §1.3（Phase 1）+ §2.5（Phase 2）"关键文件清单"
```

### 4.2 接 Phase 2 任务 D 时

#### 推荐顺序

1. **先做 OAuth 设备授权流（design.* + Controller）**——独立可测，不阻塞 cron
2. **再做去重表 + 幂等检查**——保证重复执行不会刷屏首页弹窗
3. **最后串 cron 调度**——优先排查 `timer` 胶囊 wip 状态，必要时走外部 cron + workflow run API

#### 每个任务做完跑这套验证

```bash
# 前端
cd prd-admin && pnpm tsc --noEmit && pnpm exec eslint src/components/weekly-poster src/pages/workflow-agent

# 后端
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS"

# 端到端冒烟
/cds-deploy   # 触发部署
# CDS 链路绿后真人去预览域名验收（参考 §4.1）
```

#### Changelog

每次提交在 `changelogs/2026-XX-XX_emergence-1-phase-2-*.md` 加碎片，**不要**直接编辑 `CHANGELOG.md`（CLAUDE.md 规则 #4）。

### 4.3 完成后

- 把 `presentationMode` 文档单独移到 `doc/spec.weekly-poster-presentation-modes.md`（独立文档），列出 static / ad-4-3 / ad-rich-text / fullscreen / interactive 五种状态与字段约定
- 把 `涌现 1` 系列下一篇（涌现 2）开新文件 `doc/plan.emergence-2-*.md`，本文件保持只读历史
- 更新 `doc/index.yml` 与 `doc/guide.list.directory.md`
- 把 §2.6 已知边界里仍然存在的项移入 `doc/debt.video-agent.md`
- 通知用户验收 + `/handoff` 出交接清单

---

## 4. 关联文档

- `.claude/rules/marketplace.md` — 海鲜市场扩展（如要把 TikTok 订阅作为可分享的工作流模板上架）
- `.claude/rules/server-authority.md` — Run/Worker 模式（cron 调度真订阅时必读）
- `.claude/rules/llm-gateway.md` — ASR / 摘要必经
- `prd-admin/src/lib/homepageAssetSlots.ts` — 首页 slot 注册表（**只读**，Phase 2 不需要动）

---

**最后更新**: 2026-05-06 / Phase 2 任务 A/B/C 完成（commits `cbef04c` `1d87b8a` `1604c15` 在分支 `claude/review-emergence-plan-Y8pOR` 上）/ Phase 1 完成 commit `61046085`
