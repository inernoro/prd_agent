| feat | cds | 新增「极速版（CI 预构建）」部署模式：push 后不在 CDS 本机编译，改由 GitHub Actions 把 commit 编译成 ghcr 镜像，CDS 监听 workflow_run 后按 SHA docker pull + run，省服务器算力 |
| feat | ci | 新增 .github/workflows/branch-image.yml：每分支 push 把 prd-api / prd-admin 编译成 ghcr 镜像（sha-<SHA> + branch-<slug> tag） |
| feat | cds | DeployModeOverride 扩展 prebuilt / containerPort；dockerImage 支持部署期模板变量 ${CDS_COMMIT_SHA} / ${CDS_BRANCH_SLUG}（resolveImageTemplate） |
| feat | cds | webhook 新增 workflow_run 事件处理：CI 成功→拉取部署、失败→标记可切回源码编译；push 在极速版分支置「等待 CI 镜像」而非立即编译 |
| feat | cds | 分支卡新增 CI 状态徽章（等待 CI 镜像 / CI 构建失败 + 切回源码编译 + 查看构建链接）；部署模式标签细化「极速版」 |
| feat | cds | cds-compose.yml 给 api / admin 增加 express 模式（极速版，prebuilt + 8080 端口） |
| docs | cds | spec.cds.compose-contract 补 x-cds-deploy-modes 子键表（含 prebuilt/containerPort/模板）；新增 debt.cds.ci-prebuilt 台账 |
| feat | cds | 极速版分支卡用独立 Zap（闪电）图标 + 青色徽章「极速版」,从「发布版」里区分出「拉 CI 镜像 vs 源码编译」（lucide SVG,非 emoji,遵 §0） |
| feat | cds | 项目设置新增「强制所有分支对齐」：一键把项目默认运行模式写入全部已有分支配置（POST /api/projects/:id/align-deploy-modes，复用 applyDefaultDeployModesToBranch；只写配置不批量重部署,各分支下次部署生效,避免压垮宿主） |
| fix | cds | PR review 修复（Bugbot/Codex）：align-deploy-modes 补 assertProjectAccess 防越权；push「等待 CI」判定不再用项目默认（与 deploy 一致,避免无 override 旧分支误等 CI 后跑源码）；workflow_run 匹配带 head_branch + 允许 failed re-run 成功恢复；deploy 兜底从 worktree HEAD 推导 commit SHA（避免极速版镜像 tag 变 sha-空）；极速版配置未生效显示「极速版·待生效」；CI 等待/失败徽章仅在仍是极速版时显示 |
| fix | cds | PR review 修复（Bugbot）：commit SHA 推导上提到集群分发决策之前，集群/远端部署经 proxyDeployToExecutor 前先 stamp githubCommitSha，避免远端 payload 极速版 dockerImage 仍是 sha-空 tag 导致 docker pull 失败；本地路径不再重复推导 |
| fix | cds | PR review 修复（Bugbot/Codex P2）：早到的 workflow_run.completed 不再丢弃——按 repo+sha 进程内缓存(1h/200 上限,一次性消费),push 把分支置 express-waiting 时先认领缓存命中即直接 ready+deploy / failed,另加 githubCommitSha 兜底匹配,根治「push 延迟导致极速版分支卡死 waiting」 |
| fix | cds | PR review 修复（Bugbot）：docs-only push 命中等待中的极速版分支时同步推进 ciTargetSha,避免新 commit 的 CI run 因 ciTargetSha 滞留旧 SHA 永不匹配 |
| fix | cds | PR review 修复（Bugbot）：webhook self-test/dry-run 在极速版分支返回 ci-image-waiting（无 deployRequest），与真实路径一致,不再误报会部署 |
| fix | cds | PR review 修复（Codex P2）：static→express 配置变更标记为「待生效」——配置预构建但实际容器是别的 release 模式时也判 pendingPublish,卡片不再亮虚假「极速版」绿徽章 |
| fix | cds | PR review 修复（Codex P2）：项目设置「强制所有分支对齐」在默认模式有未保存改动时禁用并提示先保存,避免按旧默认覆盖全部分支而 toast 误导 |
| fix | cds | PR review 修复（Bugbot/Codex P2）：早到 CI 结果缓存键加 head_branch,同一 commit 的两分支各跑各的 workflow_run 不再互相覆盖/吞噬;认领时也按分支匹配,避免 A 分支用 B 分支的成功结果误标 ready |
| fix | cds | PR review 修复（Codex P2）：docs-only push 推进 ciTargetSha 后同样认领早到的 CI 缓存(提取 claimCachedCiRunForExpress 复用),命中直接 ready+deploy/failed,不再因绕过认领而卡 waiting |
| fix | cds | PR review 修复（Codex P2）：极速版 docker pull 前 fail-fast 校验镜像 tag 已解析,未解析(含 ${ / 空 :sha-)直接报可操作错误而非语义不清的拉取失败 |
| fix | cds | PR review 修复（Bugbot）：check_run 重跑在极速版 waiting/failed 分支不再绕过 CI 闸门直接部署预构建镜像(镜像可能未 push),仅 ciImageStatus=ready 才放行;非极速版行为不变 |
| fix | cds | PR review 修复（Bugbot）：align-deploy-modes 写 override 时若分支模式真的变了,清掉旧 ciImageStatus/ciTargetSha/ciWorkflowConclusion/ciWorkflowRunUrl,避免卡片显示与新模式不符的「等待 CI / CI 失败」陈旧徽章;模式未变不动(不打断 in-flight 等待) |
| fix | cds | PR review 修复（Bugbot）：check_run 重跑放行极速版部署须同时满足 ciImageStatus=ready 且 ciTargetSha===head_sha,避免「A 已 ready」误部署 commit B 的预构建镜像 |
| fix | cds | PR review 修复（Bugbot）：新 push 重置 express 分支为 waiting 时一并清掉旧 ciWorkflowRunUrl,避免「等待 CI 镜像」卡片的「查看构建」指向旧的失败/无关 Actions run |
| fix | cds | PR review 修复（Bugbot）：workflow_run 标记 ready/failed 时同步 ciTargetSha=head_sha,避免 fallback(按 githubCommitSha)匹配后 ciTargetSha 滞留旧值,导致 check_run 闸门(ready && ciTargetSha===head_sha)永久卡住 |
| fix | cds | PR review 修复（Bugbot）：deploy 路由补极速版 CI 闸门——极速版分支 ciImageStatus=waiting/failed 时手动/内部重部署返回 409 ci_image_not_ready(给可操作提示 + ?ignoreCiGate=1 逃生口),避免 docker pull 不存在的镜像留下噪音错误;非极速版/ready/CI 驱动部署不受影响 |
| fix | cds | PR review 修复（Codex P2）：移除 workflow_run 的 githubCommitSha 兜底匹配,只按 ciTargetSha(显式等待标记)匹配,避免 docs-only push 刷新 githubCommitSha 后其 CI 完成被误部署(docs-only 已显式跳过);早到竞态仍由结果缓存兜底 |
| fix | cds | PR review 修复（Codex P2）：本地 deploy 在 worktree pull 后用真实 HEAD 刷新 githubCommitSha,避免远端已前进时极速版镜像 tag 仍渲染 pull 前旧 SHA 导致跑旧镜像/拉错 tag;主 deploy 与单服务 deploy 两路径均覆盖 |
| fix | cds | PR review 修复（Bugbot/Codex P2）：极速版部署严格锁定 CI 就绪 SHA——deploy 闸门改为「仅 ciImageStatus=ready 且 ciTargetSha===目标 SHA」放行(undefined/align 清空/ready-但-SHA-不符 一律 409);pull 后刷新 githubCommitSha 仅限非极速版,极速版镜像永远锁在 CI 就绪的 ciTargetSha,不跟随 pull 后新 HEAD |
| fix | cds | PR review 修复（Codex P2）：分支卡 CI 徽章改用 deployRuntime?.prebuilt!==false 判定,使 SSE 新建(无 deployRuntime 的原始 BranchEntry)的极速版分支在全量刷新前也显示「等待 CI/构建失败」反馈;明确非极速版(prebuilt=false)仍隐藏 |
| feat | ci | branch-image.yml 改为 path-filter 按组件构建(dorny/paths-filter):只改 prd-api/ 只构建 api、只改 prd-admin/ 只构建 admin、仅 cds/docs 两者都不构建,不再每次重复构建两镜像 |
| feat | cds | 极速版「逐组件回退主分支」(用户决策):DeployModeOverride 新增 fallbackImage;runService 按「本 commit 镜像 → 固定主分支镜像(:branch-main)」优先级 docker pull,任一拉到即用,两者都拉不到才报错——解决 CI 按需构建后某 commit 缺某组件镜像(三场景:只一个构建/都没构建/仅 cds 改动)导致预览起不来 |
| fix | cds | 极速版部署移除手动/单服务硬闸门(改为上面的逐组件回退):deploy 路由不再返回 409 ci_image_not_ready;镜像可用性下沉到 runService 逐组件回退处理,never 硬失败 |
| fix | cds | workflow_run 匹配补「当前仍是极速版」校验(branchUsesPrebuiltMode),分支切回 dev/static 后旧 CI 完成事件不再被认领自动重部署一个已退出极速版的分支 |
| docs | cds | debt.cds.ci-prebuilt 状态枚举改「进行中」(合规 rule.doc.naming);#3「每次构建两镜像」标记已偿还(改 path-filter + 回退) |
| fix | cds | PR review 修复（Bugbot High）：极速版镜像 tag 的 ${CDS_COMMIT_SHA} 优先解析为 ciTargetSha(CI 真正构建镜像的 commit)而非 githubCommitSha——后者会被 docs-only push / 被拦的 check_run 重跑悄悄推进却不产新镜像,用它渲染会拉错 SHA 镜像或静默回退 branch-main,使预览与就绪 CI 产物不一致;ciTargetSha 未设时退回 githubCommitSha |
| fix | cds | PR review 修复（Bugbot）：path-filter 下 docs-only push 不再推进 ciTargetSha / 认领缓存——docs commit 不产镜像,推进会把正在构建的代码 commit 顶成孤儿(永不部署)或让分支显示「CI ready」却指向无镜像 SHA;改为只刷新展示用 githubCommitSha,CI 状态保持等待正在构建的代码 commit |
| fix | cds | PR review 修复（Codex P1）：极速版回退改为**有序回退链**(fallbackImage 支持 string[])——本 commit 无该组件镜像时先退到本分支该组件最近一次构建(:branch-<slug>),再退到固定主分支(:branch-main)。修复「A 改 api、B 只改 admin」部署 B 时 api 直接回退 main、丢掉本分支 A 的 api 改动(混入 main 代码);admin 对称。runService 按链逐个 docker pull,第一个拉到即用 |
| fix | cds | PR review 修复（Codex P2）：slugifyBranchForImage 对齐 docker/metadata-action 的 tag 规则——保留大小写、保留 _ 和 .,只把非法字符序列转 -,使 branch-${CDS_BRANCH_SLUG} 回退能命中 CI 实际推送的 tag(此前小写+改写 _/. 会让 Codex/fix、release/v1.2 等分支回退落空到 main、丢本分支改动) |
| docs | cds | guide.cds.github-webhook-events 补充:极速版(CI 预构建)项目必须额外订阅 workflow_run 事件(需 Actions:Read-only 权限),否则极速版分支永久卡「等待 CI 镜像」;workflow_run 从噪声过滤表移到必订表 |
