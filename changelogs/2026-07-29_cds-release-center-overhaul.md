| feat | cds | 发布中心改版 v2：环境成为骨架（顶部 main 版本流水轴 + 左栏环境列表），1669 行单文件拆成 pages/release-center/ 下的一组组件 |
| feat | cds | 发布中心概览页三格摘要（线上版本含提交说明 / 健康含 24 小时可用率 / 近 30 天发布统计）+ 带提交说明的发布时间线 |
| feat | cds | 发布中心接口下发提交说明台账，发布时间线能显示这次发的是哪个改动而不只是一串 sha |
| feat | cds | 发布中心接口下发主干提交流水轴与各环境落点（落后/领先提交数），只读本地 ref 不触发 fetch |
| feat | cds | 发布中心接口下发按环境分组的目标列表与跨环境提升候选，提升的领先提交数由后端直算 |
| feat | cds | 发布中心每行补齐本目标的近 30 天 DORA 与近 24 小时可用率，无数据一律缺省不编造 |
| feat | cds | 发布失败判据从日志里提取并摆到首屏（门禁逐项检查表 + 人话解释 + 噪音单列），原始日志退到折叠区 |
| feat | cds | 跨环境提升：一个按钮把某环境正在跑的那一版原样发到另一个环境，走 expectedCommitSha 钳制，不引入「发布候选」实体 |
| feat | cds | 「立即发布」改为就地抽屉（选分支 → 发布前检查 → 开始发布 → 实时日志），不再跳去分支列表 |
| feat | cds | 发布中心新增「自动发布」页签：基于 scheduled-job 的定时发布规则增删改查、启停、立即试跑与运行记录 |
| feat | cds | 添加环境向导支持选择环境类型（生产 / 预发 / 其他），此前 environment 被写死成 production |
| feat | cds | 定时任务新增「发布」动作类型：到点直接调 ReleaseService 发版，支持发布指定分支或把某环境正在跑的版本原样提升到另一环境 |
| feat | cds | 定时发布支持「需要人工确认」：到点只跑发布前检查并生成一条待确认站内信，绝不自动发布 |
| feat | cds | 定时发布连续失败 2 次自动停用规则并发站内信告警，任务列表直接展示停用原因 |
| feat | cds | 定时发布支持失败自动回滚、目标版本未变时跳过、目标忙时按并发策略跳过（判据复用发布侧的在途/回收锁闸门） |
| feat | cds | 发布接口新增 expectedCommitSha 版本钳制：请求版本与分支当前版本不一致时 fail-closed 拒绝，杜绝「原样提升」发出未验证版本 |
| feat | cds | 新增服务端站内信账本：订阅 cds-events-bus 记录发布失败/自动回滚/现场漂移/健康掉线/自更新失败/预览探测失败/基础设施熔断七类告警，落盘 .cds/notice-ledger.json，10 分钟内同目标同类型合并计次，可选外发到 MAP 站内通知（未配置凭据时如实标记「未外发」） |
| feat | cds | 存活监控判 down/恢复上事件总线（uptime.target.down / uptime.target.recovered），生产健康掉线不再只躺在故障时间线里 |
| fix | cds | 回滚发起时补记 commit 台账，回滚记录不再永远缺提交说明 |
| fix | cds | 发布中心配置变更历史按后端真实形状渲染 before → after 明细，此前接的是不存在的 summary/fields 字段 |
| fix | cds | 定时任务的「试运行」对发布动作只执行发布前检查，不会真往生产发一次版 |
| fix | cds | 发布失败摘要纳入 stdout 并保留尾部，门禁判据不再被丢弃 |
| fix | cds | sidecar 部署 SSH 失败改用同一摘要构造源，凭据统一脱敏 |
| refactor | cds | 发布目标 environment 的归一与分组收敛为唯一判定源，杜绝前后端各判一遍 |
| refactor | cds | 环境分组的中文标签改走 releaseEnvironmentLabel 取值，此前该导出无人调用、分组直接读原始映射表，等于同一判定留了两条路径 |
| refactor | cds | 预览地址推导抽到 web/src/lib/previewUrl.ts 作为唯一判定源，BranchListPage 与发布中心共用 |
| refactor | cds | 右上角站内信铃铛（SiteNoticeInbox）数据源从 localStorage 换成服务端账本，保留 window 'cds:notice:upsert' 兼容层与调用方；死链项目通知的清理迁到服务端 |
| refactor | cds | 删除无生产调用方的 gitCommitTimeReader 包装（默认 reader 一直是 gitCommitMetaReader），对应真实 git 用例改为直接打在被接上的那个 reader 上 |
| chore | cds | 删除未被引用的 releaseModeLabel，发布方式标签统一由 releaseModeDefinitions 提供，避免同一组文案两处维护 |
| chore | cds | 补齐 /api/scheduled-jobs 与 /api/notices 系列路由的 Activity Monitor 中文 label |
| test | cds | 新增 releaseDiagnosis / releaseRail / releaseEnvironments / previewUrl 纯函数用例、发布中心接线守卫与渲染冒烟共 84 条 |
| ops | - | fast.sh 镜像预热超时默认提到 180s，新增总预算闸并收敛超时噪音 |
