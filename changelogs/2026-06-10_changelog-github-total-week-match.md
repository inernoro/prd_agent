| fix | prd-api | 更新中心 GitHub 提交总数改为仓库全历史总数（本地 git rev-list --count，浅克隆时用 GitHub API Link header 反推兜底），不再把「最近一周条数」当总数展示 |
| feat | prd-admin | 更新中心 GitHub 提交列表按自然周分组展示（本周/上周语义化标签 + 日期范围），chip 与说明文案区分「仓库总提交」与「近一周条数」 |
| feat | prd-api | 彩蛋：GitHub 提交作者名与系统用户名自动匹配（忽略大小写、去数字与分隔符、容忍姓名前后颠倒），命中时返回系统用户显示名 |
| feat | prd-admin | GitHub 提交行作者展示合并为单 chip：命中系统用户时直接显示系统名（GitHub 原名进 tooltip），不再单列两个名字 |
| feat | prd-api | 识别 commit message 的 Co-authored-by 联合作者（本地 git trailers + GitHub API 双路径），每位联合作者同样做系统用户匹配 |
| feat | prd-api | 用户名匹配支持剥离团队通用组织后缀（如 yurenping-miduo 匹配 yurenping） |
| feat | prd-admin | 更新中心面板动态化：统计数字滚动、新提交到达扫光、同步状态呼吸点、AI 总结按钮流光 |
| feat | prd-admin | 筛选标签 Telegram 式热度角标：常驻类型彩色 + 右上角近 30 天条目数徽章，最热标签火焰角标 + 流光描边 + 呼吸光晕，点击迸发同色粒子 |
| polish | prd-admin | 热度视觉收敛：火焰并入最热标签徽章（修复与相邻角标遮挡）、去掉 chip 整体呼吸/流光只保留火花跳动、口径提示「近 30 天热度」弱化挪至筛选行尾 |
