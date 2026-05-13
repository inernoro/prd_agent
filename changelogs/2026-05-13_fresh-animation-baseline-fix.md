| fix | prd-admin | 网页托管：修复上一轮"hasLoadedOnceRef 设置时机过早导致首屏所有卡片被判为新增、全部播放滑入+光环动效"的回归。改用 baselineSettledRef 推迟一帧，确保首屏只记 baseline 不触发动效（Cursor Bugbot PR #598 review） |
