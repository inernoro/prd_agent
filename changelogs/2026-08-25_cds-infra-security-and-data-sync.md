| feat | prd-api | 保存资产时回填对象 key（`StoredAsset.Key`），所有建附件的地方存进 `Attachment.StorageKey`，附件地址不再只有绝对 URL 这一份来源 |
| feat | prd-api | 跨实例同步在落库前把附件地址改写成本站地址（`DataSyncAssetUrls`，key 优先、存量按内容寻址形状从 URL 反推） |
| feat | prd-api | Run 进度新增「地址已改写 / 认不出」两个计数，同步接口与 SSE 一起送出 |
| feat | prd-admin | 同步结果页新增「附件地址」卡片：说清改写了几条、还有几条没救，并明说这次只搬记录没搬文件 |
| test | prd-api | 补 DS1 的判据单测与三条接线守卫（改写必须排在落库之前、存储必须回填 key、建附件必须存 key），四条都做过红绿闭环 |
| docs | prd-api | debt.platform.cross-instance-data-sync.md 的 DS1 拆成「地址」与「字节」两半，前者标已修、后者保持 open 并写明未验证 |
| feat | prd-api | 试跑之后可以就地转正成一次真跑（`POST runs/{id}/promote`），不用再让人去源站点第二次同意 |
| feat | prd-api | 试跑成功后票据保留到转正或过期；真跑与失败照旧立刻交还源站作废 |
| feat | prd-admin | 试跑结果页新增「确认无误，开始真的搬」卡片，说明真跑照着刚才那一份执行、不重新取数 |
| test | prd-api | 补转正的三条边界守卫（至多一次的条件更新、不重新问源站、只有成功的试跑能转正）与「试跑不许交还票据」，均做过红绿闭环 |
| docs | prd-api | debt.platform.cross-instance-data-sync.md 新增 DS21，记录两次真实迁移卡死的根因与三条边界 |
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
| feat | prd-api | 新增每 60 分钟运行的 CDS 验收报告同步任务：只在权威部署上跑，只刷新已存在的镜像库不替人建库，单个用户失败不影响其他人 |
| refactor | prd-api | 镜像库 AppKey 收敛成常量，后台任务与导入服务不再各写一遍字面量 |
| test | cds | 补 18 条权限边界判据（每条放行都配一条拒绝 + 无 scope 的反面对照），并做红绿闭环验证判据放宽会变红 |
| fix | cds | 真容器测试排队起：四个重型容器被 vitest 并行同时冷启动，CI 上全部没起来；改成跨进程互斥，一次只起一个 |
| fix | cds | 真容器探活失败时 dump 容器状态与日志，容器已退出立刻抛出不再空等到超时——原来只留一句「expected false to be true」，等于要再花一轮 CI 才能开始诊断 |
| fix | cds | postgres 探活从 pg_isready 改成拿目标库真跑一次查询：initdb 的临时服务器会让 pg_isready 提前返回成功，于是第一条 SQL 打在还没建出来的库上 |
| fix | cds | nacos 命名空间接口失败不再被 sed 的退出码吞掉：拿不到清单就整轮作废，不再只导 public 冒充全量（Codex P1） |
| fix | cds | 每日体检的豁免台账 key 补上项目：多个项目同名服务会互相捡走对方的豁免，导致配好认证的库被报成靠豁免在跑（Codex P2） |
| fix | cds | 用 json 状态后端的部署不再为一个不存在的 CDS Mongo 天天报警（Codex P2） |
| fix | prd-api | 试跑转正的写库改为不可取消：浏览器一关就可能停在「父记录已认领、子记录还是 pending」，那唯一一次转正机会永久作废，接口却回 running（Codex P1，同时是 server-authority 规则要求） |
| fix | prd-admin | 数据同步页主按钮改用 button-primary token：原来 accent 底配写死的 #fff，对比度 3.12:1，浅色主题下字会消失（双皮肤棘轮拦下） |
| test | cds | 补 9 条判据覆盖上述修复，命名空间失败、豁免 key、json 后端三处各做红绿闭环 |
| fix | cds | 存量连接不再自动补 report:read：那等于在用户没重新看过授权页的情况下扩大一张已签发的长期令牌，改为管理员显式开 CDS_GRANT_REPORT_READ_TO_EXISTING 才补，逐条留痕（Codex P1） |
| fix | cds | memcached 认证判据区分大小写：小写 -s 是 unix socket、大写 -S 才是 SASL，此前一台走 socket、没配任何认证的实例会被判成已认证并通过门禁（Codex P2） |
| fix | cds | nacos 上下文路径去掉首尾斜杠再拼：运维按 servlet 习惯写成 /nacos 时会拼出双斜杠，探活、列命名空间、导出、导入全部打错路径（Codex P2） |
| fix | prd-api | 试跑转正的激活步骤加补偿：写库抛异常时回滚父记录认领与票据、删掉子记录并如实报错，否则那唯一一次转正机会永久作废而接口回的是成功（Codex P1 第二轮） |
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
| fix | prd-api | 试跑转正的回滚也失败时不再谎称「已回滚，请再点一次」：那会把人骗去按一个必然撞回「已经转正过」的按钮，改为报 DATA_SYNC_PROMOTE_STUCK 并给出要人工核对的两条记录 id |
| fix | prd-admin | 转正卡片改口说实话：冻结的是范围不是数据，真跑会重新去源站拉一遍，期间源站改过的记录搬过来是改之后的值 |
| fix | cds | 每日体检认出 CDS_AUTH_BACKEND=mongo：json 状态后端配 mongo 鉴权后端是受支持的组合，此前那台存着账号口令的 Mongo 从体检里整个消失 |
