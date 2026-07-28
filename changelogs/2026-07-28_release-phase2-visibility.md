| feat | cds | 发布步骤模型成为一等公民：执行器按 ReleasePlan.steps 汇报「第 N/共 M 步」，前端不再用正则从日志反推步骤，并清除发布中心的本仓脚本名硬编码（CDS 恢复成通用产品） |
| feat | cds | 发布 ETA：新增独立的生产发布耗时台账（不复用 DeployDurationMode 的 release，那是极速版构建模式，语义不同会互相污染），发布进行中显示「预计还需 MM:SS（近 N 次中位）」，样本不足时给诚实文案而非编造数字 |
| feat | cds | 生产存活监控：存活探测新增 URL 型发布目标，走 ReleaseTarget.ssh.healthcheckUrl，状态页出现生产目标的可用率与故障时间线；复用既有 uptime-metrics 纯函数，不另起一套聚合 |
| feat | cds | 发布生命周期事件上 cds-events-bus（started/succeeded/failed/rolled-back），告警通道与存活告警共用一条 |
| feat | cds | 发布 SSE 流补 id: 行，支持 Last-Event-ID 标准续传，与分支部署流对齐 |
| test | cds | 新增阶段二回归约 100 例（步骤模型/ETA/存活目标/事件/SSE 续传），含多个「防再修一边」的唯一判定源守卫 |
| perf | cds | 发布中心健康列改读存活监控快照，打开页面不再按目标数放大成一串对生产的实时探测；监控没接上时诚实报「等待首次探测 / 存活监控未启用」，不偷偷回退到实时探测 |
| fix | cds | 分支侧发布向导也迁到共享步骤判定源：此前它自带第三份「日志 phase 反推 + `scripts[0] \|\| './fast.sh'` 兜底」的拷贝，换个项目就展示三个根本不会执行的脚本；同步显示「第 N/M 步 · 标题」，与发布中心对同一次发布说同一句话 |
| fix | cds | 真 SSH 端到端用例不再因私钥路径失效而静默空跑：默认路径原本是 session 级 scratchpad 绝对路径，换会话即 existsSync 失败、整套变成三个空绿灯，而债务台账正引用它当真实环境证据；改为 `CDS_RELEASE_E2E_SSH_KEY` 可覆盖 + 稳定默认路径，跳过时打印到底是缺 key 还是没 sshd |
| test | cds | 修掉一条断言 bug 本身的契约用例：release-site-ui-contract 逐字要求 BranchListPage 里存在 `执行 ${scriptOne.replace` 与 `releaseScriptPhase(scriptOne)`，等于把硬编码焊死——谁去掉谁 CI 红；改为断言走共享判定源 |
