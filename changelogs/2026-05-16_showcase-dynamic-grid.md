| feat | prd-admin | 作品广场列数随屏宽动态自适应（标准屏5列，带鱼屏6-7列防卡片过大，小屏降至3/2列） |
| feat | prd-admin | 作品广场新增创作者头像筛选行，点击头像只看该创作者作品，切类型标签自动刷新 |
| feat | prd-admin | 作品广场增强极光渐变动效背景（柔和漂移+呼吸，支持 prefers-reduced-motion 降级） |
| feat | prd-api | 投稿 public 列表支持 ownerUserId 过滤 + 新增 public/creators 聚合接口 |
| fix | prd-admin | 创作者头像行隐藏老土滚动条（保留滚动），首页区块移除有色极光背景 |
| fix | prd-admin | 前三名创作者改用金/银/铜彩色光圈（替代看不清的小皇冠） |
| perf | prd-admin | 作品广场封面图视口懒挂载（IntersectionObserver，未滚动到的卡片零请求）+ 首屏批量缩小（首页20→12 / showcase 24→18）+ decoding=async，大幅降低首屏流量 |
