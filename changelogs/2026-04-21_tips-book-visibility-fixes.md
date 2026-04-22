| fix | prd-admin | 教程小书**永远显示**:之前 `tips.length === 0 && !pinned` 会 return null 导致入口消失,改为始终渲染,空状态也能点开看到提示文案 |
| fix | prd-admin | 教程小书挪到 AppShell 通知铃铛**上方**(bottom 20+48+12=80),之前和 `AppShell.tsx:485` 的 toast notification 按钮位置完全重叠被压在下面;hidden 时右边缘留 28px 书脊,看得见也点得到 |
| fix | prd-admin | 推送降临自动展开按 **tip.id 集合**记忆,取代之前「session 内只弹一次」的死锁,管理员在同一 session 再推新 tip 也能再弹一次 |
| feat | prd-admin | dailyTipsStore 新增 60s 轮询 + visibilityChange 监听,标签页从隐藏变可见时立刻刷新;store.load 增加 `force` 参数区分首次加载与强制重拉,让管理员推送能在 1 分钟内到达用户 |
