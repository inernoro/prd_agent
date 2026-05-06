# 涌现 1 · TikTok / 抖音博主订阅 → 首页广告海报

> **系列定位**: 涌现 1（emergence-1）。本仓库的"涌现"系列指**借助平台已有砖块（工作流胶囊 + LLM Gateway + 周报海报弹窗 + COS / HomepageAsset）组合出的新功能**。本期是该系列首作。
>
> **状态**: Phase 1 已上线，Phase 2 待下一个智能体接手。
>
> **交接对象**: 下一个负责 Phase 2 的智能体（人 / Cursor / Claude Code 均可）。

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

## 2. Phase 2 待做（下一智能体）

### 2.1 总目标

把 TikTok / 抖音视频从"只看封面 + 点开播放"升级到**"图文并茂的内容卡"**：

- 视频自动转文字（标题 / 字幕 / 描述）→ AI 摘要 → 海报正文
- 海报每页支持"顶部动态封面 + 中段大字 hook + 底部转写摘要"图文混排
- 不再仅仅是 4:3 全 bleed 视频

### 2.2 子任务

#### 任务 A: 视频转文字胶囊（接入现有 `video-to-text`）

仓库**已有** `video-to-text` 胶囊（`CapsuleExecutor.cs:ExecuteVideoToTextAsync`），目前两种模式：
- `metadata`: 直接用 TikHub 返回的 `title/desc/字幕` 字段（**免费 / 快**）
- `llm`: 用多模态 LLM 看封面图 + 描述（**收费 / 较慢**）

Phase 2 要做：
1. **真音频转写模式**: 加第三种 `extractMode = 'asr'`，调系统已有 ASR 模型池（参考 `prd-api/src/.../Services/Asr*` 是否已存在；不存在则借用 `transcript-agent`）。先下载 mp4 → 提取音轨（ffmpeg） → ASR 文字稿
2. **AI 二次提炼**: 转写后再走一遍 LLM Gateway 出"标题 / 一句话 hook / 三段要点"结构化文本
3. 输出新增 `transcript / hook / bullets` 字段进上游 JSON

#### 任务 B: 新海报版式 `ad-rich-text` 图文混排

现有 `presentationMode` 路由：
- `static` — 老横幅 1200×628
- `ad-4-3` — 全 bleed 视频广告（Phase 1 做的）
- **`ad-rich-text` (新增)** — 图文混排

`ad-rich-text` 设计建议（参考 Apple Newsroom / Instagram Story Ad / 小红书笔记三套行业范式）：

```
┌────────────────────────────────────┐  4:3 或 3:4 都可
│  ┌──────────┐                      │
│  │          │  hook 大字 (clamp 28-44px)
│  │ 顶部动图  │  例: "Girl's Trip Season"
│  │  cover   │                      │
│  │  16:9    │  ─────────────────   │
│  │          │  • bullet 1          │
│  └──────────┘  • bullet 2          │
│                • bullet 3          │
│                                    │
│  [✦ @TikTok · 12s ago]    [Play ▶] │ ← 小角标，点 Play 切到 ad-4-3 全屏视频
└────────────────────────────────────┘
```

实现要点：
- 沿用 `WeeklyPosterPage` schema：`title`=hook, `body`=bullets (markdown), `imageUrl`=cover, `secondaryImageUrl`=videoUrl（点 Play 切回 ad-4-3 全 bleed）
- 在 `WeeklyPosterModal.tsx` 加一个 `PosterRichTextPageView` 组件，由 `presentationMode === 'ad-rich-text'` 路由
- 模板表单加 `presentationMode` 选项让用户选 ad-4-3 / ad-rich-text

#### 任务 C: 工作流模板分叉

现有：`tiktokCreatorToHomepageTemplate` (3 节点 ad-4-3)

Phase 2 加：`tiktokCreatorToHomepageRichTemplate` (5 节点)

```
[手动触发] → [tiktok-creator-fetch] → [video-to-text (asr)] → [llm-analyzer (摘要)] → [weekly-poster-publisher (ad-rich-text)]
```

或者：让用户在原模板表单里选 `presentationMode`，模板 build() 里根据 mode 决定是否插入 `video-to-text + llm-analyzer` 两个中间节点（参数化模板）。

#### 任务 D: 抖音 OAuth 长 token + 真订阅

目前是手动触发。完整订阅闭环还差：
1. 抖音 OAuth：用户授权后拿到长效 token，存到 `external_authorizations` 集合
2. 定时调度：cron 5 分钟查一次，新作品入库前比对去重 key（aweme_id）
3. 通知：新作品发布时除了换海报，还可推送 station 内 admin notification

### 2.3 边界 / 不要做

- ❌ **不要碰 `card.* / agent.*.image / hero.*` 这些首页设计资产**——那是设计师手动维护的视觉位（CLAUDE.md 用户已明确要求）。运营内容只走 `weekly_posters` 集合
- ❌ **不要去掉 `[Authorize]` 装饰器** — 这是 admin controller 标配，去掉 AI Access Key 立刻 401
- ❌ **不要把 cover URL 当视频处理** — TikTok CDN host 共用，必须走路径级别检测 (`/video/tos/`)
- ❌ **不要在 `<video poster>` 里塞动图 webp** — Chromium 渲染破图占位符
- ❌ **不要让模板默认 `count > 4`** — 海报弹窗 5 页起翻页疲劳

---

## 3. 交接给下一个智能体的步骤

### 3.1 第一次拉到这个任务时

```bash
# 1. 切到 Phase 1 分支看现状
git fetch origin claude/auto-publish-tiktok-subscription-dnNKX
git checkout claude/auto-publish-tiktok-subscription-dnNKX

# 2. 跑通 Phase 1 验证你环境 OK
# - 打开 https://auto-publish-tiktok-subscription-dnnkx-claude-prd-agent.miduo.org/
# - 登录 → 应弹出 4:3 ad 海报，4 页 TikTok 视频，中央 Play 按钮可点

# 3. 读这份文档 + 关键文件
cat doc/plan.emergence-1-tiktok-douyin-poster.md
# 看 1.3 节"关键文件清单"列出的所有文件
```

### 3.2 开发 Phase 2 时

#### 推荐顺序

1. **先做任务 B（`ad-rich-text` 视图）**——纯前端，影响最小，能直接验证视觉
2. **然后任务 A（ASR 转写）**——后端胶囊扩展，有 LLM Gateway 现成
3. **任务 C（模板组合）**——把 A + B 串起来
4. **任务 D（真订阅）放最后**——抖音 OAuth 是大头，不阻塞前面

#### 每个任务做完跑这套验证

```bash
# 前端
cd prd-admin && pnpm tsc --noEmit && pnpm exec eslint src/components/weekly-poster src/pages/workflow-agent

# 后端
cd prd-api && dotnet build --no-restore 2>&1 | grep -E "error CS|warning CS"

# 端到端冒烟
/cds-deploy   # 触发部署
# 然后 7 层冒烟（参考 plan.emergence-1 §"冷测验收"段落）
```

#### Changelog

每次提交在 `changelogs/2026-XX-XX_emergence-1-phase-2-*.md` 加碎片，**不要**直接编辑 `CHANGELOG.md`（CLAUDE.md 规则 #4）。

### 3.3 完成后

- 把 `presentationMode` 文档移到 `doc/spec.weekly-poster-presentation-modes.md`（独立文档）
- 把 `涌现 1` 系列下一篇（涌现 2）开新文件 `doc/plan.emergence-2-*.md`，本文件保持只读历史
- 更新 `doc/index.yml` 与 `doc/guide.list.directory.md`
- 通知用户验收 + `/handoff` 出交接清单

---

## 4. 关联文档

- `.claude/rules/marketplace.md` — 海鲜市场扩展（如要把 TikTok 订阅作为可分享的工作流模板上架）
- `.claude/rules/server-authority.md` — Run/Worker 模式（cron 调度真订阅时必读）
- `.claude/rules/llm-gateway.md` — ASR / 摘要必经
- `prd-admin/src/lib/homepageAssetSlots.ts` — 首页 slot 注册表（**只读**，Phase 2 不需要动）

---

**最后更新**: 2026-05-06 / Phase 1 完成 commit `61046085`
