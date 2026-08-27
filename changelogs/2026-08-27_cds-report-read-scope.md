| fix | cds | 读验收报告改用单独的 `report:read` 授权范围，不再并进 `instance:read`：并进去等于让一批早就签发出去的长期凭据在主人没再看过授权页的情况下多读到所有项目的报告正文，是替用户点了头。存量凭据在重新授权前读报告会被拒，这是有意的 |
| fix | cds | 默认授权范围收敛成一份 SSOT：授权页展示的、授权跳转签发的、token 端点回报的三处原先各抄了一份数组，往 `DEFAULT_SCOPES` 加一项对真正的授权流程一次都不生效（显式值盖过默认值），而且用户点头同意的清单和实际签发的清单会各自漂移 |
| fix | cds | token 端点回报的范围改成读该条连接实际拿到的值，不再回报「默认会发什么」——issue 时可传自定义范围，那种情况下回报默认值就是在对 MAP 说谎 |
| test | cds | 新增 4 条守卫：报告不许挂回 Bridge 那条范围、表里要求的范围默认授权发得出来、授权跳转与授权页都走同一个常量；逐条改回事故写法确认变红再恢复 |
| docs | cds | 记两条排查中撞见的活账：项目发布门禁可被「用全局 key 签一把项目 key」两步绕过；prd-agent 的 redis/mongo 连接串不带凭据导致每个新建分支容器启动即崩，根子是 profile 引用了 CDS 里根本不存在的变量名 |
| fix | chore | .gitignore 的 node_modules 补一条不带尾斜杠的：带斜杠只匹配目录，匹配不到同名软链，于是临时 worktree 里为跑测试建的依赖软链被 git add -A 收了进去、四条 CI 全红 |
| test | prd-api | 网关限流用例不再骑在分钟边界上：窗口按墙钟分钟取键，三条用例连发请求并断言「只有一条窗口 + 计数精确」，跨过边界就插出第二条、计数从头算，SingleAsync() 假红（CI 上真中过）。抽出纯函数判据配 6 条不依赖 Mongo 的单测，三条用例统一先等到新窗口 |
| fix | cds | CDS 往消费方容器发的只有地址没有凭据，数据服务一旦开认证，每个新建容器启动即崩（NOAUTH）——而 CDS 自己存着那对账号口令。getCdsEnvVars 补出 CDS_<服务>_USER / _PASSWORD / _URL：按镜像约定的 env 键名认（不按服务 id，多实例改名都不受影响），URL 的 userinfo 段做百分号编码，没口令的服务一个键都不发 |
| fix | ops | cds-compose.yml 的 Mongo/Redis 连接串改成带凭据：Mongo 用 `${CDS_MONGODB_URL}`（百分号编码好的完整 URI），Redis 因为 StackExchange.Redis 不吃 `redis://` 而按它的格式拼 `host:port,user=,password=`。此前只给地址，mongo 开 `--auth`、redis 开 `--aclfile` 之后 17 条分支里 7 条起不来 |
| fix | cds | 派生凭据前先解析 env 模板：`InfraService.env` 存的是未展开的 `${...}`（线上真有四个项目的 `MYSQL_USER` / `MINIO_ROOT_USER` 就是字面占位符），容器启动、数据工作台、数据操作三处都先解析再用，只有新加的派生这处直接读了生值——会把 `${CDS_MYSQL_PASSWORD}` 当口令发给消费方，`_URL` 里还编码成 `%24%7B...%7D`，拿到手认证失败比什么都不发更难查。调用方改为先解析，派生函数再加一道「还带 `${...}` 就整类不发」的闸 |
| test | cds | 凭据表与 infra-catalog 预设加一条防漂守卫：遍历整个 catalog、**真跑一遍每个预设的 `build()`**，凡是产出了口令的预设都要能派生出成对的 `CDS_<服务>_USER` + `_PASSWORD`。判据方向是从**预设产出反查**（扫预设里的 `*_USER` / `*_USERNAME` 键），不是从表里的键名出发——后者在键名漂掉时条件正好不成立，漂了也照样绿，第一版就这么写的、用 mysql 试破没报出来。顺带把 memcached 的 `userKey` 对齐预设的 `MEMCACHED_USER` |
| fix | cds | 凭据派生覆盖认证门禁认可的**每一种**形态：此前只认 `MYSQL_USER`/`MYSQL_PASSWORD`，而门禁接受「只有 `MYSQL_ROOT_PASSWORD`」（线上真有一台这样的库），于是门禁放行、服务真开着认证、消费方一个键都收不到。表结构改成「一类服务多个账号候选」，用户名与口令在同一候选里成对取，顺序即最小权限。同批补齐 mongo/minio 别名、mariadb 键名，以及门禁认而派生表整个没有的 sqlserver / clickhouse / elasticsearch；另加「与认证门禁对齐」守卫，缺哪个键直接点名 |
| fix | cds | 账号候选的完整性必须在**选中之前**判：只看口令会让 mysql 在「有 `MYSQL_PASSWORD` 没有 `MYSQL_USER`」时选中残缺候选、发出没有用户名的 `mysql://:口令@主机`，而完整的 root 候选永远轮不到；用户名是占位符时那个 `continue` 还跳掉了整个服务类。改为先判完整性再选，作废的候选继续试下一个。「本来就没有用户名」只有 redis 一类，单独标注 |
| fix | cds | redis 的凭据必须由启动参数证明服务端真在校验：env 里有 `REDIS_PASSWORD` 却既没 `--requirepass` 也没 `--aclfile` 的库真实存在，带口令连过去会被「ERR Client sent AUTH, but no password is set」顶回来——发凭据反而把本来能裸连的消费方弄坏。与认证门禁同一口径，证不出来就一个键都不发 |
