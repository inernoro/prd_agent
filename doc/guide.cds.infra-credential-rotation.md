# CDS 基建凭据轮换 Runbook（操作智能体执行本）

> **版本**：v1.0 | **日期**：2026-08-16 | **状态**：可执行

**一句话**：CDS 里的库口令只在建服务时生成过一次、之后没有任何轮换路径，所以轮换必须手工三步走——先在库里改、再改 CDS env、最后重部署消费方；改 env 重建容器那种做法对已有数据卷是假轮换。
**谁该读**：执行本次凭据轮换的操作智能体；事后复核轮换是否真的生效的人。
**读完能做什么**：按类型逐个把库口令换掉，并且每一步都有一条能证伪的验证命令；也能立刻判断哪些服务现在根本没有口令可换。

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

```bash
docker exec <C> sh -c 'MYSQL_PWD="<OLD>" mysql -uroot -e "ALTER USER \"root\"@\"%\" IDENTIFIED BY \"<NEW>\"; FLUSH PRIVILEGES;"'
docker exec <C> sh -c 'MYSQL_PWD="<NEW>" mysql -uroot -e "SELECT 1"'
```
注意 mysql 镜像里 root 可能同时存在 `'root'@'localhost'` 与 `'root'@'%'` 两条记录，只改一条会出现「容器内能连、跨容器连不上」。先 `SELECT user,host FROM mysql.user WHERE user='root'` 列全，逐条改。

### PostgreSQL

```bash
docker exec <C> psql -U postgres -c "ALTER USER postgres PASSWORD '<NEW>'"
docker exec -e PGPASSWORD='<NEW>' <C> psql -U postgres -c 'SELECT 1'
```

### RabbitMQ / Elasticsearch / MinIO

各自有专用命令（`rabbitmqctl change_password` / `elasticsearch-users passwd` / `mc admin user svcacct`），照官方文档执行，验证同样是「用新口令做一次真实调用」。

### 三步走的后两步（所有类型通用）

```bash
# 3) 改 CDS 里的连接串（envVars），让下次部署注入新值
python3 .claude/skills/cds/cli/cdscli.py env set --scope <projectId> --key MONGODB_URL --value 'mongodb://app:<NEW>@mongodb:27017/<db>?authSource=admin'
# 4) 重部署消费方；不重部署的容器会一直用旧口令直到下次部署
```

**收尾必须回答**：这个库有哪些消费方、是否都重部署了、有没有哪个分支预览还揣着旧口令在跑。答不上来就是没做完。

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

- **没有轮换路径**：口令只在建服务那一刻生成一次，之后 CDS 没有任何端点能改它。整个 §2 都是手工动作。
- **没有轮换审计**：谁在什么时候换过哪个库的口令，系统里没有记录。
- **四个预设无认证**：见 §4。

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
