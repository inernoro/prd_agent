| feat | cds | 过期分支预览页按合并/放弃分流：合并显示「已合并到主分支」中间页+切主分支预览按钮（沿用动效网格背景），放弃显示「分支已放弃」页+跳 PR；新增分支墓碑（BranchTombstone）持久化 |
| feat | cds | 没走 PR 的直接删分支（git push --delete）也写墓碑（reason=abandoned），过期预览页落到「已放弃」页而非泛化「启动失败」；recordRemovedBranch 加 merged 粘性，避免删分支 delete 事件把已合并墓碑降级 |
| fix | cds | 修复极速版分支卡在「等 CI 镜像」被误标成「容器停止·无记录·时间未知」：分支卡拆出「等待 CI 镜像/CI 镜像未就绪/待部署」三态，shouldShowStopReason 对齐后端 isStoppedBranch 口径 |
| feat | cds | 新增「等待 CI 镜像」看门狗：waiting 超时（默认 15min，CDS_CI_WAIT_TIMEOUT_MS 可调，多因分支缺 branch-image.yml）自动翻 failed + 写人类可读归因 + server-event + branch.updated 事件，根治无限期 idle 无记录 |
| fix | cds | PR review 修复：已合并页主分支链接优先用 baseRef（实际合并目标）而非 defaultBranch；prClose 策略关闭时合并 PR 也记 merged 墓碑（防 delete 事件误降级为已放弃）；停止面板判定严格对齐后端 isStoppedBranch（不靠孤立 lastStop* 误标停止）；recordRemovedBranch 承袭更丰富 PR 元数据（关 PR→删分支不丢「查看 PR」）；CI 失败 branch.updated 事件带上 ciImageError 实时下发 |
