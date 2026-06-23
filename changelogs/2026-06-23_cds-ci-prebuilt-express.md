| feat | cds | 新增「极速版（CI 预构建）」部署模式：push 后不在 CDS 本机编译，改由 GitHub Actions 把 commit 编译成 ghcr 镜像，CDS 监听 workflow_run 后按 SHA docker pull + run，省服务器算力 |
| feat | ci | 新增 .github/workflows/branch-image.yml：每分支 push 把 prd-api / prd-admin 编译成 ghcr 镜像（sha-<SHA> + branch-<slug> tag） |
| feat | cds | DeployModeOverride 扩展 prebuilt / containerPort；dockerImage 支持部署期模板变量 ${CDS_COMMIT_SHA} / ${CDS_BRANCH_SLUG}（resolveImageTemplate） |
| feat | cds | webhook 新增 workflow_run 事件处理：CI 成功→拉取部署、失败→标记可切回源码编译；push 在极速版分支置「等待 CI 镜像」而非立即编译 |
| feat | cds | 分支卡新增 CI 状态徽章（等待 CI 镜像 / CI 构建失败 + 切回源码编译 + 查看构建链接）；部署模式标签细化「极速版」 |
| feat | cds | cds-compose.yml 给 api / admin 增加 express 模式（极速版，prebuilt + 8080 端口） |
| docs | cds | spec.cds-compose-contract 补 x-cds-deploy-modes 子键表（含 prebuilt/containerPort/模板）；新增 debt.cds-ci-prebuilt 台账 |
| feat | cds | 极速版分支卡用独立 Zap（闪电）图标 + 青色徽章「极速版」,从「发布版」里区分出「拉 CI 镜像 vs 源码编译」（lucide SVG,非 emoji,遵 §0） |
| feat | cds | 项目设置新增「强制所有分支对齐」：一键把项目默认运行模式写入全部已有分支配置（POST /api/projects/:id/align-deploy-modes，复用 applyDefaultDeployModesToBranch；只写配置不批量重部署,各分支下次部署生效,避免压垮宿主） |
| fix | cds | PR review 修复（Bugbot/Codex）：align-deploy-modes 补 assertProjectAccess 防越权；push「等待 CI」判定不再用项目默认（与 deploy 一致,避免无 override 旧分支误等 CI 后跑源码）；workflow_run 匹配带 head_branch + 允许 failed re-run 成功恢复；deploy 兜底从 worktree HEAD 推导 commit SHA（避免极速版镜像 tag 变 sha-空）；极速版配置未生效显示「极速版·待生效」；CI 等待/失败徽章仅在仍是极速版时显示 |
| fix | cds | PR review 修复（Bugbot）：commit SHA 推导上提到集群分发决策之前，集群/远端部署经 proxyDeployToExecutor 前先 stamp githubCommitSha，避免远端 payload 极速版 dockerImage 仍是 sha-空 tag 导致 docker pull 失败；本地路径不再重复推导 |
