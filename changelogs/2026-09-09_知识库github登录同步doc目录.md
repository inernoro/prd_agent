| feat | prd-api | 新增共用 GitHub 连接中心 /api/github/*（连接状态 / Device Flow / 仓库 / 分支 / 目录树 / 递归扫 doc 目录），任何登录用户都能连自己的账号 |
| feat | prd-api | 知识库新增批量 GitHub 目录订阅端点，一次勾多个目录开启同步，重复勾选幂等跳过 |
| feat | prd-admin | 知识库新增 GitHub 同步向导：连接 GitHub → 选仓库分支 → 勾目录（所有 doc/docs 递归预勾）→ 开启同步 |
| fix | prd-api | GitHub 目录同步改带用户 token 请求，支持私有仓并把限额从匿名 60/h 提到 5000/h |
| fix | prd-api | GitHub 子条目去重键从 download_url 改为仓库内路径，避免私有仓临时 token 让同一文件每轮被判成新增+删除 |
| docs | doc | 新增 design.knowledge-base.github-sync 设计文档，已知边界记入 debt.knowledge-base K-10 |
