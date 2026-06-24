| feat | cds | 过期分支预览页按合并/放弃分流：合并显示「已合并到主分支」中间页+切主分支预览按钮（沿用动效网格背景），放弃显示「分支已放弃」页+跳 PR；新增分支墓碑（BranchTombstone）持久化 |
| feat | cds | 没走 PR 的直接删分支（git push --delete）也写墓碑（reason=abandoned），过期预览页落到「已放弃」页而非泛化「启动失败」；recordRemovedBranch 加 merged 粘性，避免删分支 delete 事件把已合并墓碑降级 |
