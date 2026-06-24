| feat | cds | 过期分支预览页按合并/放弃分流：合并显示「已合并到主分支」中间页+切主分支预览按钮（沿用动效网格背景），放弃显示「分支已放弃」页+跳 PR；新增分支墓碑（BranchTombstone）持久化 |
| feat | cds | 没走 PR 的直接删分支（git push --delete）也写墓碑（reason=abandoned），过期预览页落到「已放弃」页而非泛化「启动失败」；recordRemovedBranch 加 merged 粘性，避免删分支 delete 事件把已合并墓碑降级 |
| fix | cds | 修复极速版分支卡在「等 CI 镜像」被误标成「容器停止·无记录·时间未知」：分支卡拆出「等待 CI 镜像/CI 镜像未就绪/待部署」三态，shouldShowStopReason 对齐后端 isStoppedBranch 口径 |
| feat | cds | 新增「等待 CI 镜像」看门狗：waiting 超时（默认 15min，CDS_CI_WAIT_TIMEOUT_MS 可调，多因分支缺 branch-image.yml）自动翻 failed + 写人类可读归因 + server-event + branch.updated 事件，根治无限期 idle 无记录 |
| fix | cds | PR review 修复：已合并页主分支链接优先用 baseRef（实际合并目标）而非 defaultBranch；prClose 策略关闭时合并 PR 也记 merged 墓碑（防 delete 事件误降级为已放弃）；停止面板判定严格对齐后端 isStoppedBranch（不靠孤立 lastStop* 误标停止）；recordRemovedBranch 承袭更丰富 PR 元数据（关 PR→删分支不丢「查看 PR」）；CI 失败 branch.updated 事件带上 ciImageError 实时下发 |
| fix | cds | PR review 二轮：delete 策略关闭时也记 abandoned 墓碑（与 prClose 一致，删分支清理不再落泛化「启动失败」）；墓碑增 branchId/aliases 兜底键 + findRemovedBranchByIdentifier，自定义子域别名访问 gone 页也能匹配到合并/放弃页（previewSlug 主键查不到时兜底） |
| fix | cds | PR review 三轮（竞态）：delete 先到清掉 entry 时，closed(merged) 仍基于 head.ref 写 merged 墓碑（merged 粘性升级 delete 写的 abandoned，合并 PR 不再错显已放弃）；CI 完成早到的缓存认领路径 failed 分支也写 ciImageError + 清 ciWaitingSince（脱离 waiting 后看门狗不兜底，看板能实时显示原因） |
| fix | cds | PR review 四轮：CI 等待看门狗超时翻 failed 时清掉 ciWorkflowRunUrl，避免卡片「查看构建」指向与「无匹配构建完成」失败无关的历史 Actions run |
| fix | cds | PR review 五轮：停止但未删除的 PR 分支（仓库保留合并分支）也落合并/放弃页——proxy.routeToBranch 在 stopped 兜底前查墓碑命中则走新增 onBranchGone 回调到 serveBranchGonePage；fail-safe（无墓碑照旧 + 仅拦 HTML 导航 + 置于 auto-wake 副作用前不复活已合并分支） |
| fix | cds | PR review 六/七轮：CI 状态字段清空在 **state** 里写 '' 而非 undefined——/api/branches/stream 的 branch.updated 从 state 重新序列化整个 branch 下发、BranchList 按 data.branch merge，JSON.stringify 丢 undefined 字段导致客户端保留旧值（旧「查看构建」链接/旧错误文案/旧等待时间）。看门狗超时 + CI 缓存认领 + 主 workflow_run + 进 waiting 等所有清空点统一改 ''（ciWorkflowRunUrl/ciImageError/ciWaitingSince/ciWorkflowConclusion） |
