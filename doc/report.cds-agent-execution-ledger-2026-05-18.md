# CDS Agent 执行过程账本

> 日期：2026-05-18
> 范围：`codex/cds-agent-workbench-ui` 分支、远程 `prd-agent` preview、CDS Agent runtime pool 恢复
> 用途：回答“问题是什么、怎么处理、花了多久、下次怎么少花时间”。

## 当前结论

这份账本补的是此前缺失的执行过程视角。已有 `doc/status.cds-agent-current-progress.md` 记录当前状态和证据目录，但它偏结果；本文件专门记录过程问题、处理动作、耗时和优化。

截至 2026-05-18 22:08 Asia/Shanghai：

- 已解决：`prd-agent` branch-local `claude-agent-sdk-runtime-v2-prd-agent` 污染。
- 已解决：执行面板能展示 destructive cleanup 和 remote host/shared runtime recovery 的结构化 manifest。
- 已解决：发布验证能证明远程 bundle 支持 `applyManifest/preconditions` 渲染。
- 已解决：生命周期视图能直接回答“目标到哪一步、离完成多远、下一步 ETA”。
- 已解决：sidecar image 本地构建上下文已纳入预检，不再靠人工猜 Dockerfile 是否可用。
- 已解决：sidecar image build smoke 已通过，本地候选镜像可构建；Docker daemon/Colima 问题已从 R0 远程问题中剥离。
- 已解决：sidecar image registry 发布阶段已纳入 dry-run/显式 push 门禁。
- 已解决：remote host `docker pull` 已纳入独立 dry-run/显式 SSH 验证门禁。
- 已解决：当前进度面板的 `Exact Next Step` 已改成按 gate 顺序动态输出。
- 已解决：registry candidate tag 可由 git remote/commit 自动推导；进度面板下一步不再要求手填占位符。
- 已解决：候选 GHCR tag 已在本地 Docker 中创建；仍未 push。
- 已解决：GHCR 发布增加手动 GitHub Actions 入口，不再只能由本机 Codex push。
- 已解决：GHCR 手动发布入口有只读 handoff；当明确选择 fallback 路径时可用，但默认产品下一步已纠正为 CDS-managed runtime 事实源。
- 已解决：sidecar image 发布后到 remote host SSH pull 前增加只读 registry manifest 验证门，减少远程排障面。
- 已解决：R0 readiness 与 operator handoff 已消费 registry manifest / remote pull 报告，能显示它们是否匹配当前 `CDS_AGENT_SIDECAR_IMAGE`。
- 已解决：R0 operator handoff 优先显示当前 HEAD 对应 GHCR image，旧 publish report candidate 不再覆盖当前发布目标。
- 已解决：新增一键只读 R0 状态刷新入口，统一刷新 handoff/workflow/readiness/operator/lifecycle/progress，减少旧 `/tmp` 证据干扰。
- 已解决：新增 GitHub Actions workflow 状态检查脚本，默认 dry-run；显式开启后把 workflow 404/API 失败写入结构化报告。
- 已确认：workflow 文件已存在于 `codex/cds-agent-workbench-ui`，但 GitHub Actions workflow API 仍不可 dispatch/list，状态为 `workflow_file_on_branch_not_indexed`。
- 已校准：GHCR 降级为候选 fallback；R0 产品主线是 CDS-managed runtime/container/sandbox，不是 remote host/image 输入。
- 已校准：`doc/status.cds-agent-current-progress.md` 第一屏现在直接回答预计结束时间、总步骤、当前位置、需要用户协助项和关键文档。
- 已校准：进度面板 `Exact Next Step` 在缺 legacy host/image 证据时不再要求补 env，而是先执行有限架构纠偏计划。
- 已校准：R0 status refresh 的 `Next Command` 与进度面板同口径，不再把 GHCR publish 伪装成唯一下一步。
- 已补齐：新增本地 progress consistency check，防止 refresh、progress board、主文档再次出现不同步的下一步。
- 已补齐：goal audit 现在把 progress consistency 作为 D1 guardrail；同时 N6 沙箱内失败不会覆盖 canonical N6 pass summary。
- 已纠偏：用户确认最终目标不是 `MAP -> CDS -> external agent host`，而是 `MAP -> CDS -> CDS-managed Claude SDK runtime/container/sandbox`。
- 已纠偏：`CDS_REMOTE_HOST_*`、SSH 私钥、sidecar image、env 只能作为 operator/debug fallback，不能作为普通用户主路径，也不能写成当前产品下一步。
- 已启动：新增有限纠偏计划 `doc/plan.cds-agent-runtime-correction-limited.md`，本轮只校准文档入口和本地事实源，不实现 runtime。
- 已设计：新增 R0 fact source 设计 `doc/design.cds-agent-managed-runtime-fact-source.md`，把 R0 blocker 改成 CDS-managed runtime/project/profile/container/session，而不是 remote host/image/env。
- 已校准：runtime-status execution panel 的 R0.2/R0.3、NextCommand、runbook 和 task board 已指向 CDS-managed runtime fact source；remote host/image 只作为 operator fallback debug。
- 已修复：CDS `/agent-sessions` 非 fake runtime message 不再返回“delegated to MAP sidecar bridge”；runtime 缺失时由 CDS 返回 `cds_managed_runtime_unavailable`，避免再次把执行归属推回 MAP。
- 已推进：CDS-managed official SDK runtime transport 已有最小闭环；CDS 可从 shared-service branch service 发现 `claude-agent-sdk` runtime，并投递 `/v1/agent/run` 后写回 `runtime_init/text_delta/done`。
- 未解决：MAP adapter session transport + managed-runtime smoke 仍需补齐；当前目标保持 `not_complete`。

## 执行时间线

| 时间 | 问题 | 处理 | 证据 | 耗时 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 17:19 | 用户截图显示 `claude-agent-sdk-runtime-v2` 仍出现在 MAP 分支服务 | 只读查询 `branch list` 和 `project list`，确认是远程 CDS 存量 state，不是本地 compose 回退 | `/tmp/cds-agent-branch-list-latest.json`、`/tmp/cds-agent-project-list-latest.json` | 约 2s | 确认 4 个分支污染，`prd-agent.appServices` 包含 sidecar |
| 17:22 | 远程 BuildProfile/service residual 仍污染业务分支 | 经用户精确批准后运行 branch isolation evidence wrapper | `/tmp/cds-agent-branch-isolation-repair-apply-current/summary.json` | 40s | `beforeContaminatedBranchCount=4`、`afterContaminatedBranchCount=0` |
| 17:23 | 需要确认是否只是 wrapper 误判 | 直接查远程 branch list 和 project list | `/tmp/cds-agent-branch-list-after-delete.json`、`/tmp/cds-agent-project-list-after-delete.json` | 约 2s | 污染列表 `[]`，`prd-agent.appServices=api,admin` |
| 17:23 | 清理后 R0 是否恢复不清楚 | 运行 runtime pool evidence | `/tmp/cds-agent-runtime-pool-evidence-after-branch-clean/summary.json` | 11s | branch isolation clean；剩余 `REMOTE_HOST_AVAILABLE`、`SHARED_POOL_RUNNING` |
| 17:24 | 报告/进度仍写旧 contaminated 状态 | 更新状态面板和事故报告 | `doc/status.cds-agent-current-progress.md`、`doc/report.cds-agent-runtime-pool-contamination-2026-05-18.md` | 本地编辑 | 文档与远程证据对齐 |
| 17:25 | 页面执行面板只结构化 branch 删除，没有结构化 remote host 恢复 | 给 `remote-host-prepare` 增加后端 `applyManifest` | `InfraAgentSessionsControllerTests` | 后端测试 18/18，约数秒 | 页面可展示 remote host create / deploy sidecar 所需条件 |
| 17:31 | 远程是否发布了 manifest UI 不清楚 | 运行发布验证脚本 | `/tmp/cds-agent-runbook-published/summary.json` | 首轮约 35s | 发现脚本错误地要求后端常量出现在前端 bundle |
| 17:35 | 发布验证脚本误报 | 改为验证前端 bundle 的 `applyManifest/preconditions` 渲染能力，后端常量由控制器测试覆盖 | `/tmp/cds-agent-runbook-published/summary.json` | 约 35s | 发布验证通过，命中 `assets/index-D_MWXu97-local.js` |
| 17:38 | remote host dry-run 只列创建 host 缺参，没有列 deploy sidecar 缺参 | 给 `prepare-cds-agent-remote-host-pool.sh` 增加 `recoveryManifest.phases[]` | `/tmp/cds-agent-remote-host-pool-manifest-current/summary.json` | 14s | 机器可读列出 `remote_host_create` 和 `shared_runtime_deploy` 两阶段缺参 |
| 17:43 | 进度面板可读性不足，且远程构建状态需要复核 | 将 status 改成看板式第一屏，并刷新 CDS branch status 与 R0 evidence | `/tmp/cds-branch-status-latest-progress.json`、`/tmp/cds-agent-runtime-pool-evidence-latest/summary.json` | 约 13s | 远程拾取 `ffef7117`，服务仍只有 api/admin；R0 仍只缺 remote host/shared runtime |
| 17:46 | 用户反馈没有计划，文档仍可能让人误以为目标漂移 | 扫描 docs/audit，修正旧 `contaminated:4` 口径和“先清理 residual”的过期下一步 | quickstart、runbook、migration plan、adapter design、root-cause report、goal audit | 约 4m | 统一为 `BRANCH_LOCAL_SIDECAR_CLEAN=pass`，下一步只剩 remote host/shared runtime |
| 17:50 | 目标审计在无显式 live 输入时仍被环境变量带去查 `https://miduo.org`，并把旧 one-cycle R1 当当前 blocker | 改为 `CDS_AGENT_GOAL_AUDIT_LIVE=1` 才查远程；未观测 R0 时禁止把旧 R1 当当前结论 | `/tmp/cds-agent-goal-audit-fast.json` | 约 11s 快速审计 | 当前 blocker 回到 `R0 evidence not observed`，不会误导去修 R1 |
| 17:56 | N6 在目标审计中超时，需区分测试失败还是沙箱问题 | 先在沙箱内复现 `Permission denied`，再用已批准的 `dotnet test` 沙箱外跑 no-build 测试 | dotnet test 输出 | 64ms 测试执行；审计超时 62s | 27/27 pass；目标审计的 N6 是 infra/sandbox failure，不是业务回归 |
| 17:56 | 无 live 时只显示 R0 unknown 仍不够好，因为已有 `/tmp` R0 evidence 可用 | 让 goal audit 支持 `CDS_AGENT_GOAL_RUNTIME_POOL_SUMMARY`，直接消费 `/tmp/cds-agent-runtime-pool-evidence-latest/summary.json` | `/tmp/cds-agent-goal-audit-summary-fast.json` | 11s | `runtimePoolRecovery.source=summary`，当前 blocker 精确为 remote host/shared runtime |
| 18:00 | goal audit 已识别 R0 blocker，但 `executionPanel.status` 仍继承旧 one-cycle 的 `blocked_r1`，`nextCyclePlan` 仍指向 profile closure | R0 blocker 存在时覆盖 `cycle_status=blocked_r0`，并生成 `r0-runtime-pool-recovery` 计划 | `/tmp/cds-agent-goal-audit-summary-fast.json` | 11s | `status=blocked_r0`，plan items=`R0.2/R0.3/R0V` |
| 18:06 | remote host prepare 总是要求创建 host 参数，即使 CDS 已有 enabled host；这会阻塞“复用已有 host 部署 shared runtime”的路径 | 支持 `CDS_REMOTE_HOST_ID` 或第一个 enabled host 作为 target；已有 host 时不再要求 SSH 创建参数 | `/tmp/cds-agent-remote-host-existing-report.json`、`/tmp/cds-agent-remote-host-existing-deploy-missing-image-report.json` | <1s fixture | 复用 host 路径 `missingConfig=[]`；部署路径只缺 `CDS_AGENT_SIDECAR_IMAGE` |
| 18:08 | 沙箱内只读 live dry-run DNS 失败时，wrapper 把 `evidence-unavailable` 误判成 `blocked-branch-isolation` | 沙箱外重跑只读 dry-run确认真实远程状态；同时修 wrapper verdict 优先区分证据不可用 | `/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json`、`/tmp/cds-agent-remote-host-pool-current-readonly-unavailable-fixed/summary.json` | 18s live；<1s fixture | 远程真实缺 enabled host；网络/鉴权失败现在输出 `evidence-unavailable` |
| 18:10 | apply 前仍可能到远程才发现 SSH host、port、key、image 参数格式不合法 | prepare dry-run 增加 `invalidConfig/preflightReady`，并让 wrapper 顶层支持 `dry-run-invalid-config` | `/tmp/cds-agent-remote-host-invalid-report.json` | <1s fixture | host URL、非数字 SSH port、非私钥内容会在本地 dry-run 阶段拦截 |
| 18:18 | 脚本已有 `preflightReady/invalidConfig`，但页面 execution panel 仍只展示老的 required env 和 preconditions | 后端 `ApplyManifest` 增加 `localPreflightCommand/reportFields/optionalEnv`，前端展示 preflight 命令和报告字段 | `InfraAgentSessionsControllerTests`、`pnpm --prefix prd-admin tsc` | dotnet 有效测试约 8s；tsc 通过 | 页面能指向 `prepare.preflightReady/invalidConfig`，不再只让人猜环境变量 |
| 18:20 | 参数给齐后仍需要从长文档拼 apply/deploy/post-check 命令，容易泄露私钥或漏 flag | 新增安全 handoff 脚本，从 summary 生成占位符命令；支持 wrapper summary 和 prepare report | `/tmp/cds-agent-remote-host-handoff.md`、`/tmp/cds-agent-remote-host-existing-handoff.md`、`/tmp/cds-agent-remote-host-invalid-handoff.md` | <1s | 输出不含私钥；existing host 路径使用 `CDS_REMOTE_HOST_ID`；invalid 路径只列错误 |
| 19:00 | `CDS_AGENT_SIDECAR_IMAGE` 容易被误解为“仓库有 Dockerfile 就能部署”，但 CDS remote deployer 实际只 `docker pull` | R0 readiness、lifecycle overview、operator handoff 增加 image readiness；明确候选 build/push 命令不等于远程可拉取 | `/tmp/cds-agent-r0-apply-readiness-current.json`、`/tmp/cds-agent-r0-operator-handoff-current.md`、`scripts/print-cds-agent-lifecycle-overview.sh` | <1s | R0 阻塞被拆成 remote host SSH 参数 + pullable sidecar image，不再混成一个黑盒 |
| 19:08 | 只知道“缺 image”还不够，下一次远程部署前还需要知道本地 sidecar build context 是否健康 | 新增 `scripts/preflight-cds-agent-sidecar-image.sh`，并接入 R0 readiness、progress board、lifecycle、handoff | `/tmp/cds-agent-sidecar-image-preflight-current.json`、`/tmp/cds-agent-r0-apply-readiness-current.json` | <1s | `buildContext=pass`、`image=missing`；远程写动作前少一个不确定项 |
| 19:15 | Colima 显示 running，但 Docker CLI 无法连接 daemon；本地 image 构建证据缺失 | 新增 `scripts/smoke-cds-agent-sidecar-image-build.sh`，将 Docker/build 结果写入 JSON，并接入 progress/lifecycle/handoff | `/tmp/cds-agent-sidecar-image-build-current.json` | <1s 当前失败 | 当前 `status=docker_unavailable`；不会误触发 push/deploy |
| 19:26 | Colima LaunchAgent 与 Lima VM 状态不一致，`colima status` 误报 running，实际 Lima instance broken | 卸载 stale LaunchAgent，`LIMA_HOME=/Users/inernoro/.colima/_lima limactl stop -f colima` 清理 broken pid/socket，再 `colima start`；拉取 `python:3.12-slim` 后复跑 build smoke | `/tmp/cds-agent-sidecar-image-build-current.json` | 约 2m，build 约 65s | `status=build_pass`；本地候选镜像 `prd-agent/claude-sidecar:latest` 可构建 |
| 19:30 | 本地 build pass 后仍缺 registry tag/push/pullability 证据 | 新增 `scripts/publish-cds-agent-sidecar-image.sh`，默认 dry-run；只有 `CDS_AGENT_SIDECAR_IMAGE_PUSH=1` 才 push | `/tmp/cds-agent-sidecar-image-publish-current.json`、`/tmp/cds-agent-sidecar-image-publish-dryrun-ghcr.json` | <1s dry-run | 当前默认 `missing_target_image`；示例 ghcr tag dry-run 为 `push_ready`，未 push |
| 19:36 | 即使 image 已 push，也还需要证明目标 remote host 能 `docker pull` | 新增 `scripts/verify-cds-agent-remote-sidecar-pull.sh`，默认 dry-run；只有 `CDS_AGENT_REMOTE_PULL_VERIFY=1` 才 SSH 执行 `docker pull` | `/tmp/cds-agent-remote-sidecar-pull-current.json`、`/tmp/cds-agent-remote-pull-dryrun-ready.json` | <1s dry-run | 当前默认 `missing_config`；示例参数 dry-run 为 `dry_run_ready`，未 SSH、未 deploy |
| 19:39 | 进度面板虽然显示多个 gate，但 `Exact Next Step` 固定指向 remote-host handoff，容易跳过 registry/pull 门禁 | `scripts/print-cds-agent-current-progress.sh` 改为按 gate 顺序选择下一步：context -> local build -> registry publish -> remote pull -> remote host apply/deploy | terminal output | <1s | 当前下一步明确是提供 registry-qualified `CDS_AGENT_SIDECAR_IMAGE` 并跑 publish dry-run |
| 19:46 | 下一步命令仍有 `<registry>` 占位符，且首次用 unquoted heredoc 拼动态 Markdown 时触发了 shell command substitution 风险 | `publish-cds-agent-sidecar-image.sh` 从 git remote/commit 推导 candidate tag；progress board 改用 `printf` 生成动态命令，保持只读 | `/tmp/cds-agent-sidecar-image-publish-current.json`、progress board output | <1s | candidate=`ghcr.io/inernoro/prd-agent/claude-sidecar:12a488c3f4fa`；面板生成不执行 publish |
| 19:52 | GHCR push 需要明确批准，但本地 tag 还可以安全推进 | 执行 `CDS_AGENT_SIDECAR_IMAGE=ghcr.io/inernoro/prd-agent/claude-sidecar:0f14b13f0c84 CDS_AGENT_SIDECAR_IMAGE_TAG=1 scripts/publish-cds-agent-sidecar-image.sh` | `/tmp/cds-agent-sidecar-image-publish-current.json`、`docker image inspect` | <1s | `tagPassed=true`、`pushAttempted=false`；本地 tag 和 source image 指向同一 image id |
| 19:54 | 外部 registry push 被安全策略拦截，仍需要一个可审计的发布路径 | 新增 `.github/workflows/cds-sidecar-image.yml`，仅 `workflow_dispatch` 手动发布 GHCR image | workflow file | local edit | GitHub UI 手动触发后输出 `CDS_AGENT_SIDECAR_IMAGE` 和 digest |
| 19:58 | workflow 存在但执行入口仍分散，进度面板默认仍容易让人走本机 push | 新增 `scripts/print-cds-agent-sidecar-publish-handoff.sh`，并让进度面板默认指向它 | `/tmp/cds-agent-sidecar-publish-handoff-current.md` | <1s | Handoff 输出 Actions URL、image tag、CLI 等价命令、本机 push 替代命令 |
| 20:00 | handoff 同时展示 workflow tag 和旧 local candidate，容易让人以为有两个目标 image | local push alternative 改为先按当前 commit tag retag，再 push；旧 candidate 只作为 previousLocalCandidate | handoff script diff | <1s | 发布目标统一到当前 commit tag |
| 20:03 | image 发布成功与 remote host pull 失败之间缺少中间诊断，容易把 registry 不可见误判成 host/SSH 问题 | 新增 `scripts/verify-cds-agent-sidecar-registry-image.sh`，默认 dry-run，显式开启后只读查询 GHCR manifest | `/tmp/cds-agent-sidecar-registry-image-current.json` | <1s dry-run | 新增 `SIDECAR_REGISTRY_MANIFEST` gate；handoff 输出发布后验证命令 |
| 20:10 | readiness 仍只看 image 是否提供，不看 registry manifest / remote pull 是否属于当前 image | `preflight-cds-agent-r0-apply-readiness.sh` 和 R0 handoff 增加 registryManifest/remotePull 匹配状态 | `/tmp/cds-agent-r0-apply-readiness-current.json`、`/tmp/cds-agent-r0-operator-handoff-current.md` | <1s | 发布后刷新一个 readiness 即可看到 image -> manifest -> remote pull 链路 |
| 20:11 | operator handoff 仍可能显示旧 publish report candidate，和当前 commit 的 workflow image 不一致 | handoff 从 git remote + HEAD 推导 `currentSidecarImage`，并优先作为 `imagePublishCandidate` | `/tmp/cds-agent-r0-operator-handoff-current.md` | <1s | 当前候选统一为 `ghcr.io/inernoro/prd-agent/claude-sidecar:e25e3f64a433` |
| 20:14 | 每次提交后需要分别运行多个脚本刷新 `/tmp` 证据，容易让 progress board、handoff、readiness 不在同一 commit | 新增 `scripts/refresh-cds-agent-r0-status.sh` | `/tmp/cds-agent-r0-status-refresh-current.md` | <3s | 一个命令刷新 publish handoff、registry dry-run、readiness、operator handoff、lifecycle、progress |
| 20:18 | 手动发布 workflow 是否存在/是否运行只能靠打开 GitHub 页面；`gh api` 当前返回 404 时没有结构化沉淀 | 新增 `scripts/check-cds-agent-sidecar-workflow.sh`，并由 refresh 脚本默认 dry-run 调用 | `/tmp/cds-agent-sidecar-workflow-current.json` | <1s dry-run；显式检查约 1s | workflow 404/API 失败会进入报告，不再散落在终端 |
| 20:22 | workflow runs API 返回 404，但无法区分文件未推送还是 Actions 未索引 | workflow 检查脚本追加 contents API fallback | `/tmp/cds-agent-sidecar-workflow-current.json` | 约 1s | `workflowFileVisible=true`、`workflowStatus=workflow_file_on_branch_not_indexed` |
| 20:32 | 用户指出 GHCR 意义不清且项目级进度不清楚 | GHCR 从主路径降级为候选；进度文档第一屏增加 8 步、ETA、当前位置、需要用户协助项 | `doc/status.cds-agent-current-progress.md`、publish handoff | 本地编辑 | R0 主输入回到 `CDS_AGENT_SIDECAR_IMAGE=<任意可 pull image>` |
| 20:38 | 进度面板虽然文案承认 GHCR 只是候选，但 `Exact Next Step` 仍把 publish handoff 放在缺 remote host/image 之前 | 调整 `scripts/print-cds-agent-current-progress.sh` 的下一步选择顺序：缺 R0 外部输入时先要求补 `CDS_AGENT_SIDECAR_IMAGE` 和 remote host 参数 | `/tmp/cds-agent-current-progress-current.md` | <1s | 面板下一步不再误导到 GHCR |
| 20:39 | R0 status refresh 底部 `Next Command` 仍固定指向 publish handoff，和进度面板冲突 | 调整 `scripts/refresh-cds-agent-r0-status.sh`：`userActionRequired=true` 时直接输出缺失输入刷新命令 | `/tmp/cds-agent-r0-status-refresh-current.md` | <1s | refresh 报告与 progress board 同口径 |
| 20:48 | 多个进度面之间靠人工目测保持一致，容易再次漂移 | 新增 `scripts/check-cds-agent-progress-consistency.sh`，自动刷新并断言 refresh、progress board、主文档同口径 | terminal output | <3s | `CDS Agent progress consistency: pass` |
| 20:51 | consistency check 单独通过，但接入 goal audit 时继承了“尚未生成”的 `CDS_AGENT_GOAL_AUDIT_REPORT` 导致假失败；同时 N6 沙箱失败会覆盖 canonical summary | consistency check 在 in-progress audit report 不存在时回退默认目标审计输入；goal audit 内 N6 attempt 写入 audit dir，只有 pass 才更新 canonical summary | `/tmp/cds-agent-goal-audit-with-progress-consistency.json`、`/tmp/cds-agent-n6-non-code-compatibility-current.json` | audit 约 10s；沙箱外 N6 约 30s | D1=pass，N6=pass；本地审计唯一失败收敛到 R0 runtime pool 未恢复 |
| 21:35 | 用户明确指出 remote-host/env 路线偏离原始 CDS 设计，要求新建有限计划并先纠正文档 | 新增 `doc/plan.cds-agent-runtime-correction-limited.md`；主进度文档第一屏改为 CDS-managed runtime 纠偏；progress/refresh 下一步改为纠偏计划 | 本文档、`doc/status.cds-agent-current-progress.md`、progress consistency | 预计 65-90m，本轮先完成入口校准 | remote host/env 被降级为 operator fallback，不再作为产品主路径 |
| 22:02 | D1 完成后 runtime-status 后端仍把 R0.2/R0.3 写成 remote host carrier / deploy sidecar image | 新增 R0 fact-source 设计文档；修正 runtime-status execution panel、debug command、task board、controller tests | `doc/design.cds-agent-managed-runtime-fact-source.md`、`InfraAgentSessionsControllerTests` | controller tests 18/18，约 11s | 页面数据源主线已改为 CDS-managed runtime fact source；下一步是 CDS `/agent-sessions` execution 改造 |
| 22:08 | CDS `/agent-sessions` 非 fake message 仍可能把执行描述成 MAP sidecar bridge delegation | 改成 CDS-owned unavailable/error path；补 CDS route test，断言不出现 MAP sidecar bridge，也不要求 SSH/image/env | `cds/src/routes/remote-hosts.ts`、`cds/tests/routes/remote-hosts-instances.test.ts` | CDS route tests 3/3，约 0.5s | R0.2.2 ownership guard 完成；下一步是 CDS-managed official SDK runtime transport |
| 22:28 | CDS `/agent-sessions` 仍只能返回 runtime unavailable，尚未真实投递 official SDK runtime | 增加 CDS-managed branch-service transport：发现 shared-service `claude-agent-sdk` runtime，POST `/v1/agent/run`，解析 SSE 并写回 session events；补 mock official SDK runtime route test | `cds/src/routes/remote-hosts.ts`、`cds/tests/routes/remote-hosts-instances.test.ts` | CDS route tests 4/4，约 0.9s；CDS build pass | R0.2.3 done_minimal；下一步是 MAP adapter session transport + managed-runtime smoke |

## 本轮暴露的问题

### 1. 报告不是修复

问题：先前给出了根因报告，但没有执行远程存量清理，因此页面继续显示 `claude-agent-sdk-runtime-v2`。

处理：用户精确批准后，执行 remote state cleanup wrapper，并做直接远程复查。

优化：以后“报告”和“修复”必须分开标记。状态面板必须明确写：

- report-only
- dry-run
- apply executed
- post-check passed

### 2. 证据分散，用户看不到时间花在哪里

问题：证据散落在 `/tmp`、status 文档、聊天更新里，不形成过程账本。

处理：新增本文件，按时间线记录问题、动作、证据、耗时、结果。

优化：后续每个超过 30s 的动作必须至少落一条账本记录，尤其是远程查询、构建、视觉验证、provider smoke。

### 3. 不该重复 preview redeploy

问题：R0 blocker 是 remote host/shared pool 缺失，普通 preview deploy 不会创建 remote host，也不会恢复 shared runtime pool。

处理：执行面板和文档都标明 `do not redeploy for this state`，并把下一步收敛到 remote host recovery wrapper。

优化：只在以下情况部署：

- 代码变更需要发布到页面/API。
- 远程容器网络或鉴权修复需要新容器。
- 视觉证据需要看最新 UI。
- promotion/self update 被明确要求。

### 4. 发布验证脚本的验证对象错了

问题：脚本要求 `remote_host_create_then_shared_runtime_deploy`、`CDS_AGENT_SIDECAR_IMAGE` 出现在前端 bundle，但这些是后端 runtime-status 返回值，不应该在 JS bundle 里硬编码。

处理：脚本改为验证前端是否发布了 `applyManifest/preconditions` 渲染能力；后端具体 manifest 由 `InfraAgentSessionsControllerTests` 覆盖。

优化：发布验证按层拆分：

- 前端 bundle：验证渲染能力和 UI 标记。
- 后端测试/API：验证 runtime-status 内容。
- 远程 runtime evidence：验证 CDS state。

### 5. remote host 恢复报告缺第二阶段

问题：`prepare-cds-agent-remote-host-pool.sh` 在 `DEPLOY_SIDECAR=0` 时只列 host 创建缺参，没有清楚说明恢复 shared runtime 还缺 `CDS_AGENT_SIDECAR_IMAGE` 和 deploy flag。

处理：新增 `recoveryManifest.phases[]`：

- `remote_host_create`: `POST /api/cds-system/remote-hosts`
- `shared_runtime_deploy`: `POST /api/cds-system/remote-hosts/<hostId>/deploy-sidecar`

优化：以后每个远程写动作都必须有 manifest，包含 safety、method、endpoint、requiredEnv、missingEnv、expectedPostCheck。

### 6. 文档校准没有跟上远程修复

问题：branch-local sidecar 已经清理，但 quickstart、runbook、migration plan、adapter design 和 `scripts/audit-cds-agent-goal.sh` 仍保留 `contaminated:4` 或“先清理 residual”的旧下一步。用户看到这些文档时，会以为修复没有发生，或者计划仍停在旧目标。

处理：把当前权威状态统一为 `BRANCH_LOCAL_SIDECAR_CLEAN=pass`、`REMOTE_HOST_AVAILABLE=missing`、`SHARED_POOL_RUNNING=missing`，并让 goal audit 以后检查新的状态面板文案。

优化：每次远程写动作完成后，必须同步更新三类文档：当前状态、用户使用入口、目标审计脚本。不能只更新事故报告。

### 7. 目标审计把旧证据当当前事实

问题：本机环境变量里有 `CDS_HOST=https://miduo.org`，目标审计在没有明确要求 live 远程审计时仍尝试查询 CDS，导致 P0 计划失败；同时当 runtime pool 没有当前证据时，脚本会继续读取旧 one-cycle summary 的 R1 blocker，让执行方向看起来像“应该先修 profile”。

处理：新增 `CDS_AGENT_GOAL_AUDIT_LIVE=1` 显式开关。不开 live 时，P0 远程状态只标记 `not_observed`；如果 runtime pool 未观测，当前 blocker 固定为 R0 evidence，而不是继承旧 one-cycle R1。

优化：以后审计分两层：

- 本地 guardrail：A0、D0、N6、evidence index，可以无网络跑。
- live control-plane：R0 runtime pool、branch isolation、remote branch status，必须显式 `CDS_AGENT_GOAL_AUDIT_LIVE=1`。

### 8. N6 慢点不是业务失败

问题：目标审计中的 N6 dotnet 测试在沙箱内被 VSTest 本地 socket 限制拦住，表现为 `System.Net.Sockets.SocketException (13): Permission denied` 或超时。

处理：N6 脚本增加 `DOTNET_CLI_USE_MSBUILD_SERVER=0`、`MSBUILDDISABLENODEREUSE=1`、`-m:1 /nodeReuse:false`，减少 MSBuild server/node reuse 干扰；随后沙箱外复跑 no-build N6 测试通过。

证据：`dotnet test ... --no-build --filter 'FullyQualifiedName~CdsAgentRuntimeCompatibilityTests|FullyQualifiedName~InfraAgentRuntimeProfilesControllerTests'` 结果为 `27/27 pass`，测试执行 `64ms`。

优化：目标审计里 N6 `infra_failed` 不再等同于业务失败；需要用沙箱外 no-build 测试确认。

### 9. 无 live 审计也要能读已有 R0 证据

问题：即使禁止无意 live 查询，目标审计也不应该退化成 R0 unknown。当前目录里已有 `/tmp/cds-agent-runtime-pool-evidence-latest/summary.json`，它足以证明 branch cleanup 已干净、remote host 和 shared runtime 仍缺失。

处理：`scripts/audit-cds-agent-goal.sh` 新增 `CDS_AGENT_GOAL_RUNTIME_POOL_SUMMARY`。当 live plan 未运行但 summary 存在时，审计把 runtime pool recovery 标为 `source=summary`，并继承其中的 blockers。

证据：`/tmp/cds-agent-goal-audit-summary-fast.json` 显示 `runtimePoolRecovery.status=pass`、`source=summary`、`contaminatedBranchCount=0`、`REMOTE_HOST_AVAILABLE=missing`、`SHARED_POOL_RUNNING=missing`。

优化：以后日常进度面板优先走“本地 guardrail + 最近 R0 summary”，只有要刷新远程事实时才开 `CDS_AGENT_GOAL_AUDIT_LIVE=1`。

### 10. 审计状态和下一步计划不能继承旧 one-cycle

问题：即使 runtime pool blockers 已经来自最新 summary，`executionPanel.status` 仍沿用旧 one-cycle 的 `blocked_r1`，`nextCyclePlan` 仍是 provider/profile closure。这会让页面或人类读者误以为下一步应先修 R1。

处理：当 runtime pool plan 未观测或存在 blockers 时，goal audit 强制输出 R0 状态：

- `executionPanel.status=blocked_r0`
- `currentBlockingGate=R0`
- `nextCyclePlan.cycle=r0-cds-managed-runtime-reconciler`（该条为当时状态；R0.6 完成后已推进到 R0.7）
- plan items 为 `D1` 架构纠偏、`R0.3` CDS-managed official SDK runtime transport done_minimal、`R0.4` MAP session transport smoke done、`R0V` live evidence done_blocked、`R0.5` capacity contract done_minimal、`R0.6` reconciler next（该条为当时状态）。

证据：当时 `scripts/audit-cds-agent-goal.sh` 输出 `Next cycle plan: r0-cds-managed-runtime-reconciler state=cds-managed-runtime-reconciler-missing items=D1,R0.3,R0.4,R0V,R0.5,R0.6`。当前状态以后文最新章节和 `doc/status.cds-agent-current-progress.md` 为准。

优化：旧 one-cycle 只作为历史 provider/profile 证据，不再决定当前执行面板的顶层状态。

### 11. remote host prepare 不应强制创建新 host

问题：恢复 R0 时可能已经存在 enabled remote host，但旧脚本仍强制要求 `CDS_REMOTE_HOST_NAME`、`CDS_REMOTE_HOST_HOST`、`CDS_REMOTE_HOST_SSH_USER` 和 SSH key。这会把“部署 shared runtime sidecar”误挡在“创建 host 参数缺失”上。

处理：`prepare-cds-agent-remote-host-pool.sh` 现在会先选择 target host：

- 优先使用 `CDS_REMOTE_HOST_ID`。
- 未指定时复用第一个 enabled remote host。
- 只有没有 target host 时才要求创建 host 的 SSH 参数。
- 部署 sidecar 时单独要求 `CDS_AGENT_SIDECAR_IMAGE`。

证据：

- `/tmp/cds-agent-remote-host-existing-report.json`：existing enabled host dry-run，`willCreateHost=false`、`missingConfig=[]`。
- `/tmp/cds-agent-remote-host-existing-deploy-missing-image-report.json`：existing enabled host + deploy dry-run，只缺 `CDS_AGENT_SIDECAR_IMAGE`。

优化：真实执行前先用 prepare report 看 `targetHostId/willCreateHost/missingConfig`，避免把创建 host 和部署 sidecar 混成一个大黑盒。

### 12. evidence unavailable 不能误报成 branch contamination

问题：沙箱内 DNS 解析 `cds.miduo.org` 失败时，pre evidence 标记 `branchIsolation.evidenceCaptured=false`，但 remote host wrapper 仅通过 `branchIsolationClean=false` 推导 verdict，最终误报 `blocked-branch-isolation`。

处理：`run-cds-agent-remote-host-pool-with-evidence.sh` 增加 `preEvidenceAvailable`，先判断证据是否可用。证据不可用时输出：

- `verdict=evidence-unavailable`
- `nextAction=fix network/auth and rerun`

证据：

- 沙箱外 live dry-run `/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json`：`dry-run-missing-config`，远程 `enabledHostCount=0`、`sharedRunning=0`。
- 沙箱内 DNS 失败 fixture `/tmp/cds-agent-remote-host-pool-current-readonly-unavailable-fixed/summary.json`：`verdict=evidence-unavailable`。

优化：以后只有看到真实 `BRANCH_LOCAL_SIDECAR_CLEAN` blocker 时才写 branch contamination；证据不可用单独处理，避免误导执行顺序。

### 13. remote host apply 前要先拦截格式错误

问题：即使变量都填了，也可能因为 `CDS_REMOTE_HOST_HOST` 写成 URL、`CDS_REMOTE_HOST_SSH_PORT` 非数字、private key 内容不像私钥、或 `CDS_AGENT_SIDECAR_IMAGE` 带空白字符，直到远程 POST 时才失败。

处理：`prepare-cds-agent-remote-host-pool.sh` 增加本地格式 preflight：

- `invalidConfig`: 已提供但格式不合格的变量。
- `preflightReady`: `missingConfig=[]` 且 `invalidConfig=[]`。
- wrapper verdict 新增 `dry-run-invalid-config`。

证据：`/tmp/cds-agent-remote-host-invalid-report.json` 显示 `status=invalid_config`、`preflightReady=false`，并列出 host URL、SSH port、private key 三类错误。

优化：执行写入前先看 `preflightReady=true`，否则不进入 apply。

### 14. 页面执行面必须看到 preflight 证据字段

问题：`prepare` 脚本已经输出 `preflightReady`、`targetHostId`、`willCreateHost`、`missingConfig`、`invalidConfig`，但后端 runbook manifest 和前端 execution panel 只展示 required env 和 preconditions。用户在页面上仍看不到“应该先跑哪个本地 preflight、看哪些字段”。

处理：

- `SidecarCommandApplyManifest` 增加 `LocalPreflightCommand`、`ReportFields`、`OptionalEnv`。
- remote host runbook 返回 `run-cds-agent-remote-host-pool-with-evidence.sh` preflight 命令。
- manifest 明确报告字段：`prepare.preflightReady`、`prepare.targetHostId`、`prepare.willCreateHost`、`prepare.missingConfig`、`prepare.invalidConfig`、`verdict`。
- 前端 execution panel 展示 preflight 命令和报告字段 chip。

证据：`InfraAgentSessionsControllerTests` 18/18 通过；`pnpm --prefix prd-admin tsc` 通过。

优化：页面下一步应该围绕 preflight report 判断，而不是只读静态 env 列表。

### 15. apply handoff 不能靠人工拼命令

问题：即使 dry-run summary 已经明确，人工从文档里拼 create host、deploy sidecar、post-check 三段命令仍容易漏 flag；更严重的是可能把 private key 内容复制到聊天或日志里。

处理：新增 `scripts/print-cds-agent-remote-host-handoff.sh`。输入 wrapper summary 或 prepare report，输出安全 handoff：

- 新建 host 路径输出占位符 `<private-key-file>`，不输出 key 内容。
- existing host 路径输出 `CDS_REMOTE_HOST_ID=<id>`。
- invalid config 路径只输出错误列表，不输出 apply 命令。

证据：

- `/tmp/cds-agent-remote-host-handoff.md`
- `/tmp/cds-agent-remote-host-existing-handoff.md`
- `/tmp/cds-agent-remote-host-invalid-handoff.md`

优化：真实写远程前先生成 handoff，再由人类填入私钥文件路径和 sidecar image。

### 16. 进度入口不能只靠长文档

问题：`doc/status.cds-agent-current-progress.md` 信息完整但太长；用户长时间看不到一个稳定的任务总览、当前 gate、下一步和耗时预估，导致无法判断任务是在开发还是兜圈。

处理：新增 `scripts/print-cds-agent-current-progress.sh`，直接读取当前 goal audit 和 remote host summary，输出：

- 当前总状态、blocking gate、A0/R0/V1/N6 gate 状态。
- R0 remote host verdict、enabled host 数、shared runtime running 数。
- 分阶段任务看板和每步 ETA。
- 当前缺失配置、下一条 handoff 命令。
- 现在不该做的事，避免重复 preview redeploy 和过早 provider one-cycle。

证据：`scripts/print-cds-agent-current-progress.sh` 运行通过，当前输出 `blocked_r0`、`R0=pending`、`enabledHostCount=0`、`sharedRunning=0`。

耗时：脚本输出 <1s；语法检查 <1s。

优化：后续每轮先更新 evidence，再用该命令给用户汇报，不再让用户从长文档和 `/tmp` JSON 里拼进度。

### 17. 页面执行面板需要直接展示任务纵览和 ETA

问题：本地 `scripts/print-cds-agent-current-progress.sh` 已能解释进度，但最终用户看的是 MAP/CDS 页面。旧 `runtime-status.executionPanel` 有 runbook、gateCounts 和 nextCommand，却没有一个稳定的 task board 字段，页面仍需要把多个诊断块拼起来才能理解“完成了几个、卡在第几个、下一步多久”。

处理：

- `SidecarExecutionPanel` 增加 `taskBoard`、`nextStepEta`、`timeSinkAdvice`。
- 后端按 A0/R0.1/R0.2/R0.3/R1/S1-S3/V1 生成阶段看板，标明状态、下一步、ETA 和证据入口。
- CDS Agent 页面新增“任务纵览与 ETA”区块，并在当前执行结论顶部展示“下一步耗时”和“耗时控制”。

证据：

- `dotnet test prd-api/tests/PrdAgent.Api.Tests/PrdAgent.Api.Tests.csproj --filter InfraAgentSessionsControllerTests --no-restore`：18/18 pass（沙箱外；沙箱内 MSBuild named pipe 权限失败）。
- `pnpm --prefix prd-admin tsc`：pass。
- `git diff --check`：pass。

耗时：后端目标单测 15s；前端 tsc 20s；diff check <1s。

优化：用户以后看页面就能看到任务纵览和 ETA，不需要等待我在聊天里解释当前第几步。

### 18. N6 不能被沙箱 socket 权限长期标成 infra_failed

问题：目标审计里的 `N6=infra_failed` 来自沙箱内 dotnet/VSTest socket 权限失败，不代表 PRD/Defect/Literary/Visual 等非代码智能体兼容性失败。进度面板只读旧 goal audit，会继续误导当前状态。

处理：

- 沙箱外重跑 `bash scripts/smoke-cds-agent-non-code-compatibility.sh`。
- `scripts/smoke-cds-agent-non-code-compatibility.sh` 新增机器可读 summary 输出，默认 `/tmp/cds-agent-n6-non-code-compatibility-current.json`。
- `scripts/print-cds-agent-current-progress.sh` 优先读取最新 N6 summary；如果 summary 为 `pass`，进度面板显示 `N6=pass`。

证据：

- `/tmp/cds-agent-n6-non-code-compatibility-current.json`：`status=pass`、`exitCode=0`、`totalSeconds=3`。
- N6 smoke：27/27 pass。
- `scripts/print-cds-agent-current-progress.sh` 当前显示 `Gate status: A0=pass, R0=pending, V1=pass, N6=pass`。

耗时：普通沙箱失败约 60s；沙箱外真实 N6 3s；进度面板刷新 <1s。

优化：后续 N6 状态用 summary 校准，不再把本地执行环境权限问题当成智能体兼容性问题。

### 19. R0 apply 前需要纯本地 readiness 门禁

问题：`prepare-cds-agent-remote-host-pool.sh` 会访问远程 CDS；在真正 apply 前，如果本地 env 缺 host/image 或格式错误，容易把时间浪费在远程 dry-run / apply 循环里。当前 shell 只有 CDS 访问 key 和一个非目标 `CDS_HOST`，没有 remote host SSH 参数和 sidecar image。

处理：

- 新增 `scripts/preflight-cds-agent-r0-apply-readiness.sh`。
- 它只读 `/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json` 和本地 env，不访问远程，不打印 secret。
- 输出 `/tmp/cds-agent-r0-apply-readiness-current.json`，字段包括 `readyForHostApply`、`readyForDeployRequest`、`readyForR0Apply`、`missingConfig`、`invalidConfig`、`warnings`。
- `scripts/print-cds-agent-current-progress.sh` 接入该 summary，直接显示 R0 local apply readiness。

证据：

- `/tmp/cds-agent-r0-apply-readiness-current.json`：`readyForR0Apply=false`。
- 当前缺失：`CDS_REMOTE_HOST_NAME`、`CDS_REMOTE_HOST_HOST`、`CDS_REMOTE_HOST_SSH_USER`、`CDS_REMOTE_HOST_SSH_PRIVATE_KEY or CDS_REMOTE_HOST_SSH_PRIVATE_KEY_FILE`、`CDS_AGENT_SIDECAR_IMAGE`。
- 当前 warning：`CDS_HOST` 不是 `https://cds.miduo.org`。
- 当时 `scripts/print-cds-agent-current-progress.sh` 把 R0 readiness 的下一步写成补 env；21:35 后已纠正为先进入 R0 CDS-managed runtime 事实源设计。

耗时：本地 readiness <1s；进度面板 <1s；不触发远程网络。

优化：R0.2/R0.3 真正执行前先跑该门禁，只有 ready 后才进入远程 apply/deploy，避免反复远程构建/部署/写入。

### 20. R0 需要一个单文件操作员交接包

问题：R0 的事实分散在 progress board、readiness JSON、remote host handoff 和状态文档中。即使信息齐全，实际执行人仍需要在多个文件里切换，容易漏掉 warning、缺失输入或“不要重复 preview redeploy”的约束。

处理：

- 新增 `scripts/print-cds-agent-r0-operator-handoff.sh`。
- 它先刷新本地 R0 readiness，再把当前决策、缺失输入、ETA、不要做的事、安全 apply/deploy/post-check 命令聚合为 `/tmp/cds-agent-r0-operator-handoff-current.md`。
- 交接包只使用占位符和 env 名称，不输出 private key、AI access key 或 provider key。

证据：

- `/tmp/cds-agent-r0-operator-handoff-current.md`：`status=blocked_before_apply`、`readyForR0Apply=false`、缺 remote host SSH 参数和 `CDS_AGENT_SIDECAR_IMAGE`。
- 安全扫描：未发现 `BEGIN .*PRIVATE KEY`、当前访问 key、`sk-` 或 key=value secret 形态。
- `git diff --check`：pass。

耗时：生成 <2s；安全扫描 <1s。

优化：拿到参数后先看一个 handoff 文件即可执行 R0.2/R0.3/R0V，减少人工拼命令和重复部署。

### 21. goal audit 必须消费最新 N6 summary 和 R0 readiness

问题：`audit-cds-agent-goal.sh` 会在沙箱内运行 N6。即使已有 `/tmp/cds-agent-n6-non-code-compatibility-current.json` 的当前通过证据，沙箱内 VSTest socket/timeout 仍可能把 N6 写成 `infra_failed`，从而污染当前进度判断。同时 R0 apply readiness 只在进度脚本里可见，goal audit JSON 里缺少同一份证据。

处理：

- goal audit 运行 N6 时传入 `SMOKE_CDS_AGENT_N6_REPORT`。
- 如果 N6 summary 为 `pass`，audit 将 `N6=pass`，并移除本轮沙箱 N6 失败标签。
- audit 会调用纯本地 `preflight-cds-agent-r0-apply-readiness.sh`，并把 `runtimePoolRecovery.applyReadiness` 写入报告。
- `requirements.otherAgentCompatibility.summary` 指向 N6 summary。

证据：

- `/tmp/cds-agent-goal-audit-current-with-readiness.json`：`gates.N6=pass`。
- `requirements.otherAgentCompatibility.status=proved`。
- `runtimePoolRecovery.applyReadiness.readyForR0Apply=false`。
- audit stdout 仍明确 `Goal status: not_complete`，当时失败为 `CDS-managed runtime capacity reconciler has not produced running official SDK runtime`。R0.6 完成后，当前失败已推进为 R0.7 live apply 尚未产生 running official SDK runtime。

耗时：短超时审计 15s；N6 沙箱步骤被超时停止，但 summary 将当前 N6 证据校准为 pass。

优化：以后目标审计的“当前进度”会和本地进度面板一致，减少 N6 误报和重复解释。

### 22. 用户需要生命周期级视图，而不是只看局部进度

问题：已有 progress board、operator handoff 和 goal audit，但它们分别回答“当前命令”“R0 怎么交接”“目标审计结果”。用户问“整个生命周期开发到什么程度、离目标多远”时，仍需要人工把这些输出拼起来。

处理：

- 新增 `scripts/print-cds-agent-lifecycle-overview.sh`。
- 输出完整生命周期：A0 边界、N6 兼容、R0 runtime pool、R1 profile、S1、S2/S3、V1、商业收口。
- 明确当前不是完成态：`goalStatus=not_complete`、`currentBlockingGate=R0`。
- V1 历史页面证据不再显示为完全 done，而是 `partial`，要求 R0/R1/S1-S3 后重截 live runtime 页面。

证据：

- 生命周期视图当前显示：A0 done、N6 done、R0 blocked、R1 blocked、S1 blocked、S2/S3 blocked、V1 partial、Commercial closure blocked。
- Missing R0 inputs 与 readiness 一致：remote host SSH 参数和 `CDS_AGENT_SIDECAR_IMAGE`。

耗时：<1s。

优化：以后回答全局进度先跑生命周期视图，再决定是否需要展开 audit 或 handoff。

### 23. Sidecar image 不能被误认为本地可构建即远程可部署

问题：仓库里有 `claude-sdk-sidecar/Dockerfile`，但 CDS remote sidecar deployer 的真实行为是目标 host 上 `docker pull` 再 `docker run`。如果只说“需要 `CDS_AGENT_SIDECAR_IMAGE`”，容易让执行者以为本地 build context 会被 CDS 自动带到远程，导致 R0.3 又在远程部署阶段失败。

处理：

- `scripts/preflight-cds-agent-r0-apply-readiness.sh` 增加 `imageReadiness`，输出 `missing/invalid/provided_unverified`。
- `scripts/print-cds-agent-r0-operator-handoff.sh` 增加 Sidecar Image 区块，明确 `docker-pull-only`，并只给候选 build/push 命令。
- `scripts/print-cds-agent-lifecycle-overview.sh` 展示 sidecar image readiness，并在输出前刷新本地 R0 readiness，减少读取旧 `/tmp` 证据。

证据：

- `cds/src/services/sidecar/sidecar-deployer.ts` 部署路径执行 `docker pull ${image}` 和 `docker run ... ${image}`。
- `cds/src/routes/remote-hosts.ts` 的 deploy-sidecar route 要求 request body 提供 `image`。
- `/tmp/cds-agent-r0-apply-readiness-current.json` 当前 `imageReadiness.status=missing`，`deployerMode=docker-pull-only`。

优化：R0.3 开始前必须先回答“目标 remote host 能否 `docker pull` 该 image”。没有 pullable registry tag 时，只允许 dry-run、handoff 和本地预检，不进入远程 deploy。

### 24. Sidecar image 预检需要拆成本地 build context 与远程 pullability

问题：`CDS_AGENT_SIDECAR_IMAGE` 的远程可拉取性不能在本地证明，但本地仍然可以证明 Dockerfile/context 是否足以生成候选 image。之前这两类问题混在一起，容易导致下一次 R0.3 失败时不知道是 Dockerfile/context 坏了，还是 registry/remote host pull 权限坏了。

处理：

- 新增 `scripts/preflight-cds-agent-sidecar-image.sh`。
- 本地验证 `claude-sdk-sidecar/Dockerfile`、`requirements.txt`、`app/main.py`、`app/official_agent_sdk.py`、`/healthz`、`/readyz`、`claude-agent-sdk` dependency 和端口/healthcheck。
- R0 readiness 嵌入 `imageReadiness.preflight`、`buildContextStatus` 和 preflight report 路径。
- progress board、lifecycle overview、operator handoff 都显示 `Sidecar build context`。

证据：

- `/tmp/cds-agent-sidecar-image-preflight-current.json` 当前 `buildContext.status=pass`、`image.status=missing`。
- `/tmp/cds-agent-r0-apply-readiness-current.json` 当前 `imageReadiness.buildContextStatus=pass`。

优化：后续 R0.3 的失败面被拆成三类：本地 context、registry image、remote host docker pull。当前只剩 registry image 和 remote host。

### 25. 本地 Docker 构建也必须成为门禁，而不是临时终端错误

问题：`colima status` 显示 running，但 `docker version` 和 `docker ps` 无法连接 `/Users/inernoro/.colima/default/docker.sock`。如果没有独立 build smoke，这类环境问题会在人工构建镜像时才暴露，并再次被误解成 CDS R0 远程 deploy 问题。

处理：

- 新增 `scripts/smoke-cds-agent-sidecar-image-build.sh`。
- 脚本先跑 image preflight，再尝试 `docker build -t <image> -f <Dockerfile> <context>`。
- 结果写入 `/tmp/cds-agent-sidecar-image-build-current.json`，状态包括 `docker_unavailable`、`build_failed`、`build_pass`。
- 脚本明确 `pushAttempted=false`、`deployAttempted=false`。
- progress board、lifecycle overview、operator handoff 显示 local docker build 状态。

证据：

- 初始 `/tmp/cds-agent-sidecar-image-build-current.json` 为 `status=docker_unavailable`。
- 当前 `/tmp/cds-agent-sidecar-image-build-current.json` 为 `status=build_pass`。

优化：R0.3 前置证据现在分层为：build context pass、local docker build、registry push/pull、remote deploy。下一步不再把 Docker daemon 问题与 CDS remote host 问题混在一起。

补充：脚本现在区分 `docker_permission_denied` 和 `docker_unavailable`。前者通常是沙箱没有 Docker socket 权限，后者才是 daemon 真不可达。

### 26. Registry 发布必须显式化，不能把 build pass 当作 remote pullable

问题：`build_pass` 只证明本机能构建 `prd-agent/claude-sidecar:latest`，但 CDS remote deployer 需要目标 host 能 `docker pull` 一个 registry-qualified image。缺少单独发布门禁时，执行者可能把本地镜像名直接填进 `CDS_AGENT_SIDECAR_IMAGE`，导致 R0.3 在 remote host 上 pull 失败。

处理：

- 新增 `scripts/publish-cds-agent-sidecar-image.sh`。
- 默认 dry-run：验证本地 source image 存在、target image 安全、target image registry-qualified，并输出 tag/push/pull 命令。
- 只有 `CDS_AGENT_SIDECAR_IMAGE_PUSH=1` 时才执行 `docker tag` 和 `docker push`。
- 可选 `CDS_AGENT_SIDECAR_IMAGE_PULL_VERIFY=1` 在 push 后做本机 pull 验证。
- progress board、lifecycle overview、operator handoff 显示 `Sidecar registry publish`。

证据：

- 默认报告 `/tmp/cds-agent-sidecar-image-publish-current.json` 当前 `status=missing_target_image`。
- 示例报告 `/tmp/cds-agent-sidecar-image-publish-dryrun-ghcr.json` 当前 `status=push_ready`、`pushAttempted=false`。

优化：R0.3 现在被拆成 build context -> local build -> registry publish -> remote host pull/run。每一步都有独立证据，不再把失败都堆到远程部署阶段。

### 27. Remote host pull 必须先于 deploy-sidecar 单独验证

问题：就算 registry push 成功，目标 remote host 仍可能因为网络、鉴权、Docker daemon、registry 权限或架构问题无法 `docker pull`。如果直接调用 CDS deploy-sidecar，失败会混在 remote deployment 里，难以区分是 pull 问题还是 run/healthcheck 问题。

处理：

- 新增 `scripts/verify-cds-agent-remote-sidecar-pull.sh`。
- 默认只校验 `CDS_AGENT_SIDECAR_IMAGE`、`CDS_REMOTE_HOST_HOST`、`CDS_REMOTE_HOST_SSH_USER`、SSH key 和 port，不 SSH。
- 只有 `CDS_AGENT_REMOTE_PULL_VERIFY=1` 时才通过 SSH 执行 `docker pull <image>`。
- 脚本报告 `pullAttempted`、`pullPassed`、`deployAttempted=false`，保证它不会创建 CDS host 或运行 sidecar。
- progress board、lifecycle overview、operator handoff 显示 `Remote host docker pull`。

证据：

- 默认报告 `/tmp/cds-agent-remote-sidecar-pull-current.json` 当前 `status=missing_config`。
- 示例报告 `/tmp/cds-agent-remote-pull-dryrun-ready.json` 当前 `status=dry_run_ready`、`pullAttempted=false`。

优化：R0.3 现在继续拆分为 remote pull 和 sidecar run/healthcheck。下一次远程失败可以定位到 pull、run、healthcheck 或 CDS state post-check，而不是笼统“部署失败”。

### 28. 进度面板必须按 gate 顺序给下一步

问题：面板已经显示 `Sidecar registry publish=missing_target_image` 和 `Remote host docker pull=missing_config`，但 `Exact Next Step` 仍固定让执行者生成 remote-host handoff。这会绕过当前最靠前的 registry/pull 门禁。

处理：`scripts/print-cds-agent-current-progress.sh` 的 `Exact Next Step` 现在按顺序选择：

- sidecar build context
- local image build
- registry publish dry-run/push
- remote host pull dry-run/verify
- remote host apply/deploy handoff
- R0 post-check

证据：当前面板下一步输出 registry-qualified `CDS_AGENT_SIDECAR_IMAGE` 的 publish dry-run 命令，而不是 remote-host handoff。

优化：以后用户只看一个进度面板，也能知道当前最前面的失败 gate 和下一条命令。

### 29. 下一步命令必须是可执行候选值，且面板生成必须只读

问题：`Exact Next Step` 仍显示 `<registry>/<namespace>/...` 占位符，执行者还要自己推导 tag。同时第一次把动态变量放进 unquoted heredoc，Markdown 三反引号触发 shell command substitution 风险，导致面板生成时意外运行了一次 publish dry-run。

处理：

- `scripts/publish-cds-agent-sidecar-image.sh` 从 `git remote origin` 和 `git rev-parse --short=12 HEAD` 推导 `candidateTargetImage`。
- 当前 candidate 为 `ghcr.io/inernoro/prd-agent/claude-sidecar:12a488c3f4fa`。
- `scripts/print-cds-agent-current-progress.sh` 的动态命令改用 `printf` 拼接，避免 shell 展开 Markdown 反引号。
- 默认 publish report 在 `missing_target_image` 状态下也写入 `candidateTargetImage` 和 candidate dry-run/push 命令。

证据：

- `/tmp/cds-agent-sidecar-image-publish-current.json` 包含 `candidateTargetImage=ghcr.io/inernoro/prd-agent/claude-sidecar:12a488c3f4fa`。
- 当前 progress board 的 `Exact Next Step` 直接输出该 candidate dry-run 命令。

优化：面板现在既给具体命令，又保持只读；不再靠用户手动拼 registry tag。

### 30. 外部 push 前先完成本地 registry tag

问题：GHCR push 属于外部 registry 写入，需要明确批准；但在批准前仍可以完成本地 `docker tag`，把本地 build artifact 和目标 registry tag 对齐，减少 push 之后才发现 tag 参数错误的风险。

处理：

- 使用 `CDS_AGENT_SIDECAR_IMAGE_TAG=1` 只执行 `docker tag`。
- 没有设置 `CDS_AGENT_SIDECAR_IMAGE_PUSH=1`，因此没有 push。
- `scripts/print-cds-agent-current-progress.sh` 增加 `Sidecar local registry tag` 和 `Sidecar push attempted`。

证据：

- `/tmp/cds-agent-sidecar-image-publish-current.json` 当前 `tagPassed=true`、`pushAttempted=false`。
- `docker image inspect` 显示 `prd-agent/claude-sidecar:latest` 与 `ghcr.io/inernoro/prd-agent/claude-sidecar:0f14b13f0c84` 指向同一 image id。

优化：registry 阶段现在拆成 local tag 和 external push；外部写入仍保持显式批准。

### 31. 外部 registry 发布需要手动 CI 入口

问题：本机 Codex 直接 push GHCR 属于外部写入/产物外传，需要明确批准；即使批准，也缺少 GitHub 侧可审计的发布入口。

处理：

- 新增 `.github/workflows/cds-sidecar-image.yml`。
- 只支持 `workflow_dispatch`，普通 push 不会自动发布。
- 默认 image tag 为当前 commit 短 SHA，也可手动输入 `image_tag`。
- 输出 `CDS_AGENT_SIDECAR_IMAGE` 和 image digest 到 workflow summary。

优化：sidecar image 发布可以由 GitHub Actions 手动触发并审计；本机仍保留 dry-run/local-tag/push 脚本作为本地验证路径。

### 32. 发布入口需要一个只读 handoff

问题：workflow 文件存在后，执行者仍要自己找到 Actions 页面、tag、CLI 等价命令和本机 push 替代路径。进度面板如果直接显示本机 push 命令，会继续把用户推向需要额外批准的本地外传路径。

处理：

- 新增 `scripts/print-cds-agent-sidecar-publish-handoff.sh`。
- 输出 GitHub Actions URL、当前 commit image tag、workflow image、local push image 和 CLI 等价命令。
- `scripts/print-cds-agent-current-progress.sh` 当时在 `push_ready` 时默认提示运行 handoff，不再默认提示本机 push；后续 20:38 已再次校准为缺 R0 外部输入时优先提示补齐 image/remote host。

证据：

- `/tmp/cds-agent-sidecar-publish-handoff-current.md` 已生成。
- 当时进度面板的 `Exact Next Step` 指向 `scripts/print-cds-agent-sidecar-publish-handoff.sh`；当前已改为先提供 `CDS_AGENT_SIDECAR_IMAGE` 和 remote host 参数。

优化：外部发布入口现在从“命令散落在聊天里”收敛成一个只读 handoff 文件。

### 33. registry 可见性应在 remote host SSH 前验证

问题：即使 GitHub Actions 或本机 push 成功，后续 remote host `docker pull` 失败也可能来自三类原因：image tag 不存在、registry 权限不可读、host 本身网络/认证问题。如果直接 SSH 到 host 才发现失败，排障面过大。

处理：

- 新增 `scripts/verify-cds-agent-sidecar-registry-image.sh`。
- 默认只做参数校验和 dry-run，不访问 registry。
- 显式 `CDS_AGENT_SIDECAR_REGISTRY_VERIFY=1` 时，对 GHCR 走匿名 pull token + manifest HEAD 查询，只读验证 tag/digest 可见。
- handoff 在 GitHub Actions 发布后直接给出 manifest 验证命令。
- current progress 和 lifecycle overview 增加 `Sidecar registry manifest` 状态。

证据：

- 脚本写入 `/tmp/cds-agent-sidecar-registry-image-current.json`。
- `scripts/print-cds-agent-current-progress.sh` 会展示 `Sidecar registry manifest`。

优化：R0.3 前置链路从“publish -> remote SSH pull”拆为“publish -> registry manifest visible -> remote SSH pull”，减少远程环境排障。

### 34. R0 readiness 应消费 image 后置验证结果

问题：新增 registry manifest 验证后，如果 readiness 不读取该报告，执行者仍要人工比较 `CDS_AGENT_SIDECAR_IMAGE`、registry manifest 报告和 remote pull 报告是否是同一个 image。

处理：

- `scripts/preflight-cds-agent-r0-apply-readiness.sh` 增加 `imageReadiness.registryManifest` 与 `imageReadiness.remotePull`。
- 两个字段都包含 report、status、结果布尔值、image 和 `matchesCurrentImage`。
- `scripts/print-cds-agent-r0-operator-handoff.sh` 展示 `imageRegistryManifest` 与 `imageRegistryVisible`。

证据：

- `/tmp/cds-agent-r0-apply-readiness-current.json` 可直接检查当前 image、manifest、remote pull 是否同源。
- `/tmp/cds-agent-r0-operator-handoff-current.md` 展示 registry manifest 状态。

优化：R0 readiness 从“只看 env 是否给齐”推进到“env + image publish evidence + registry manifest + remote pull evidence 同屏判断”。

### 35. R0 handoff 不应被旧 publish report tag 误导

问题：每次提交后，GitHub Actions 推荐 image tag 应随当前 HEAD 更新；但 `/tmp/cds-agent-sidecar-image-publish-current.json` 可能仍保存旧本地 tag。如果 operator handoff 直接采用旧 candidate，会和 publish handoff 出现两个目标 image。

处理：

- `scripts/print-cds-agent-r0-operator-handoff.sh` 从 git remote + 当前 HEAD 推导 `currentSidecarImage`。
- 当 publish report candidate 为空或不等于当前 image 时，operator handoff 优先显示当前 image。
- 旧 publish target 仍保留为历史证据字段，不再作为下一次发布目标。

证据：

- `/tmp/cds-agent-r0-operator-handoff-current.md` 当前 `imagePublishCandidate` 和 `currentSidecarImage` 均为 `ghcr.io/inernoro/prd-agent/claude-sidecar:e25e3f64a433`。

优化：R0 发布目标现在由当前 commit 决定，避免手动发布错旧 image。

### 36. R0 状态刷新需要一个单入口

问题：publish handoff、registry dry-run、readiness、operator handoff、lifecycle、progress board 分散在多个脚本中。每次提交后，如果只刷新其中一部分，用户看到的 image tag、blocker 和下一步可能来自不同时间点。

处理：

- 新增 `scripts/refresh-cds-agent-r0-status.sh`。
- 默认只读：不 push、不访问 GitHub、不 SSH、不部署。
- 推导当前 HEAD 对应 GHCR image，并用它刷新 registry dry-run 报告。
- 统一生成 `/tmp/cds-agent-r0-status-refresh-current.md`、publish handoff、readiness、operator handoff、lifecycle overview、progress board。

证据：

- `/tmp/cds-agent-r0-status-refresh-current.md` 记录 currentSidecarImage、registryCheckImage、readyForR0Apply、nextAction、missingConfig、registryManifestStatus、remotePullStatus 和所有证据路径。

优化：日常查看入口从“跑多个脚本并人工对齐”收敛到一个只读刷新命令。

### 37. GitHub Actions 发布状态需要结构化检查

问题：sidecar image 推荐通过 GitHub Actions 手动发布，但 workflow 是否已被 GitHub 索引、是否有 run、最近 run 是否成功，不应靠人工打开网页判断。实际只读探测中，`gh api repos/inernoro/prd_agent/actions/...` 返回过 404，这也需要被沉淀为证据。

处理：

- 新增 `scripts/check-cds-agent-sidecar-workflow.sh`。
- 默认 dry-run，不访问 GitHub。
- 显式设置 `CDS_AGENT_WORKFLOW_CHECK=1` 后使用 `gh api` 只读查询 workflow runs。
- 将 `dry_run_ready`、`workflow_not_found`、`api_failed`、`no_runs`、`run_in_progress`、`run_success` 写入 `/tmp/cds-agent-sidecar-workflow-current.json`。
- `scripts/refresh-cds-agent-r0-status.sh` 默认调用该脚本 dry-run，并在总刷新报告中展示 `workflowStatus`。

证据：

- `/tmp/cds-agent-sidecar-workflow-current.json`。
- `/tmp/cds-agent-r0-status-refresh-current.md` 展示 workflowStatus/workflowRun。

优化：R0.0 发布链路从“打开网页看”推进到“可选只读 API 检查 + 结构化报告”。

### 38. workflow 文件存在不等于 Actions 可 dispatch

问题：`cds-sidecar-image.yml` 已推送到 `codex/cds-agent-workbench-ui` 分支，但 GitHub Actions workflow API 对 `repos/inernoro/prd_agent/actions/workflows/cds-sidecar-image.yml/runs` 返回 404。单看 404 会误判为文件未推送或仓库不可见。

处理：

- `scripts/check-cds-agent-sidecar-workflow.sh` 在 workflow API 404 时追加 contents API fallback。
- 如果 `.github/workflows/cds-sidecar-image.yml?ref=<branch>` 可见，则状态写为 `workflow_file_on_branch_not_indexed`。
- publish handoff 的本机 push 替代路径增加说明：当 Actions 不能 dispatch 非索引分支 workflow 时才使用，且仍需要显式批准外部 registry 写入。

证据：

- `/tmp/cds-agent-sidecar-workflow-current.json` 当前：
  - `workflowFileVisible=true`
  - `workflowFileHtmlUrl=https://github.com/inernoro/prd_agent/blob/codex/cds-agent-workbench-ui/.github/workflows/cds-sidecar-image.yml`
  - `status=workflow_file_on_branch_not_indexed`

优化：发布阻塞现在从“workflow 404”细化为“文件在分支上，但 Actions 不可 dispatch/list”，下一步选择更明确。

### 39. GHCR 不能成为架构目标

问题：用户指出“做 ghcr.io 的意义在哪里”。这是合理质疑。R0 的真实要求不是 GHCR，而是给 CDS remote deployer 一个 remote host 可 `docker pull` 的 `CDS_AGENT_SIDECAR_IMAGE`。继续把 GHCR 写成主路径会制造不必要复杂度。

处理：

- `scripts/print-cds-agent-sidecar-publish-handoff.sh` 改为 registry-agnostic 口径。
- `CDS_AGENT_SIDECAR_IMAGE` 被标为 required image input。
- GHCR 只作为 GitHub repo 的默认 candidate image。
- 支持 `CDS_AGENT_SIDECAR_IMAGE_REPOSITORY` 覆盖候选仓库。
- `scripts/refresh-cds-agent-r0-status.sh` 区分 `imageSource=provided|candidate`。

证据：

- publish handoff 第一屏写明“Use any registry image that the target remote host can docker pull”。
- R0 status refresh 当时写出 `requiredImageInput=CDS_AGENT_SIDECAR_IMAGE`、`candidateSidecarImage`、`registryCheckImage`；21:35 后已改为 `operatorFallbackImageInput=CDS_AGENT_SIDECAR_IMAGE`，避免把 image 写成产品主输入。

优化：R0 发布路径从“GHCR 优先”收敛为“任意可 pull registry image 优先，GHCR 只是候选”。

### 40. 进度文档必须第一屏回答项目级问题

问题：用户多次要求知道预计什么时候结束、规划多少步骤、当前在哪一步、关键文档在哪。此前这些信息分散在聊天、脚本输出和长账本中，第一屏没有稳定回答。

处理：

- `doc/status.cds-agent-current-progress.md` 第一节改为“项目级答案”。
- 明确当前有限周期已推进到 R0.6 CDS-managed runtime capacity reconciler；R0V live evidence 已完成并证明 capacity 缺失，R0.5 contract/API 已完成。
- 明确总共 8 步，当前在第 4 步 R0。
- 明确当前不需要把 `CDS_AGENT_SIDECAR_IMAGE` + remote host SSH 信息当成产品主路径输入；它们只保留为 operator/debug fallback。
- 明确优先看三个文档：当前进度面板、managed-runtime fact-source 设计、执行账本。

证据：

- `doc/status.cds-agent-current-progress.md` 的 `## 1. 项目级答案`。

优化：后续同步进度时先更新项目级答案，再补技术细节。

### 41. R0.2.4 完成后，MAP 默认执行面仍需要从 direct runtime queue 收回

问题：CDS `/agent-sessions` 已经能通过 CDS-managed branch service transport 调 official SDK sidecar，但 MAP 侧 `CdsAgentAdapter` 仍注入 `IInfraAgentRuntimeAdapter` 做预检，`InfraAgentSessionService.SendMessageAsync` 仍默认排 `_runtimeJobs.EnqueueAsync`。这会让 MAP 重新拥有执行队列，结构上继续接近“MAP 直连 runtime”，和“MAP 只连接 CDS、CDS 管 runtime/container/sandbox”的目标不一致。

处理：

- `CdsAgentAdapter` 移除 `IInfraAgentRuntimeAdapter` 构造依赖和 runtime pool 预检，只负责创建 CDS session、启动 session、发送 CDS session message。
- `InfraAgentSessionService.SendMessageAsync` 先调用 CDS `/agent-sessions/{id}/messages`，导入 CDS stream events，再更新本地 session 状态。
- MAP direct runtime queue 改为显式 fallback：只有 `INFRA_AGENT_ENABLE_MAP_DIRECT_RUNTIME_FALLBACK=1|true|yes` 时才 enqueue；默认记录 `cds-session-transport` 事件。
- `RunRuntimeJobAsync` 默认早退，写入 `MAP direct runtime job skipped; CDS session transport owns execution`，避免后台 worker 继续偷跑。
- 新增 `scripts/smoke-cds-agent-map-session-transport.sh`，静态锁定 Toolbox adapter 不注入 direct runtime adapter、session message 先走 CDS、fallback env 必须显式存在。

证据：

- `scripts/smoke-cds-agent-map-session-transport.sh`：pass。
- `dotnet test prd-api/tests/PrdAgent.Api.Tests --filter "CdsAgentRuntimeCompatibilityTests|CdsAgentAdapterTests|InfraAgentSessionsControllerTests" --no-restore`：32/32 pass。
- `CdsAgentRuntimeCompatibilityTests` 现在要求所有 Toolbox adapters 都不能依赖 `IInfraAgentRuntimeAdapter`。

耗时：本地实现和单元验证约 35-45 分钟；文档和审计口径同步约 10 分钟。

优化：后续默认调试入口应先看 `cds-session-transport` 事件和 CDS session logs。只有 operator 明确打开 fallback env 时，才允许 MAP direct runtime job 参与排障，且不能作为产品验收路径。

### 42. R0V live evidence 完成后，真正 blocker 是 CDS-managed runtime capacity

问题：R0V 远程只读证据跑完后，旧脚本仍把 `REMOTE_HOST_AVAILABLE` / `SHARED_POOL_RUNNING` 输出成下一步，容易再次滑回“让用户补 SSH/env/image”的 external host 路线。

处理：

- 运行 `CDS_HOST=https://cds.miduo.org CDS_AGENT_RUNTIME_POOL_RUN_GOAL_AUDIT=0 CDS_AGENT_RUNTIME_POOL_EVIDENCE_DIR=/tmp/cds-agent-runtime-pool-evidence-latest bash scripts/collect-cds-agent-runtime-pool-evidence.sh`。
- 运行 `CDS_HOST=https://cds.miduo.org CDS_AGENT_REMOTE_HOST_POOL_RUN_DIR=/tmp/cds-agent-remote-host-pool-current-readonly-live bash scripts/run-cds-agent-remote-host-pool-with-evidence.sh`。
- 将 evidence 脚本的 `nextAction` 改为：CDS-managed runtime capacity 缺失；不要要求产品用户提供 remote host variables；remote host 只允许 explicit operator fallback。
- progress board 顶层从 `R0 remote host verdict` 改成 `R0 managed runtime capacity`，并把 remote host 行标为 `Operator fallback`。
- goal audit 的下一周期先从 `r0-managed-runtime-postcheck` 改成 capacity gate，随后在 R0.5 contract/API 完成后推进到 `r0-cds-managed-runtime-reconciler`；R0.6 完成后再推进到 `r0-cds-managed-runtime-live-apply`。

证据：

- `/tmp/cds-agent-runtime-pool-evidence-latest/summary.json`：branch isolation `dry-run-clean`；shared runtime running `0`；enabled remote host `0`；total `17s`。
- `/tmp/cds-agent-remote-host-pool-current-readonly-live/summary.json`：`nextAction` 已明确 operator fallback，不能作为产品用户主路径。

耗时：远程只读 evidence 约 17s；remote-host fallback wrapper 只读约 16s；脚本和文档校准约 10 分钟。

优化：后续所有进度展示先说 `CDS_MANAGED_RUNTIME_CAPACITY`，再把 `REMOTE_HOST_AVAILABLE` / `SHARED_POOL_RUNNING` 放进 legacy fallback evidence，避免再次绕回 external host/env-driven recovery。

### 43. runtime-status 页面事实源也必须进入 R0.5，而不是停在 R0.4/R0V

问题：脚本和文档已经进入 R0.5，但后端 `/api/infra-agent-sessions/runtime-status` 的 execution panel 仍把 R0 下一步估算成 R0.4/R0V。页面会消费这个后端事实源，因此只改文档会继续让用户看不懂进度。

处理：

- `InfraAgentSessionsController` 的 R0 blocking message 加入 `CDS_MANAGED_RUNTIME_CAPACITY=missing`。
- execution task board 增加 `R0V done_blocked`、`R0.5 CDS-managed runtime capacity contract done_minimal` 和 `R0.6 CDS-managed runtime capacity reconciler active`。
- R0 next command 改为 `scripts/smoke-cds-agent-managed-runtime-capacity.sh`。
- 新增 `scripts/smoke-cds-agent-managed-runtime-capacity.sh`，同时检查 progress、goal audit、runtime-status controller 源码和 fallback wrapper。
- `InfraAgentSessionsControllerTests` 更新为检查 R0.5、capacity smoke 和 task board 新状态。

证据：

- `scripts/smoke-cds-agent-managed-runtime-capacity.sh`：pass。
- `dotnet test prd-api/tests/PrdAgent.Api.Tests --filter InfraAgentSessionsControllerTests --no-restore`：覆盖 runtime-status execution panel 的 R0.5 状态。

耗时：实现和测试约 20 分钟；主要耗时在把页面事实源、脚本事实源、文档事实源对齐，避免再发生“文档说 R0V、页面说 R0.4”的偏差。

### 44. CDS 侧必须暴露 runtime capacity contract，而不是只让 MAP 推断

问题：MAP progress/audit/runtime-status 已能表达 `CDS_MANAGED_RUNTIME_CAPACITY`，但如果 CDS 只暴露 `/instances`，MAP 仍需要从 `REMOTE_HOST_AVAILABLE`、`SHARED_POOL_RUNNING`、branch service 数量里推断产品 capacity。这会让事实源继续分裂。

处理：

- `cds/src/routes/remote-hosts.ts` 新增 `GET /api/projects/:id/runtime-capacity`。
- `/api/projects/:id/instances` 同步返回 `capacity` 对象。
- capacity contract 明确：
  - `requirement=CDS_MANAGED_RUNTIME_CAPACITY`
  - `status=available|missing`
  - `productPath.runningOfficialSdkRuntimeCount`
  - `legacyFallback.runningDeploymentCount/enabledRemoteHostCount/runningFallbackInstanceCount`
  - `legacyFallback.scope=operator-debug-only`
- branch-service official SDK runtime 标记为 `capacityRole=product-runtime`、`runtimeOwnedBy=cds-managed-runtime`、`runtimeAdapter=claude-agent-sdk`、`loopOwner=claude-agent-sdk`。
- remote host deployment 标记为 `capacityRole=operator-fallback`，不作为产品 capacity。

证据：

- `npm --prefix cds test -- --run tests/routes/remote-hosts-instances.test.ts`：5/5 pass。
- `npm --prefix cds run build`：pass。
- `scripts/smoke-cds-agent-managed-runtime-capacity.sh`：pass，并静态检查 CDS capacity endpoint 与 contract。

耗时：实现和测试约 25 分钟。

下一步：R0.6 不再是“定义事实源”，而是实现 CDS-managed runtime capacity reconciler，让 CDS 能自己创建/启动/恢复 official SDK runtime capacity；这一步仍不能要求普通用户补 SSH/env/image。

## 最耗时项

| 项 | 耗时 | 是否可本地化 | 后续优化 |
| --- | --- | --- | --- |
| branch isolation cleanup wrapper | 40s | 部分可本地化 | wrapper 已有 pre/post evidence；直接清理后追加 direct branch/project query，避免再猜 |
| runbook publish verification | 约 35s/次 | 部分可本地化 | 本地 `tsc`/controller tests 先跑；远程 bundle 验证只在 UI 发布后跑 |
| runtime pool evidence | 11-14s | 不可完全本地化 | 它查远程 CDS state，保留为 R0 权威证据，不用 one-cycle 替代 |
| controller tests | 18 tests，<1s 测试执行；构建有 warnings | 可本地化 | 只跑 `InfraAgentSessionsControllerTests` 覆盖 execution panel 内容 |
| current progress board | <1s | 可本地化 | 固定入口展示任务纵览、当前 gate、blocker、下一步 ETA |
| runtime-status task board | 后端测试 15s，前端 tsc 20s | 可本地化 | 页面事实源输出 taskBoard/nextStepEta/timeSinkAdvice，减少聊天解释和重复部署 |
| N6 current smoke | 3s 沙箱外；沙箱内会因 VSTest socket 权限失败 | 可本地化但需要 dotnet/VSTest 权限 | smoke 写 summary 后，进度面板直接读最新 N6 证据 |
| R0 local apply readiness | <1s | 完全可本地化 | 先确认 env、dry-run summary、image、registry manifest 和 remote pull 是否足够 apply/deploy，再决定是否触发远程写动作 |
| R0 operator handoff bundle | <2s | 完全可本地化 | 单文件交接状态、缺失输入、ETA、安全命令和禁止事项 |
| goal audit with readiness | 15s；N6 沙箱步骤超时但 summary 校准为 pass | 部分可本地化 | audit 消费 N6 summary 和 R0 readiness，当前唯一失败收敛到 R0 runtime pool 未恢复 |
| lifecycle overview | <1s | 完全可本地化 | 固定回答完整生命周期进度、剩余距离和关键路径 |
| sidecar image readiness | <1s | 完全可本地化 | 把本地 Dockerfile、候选 build/push 命令、远程 pull-only 要求分开，避免远程 deploy 才失败 |
| sidecar image preflight | <1s | 完全可本地化 | 先证明 build context，后续只追 registry image 和 remote host pull 权限 |
| sidecar image build smoke | 约 65s 当前通过 | 完全可本地化 | Docker daemon、base image pull、Python dependency install 都在本地 build gate 暴露，不进入远程 deploy |
| sidecar image publish dry-run | <1s | 完全可本地化 | registry target/tag/push 显式化；默认不 push、不 deploy |
| sidecar registry manifest verify | <1s dry-run；真实 GHCR 查询通常 1-5s | 部分本地化 | 先确认 image tag 在 registry 可见，再进入 remote host SSH/docker pull |
| remote sidecar pull dry-run | <1s | 部分本地化 | 先校验 SSH/image 输入；显式开启后才访问目标 host 执行 docker pull |
| dynamic exact next step | <1s | 完全可本地化 | 按 gate 顺序给下一条命令，减少人工在多个 handoff 之间判断 |
| R0 status refresh bundle | <3s | 完全可本地化 | 一个命令刷新所有本地只读 R0 证据，减少旧 `/tmp` 文件影响判断 |
| sidecar workflow status check | <1s dry-run；显式 API 检查约 1s | 部分本地化 | workflow 索引/运行状态进入结构化报告，避免人工打开 GitHub 页面判断 |

## 当前下一步

现在不应该继续普通 preview redeploy，也不应该把 remote host 参数作为普通产品路径。R0.6 已完成最小 reconciler/API，本轮下一步是 R0.7：把 reconciler 接到真实 CDS container start/recover 与 live evidence。

查看当前任务纵览：

```bash
scripts/print-cds-agent-current-progress.sh
```

R0.7 真正恢复 R0 需要：

```text
CDS-managed shared-service official SDK runtime running > 0
CDS /runtime-capacity status=available
MAP -> CDS /agent-sessions message path remains the only product path
remote host / SSH / image / env remain operator/debug fallback evidence only
```

执行入口：

```bash
npm --prefix cds test -- --run tests/routes/remote-hosts-instances.test.ts
scripts/smoke-cds-agent-managed-runtime-capacity.sh
scripts/check-cds-agent-progress-consistency.sh
```

完成后必须通过：

```bash
scripts/print-cds-agent-current-progress.sh
scripts/audit-cds-agent-goal.sh
```

## 2026-05-18 23:25 CST - R0.6 reconciler 最小闭环

问题：R0.5 只有 `/runtime-capacity` fact source，面板长期停在 R0.6，用户看不到实际推进。

处理：

- CDS 新增 `POST /api/projects/:id/runtime-capacity/reconcile`。
- dry-run 返回 `ensure-build-profile`、`ensure-branch-service`、`verify-product-capacity` 三步计划。
- apply 在 shared-service project 内创建/修复 `claude-agent-sdk-runtime` BuildProfile 与 `cds-managed-runtime` branch service。
- route 测试证明 apply 后 `/runtime-capacity` 变为 available，并且 `/agent-sessions/{id}/messages` 继续走 CDS branch-service official SDK transport。
- progress/status/audit 从 R0.6 推进到 R0.7，避免继续显示“一个任务原地没动”。

耗时：约 35 分钟。

验证：

- `npm --prefix cds test -- --run tests/routes/remote-hosts-instances.test.ts`：6/6 pass。
- `npm --prefix cds run build`：pass。

剩余：R0.7 需要把 reconciler 接到真实 CDS container start/recover 与 live evidence，使 shared-service official SDK runtime running > 0。

## 承诺的记录方式

后续继续推进时，每轮必须更新：

- `doc/status.cds-agent-current-progress.md`：当前状态、最新 evidence、下一步。
- `doc/report.cds-agent-execution-ledger-2026-05-18.md`：问题、处理、耗时、优化。
- 对任何远程写动作：保留 evidence wrapper summary 和 post-check。
