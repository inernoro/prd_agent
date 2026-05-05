| feat | prd-api | 工作流新增 tiktok-creator-fetch 胶囊（调 TikHub 拉博主视频列表，输出标准化 items 数组 + firstItem 快捷字段）
| feat | prd-api | 工作流新增 homepage-publisher 胶囊（下载媒体并写入 HomepageAsset，slot/objectKey 规则与 HomepageAssetsController 对齐）
| feat | prd-admin | 工作流模板新增「TikTok 博主订阅 → 首页海报」：填 secUid + API 密钥 → 抓最新视频 → 直发首页槽位
| refactor | prd-admin | TikTok 博主订阅模板瘦身：必填项从 5 项砍到 2 项（API 密钥 + secUid，secUid 默认填 TikHub 官方示例），默认发封面图到 card.showcase 槽位避开 tt_chain_token 复杂度
| fix | prd-api | TikTok 端点改用 app/v3（/api/v1/tiktok/app/v3/fetch_user_post_videos），web 端点上游 TikTok 实测 400（连官方示例 secUid 也失败）。app/v3 稳定可用，响应结构 data.aweme_list 与抖音对齐
| fix | prd-api | TikTok coverUrl 改优先取 video.dynamic_cover（WebP）。TikTok 默认的 video.cover/origin_cover 实际返回 HEIC，浏览器无法直接显示
| feat | prd-api | 工作流新增 weekly-poster-publisher 胶囊：把上游条目数组写入 WeeklyPoster 集合并发布，登录后首页轮播弹窗即时显示。每条 item 对应海报一页（title/body/imageUrl），imageUrl 前端自动识别视频/图片
| feat | prd-api | tiktok-creator-fetch 标准化输出新增 shareUrl 字段（拼 https://www.tiktok.com/@unique_id/video/aweme_id），便于海报 CTA 直跳 TikTok
| refactor | prd-admin | TikTok 模板改名「订阅 → 首页弹窗海报」，发布节点改用 weekly-poster-publisher，count 默认 4（弹窗 4 页轮播），CTA 自动跳到 TikTok 视频页
| fix | prd-api | WeeklyPosterController 补 [Authorize] 装饰器，AI Access Key 等 non-cookie 认证才能正常通过（之前缺这个标记，AdminPermissionMiddleware 直接拦在未登录分支返回 401）
| fix | prd-admin | 移除 WeeklyPosterModal 用户端误传的 metaLabel="1200 × 628 · 发布"（编辑器调试残留），用户登录看到的弹窗右下角不再有这条提示
| feat | prd-admin | isVideoUrl 扩展识别 TikTok / 抖音 CDN URL（路径含 /video/tos/ 或 host 含 tiktokcdn 等），无 .mp4 扩展名也能命中，被识别后走 <video autoplay loop> 自动播放
| refactor | prd-api | weekly-poster-publisher 优先取 videoUrl（真实 mp4，前端直接 <video> 播放），fallback 到 coverUrl。海报弹窗由"模糊静图"升级为"自动播放视频"
| feat | prd-admin | TikTok 订阅模板新增 platform 二选项（TikTok / 抖音），选抖音时走 sec_user_id + douyin web 端点
| feat | prd-admin | 海报弹窗新增 ad-4-3 展示模式：4:3 比例 + 全 bleed cover/video + 中央 Play 按钮 + 用户主动点击播放（借鉴 Apple 产品视频弹窗 / Netflix 预告 modal / Twitch 视频卡片，autoplay 容易吓跑用户）。修改 WeeklyPosterModal.tsx 根据 presentationMode 切换 aspectRatio 和 PageView 组件
| feat | prd-api | weekly-poster-publisher 暴露 presentationMode 配置（默认 ad-4-3）；视频 URL 时同步把 cover 写到 SecondaryImageUrl 作为 video poster 海报，pause 状态显示静图，点击后切到真视频
| refactor | prd-admin | TikTok / 抖音订阅模板默认 presentationMode='ad-4-3'，CTA 文案随平台切换（"去 TikTok 看完整视频" / "去抖音看完整视频"）
