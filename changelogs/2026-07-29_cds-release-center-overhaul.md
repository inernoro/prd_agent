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
| feat | cds | 加环境时可以就地添加服务器：向导第一步内嵌新建表单，不再把用户支到 CDS 系统设置再走回来 |
| feat | cds | 服务器支持三种接法：CDS 生成密钥对（私钥留在服务端、只给公钥去授权）、粘贴私钥、用户名密码 |
| feat | cds | 远程主机新增密码认证，发布与 sidecar 两条 SSH 链路同步支持，此前只认私钥 |
| feat | cds | 新建服务器支持粘贴连接串自动填表（认 ssh:// 、ssh 命令行 -p 端口、user@host:port、IPv6），并按主机名建议显示名 |
| feat | cds | 新建服务器后就地测试连接，生成密钥对时同时给出公钥与一行授权命令 |
| fix | cds | 记忆的项目 id 在当前 CDS 实例不存在时自动落到第一个真实项目，不再拿幽灵 id 去打接口换回一串 404 |
| fix | cds | 发布方式探测失败不再把裸 HTTP 错误糊在页面顶部，改为说明「需要手动填写」 |
| fix | cds | 录入私钥时不再 trim 尾部换行，避免 PEM 缺失换行导致解析失败 |
| test | cds | 新增连接串解析 18 条、三种认证方式 10 条、就地新建服务器接线守卫 10 条 |
| fix | cds | 修复 ssh2 静态具名导入导致 CDS 启动即崩（tsc 与 vitest 均不报错，真 ESM 运行时抛 Named export not found），改走默认导入 |
| test | cds | 新增 CommonJS 依赖导入方式守卫，禁止对 ssh2 一类 CJS 包使用静态具名导入 |
| fix | cds | 就地新建的服务器改为直接并入列表，不再重拉按引用过滤的目标接口（新建的主机尚未被任何发布目标引用，重拉会查无此人，界面继续说「还没有服务器」，再加一次撞后端全局重名 409） |
| fix | cds | 发布中心空状态的「先添加服务器」不再跳去 CDS 系统设置，改为就地打开向导第一步 |
| fix | cds | 新建服务器重名冲突给出可照做的中文提示，替代原始英文 409 与 requestId |
| fix | cds | 去掉 InlineHostCreator 上随 hosts 数量变化的 key：新建主机进列表会让组件重挂，刚生成的公钥当场消失，而那是用户唯一一次拿到它的机会 |
| fix | cds | 站内信 href 只收同源相对路径：项目级 Key 可写入通知，而收件箱把 href 直接渲染成链接，javascript: 之类会在全局运维会话里执行 |
| fix | cds | 发布告警深链的 target/run 参数真正生效：点「查看发布记录」直接选中出事的目标并打开那次发布的日志，不再落到默认目标 |
| fix | cds | 镜像预热单张超时被剩余总预算夹住，避免 4 张各 180s 把 420s 的总闸撑到 540s |
| ci | cds | CI 跑 cds 测试前安装 cds/web 依赖：渲染冒烟 import 的 react 装在 web 侧，此前作业只装 cds/ 导致该测试文件整体加载失败 |
| security | cds | 密码认证主机的公开标识改为与密钥材料无关的随机串：原先是明文口令的截断 sha256，且经公开接口返回，可离线撞库 |
| security | cds | 通知合并键按调用方作用域加前缀：项目级 Key 原先可用自定义 id 覆盖其他项目或内部事件生成的告警 |
| security | cds | SSH 失败摘要脱敏补齐 Authorization 头 / JSON 口令 / URL userinfo 三类格式，发布日志改为复用同一个脱敏器 |
| fix | cds | port 预览模式不再套用 multi 子域公式伪造地址，发布向导改为现取分配端口 |
| fix | cds | 晋升候选加祖先判定：分叉版本双向 rev-list 皆为正，原先会被标成可晋升 |
| fix | cds | 定时发布待人工确认时把过检版本钉进通知深链，审批发出的仍是通过检查的那一版 |
| fix | cds | 待人工确认的规则预检失败记为失败而非跳过，否则失败计数被清零、永远够不到自动停用阈值 |
| fix | cds | 切换到密码认证时清空私钥口令，避免公开视图谎报 hasPassphrase 及日后换回私钥时解密失败 |
| fix | cds | 编辑自动发布规则只替换本目标的 release 动作，不再整体覆盖导致兄弟动作被静默删除 |
| fix | cds | 新建环境时「设为主目标」按该环境是否已有主目标决定默认勾选，避免保存必被后端拒 |
| fix | cds | 通知外发到 MAP 的动作链接绝对化为 CDS 自身入口，缺少 origin 时不下发动作 |
| fix | cds | 自动发布试跑失败给出具体未通过项，替代原先恒定显示的安全横幅 |
| fix | cds | 发布路由改用 server.ts 那个 ReleaseService 实例：此前路由与定时调度器各持一个，settling 期的在途发布互相看不见，双重并发闸同时放行 |
| fix | cds | commit 元信息改在服务层 onRunStarted 记录：此前只在 HTTP 路由里记，定时发布的成功记录从不进台账，DORA 只统计人手发布 |
| fix | cds | 分支来源首次定时发布不再必然失败：历史无发布记录时按 multi 模式现推预览地址，port/simple 如实留空交预检判定 |
| fix | cds | 晋升候选带可执行判定：来源版本已不是分支 tip 时按钮置灰并说明原因，不再让用户点了才吃版本钳制拒绝 |
| fix | cds | 忽略通知按 id + 作用域联合查找：此前先取第一条同 id 再校验作用域，跨项目同名 id 会让项目方关不掉自己的通知 |
| fix | cds | 强制更新按钮补上版本切换声明（transitionIntent / expectedFromSha / transitionReason）：此前只发 branch+force，非快进切换必然被后端回「必须显式声明 release 或 rollback」，而用户刚点的按钮就叫强制更新 |
| fix | cds | 强制更新对话框可选「发布新版本 / 回滚旧版本」并填原因（预填可编辑），原因不合法时禁用确认；expectedFromSha 取自 self-status 当前 sha |
| fix | cds | 非快进切换的拒绝文案改为指明去哪里声明、API 缺哪三个字段 |
| fix | cds | 强制更新改为永不拒绝（resolveForceSyncTransition）：它是用户控制 CDS 的最后手段，能被策略拒绝的强制不叫强制；普通更新仍保留严格闸门 |
| fix | cds | 自更新重启不再被记账动作取消：记账各自 try/catch，spawn 成功后先排上 process.exit 再做其余记账，避免写日志失败导致「产物已换、进程没重启」 |
| fix | cds | 「更新成功但进程没重启」从小字 chip 升级为醒目横幅 + 一键重启，说明当前是新前端配旧后端 |
