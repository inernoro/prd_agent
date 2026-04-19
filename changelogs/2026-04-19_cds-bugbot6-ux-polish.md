| fix | cds | Bugbot #450 第六轮 LOW: handleCheckRun 补 head_sha 格式校验(与 handlePush 一致) — malformed SHA 在 updateBranchGithubMeta + .slice() 路径会炸 |
| feat | cds | 分支卡片 chip 布局重构 — github chip(去 "from GitHub" 文字只留图标+7位 SHA)、端口 chips、pinned 历史提交 chip 合并到同一行 branch-card-chips flex wrap,所有分支卡片高度/结构从此一致 |
| feat | cds | 分支列表页改用 CSS column-count 瀑布流布局,消除网格行高对齐造成的视觉空洞(不同卡片 tag/徽章数量差异导致的断层) |
