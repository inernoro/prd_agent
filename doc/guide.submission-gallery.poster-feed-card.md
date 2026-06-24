# 多平台博主订阅 → 首页海报弹窗 · 指南

> **版本**：v1.0 | **日期**：2026-05-07 | **状态**：已落地

把 TikTok / 抖音 / B 站 / 小红书 / YouTube 任一博主的最新 N 条作品，自动拉过来 + 媒体迁移到 COS + 落到首页登录弹窗海报。**不需要写代码**，工作流编辑器拖几步就搭出来。

本文档面向：第一次使用此功能的运营 / 管理员 / 开发同事。

---

## 1. 这套东西做了什么

```
[手动触发 / cron]
    ↓
[博主作品订阅 (TikHub)]   ← 一个 API key 五个平台
    ↓ items[]
[媒体迁移到 COS]          ← 解决抖音/B 站防盗链 403
    ↓ items[] (COS URLs)
[(可选) 音频转写 + AI 提炼]  ← rich-text 模板才有
    ↓ items[] (+ hook / bullets / 字幕时间戳)
[发布到首页弹窗海报]
    ↓
weekly_posters 集合 → 登录后所有用户首页弹窗
```

完成后用户登录就能看到一张轮播海报，每页对应博主的一条作品。

---

## 2. 前置条件

### 2.1 必备

| 项 | 说明 |
|---|---|
| TikHub API Key | https://tikhub.io 用户中心免费申请。一个 key 通五个平台 |
| 管理员账号 | 需要 `workflow-agent.use` 权限创建工作流 |

### 2.2 仅 ASR 模板需要（rich-text + 字幕版式）

如果只用 `ad-4-3` / `feed-card` / `static` 三种版式，不需要。如果要走 `ad-rich-text` 或想要字幕浮层，必须确认管理后台「模型池」里**至少有一个 ASR caller 绑了 doubao-asr-stream 模型**。三个 caller 任一即可，胶囊会按以下顺序 fallback：

1. `video-agent.video-to-text::asr`（推荐为本功能新建一个独立池）
2. `video-agent.v2d.transcribe::asr`（视频转文档已用）
3. `document-store.subtitle::asr`（知识库字幕已用）

如果你之前用过「视频转文档」或「知识库字幕生成」功能，**大概率不需要新建**——胶囊会自动 fallback 到现有池。

---

## 3. 选模板创建工作流

工作流编辑器目前提供 2 个开箱即用模板：

| 模板名 | 节点数 | 适用 | 总耗时 |
|---|---|---|---|
| **多平台博主订阅 → 首页广告海报 (TikHub)** | 4 | 快速发布。轻量、不需要 ASR 模型池 | 30s ~ 2min |
| **多平台博主订阅 → 首页图文混排海报 (ASR)** | 5 | 想要 hook 大字 + bullets + 字幕浮层 | 2 ~ 8min（每条作品 ASR 10-60s） |

### 3.1 操作步骤

1. 登录管理端，左侧菜单进「**工作流**」
2. 右上角「**新建工作流**」
3. 选模板（任选一个）
4. 表单填 4 项必填：

| 字段 | 填什么 | 示例 |
|---|---|---|
| **TikHub API Key** | 你的 key 或 `{{secrets.TIKHUB_API_KEY}}` | `gr1eUZ4r...` |
| **平台** | 下拉五选一 | 抖音 |
| **博主 ID** | 按平台不同，见下表 | `MS4wLjAB...` |
| **拉取数量** | 1-10 条 | 4 |

### 3.2 各平台「博主 ID」怎么取

| 平台 | 字段类型 | 怎么找 | 示例 |
|---|---|---|---|
| TikTok | secUid | 博主主页 URL 或 TikHub user search 接口 | `MS4wLjABAAAAv7iSuuXDJGDvJkmH_vz1qkDZYo1apxgzaxdBSeIuPiM` |
| 抖音 | sec_user_id | web 版抖音博主主页 URL `?sec_uid=` 后那段 | 同上格式（MS4wLjAB 开头）|
| B 站 | mid（数字） | UP 主主页 `space.bilibili.com/{mid}` 里的数字 | `208259`（哔哩哔哩官号）|
| 小红书 | user_id（24 位 hex） | 博主主页 URL `xiaohongshu.com/user/profile/{user_id}` 末段 | `5f8a9b2c000000000100abcd` |
| YouTube | channelId（UCxxxxx）| 频道页「关于」标签里看 channelId | `UCBR8-60-B28hp2BmDPdntcQ` |

⚠ **B 站常见错误**：填 BV 号（`BV1xx...`）—— 不对，要填 mid 数字
⚠ **YouTube 常见错误**：填 `@username` 或频道 URL slug —— 不对，要填 `UCxxxxx` 的 channelId

5. 点「**执行**」按钮
6. 看节点逐个变绿。失败节点会标红，点开看 logs

---

## 4. 验收：去首页看效果

执行完毕后，最后一个节点 logs 末尾会输出 posterId。打开任意账号登录预览域名，**首页应该弹出海报**。

预览域名公式（v3）：
```
https://{tail}-{prefix}-{projectSlug}.miduo.org/
```
- 当前分支 `claude/review-emergence-plan-Y8pOR` → tail=`review-emergence-plan-y8por`，prefix=`claude`，projectSlug=`prd-agent`
- 即 https://review-emergence-plan-y8por-claude-prd-agent.miduo.org/

如果首页没弹窗，可能原因：
- 该用户已经 dismiss 过这周的海报（同 weekKey 已读不重弹）
- 当前周已经有更新的 published 海报（同 weekKey 旧版自动归档）
- 直接点首页右下角「再看」胶囊（如果之前 minimize 过）

---

## 5. 四种海报版式怎么选

| presentationMode | 视觉 | 适合 | 必备字段 |
|---|---|---|---|
| **`feed-card`**（**推荐**）| 抖音 / 小红书播放页风格：头像 + @ 用户 + 平台 chip + 时长 + 视频 + 互动 chip + 字幕浮层 + 标题 + 标签 | 短视频博主订阅、内容信息密度高 | 必有视频；建议跑 ASR 模板有字幕 |
| `ad-4-3` | 4:3 全 bleed 视频广告 + 中央 Play | 强调视频本身、信息少 | 视频 URL（COS）|
| `ad-rich-text` | 4:3 左动图 + 右 hook 大字 + 三条 bullet | 摘要型呈现、重点突出 | 必须 ASR + LLM 提炼有 hook + bullets |
| `static` | 1200×628 横幅 上图 48% / 下文 52% | 兼容老周报海报 | 任意图片 |

### feed-card 视频比例自适应

`feed-card` 模式自动检测视频原生宽高比：
- 竖屏（短视频原生 9:16）→ 模态 460px 宽
- 方屏（4:3 中间档）→ 760px 宽
- 横屏（16:9 横屏视频）→ 920px 宽

不需要手动指定。

---

## 6. 关闭 / 收起 / 再看

海报弹窗右上角的 **X 按钮 = 收起到右下角胶囊**（不是直接关闭）。胶囊上有：
- 缩略图 + 标题 + 页码 → 点击重新展开（pageIndex 不丢）
- ✕ 红色按钮（hover 高亮）→ 这才是真的彻底关闭，dismiss 写到本地存储

设计意图：仿照抖音 PiP / Slack reminder，让用户即使误点也能找回海报。

---

## 7. 自动化（cron / 定时订阅）

当前模板默认是 `manual-trigger`（手动触发）。要改成定时订阅：

1. 编辑工作流
2. 删除 `manual-trigger` 节点
3. 拖一个 `timer` 节点替换上去
4. 配置 cron 表达式（如 `0 */6 * * *` 每 6 小时）

⚠ `timer` 胶囊目前在 `wip:true` 状态。如本部署版本 cron 不可用，备选方案：
- 走外部 cron（如 GitHub Actions 定时）调 `POST /api/workflow-agent/workflows/{id}/execute`
- 或等任务 D（抖音 OAuth + 真订阅闭环）正式落地

去重逻辑（防止同一作品重复发海报）暂未做，**当前每次执行都会归档同 weekKey 的旧 published 并新建一个**。任务 D 会落地 aweme_id 去重表。

---

## 8. 媒体迁移（media-rehost）：为什么海报不再 403

之前直接把 TikTok CDN 的临时签名 URL 写进海报，前端浏览器跨域拉视频被防盗链 403 → 视频白屏。

新增 `media-rehost` 胶囊插在 `tiktok-creator-fetch` 与 `weekly-poster-publisher` 之间：
- 输入：items 数组
- 行为：对每个 item 的 `videoUrl / coverUrl / authorAvatarUrl` 三个字段，下载到本平台 COS，URL 替换为稳定 `cfi.miduo.org` 直链
- 路径约定：`workflow/media-rehost/{yyyy-MM}/{guid}.{ext}`
- 并发 4 / 单文件 50MB 上限 / 失败保留原 URL 不阻塞流水线

模板默认已经在工作流里插好这个节点。**不要删除它**，否则海报会回到 403 状态。

如果上游视频 > 50MB（如 B 站长视频 154MB），rehost 会跳过保留原 URL；前端 isVideoUrl 检测到 B 站 CDN 域名，仍能尝试播放，但同样可能 403。**长视频建议设置 `maxBytesMb=200` 或更高**。

---

## 9. ASR 字幕浮层（feed-card / ad-rich-text 才有）

走 `ad-rich-text` 或 `feed-card` 模板 + `video-to-text` extractMode=asr 时：
1. 胶囊下载视频 → ffmpeg 抽 16kHz mono wav → 流式 ASR 转写
2. 从豆包 ASR 返回的 utterances 抽 `start_time / end_time / text`（毫秒精度）
3. 写到 `WeeklyPosterPage.transcriptCues`
4. 前端 `<video>` 监听 `timeupdate` → 二分查当前时间命中的 cue → 渲染半透明黑底 + 白字浮层在视频中下部

效果：播放抖音视频时实时同步显示当前句字幕。比抖音 web 还省一步开关字幕。

---

## 10. 常见问题

### Q1：执行节点显示「未知舱类型 'xxx'，已跳过」

CDS 部署模式问题。dev 模式下 dotnet watch hot-reload 遇到 rude edit 不能完整重启进程，跑旧 IL。

**解法**：CDS dashboard → 当前分支 → api 服务 → 部署模式切到「**静态部署 (publish)**」。详情见 `doc/debt.workflow-agent.md` 第 1 项。

### Q2：海报视频白屏点 Play 没反应

CDN 防盗链。检查工作流里有没有 `media-rehost` 节点 + 确认 imageUrl 是 `cfi.miduo.org` 域名。

如果是 B 站 / YouTube：list endpoint 不给 mp4 直链，海报上视频本来就播不了，CTA 跳转原平台。

### Q3：feed-card 海报上没头像 / 头像 403

抖音 / B 站 / 小红书的 avatar URL 也防盗链。确认 `media-rehost` 节点的 `rehostFields` 配置包含 `authorAvatarUrl`：

```
videoUrl,coverUrl,authorAvatarUrl
```

### Q4：ASR 模板报「ASR 模型调度失败：尝试了三个 caller，无一绑定...」

需要在管理后台「模型池」给 `video-agent.video-to-text::asr` / `video-agent.v2d.transcribe::asr` / `document-store.subtitle::asr` 三个 caller 中任一个绑定 `doubao-asr-stream` 模型。

### Q5：B 站填了 mid 还是拉不到

确认填的是数字 mid（如 `208259`）。不是 BV 号、不是 UID 加密版（`UID` 字段在某些 API 是加密的）。

---

## 关联文档

- `doc/plan.emergence.tiktok-douyin-poster.md`：本功能完整设计与三阶段交付历史
- `doc/debt.workflow-agent.md`：本功能已知边界与未还债务（含 dotnet watch 卡进程根因）
- `.claude/rules/marketplace.md`：把工作流模板分享到海鲜市场
- `.claude/rules/server-authority.md`：Run/Worker 模式（cron 调度真订阅时必读）

---

## 最近更新（来自 changelog 片段）

### 2026-06-14 短视频解析 Card 展示

- **后端 Card 数据**：短视频解析新增 Card 展示卡片数据（封面/作者/头像/时长/话题/点赞评论等统计）+ COS 永久视频地址
- **前端仿真卡片**：粘贴链接后改用仿真短视频卡片（复用 PosterFeedCardView）展示封面+可播放视频，取代原先的文字块
- **渐进加载**：封面先出、入库后切 COS 永久地址播放；解析进度降为卡片下方一行状态
