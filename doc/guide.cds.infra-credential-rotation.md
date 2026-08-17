# CDS 基建凭据轮换 Runbook（操作智能体执行本）

> **版本**：v1.0 | **日期**：2026-08-16 | **状态**：可执行

**一句话**：CDS 没有「轮换」这个动作，只有五个必须按顺序手工做完的零件；漏掉任何一个，系统就停在「库是新口令、别处还是旧的」这种不一致态。
**谁该读**：执行本次凭据轮换的操作智能体；事后复核轮换是否真的生效的人。
**读完能做什么**：按类型逐个把库口令换掉，每一步都有一条能证伪的验证命令；也能立刻判断哪些服务现在根本没有口令可换。

---

## 0. 先看清现状（决定你今天能做什么）

| 预设 | 有没有口令 | 本次能不能轮换 |
|---|---|---|
| mongodb / postgres / mysql / mariadb / sqlserver / clickhouse | 有 | 能，按 §2 |
| rabbitmq / elasticsearch / minio | 有 | 能，按 §2 |
| **memcached / kafka / nats** | **没有** | **不能**——它们从创建那天起就是无认证。见 §4 |
| redis | **新建的有**（口令走 `REDIS_PASSWORD`），**存量的没有** | 新建的按 §2；存量的要先有口令才谈得上换，见 §4 |

判据来源是基建预设目录里的「要生成哪些密钥」字段（见文末实现来源）。没有声明这个字段的预设，建服务时不会生成任何口令，容器起来就是裸的。

---

## 1. 三条铁律（违反其一，轮换就是假的）

1. **口令要在库里改，不是在 env 里改。** `MONGO_INITDB_ROOT_PASSWORD` / `MYSQL_ROOT_PASSWORD` 这类 env **只在空数据卷首次初始化时生效**。对着一个已经有数据的卷改 env 再重建容器，旧口令照样能登、新口令登不上——而 CDS 的连接串已经换成新的了，于是所有消费方 401，看起来像「轮换把系统打坏了」，其实是口令根本没换成。
2. **改完 CDS env 不等于生效。** 分支容器的连接串是**部署时**注入的，改了 env scope 之后，已经在跑的容器还揣着旧口令。必须重部署消费方，或明确接受「下次部署才生效」。
3. **每一步都要用新口令真连一次。** 「命令返回 0」不算数——`docker exec` 到库里用新口令跑一条查询，能查出东西才算换成了。

---

## 2. 逐类型轮换步骤

下面 `<C>` 是容器名（`cdscli` 或 CDS 面板可查），`<OLD>` / `<NEW>` 是旧新口令。**新口令先自己生成好**（16 字节 hex 即可），不要复用其它环境的值。

**先对表：每个预设建出来的账号叫什么**。这一步踩过两次（MySQL 只换 root、PostgreSQL 对着不存在的 `postgres` 敲），所以把真值列在这里——凭据 env 与连接串都跟着这个账号走：

| 预设 | 应用账号 | 口令所在 env | 备注 |
|---|---|---|---|
| mongodb | `app` | `MONGO_INITDB_ROOT_PASSWORD` | 认证库是 `admin` |
| postgres | `app` | `POSTGRES_PASSWORD` | **没有 `postgres` 角色** |
| mysql / mariadb | `app`（应用）+ `root`（管理） | `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD` | 两个都要管，周期备份用 root |
| sqlserver | `sa` | `MSSQL_SA_PASSWORD` | 口令有复杂度策略 |
| clickhouse | `app` | `CLICKHOUSE_PASSWORD` | |
| rabbitmq | `app` | `RABBITMQ_DEFAULT_PASS` | |
| elasticsearch | `elastic` | `ELASTIC_PASSWORD` | 唯一不叫 app 的 |
| minio | `app` | `MINIO_ROOT_PASSWORD` | 同时是 S3 access key |

表的来源是基建预设目录（见文末实现来源）。**动手前先核一遍这一行**，别照着别的库的账号名敲。

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

**先看清要换的是哪个账号**。CDS 建出来的 MySQL 有**两个**：`root`（管理，`MYSQL_ROOT_PASSWORD`）和 `app`（**应用真正连的那个**，`MYSQL_PASSWORD`，连接串 `mysql://app:...`）。只换 root 是这一步最容易犯的错——换完 root、再把 `DATABASE_URL` 里的密码改成新值，结果是**所有消费方立刻连不上**（app 的口令根本没动），而旧的 app 口令还在到处能用，等于没轮换。

```bash
# 0) 先列全：root 和 app 各自可能有 'localhost' 与 '%' 两条记录，
#    只改一条会出现「容器内能连、跨容器连不上」。
docker exec <C> sh -c 'MYSQL_PWD="<OLD_ROOT>" mysql -uroot -N -e "SELECT user,host FROM mysql.user WHERE user IN (\"root\",\"app\")"'

# 1) 换 app（应用凭据，连接串里的那个）——逐条 host 改
docker exec <C> sh -c 'MYSQL_PWD="<OLD_ROOT>" mysql -uroot -e "ALTER USER \"app\"@\"%\" IDENTIFIED BY \"<NEW_APP>\"; FLUSH PRIVILEGES;"'
docker exec <C> sh -c 'MYSQL_PWD="<NEW_APP>" mysql -uapp -e "SELECT 1"'

# 2) 换 root（管理凭据，备份走的也是它）——需要时才换，与 app 分开进行
docker exec <C> sh -c 'MYSQL_PWD="<OLD_ROOT>" mysql -uroot -e "ALTER USER \"root\"@\"%\" IDENTIFIED BY \"<NEW_ROOT>\"; FLUSH PRIVILEGES;"'
docker exec <C> sh -c 'MYSQL_PWD="<NEW_ROOT>" mysql -uroot -e "SELECT 1"'
```

两个账号对应下一步要改的两处：`MYSQL_PASSWORD` + 连接串跟着 `app` 走，`MYSQL_ROOT_PASSWORD` 跟着 `root` 走。漏掉任一处，要么应用连不上，要么周期备份连不上。

### PostgreSQL

**账号是 `app` 不是 `postgres`**。CDS 建库时把 `POSTGRES_USER` 设成了 `app`，官方镜像据此创建超级用户 `app`，**不会**再有 `postgres` 角色——对着 `-U postgres` 敲会直接报「role does not exist」。

```bash
docker exec <C> psql -U app -d app -c "ALTER USER app PASSWORD '<NEW>'"
docker exec -e PGPASSWORD='<NEW>' <C> psql -U app -d app -c 'SELECT 1'
```
改完对应 `POSTGRES_PASSWORD` 与 `DATABASE_URL` / `POSTGRES_URL` 两个连接串。

### RabbitMQ / Elasticsearch / MinIO

各自有专用命令（`rabbitmqctl change_password` / `elasticsearch-users passwd` / `mc admin user svcacct`），照官方文档执行，验证同样是「用新口令做一次真实调用」。

### 后三步（所有类型通用，**一步都不能少**）

库里改完只是第一步。口令在系统里还有**两份**拷贝，漏掉任一份就会出现「一半新一半旧」：

```bash
# 2) 改基建服务自己的 env（周期备份、数据面板、容器重建都读这一份）
#    不改的话：下一轮自动备份仍用旧口令认证 → 每轮失败；
#    对 redis 更糟——容器一旦重建，启动命令会把**旧的** REDIS_PASSWORD 重新设回去，
#    把你刚换的新口令顶掉，而且悄无声息。
curl -X PUT "$CDS/api/infra/<infraId>?project=<projectId>" -H 'Content-Type: application/json' \
  -d '{"env":{"MYSQL_ROOT_PASSWORD":"<NEW_ROOT>","MYSQL_PASSWORD":"<NEW_APP>","MYSQL_USER":"app","MYSQL_DATABASE":"<db>"}}'
#    env 是整体覆盖，PUT 之前先 GET 一份当前值改在上面，别把别的键删了。

# 3) 让容器带新 env 重建（restart 走的是 docker stop && rm 再 run，会读上一步的新值；
#    直接 `docker restart` 不行——那只是重启进程，env 还是旧的）
curl -X POST "$CDS/api/infra/<infraId>/restart?project=<projectId>"

# 4) 改项目环境变量里的连接串（消费方真正读的是这一份），再重部署消费方
python3 .claude/skills/cds/cli/cdscli.py env set --scope <projectId> --key DATABASE_URL --value 'mysql://app:<NEW_APP>@mysql:3306/<db>'
```

顺序不能换：先改库、再改服务 env、然后重建容器、最后改连接串并重部署。中间任何一步停下，系统就处在「库是新口令、某一层还是旧口令」的不一致态——那正是故障窗口。

**收尾必须回答**：库里改了吗、服务 env 改了吗、容器重建过吗、连接串改了吗、消费方都重部署了吗、有没有哪个分支预览还揣着旧口令在跑。六个问题答不全就是没做完。

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
