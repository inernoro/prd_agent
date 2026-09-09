| feat | prd-api | 新增共用 GitHub 连接中心 /api/github/*（连接状态 / Device Flow / 仓库 / 分支 / 目录树 / 递归扫 doc 目录），任何登录用户都能连自己的账号 |
| feat | prd-api | 知识库新增批量 GitHub 目录订阅端点，一次勾多个目录开启同步，重复勾选幂等跳过 |
| feat | prd-admin | 知识库新增 GitHub 同步向导：连接 GitHub → 选仓库分支 → 勾目录（所有 doc/docs 递归预勾）→ 开启同步 |
| fix | prd-api | GitHub 目录同步改带用户 token 请求，支持私有仓并把限额从匿名 60/h 提到 5000/h |
| fix | prd-api | GitHub 子条目去重键从 download_url 改为仓库内路径，避免私有仓临时 token 让同一文件每轮被判成新增+删除 |
| docs | doc | 新增 design.knowledge-base.github-sync 设计文档，已知边界记入 debt.knowledge-base K-10 |
| polish | prd-admin | GitHub 同步向导的目录树默认折叠，只展开通往已勾选目录的链路，几百个目录不再一次摊平 |
| fix | prd-api | 仓库目录扫描上限 600 提到 1500，本仓库 666 个候选目录不再一进来就是截断态 |
| fix | prd-api | GitHub 目录同步的子文件不再被当普通 URL 订阅单独重拉，私有仓不会每天刷出一批假的同步失败 |
