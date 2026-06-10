| fix | prd-api | 更新中心 GitHub 提交总数改为仓库全历史总数（本地 git rev-list --count，浅克隆时用 GitHub API Link header 反推兜底），不再把「最近一周条数」当总数展示 |
| feat | prd-admin | 更新中心 GitHub 提交列表按自然周分组展示（本周/上周语义化标签 + 日期范围），chip 与说明文案区分「仓库总提交」与「近一周条数」 |
| feat | prd-api | 彩蛋：GitHub 提交作者名与系统用户名自动匹配（忽略大小写、去数字与分隔符、容忍姓名前后颠倒），命中时返回系统用户显示名 |
| feat | prd-admin | GitHub 提交行命中系统用户时展示绿色「已匹配系统用户」徽章 |
