| refactor | prd-admin | 网页托管：彻底重写"新上传卡片动效"机制 — 砍掉 sites diff，改为 onSaved 回调直接把新 site ID 推入 freshIds。修复 Cursor PR #598 review：筛选/排序变化误触发动效、首屏全部卡片误触发、首屏空时无动效等三个 diff 路径的连锁 bug |
