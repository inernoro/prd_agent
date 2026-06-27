| fix | cds | 根治 override.containerPort=null 覆盖 baseline 端口致 `docker: invalid containerPort: null`：resolveProfileWithMode/applyProfileOverride 两处合并改用 `!= null`，null 不再覆盖 baseline 真实端口（prd-agent-main 等 api/admin 部署失败修复） |
| fix | cds | 新增部署卡死状态 reconciler：时间戳证据 + 保守硬超时终结卡死非终结态（branch/service starting/building/stopping/restarting），极速版镜像落后 HEAD 含运行时改动时只告警不自动部署 |
| fix | cds | 根治 branch override 的 null 结构哨兵覆盖 baseline（sanitizeProfileOverride 在 merge/writer 双端剥 null），整类 `invalid containerPort: null` / 空镜像 `sh:latest` 部署故障一次性消失 |
| fix | cds | docker run 前增加空镜像断言：解析出的 dockerImage 为空或含未解析模板时明确报错并指出是 CDS profile 解析问题，不再误判为 Docker 镜像问题 |
| fix | cds | 看门狗双路径各自 try/catch：webhook 派发收敛与卡死收敛崩溃各记各的 action/source，不再张冠李戴（Bugbot Low #940） |
| fix | cds | 服务级卡死收敛改了 service.status 后重算分支聚合 status/errorMessage，避免发出「branch 仍 running、某 service 已 error」的脏更新（Codex P2 #940） |
| fix | cds | 卡死看门狗有在途操作的分支整条跳过，合法长任务（>45min 编译/迁移）不被硬超时误杀（Bugbot Medium #940） |
| fix | cds | 卡死看门狗：有服务的分支聚合状态一律以服务真实状态为准，治「服务全 stopped 但分支仍 running」（Bugbot Medium #940） |
| fix | cds | 源码部署 pull 后用 parsePulledSha 取裸 SHA（优先 after）刷新 githubCommitSha + 构建历史版本列，治 head 带标题不匹配裸 SHA 正则导致版本列停在旧 SHA（Codex P2 #940） |
| fix | cds | 源码部署刷新 githubCommitSha 用完整 40 位 SHA（pull 新增 afterFull=rev-parse HEAD，parsePulledSha 优先全 SHA），避免截断成短 SHA 影响 GitHub check-run/release/OperationLog.commitSha 等外部集成（Codex P2 #940） |
| fix | cds | 部署历史「部署类型」chip 区分缺失元数据与显式源码模式：旧历史行 deployMode 为 undefined 显示「未记录」而非臆造「源码/默认」（Codex P2 #940） |
| fix | cds | 卡死看门狗聚合重算保留分支级 error（webhook 派发失败/镜像门等非服务来源），不再被服务聚合清成 idle/清空 errorMessage（Bugbot Medium + Codex P2 #940） |
| fix | cds | executor /exec/deploy 起点盖 lastDeployStartedAt，让 executor 本地卡死看门狗硬超时有锚点（集群模式，Codex P2 #940） |
| fix | cds | executor 节点禁用看门狗硬超时（allowHardTimeout=isMaster），只做时间戳证据收敛+告警，避免无租约判活时把合法 >45min 远端构建误判 error（Bugbot High #940） |
| fix | cds | 看门狗分支聚合按当前在册 build profile 过滤服务，僵尸服务（profile 删/改名残留）不再把健康分支翻回 error（Codex P2 #940） |
| fix | cds | executor 代理 source-build 的 pull 回传结构化 head/after/afterFull，master 用 parsePulledSha 取全 SHA 刷新构建历史+branch HEAD，远端路径不再只记短 SHA（Bugbot Low #940） |
| fix | cds | 看门狗：getBuildProfiles 空数组视为不过滤(不把所有服务当僵尸误判 idle)；多服务分支不再用 branch.lastReadyAt 把仍在 starting 的服务过早翻 running；executor 模式不按本地 profile 过滤僵尸服务（Bugbot Medium×2 + Codex P2 #940） |
| fix | cds | 远端执行器部署：master 从 complete 事件复制 executor 回报的真实 deployedMode，express→source 回退不再被构建历史误标 express（Bugbot Medium #940） |
| fix | cds | 单服务部署 deployedMode 缺失/空时退回 resolveEffectiveProfile，不再保留 pull 前配置态（Bugbot Low #940，与主/远端路径一致） |
| feat | cds | CDS 系统设置-维护：自更新「更新日志」面板在有更新任务时默认展开（DisclosurePanel 支持 defaultOpen + 展开/收起标签），不用每次点开看进度 |
| fix | cds | 部署刷新 githubCommitSha 改用 shouldRefreshCommitSha：同 commit 的短 SHA 可升级为完整 40 位（不降级），治已持久化短 SHA 的分支 OperationLog.commitSha 一直短、版本元数据存歧义（Codex P2 #940） |
| fix | cds | 卡死看门狗以「存活服务」（按在册 profile 过滤后）判定是否走分支级收敛：分支只剩僵尸服务时退回硬超时成 error，不被聚合藏成 idle（Codex P2 #940） |
| polish | cds | 自更新历史耗时条：任何未计量时间都补「其他」铺满进度条（不留暗色黑轨道），「其他」颜色从 /30 提到 /55 中性灰（暗色下不再像黑块），图例仍只在 >1.5s 列出（用户反馈「后面黑色的是什么」） |
| docs | cds | 新增 debt.cds.executor-watchdog：记录 executor 卡死看门狗硬超时的 #228/#233 评审冲突与根治方案（cluster-only） |
| fix | cds | 卡死看门狗服务级收敛跳过僵尸服务（已删/改名 profile 残留条目），不再被单服务证据路径误翻 running/stopped 在 UI/快照留误导状态（Bugbot Medium #940） |
