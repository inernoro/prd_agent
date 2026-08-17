# CDS 基建凭据轮换 Runbook（操作智能体执行本）

> **版本**：v1.0 | **日期**：2026-08-16 | **状态**：可执行

**一句话**：CDS 没有「轮换」这个动作，只有五个必须按顺序手工做完的零件；漏掉任何一个，系统就停在「库是新口令、别处还是旧的」这种不一致态。
**谁该读**：执行本次凭据轮换的操作智能体；事后复核轮换是否真的生效的人。
**读完能做什么**：按类型逐个把库口令换掉，每一步都有一条能证伪的验证命令；也能立刻判断哪些服务现在根本没有口令可换。

---

## 0. 先看清现状（决定你今天能做什么）

| 预设 | 有没有口令 | 本文有没有**核对过的步骤** |
|---|---|---|
| mongodb / mysql / mariadb / postgres | 有 | 有（§2.1，按预设目录真值写的） |
| sqlserver / clickhouse / rabbitmq / elasticsearch / minio | 有 | **没有**——按 §2.0 的通则自己组装并自己验证 |
| redis | 新建的有，**存量的没有** | 新建的按通则；存量的先得有口令，见 §4 |
| memcached / kafka / nats | **没有** | 不适用——它们从创建那天起就是无认证，见 §4 |

第三列是这份文档的诚实边界：**只有前一行的步骤是逐条对着预设目录核过的**。其余预设的改口令命令我没有在真实镜像上核对过，与其写一份看着像样、跑起来报错的命令让人照抄，不如明说没有——照抄一条错命令的代价是把 env 改成新口令而库里还是旧的，那时所有消费方一起断。

判据来源是基建预设目录里的「要生成哪些密钥」字段（见文末实现来源）。没有声明这个字段的预设，建服务时不会生成任何口令，容器起来就是裸的。

---

## 1. 三条铁律（违反其一，轮换就是假的）

1. **口令要在库里改，不是在 env 里改。** `MONGO_INITDB_ROOT_PASSWORD` / `MYSQL_ROOT_PASSWORD` 这类 env **只在空数据卷首次初始化时生效**。对着一个已经有数据的卷改 env 再重建容器，旧口令照样能登、新口令登不上——而 CDS 的连接串已经换成新的了，于是所有消费方 401，看起来像「轮换把系统打坏了」，其实是口令根本没换成。
2. **改完 CDS env 不等于生效。** 分支容器的连接串是**部署时**注入的，改了 env scope 之后，已经在跑的容器还揣着旧口令。必须重部署消费方，或明确接受「下次部署才生效」。
3. **每一步都要用新口令真连一次。** 「命令返回 0」不算数——`docker exec` 到库里用新口令跑一条查询，能查出东西才算换成了。

---

## 2. 逐类型轮换步骤

### 2.0 先看这张表，再动手

每个预设建出来的账号名、口令 env、**以及它注入了哪几个连接串变量**都在这里。第三列是最容易漏的：`mysql` 注入的是**两个**变量，`minio` 是**四个**，只改其中一个，用另一个变量的消费方会带着旧口令重启、连不上。

| 预设 | 账号 | 口令 env | 注入的连接串变量（**都要改**） |
|---|---|---|---|
| mongodb | `app`（认证库 `admin`） | `MONGO_INITDB_ROOT_PASSWORD` | `MONGODB_URL` |
| postgres | `app`（**没有 `postgres` 角色**） | `POSTGRES_PASSWORD` | `DATABASE_URL`、`POSTGRES_URL` |
| mysql / mariadb | `app` + `root` | `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD` | `DATABASE_URL`、`MYSQL_URL` |
| sqlserver | `sa` | `MSSQL_SA_PASSWORD` | `SQLSERVER_URL` |
| clickhouse | `app` | `CLICKHOUSE_PASSWORD` | `CLICKHOUSE_URL` |
| rabbitmq | `app` | `RABBITMQ_DEFAULT_PASS` | `RABBITMQ_URL` |
| elasticsearch | `elastic` | `ELASTIC_PASSWORD` | `ELASTICSEARCH_URL` |
| minio | `app` | `MINIO_ROOT_PASSWORD` | `S3_ENDPOINT`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`、`MINIO_URL` |
| redis | 无账号，只有口令 | `REDIS_PASSWORD` | `REDIS_URL` |

**四条通则**，任何预设都适用，比下面的具体命令更重要：

1. **在库里改，不在 env 里改。** 那些 `*_PASSWORD` 环境变量只在空数据卷首次初始化时生效；对已有数据的卷改 env 再重建容器，旧口令照样能登、新口令登不上。
2. **一个账号的多条 host 记录要在同一次会话里改完**（MySQL 尤其：`localhost` 与 `%` 是两条独立记录）。分开改必然撞死结——改了本地那条，后续命令用的旧口令立刻失效；先改远程那条，紧接着走本地的验证又认的是没改的记录。
3. **验证要走消费方真正用的那条路径，也就是 TCP，不要用容器内的本地 socket。** 好几个官方镜像对本地连接是 `trust`：用 socket 连根本不检查口令，**你拿错口令也会看到 `SELECT 1` 成功**，然后把错的值存进 env，全线断连。同时要反向验一次：**旧口令必须已经连不上**。
4. **该预设注入的每一个连接串变量都要改**（见上表第四列），一个不漏。

### 2.1 按上面通则写好的具体步骤（这三类核对过预设目录）

### MongoDB

```bash
# 1) 库内改（用旧口令登上去改自己）
docker exec <C> mongosh -u app -p '<OLD>' --authenticationDatabase admin --quiet \
  --eval 'db.getSiblingDB("admin").changeUserPassword("app", "<NEW>")'
# 2) 验证：新口令能登，旧口令登不上（两条都要跑，第二条必须失败）
docker exec <C> mongosh -u app -p '<NEW>' --authenticationDatabase admin --quiet --eval 'db.adminCommand({ping:1})'
docker exec <C> mongosh -u app -p '<OLD>' --authenticationDatabase admin --quiet --eval 'db.adminCommand({ping:1})' && echo "旧口令仍然有效，轮换未生效" && exit 1
```

### MySQL / MariaDB

两个账号都要换：`app` 是应用连的，`root` 是周期备份用的。只换 root 的后果是所有消费方立刻断（app 口令没动、连接串却换了新值）。

**一次会话改完所有 host**，不要逐条分开执行。逐条执行会撞上一个绕不开的顺序死结：先改 `root@localhost`，后续命令用的 `<OLD_ROOT>` 立刻失效；先改 `root@%`，紧接着那条走 socket（即 `localhost`）的验证又会用还没改的旧账号去认证。两种顺序都跑不完。

先列全有哪些 host（root 与 app 各自可能有 `localhost` / `%` 两条）：

```bash
docker exec <C> sh -c 'MYSQL_PWD="<OLD_ROOT>" mysql -uroot -N -e "SELECT user,host FROM mysql.user WHERE user IN (\"root\",\"app\")"'
```

再用旧口令开**一个**会话，把上一步列出的每一条都改掉（下面是 root/app 各两条的样子，按实际输出增删；全部在同一次调用里）：

```bash
docker exec <C> sh -c 'MYSQL_PWD="<OLD_ROOT>" mysql -uroot -e "
  ALTER USER \"app\"@\"%\"         IDENTIFIED BY \"<NEW_APP>\";
  ALTER USER \"app\"@\"localhost\" IDENTIFIED BY \"<NEW_APP>\";
  ALTER USER \"root\"@\"%\"        IDENTIFIED BY \"<NEW_ROOT>\";
  ALTER USER \"root\"@\"localhost\" IDENTIFIED BY \"<NEW_ROOT>\";
  FLUSH PRIVILEGES;"'
```

改完**分两条路验证**，因为它们认的是不同的 host 记录，只验一条会漏：

```bash
# 本地路径（socket，命中 @localhost 那条）
docker exec <C> sh -c 'MYSQL_PWD="<NEW_ROOT>" mysql -uroot -e "SELECT 1"'
# 网络路径（TCP，命中 @% 那条）——应用连的就是这条
docker exec <C> sh -c 'MYSQL_PWD="<NEW_APP>" mysql -h127.0.0.1 -uapp -e "SELECT 1"'
# 再跑一次第 0 步，确认没有漏掉的 host 记录
```

下一步改 env 时：`MYSQL_PASSWORD` 与两个连接串（`DATABASE_URL`、`MYSQL_URL`）跟着 `app` 走，`MYSQL_ROOT_PASSWORD` 跟着 `root` 走。漏掉任一处，要么应用连不上，要么周期备份连不上。

### PostgreSQL

**账号是 `app` 不是 `postgres`**。CDS 建库时把 `POSTGRES_USER` 设成了 `app`，官方镜像据此创建超级用户 `app`，**不会**再有 `postgres` 角色——对着 `-U postgres` 敲会直接报「role does not exist」。

```bash
# 改（这一步走 socket 没问题：本地 trust 让你不用旧口令就能改）
docker exec <C> psql -U app -d app -c "ALTER USER app PASSWORD '<NEW>'"

# 验证必须走 TCP。官方镜像的默认配置对本地 socket 是 trust——用 socket 验，
# PGPASSWORD 根本不参与判断，**你拿一个错口令也会看到 SELECT 1 成功**，
# 然后把错值存进 env，全线断连。
docker exec -e PGPASSWORD='<NEW>' <C> psql -h 127.0.0.1 -U app -d app -c 'SELECT 1'
# 反向验一次：旧口令必须已经被拒（这条要失败才算对）
docker exec -e PGPASSWORD='<OLD>' <C> psql -h 127.0.0.1 -U app -d app -c 'SELECT 1' \
  && echo "旧口令仍可用，轮换未生效" && exit 1
```
改完对应 `POSTGRES_PASSWORD`，以及 `DATABASE_URL` 与 `POSTGRES_URL` **两个**连接串。

### 其余预设（sqlserver / clickhouse / rabbitmq / elasticsearch / minio）

**本文不提供命令**。它们各有专用改口令方式，我没有在真实镜像上核对过，写一份看着像样的命令让人照抄，风险大于价值——照抄一条错命令的典型下场是 env 改了、库里没改，全线断连。

按 §2.0 的四条通则自己组装：查官方文档找改口令的命令 → 在库里改 → **走 TCP 用新口令验一次、再用旧口令反向验一次必须被拒** → 按上表把该预设注入的每一个连接串变量都改掉 → 走下面的后三步。

### 后三步（所有类型通用，**一步都不能少**）

库里改完只是第一步。口令在系统里还有**两份**拷贝，漏掉任一份就会出现「一半新一半旧」。

**第 2 步：改基建服务自己的 env。** 周期备份、数据面板、容器重建读的都是这一份。不改的话下一轮自动备份仍用旧口令认证、每轮失败；对 redis 更糟——容器一旦重建，启动命令会把存着的旧口令重新设回去，把你刚换的新值悄无声息地顶掉。注意 env 是**整体覆盖**，PUT 之前先 GET 一份当前值改在上面，别把别的键删了。

```bash
curl -X PUT "$CDS/api/infra/<infraId>?project=<projectId>" -H 'Content-Type: application/json' \
  -d '{"env":{"MYSQL_ROOT_PASSWORD":"<NEW_ROOT>","MYSQL_PASSWORD":"<NEW_APP>","MYSQL_USER":"app","MYSQL_DATABASE":"<db>"}}'
```

**第 3 步：让容器带新 env 重建。** CDS 的 restart 走的是停止、删除、再按新配置起，会读上一步的新值；直接 `docker restart` 不行——那只重启进程，env 还是旧的。

```bash
curl -X POST "$CDS/api/infra/<infraId>/restart?project=<projectId>"
```

**第 4 步：改项目环境变量里的连接串，再重部署消费方。** 消费方真正读的是这一份。**该预设注入的每一个变量都要改**（见 §2.0 表格第四列）——mysql 是两个，minio 是四个；只改一个的话，用另一个变量的消费方会带着旧口令重启、连不上。

```bash
python3 .claude/skills/cds/cli/cdscli.py env set --scope <projectId> --key DATABASE_URL --value 'mysql://app:<NEW_APP>@mysql:3306/<db>'
python3 .claude/skills/cds/cli/cdscli.py env set --scope <projectId> --key MYSQL_URL    --value 'mysql://app:<NEW_APP>@mysql:3306/<db>'
```

顺序不能换：先改库、再改服务 env、然后重建容器、最后改连接串并重部署。中间任何一步停下，系统就处在「库是新口令、某一层还是旧口令」的不一致态——那正是故障窗口。

**收尾必须回答**：库里改了吗、服务 env 改了吗、容器重建过吗、该预设注入的**每一个**连接串变量都改了吗、消费方都重部署了吗、旧口令确认连不上了吗、有没有哪个分支预览还揣着旧口令在跑。七个问题答不全就是没做完。

---

## 3. 回滚

轮换中途失败（库内改了但 env 没改、或部分消费方连不上）时，**不要继续往前推**：把库内口令改回 `<OLD>`（同样的命令反向执行），确认旧连接串恢复可用，再从头来。库内口令与 CDS env 不一致的时间窗口就是故障窗口，越短越好。

---

## 4. memcached / kafka / nats（以及**存量** redis）：现在没有口令可换

这三个预设在目录里没有声明任何密钥，容器起来就没有认证，连接串也是裸的。redis 的预设已经补上口令，但**只对补上之后新建的服务生效**——存量 redis 的 env 与连接串早就存在 state 里，不会被追溯改写，所以线上那些老的仍然是裸的。对它们做「轮换」都无从谈起，当下只有两个动作有意义：

1. **先把公网暴露关掉**（端口只绑回环 / 内网 bridge），这是真正的止血；
2. 等代码侧给这几个预设补上认证（kafka SASL、nats token/nkey；redis 已补），以及给**存量**服务补一条「加口令 / 换口令」的路径（台账 E17），补完之后它们才进入本 runbook 的 §2 流程。

在认证补上之前，**不要**手工给运行中的 redis `CONFIG SET requirepass`：CDS 注入给消费方的连接串里没有密码字段，你一加密码，所有分支预览立刻全连不上，而 CDS 这边没有任何地方能配这个密码。

---

## 4.5 CDS_JWT_SECRET / Jwt__Secret（一值两用，单独看这一节）

这个值不是普通口令，它同时是**登录 token 的签名密钥**和**平台 API key 密文的 AES 密钥**。2026-06-12 有人为了换弱钥直接改了它，把 6 个平台的 key 密文全打哑，静默 2 小时无告警。

现在代码侧有钥匙环兜底（实现见文末）：新密文用 `ApiKeyCrypto:Secret`，解密时依次试 primary → `ApiKeyCrypto:LegacySecrets` → `Jwt:Secret`。所以安全顺序是：

1. **先把旧值写进 `ApiKeyCrypto:LegacySecrets`**（存量密文的唯一解药），确认服务读得到；
2. 再改 `CDS_JWT_SECRET` / `Jwt__Secret` 为新值；
3. 验证三件事各一次：能重新登录（签名生效）、平台 key 能解密（读一次模型列表不 401）、`PlatformKeyIntegrityWorker` 启动自检无告警；
4. 存量密文用新钥重写完之前，**不要**从 `LegacySecrets` 里删旧值。

顺序反了（先换新钥、后补 legacy）就会复现 2026-06-12 那次事故。另外注意：项目 `customEnv` 里显式定义了 `Jwt__Secret` 的项目以自己的值为准，CDS 全局值只是兜底——换全局值之前先列出哪些项目钉了自己的值，它们不受影响也不该被顺手改掉。

---

## 5. 已知的系统性缺口（这次轮换暴露出来的）

- **没有「轮换」这个动作**：零件都在（改服务 env 的 `PUT`、重建容器的 `restart`、改连接串的 cdscli），但没有任何一处把它们串成一条带校验和回滚的流程。于是 §2 全靠人按顺序手动执行，漏一步就是故障窗口——这正是 E17 要补的。
- **没有轮换审计**：谁在什么时候换过哪个库的口令，系统里没有记录。
- **三个预设无认证 + 存量 redis 仍裸奔**：见 §4。

这三条已记入 [doc/debt.cds.md](./debt.cds.md)，代码侧修复另行推进——本 runbook 描述的是**在那之前**如何安全地手工轮换。

---

## 相关

- 跨项目隔离规则 —— 共享密钥通道与历史事故台账（2026-06-12 换 `CDS_JWT_SECRET` 打哑 6 个平台密文）
- [doc/debt.cds.md](./debt.cds.md) —— 缺口台账（E16 无认证预设 / E17 无轮换路径 / E18 无轮换审计）

## 实现来源

- `cds/src/services/infra-catalog.ts` —— 各预设的密钥声明、容器 env 与连接串 SSOT
- `cds/src/routes/projects.ts` —— `createInfraPreset()`：口令的唯一生成点
- `prd-api/src/PrdAgent.Infrastructure/Security/ApiKeyCryptoKeyRing.cs` —— 平台密文钥匙环（primary + LegacySecrets 兜底）
- `.claude/rules/cross-project-isolation.md` —— 共享密钥通道清单
