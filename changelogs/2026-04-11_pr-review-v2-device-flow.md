| refactor | prd-api | PR Review V2 切换到 GitHub Device Flow (RFC 8628)，取代 Web Flow。原因：CDS 动态域名（<branch>.miduo.org）与 Web Flow Callback URL 预注册机制不兼容，Device Flow 无需 callback，本地/CDS/生产共用一套代码 |
| refactor | prd-api | GitHubOAuthService 重写：StartDeviceFlowAsync + PollDeviceFlowAsync + HMAC 签名的无状态 flowToken（base64url(deviceCode|userId|expiry|hmac)，FixedTimeEquals 防时序攻击） |
| refactor | prd-api | PrReviewController 新增 POST /auth/device/start 与 POST /auth/device/poll，删除 /auth/start、/auth/callback、ResolveBaseUrl、BuildCallbackUrl 等 Web Flow 遗留 |
| refactor | prd-api | PrReviewErrors 新增 DEVICE_FLOW_TOKEN_INVALID / DEVICE_FLOW_EXPIRED / DEVICE_FLOW_ACCESS_DENIED / DEVICE_FLOW_REQUEST_FAILED；移除 state 相关错误码 |
| refactor | prd-admin | services/real/prReview.ts 替换 startPrReviewOAuth 为 startPrReviewDeviceFlow + pollPrReviewDeviceFlow，新增 PrReviewDeviceFlowStart/Poll 类型 |
| refactor | prd-admin | usePrReviewStore 重写授权路径：startConnect → open verificationUriComplete → 自动轮询循环，按 slow_down 响应动态调大间隔，支持本地倒计时超时 |
| refactor | prd-admin | GitHubConnectCard 重写为 Device Flow UX：授权码大字展示 + 一键复制 + 打开 GitHub 按钮 + 倒计时进度条 + 终态提示（expired/denied/failed） |
| refactor | prd-admin | PrReviewPage 移除 ?connected=1 query 处理（Device Flow 无 redirect），简化主页面逻辑 |
| docs | doc | design.pr-review-v2.md / spec.srs.md §4.24 全面更新，反映 Device Flow 架构与 CDS 动态域名适配决策 |
