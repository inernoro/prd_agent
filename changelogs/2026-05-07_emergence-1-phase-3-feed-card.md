| feat | prd-api | 博主作品订阅胶囊扩展支持 5 平台（TikTok / 抖音 / B 站 / 小红书 / YouTube），按 platform 分发到 5 个 normalizer 输出统一 schema |
| feat | prd-api | 新增 media-rehost 胶囊，items 数组里的视频/封面/头像 URL 下载到 COS 替换为稳定直链，绕开 CDN 防盗链 403 |
| feat | prd-api | weekly-poster-publisher 新增 feed-card 版式（presentationMode），并把 page schema 扩到 7 个新字段：authorName / avatar / platform / durationSec / hashtags / stats / transcriptCues |
| feat | prd-api | video-to-text asr 模式从豆包 ASR utterances 抽取毫秒级时间戳写入 item.transcriptCues，给前端字幕浮层用 |
| feat | prd-api | 5 个 normalizer 全部透出 author / avatar / duration / stats / hashtags 字段（TikTok statistics、B 站 length 字符串、小红书 interact_info 等）|
| feat | prd-admin | PosterFeedCardView 组件实现抖音/小红书风格 9 信息单元布局：头像 + @ 用户 + 平台 chip + 时长 + 视频 + 互动 chip + 字幕浮层 + 标题 + 标签 |
| feat | prd-admin | feed-card 模态视频比例自适应：检测 videoWidth/Height 三档切换 9:16 (460px) / 4:3 (760px) / 16:9 (920px) |
| feat | prd-admin | 海报弹窗 X 按钮重定义为「收起到右下角胶囊」，胶囊上的 ✕ 才彻底 dismiss。仿 Slack PiP / 抖音 reminder 模式 |
| feat | prd-admin | feed-card 视频播放时挂 timeupdate listener，二分查找 currentTime 命中的 cue，渲染半透明字幕浮层 |
| feat | prd-admin | 多平台模板加 PLATFORM_OPTIONS / PLATFORM_CTA_LABELS / PLATFORM_ID_HELP 共享常量，两个工作流模板都自动支持 5 平台下拉切换 |
| feat | prd-admin | 工作流模板默认插入 media-rehost 节点（fetch → rehost → publish），rich-text 模板里 rehost 在 ASR 之前防止短期签名 URL 二次过期 |
| fix | prd-api | WeeklyPosterPageDto 同步透出 7 个新字段 + TranscriptCues，否则 GET /api/weekly-posters/* 永远返回 null |
| docs | doc/ | 新增 guide.poster-feed-card 用户教程；plan.emergence-1 加 §3 Phase 3 已交付段；debt.workflow-agent 升 v2.0：Phase 2 留尾 7 项 paid + 5 项 Phase 3 新债 |
