| feat | cds | 周期备份补上 postgres：新增 pg_dump 导出、psql 恢复与数表取证，手工下载不再掉进只有空壳的 tar 兜底 |
| refactor | cds | 收敛「这是什么库」的三份判据（backupKindOf / 下载端点 detectKind / 暴露面 detectInfraKind）到一份，并支持用服务 id、容器名兜底识别 |
| fix | cds | 备份执行层改成穷尽分支：新增备份类型忘了接线时由编译器报错，不再静默掉进 redis 的 BGSAVE 分支 |
| feat | cds | 备份结论新增范围提示：postgres 只导出目标库时，同实例其它未纳入的库当场报进一轮结论 |
| security | cds | memcached / kafka / nats 三个预设补认证（-Y 认证文件 / SASL_PLAIN / --user --pass），并给 catalog 加 entrypoint 字段让口令只在容器内展开 |
| security | cds | 认证门禁不再对 memcached / kafka / nats 静默放行，判据与暴露面自检收敛成同一份 |
| fix | cds | 暴露面自检对这三类不再硬编码「无认证」，改为读真实配置，避免配好认证的库长期误报 critical |
| chore | cds | cdscli 的 nats 模板与 demo-events-nats / demo-stream-kafka 两个示例工程同步改成带认证 |
| docs | cds | debt.cds.md 新增 E48（postgres 备份缺口）、E49（三个预设无认证 + 门禁缺口）、E50（docker run 的 env 值不转义双引号），E16 结项 |
| test | cds | 补 postgres 备份的真容器用例：起库塞数据 → 导出 → gzip -t → 清库 → 灌回 → 比对行数，外加守 ON_ERROR_STOP 的「坏 dump 必须失败」一条 |
| fix | cds | nats 口令不再进容器 argv：改为容器内写 chmod 600 的 authorization 配置再 -c 加载（真容器实测抓到，sh -c 只挡住宿主那一侧） |
| fix | cds | kafka 监听器改名 CLIENT：名字带下划线时镜像的 env→属性转换表达不出 JAAS 属性名，容器 `!1: unbound variable` 起不来 |
| fix | cds | kafka 认证判据改为顺着 security.protocol.map 解析生效协议，不再看广播地址的字面前缀（改个名就能骗过） |
| fix | cds | 真容器测试补上镜像拉不到时的跳过原因，不再静默 skip |
| feat | cds | 周期备份补上 rabbitmq：definitions 导出 / 灌回 / 队列数取证，与 mysql、postgres 同一套退出码写法；下载与恢复端点不再掉进只有空壳的 tar 兜底 |
| fix | cds | 备不了的类型按桶分类，不再共用一句「暂不支持」：只有真的有东西可丢才算覆盖缺口，memcached 与未开 JetStream 的 nats 不再让备份健康位从上线那天起就永远红着 |
| feat | cds | 算缺口的那些当场说清缺的是哪一套手段：MinIO 要桶到桶复制、Kafka 要 MirrorMaker、Elasticsearch 要先注册快照仓库，SQL Server 与 ClickHouse 是有手段还没接 |
| feat | cds | rabbitmq 导出每轮报出「definitions 不含队列里的消息，默认 vhost 当前积压 N 条不会被带走」，数不出来时说数不出来而不是拿 0 顶替 |
| refactor | cds | 下载与恢复端点的「三段脚本 + 扩展名 + 计数单位」从两处三元链收敛成一张表，新增一种类型只加一行 |
| test | cds | 补 25 条覆盖面判据（含 JetStream 判据的反面对照）与 4 条 rabbitmq 真容器用例；三条既有守卫从断言源码字面量改成断言行为，路由改写不再误红 |
| docs | cds | debt.cds.md 新增 E51，记下 definitions 不含消息、import 是合并不是替换、队列数只覆盖默认 vhost 三条已知边界 |
| feat | cds | 认出 nacos：补进服务类型判据（镜像名 + 8848/9848 端口兜底），它此前一直归在「认不出的服务」里，安全面判不了、备份面备不了 |
| feat | cds | 周期备份接上 nacos 配置：逐命名空间导出打包，恢复按命名空间灌回，配置条数取证；下载与恢复端点同步接线 |
| security | cds | 暴露面自检补 nacos 认证判据：判的是 NACOS_AUTH_ENABLE 真的打开了，不是「env 里有没有口令」——口令配了开关没开等于没配 |
| fix | cds | nacos 导入接口失败也会回 HTTP 200，真相在 body 的 code 字段里，恢复脚本改为检查 body 而不只看退出码 |
| security | cds | 鉴权开着且容器里只有 wget 时拒绝备份而不是把口令摆进命令行；用 curl 时口令走 stdin 不进 argv |
| feat | cds | 导出每轮报出「不含服务注册列表与用户/角色/权限」，并带上命名空间个数 |
| test | cds | 补 32 条脚本判据（塞假 curl 用真 sh 跑一遍，覆盖控制流与失败模式，含三次红绿闭环）与 4 条真容器用例 |
| docs | cds | debt.cds.md 新增 E52，记下五条已知边界，以及「没把 nacos 加进认证门禁」这个刻意留下的决定 |
| feat | cds | 新增每日安全体检：公网无认证库、内网无口令库、平台自身存储、存量豁免倒计时、备份新鲜度与覆盖缺口、恢复演练日期，汇成一句结论 + 逐条依据，每天跑一次并记进事件流 |
| security | cds | 体检把认证门禁的盲区补上：CDS 自己的 Mongo 不是项目基础设施，从来不在门禁管辖范围内，没有任何人会被提醒——现在单独查一遍连接串里带没带凭据（只判定，绝不打印连接串本身） |
| fix | cds | 「读不到」不再当成「没问题」：备份结果文件读不到报 critical 而不是静默通过，恢复演练没有记录报「从来没演练过」而不是「没有异常」 |
| test | cds | 补 22 条体检回归，其中一条把 2026-08-23 那次人工审计查出的东西原样喂进去，要求体检自己全说出来 |
| docs | cds | debt.cds.md 的 G2 从「部分补上」推进到「大部分补上」，并写明仍缺的三样：恢复演练无处记录、证书到期、磁盘水位 |
| fix | cds | 系统互联长效 token 补上 report:read：MAP 的验收报告导入器一直在用它调 /api/reports，而 CDS 只在 /api/bridge/* 上认这个 token，一半接好一半没接，同步从来没成功过 |
| security | cds | 长效 token 的放行判据从「路径前缀」收成一张 (scope, 方法, 路径) 表：report:read 只放行两个 GET，同路径上的 POST 新建与 DELETE 删除一律拒绝 |
| refactor | cds | 默认 scope 列表收敛成一份导出常量，授权页、authorize 端点与回包不再各写一遍 |
| fix | cds | 启动时给存量系统互联连接幂等补上 report:read，否则判据加了、线上那条已配好的连接照样 401 |
| test | cds | 补 18 条权限边界判据（每条放行都配一条拒绝 + 无 scope 的反面对照），并做红绿闭环验证判据放宽会变红 |
| fix | cds | 真容器测试排队起：四个重型容器被 vitest 并行同时冷启动，CI 上全部没起来；改成跨进程互斥，一次只起一个 |
| fix | cds | 真容器探活失败时 dump 容器状态与日志，容器已退出立刻抛出不再空等到超时——原来只留一句「expected false to be true」，等于要再花一轮 CI 才能开始诊断 |
| fix | cds | postgres 探活从 pg_isready 改成拿目标库真跑一次查询：initdb 的临时服务器会让 pg_isready 提前返回成功，于是第一条 SQL 打在还没建出来的库上 |
| fix | cds | nacos 命名空间接口失败不再被 sed 的退出码吞掉：拿不到清单就整轮作废，不再只导 public 冒充全量（Codex P1） |
| fix | cds | 每日体检的豁免台账 key 补上项目：多个项目同名服务会互相捡走对方的豁免，导致配好认证的库被报成靠豁免在跑（Codex P2） |
| fix | cds | 用 json 状态后端的部署不再为一个不存在的 CDS Mongo 天天报警（Codex P2） |
| test | cds | 补 9 条判据覆盖上述修复，命名空间失败、豁免 key、json 后端三处各做红绿闭环 |
| fix | cds | 存量连接不再自动补 report:read：那等于在用户没重新看过授权页的情况下扩大一张已签发的长期令牌，改为管理员显式开 CDS_GRANT_REPORT_READ_TO_EXISTING 才补，逐条留痕（Codex P1） |
| fix | cds | memcached 认证判据区分大小写：小写 -s 是 unix socket、大写 -S 才是 SASL，此前一台走 socket、没配任何认证的实例会被判成已认证并通过门禁（Codex P2） |
| fix | cds | nacos 上下文路径去掉首尾斜杠再拼：运维按 servlet 习惯写成 /nacos 时会拼出双斜杠，探活、列命名空间、导出、导入全部打错路径（Codex P2） |
| chore | cds | rabbitmq 与 nacos 的真容器用例改为 CDS_DOCKER_TESTS=1 才跑：两者在 GitHub runner 上都因镜像与环境不兼容起不来（erlang cookie 权限 / 老 JDK 读不了 cgroup v2），与备份脚本无关 |
| test | cds | 补 12 条判据：默认不补 scope、已有 scope 并不覆盖新权限、memcached 大小写、nacos 三种上下文路径写法 |
| docs | cds | debt.cds.md 新增 E53，记下两个真容器用例没跑起来的确切原因与重开方式 |
| fix | cds | 真容器测试的互斥此前从未生效：beforeAll 引用了一个文件里不存在的变量，CI 直接 ReferenceError，kafka 一直在和别的容器抢资源的情况下起；改成整文件取一次槽位 |
| fix | cds | kafka 起不来时改为打印真正的报错行而不是日志尾巴：JVM 把致命原因打在开头，尾巴几十行全是优雅关闭的 INFO，两轮 CI 拿到的都是噪音 |
| fix | cds | 真容器测试补主机名，kafka 预设终于起得来（自我引用的 `kafka:9093` 在裸 docker run 下解析不了）|
| fix | cds | 容器日志诊断给足缓冲，JVM 服务的长日志不再 ENOBUFS 把失败原因整个吞掉 |
| fix | cds | 每日体检的事实映射带上防火墙状态，被宿主防火墙挡住的端口不再被报成「公网裸奔」 |
| fix | cds | 暴露面自检认不出任何数据面容器时也出报告，不再让这类部署永远跳过每日体检 |
| test | cds | 补每日体检事实来源的接线守卫与防火墙分档回归，两处事故写法均验过必红 |
| docs | cds | 债务台账补 E54：nacos 未接入创建门禁的原因与要做需要的三件事 |
| fix | cds | 每日体检认出 CDS_AUTH_BACKEND=mongo：json 状态后端配 mongo 鉴权后端是受支持的组合，此前那台存着账号口令的 Mongo 从体检里整个消失 |
| fix | cds | 备成了但只备到一部分（如 postgres 只导了 POSTGRES_DB）现在算覆盖缺口并拉低整轮健康：原来那行范围提示只挂在 note 上、无人读，那几个库一份备份都没有而灯是绿的 |
| fix | cds | 每日体检结论的 id 与话术带上项目：两个项目各有一个 redis 时不再生成同名结论被去重吃掉 |
| test | cds | 补范围缺口与项目标识回归共 8 条，含两条防判据恒真的反面对照 |
| fix | cds | 跑着但不发布端口的库不再从每日体检里消失：暴露面自检把这批单独留下来（不进暴露面计数），体检的「内网但无口令」那一档才响得起来 |
| fix | cds | 存量豁免倒计时改从配置台账取，不再挂在运行态事实上——纯内网或当前停着的库到期前也要被提醒，而这条倒计时存在的意义就是提前说这句话 |
| fix | cds | nacos 数配置条数：管道退出码被 sed 盖住 + `:-0` 兜底，会把「没查通」报成一个真实的数字；改成先接响应再校验，数不出来就整段失败 |
| test | cds | 补 12 条：内网服务留存与反面对照 5 条、豁免覆盖面 2 条、内网无口令 2 条、nacos 计数跑真脚本 4 条（含 dash 语法校验），接线守卫加 2 条 |
| fix | cds | 备份的「范围说明」与「真的少备了」分成两个标记：上一版把任何说明都算成阻塞缺口，而 rabbitmq / nacos 每轮无条件报一行，导致装了这两者的部署备份健康位永远刷不新、每日体检天天报「读不到上一轮备份」 |
| fix | cds | kafka 示例工程的后端补上 SASL 账号口令两个环境变量：x-cds-env 只是插值输入不会自动进容器，漏了它们后端会退回无认证连接，broker 拒绝，/api/health 永远起不来 |
| test | cds | 补 9 条：note/gapNote 分家 2 条（含反面对照）、rabbitmq 标记按积压分档跑真脚本 4 条（含 dash 语法校验）、两个提取器互不认领 1 条、postgres 改断言行为 2 条 |
| fix | cds | postgres 真容器用例改断言 gap 标记：本机无 docker 时它被跳过，只有 CI 会跑，上一条改动漏了它 |
| test | cds | rabbitmq 的 stderr 走向守卫改为两个标记都查（只查一个的话另一个漏写 >&2 会静默放行、写坏 definitions JSON）；真容器用例按实际积压分档断言，不写死单一标记 |
