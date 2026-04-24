# CDS state.json → MongoDB 迁移 · 指南

> **类型**：操作指南 (How-to) | **日期**：2026-04-18 | **版本**：v1.1

---

## 场景分流

| 你的情况 | 走哪条路径 |
|---------|-----------|
| **新装 CDS**（空服务器）| 路径 A：`./exec_cds.sh init` 一步走完 |
| **老 CDS 在跑 state.json**，想切 Mongo | 路径 B：CDS API 运行时切换（seed-from-json）|
| **之前切过 Mongo 但没持久化**（bug 受害者）| 路径 C：升到 d750fde+ 再切一次 |

---

## 路径 A：新装（强烈推荐）

```bash
cd cds && ./exec_cds.sh init
# 向导会问：
#   CDS_USERNAME / CDS_PASSWORD / CDS_JWT_SECRET / CDS_ROOT_DOMAINS
#   是否启动 MongoDB 容器并启用持久化存储? [Y/n]: Y   ← 选 Y
# 自动完成：
#   - docker run -d --name cds-state-mongo -p 127.0.0.1:27018:27017 mongo:7
#   - 等 mongosh ping OK（最多 30s）
#   - 写 .cds.env: CDS_STORAGE_MODE=mongo, CDS_MONGO_URI, CDS_MONGO_DB, CDS_MONGO_CONTAINER
./exec_cds.sh start
# CDS 启动前 exec_cds.sh 自动 docker start cds-state-mongo（如果停了），
# node 进程自己 parse .cds.env 读 URI，直接进 Mongo 模式
```

零人工干预。端口固定 27018（避开业务 mongo 的 27017）。
数据卷 `cds-state-mongo-data`（命名卷，容器删除也不丢数据）。

---

## 路径 B：老 CDS 运行时切换（含 seed-from-json）

前置：CDS 已升级到 `d750fde+`（含 node 自己 parse .cds.env 的 fix）。

通过 CDS Dashboard / curl 全自动：

通过 CDS Dashboard / `cdscli` 全自动：

```bash
# 1. 在 CDS 上启动一个专属 MongoDB 容器（独立于业务 DB）
export CDS="https://your-cds-host"
export KEY="your-ai-access-key"
export PROJ="default"  # 或 "legacy"，取决于你 CDS 的 default project id

curl -sf -H "X-AI-Access-Key: $KEY" -X POST \
  -H "Content-Type: application/json" \
  "$CDS/api/infra" \
  -d "{
    \"id\":\"cds-state-mongo\",
    \"projectId\":\"$PROJ\",
    \"name\":\"CDS State MongoDB\",
    \"dockerImage\":\"mongo:7\",
    \"containerPort\":27017,
    \"volumes\":[{\"name\":\"cds-state-mongo-data\",\"containerPath\":\"/data/db\",\"type\":\"volume\"}]
  }"

# 2. 启动它
curl -sf -H "X-AI-Access-Key: $KEY" -X POST \
  "$CDS/api/infra/cds-state-mongo/start"

# 3. 读出分配的 hostPort
PORT=$(curl -sf -H "X-AI-Access-Key: $KEY" "$CDS/api/infra" | \
       python3 -c "import json,sys;d=json.load(sys.stdin);print([s for s in d if s['id']=='cds-state-mongo'][0]['hostPort'])")

# 4. 测连
curl -sf -H "X-AI-Access-Key: $KEY" -X POST \
  -H "Content-Type: application/json" \
  "$CDS/api/storage-mode/test-mongo" \
  -d "{\"uri\":\"mongodb://127.0.0.1:$PORT/cds_state_db\",\"databaseName\":\"cds_state_db\"}"

# 5. 切换（含 seed-from-json + 持久化到 .cds.env）
curl -sf -H "X-AI-Access-Key: $KEY" -X POST \
  -H "Content-Type: application/json" \
  "$CDS/api/storage-mode/switch-to-mongo" \
  -d "{\"uri\":\"mongodb://127.0.0.1:$PORT/cds_state_db\",\"databaseName\":\"cds_state_db\"}"

# 响应应该带 "persisted": true 和 persistNote（证明 .cds.env 已写）
```

执行完成后：
- CDS 当前进程 → Mongo 模式（运行时已切换）
- `cds/.cds.env` 里已追加 `CDS_STORAGE_MODE=mongo` + `CDS_MONGO_URI=...` + `CDS_MONGO_DB=cds_state_db`
- **下次 CDS 重启自动进 Mongo 模式**（exec_cds.sh source .cds.env → process.env 含 Mongo 参数）

## 验证

```bash
# 应显示 mode=mongo, mongoHealthy=true
curl -sf -H "X-AI-Access-Key: $KEY" "$CDS/api/storage-mode"
```

可选：重启 CDS 一次（`cdscli self update --branch <same>`）然后再跑上面查询，验证**重启后仍然是 mongo 模式**而非退回 json。

## 紧急回退

**场景 1**：Mongo 突然挂了，CDS 启动不了  
→ 当前代码 Mongo URI 配了但连不上会 throw exit。编辑 `cds/.cds.env`
   注释掉 `export CDS_STORAGE_MODE=mongo` 和 `export CDS_MONGO_URI=...` 
   然后 `./exec_cds.sh restart`，回到 JSON 模式（state.json 是上次切换前的快照）

**场景 2**：Mongo 还活着但想回 JSON  
→ Dashboard Settings → 存储模式 → "切回 JSON"，或 API:
```bash
curl -sf -H "X-AI-Access-Key: $KEY" -X POST \
  "$CDS/api/storage-mode/switch-to-json"
```
这会把当前 Mongo 数据导出到 state.json + 清 .cds.env 里的 Mongo 变量 + 运行时切 JSON。

## 数据备份

Mongo 数据卷 `cds-state-mongo-data` 是 Docker 命名卷。定期 `docker exec` 跑 mongodump:

```bash
docker exec cds-infra-default-cds-state-mongo \
  mongodump --db=cds_state_db --out=/data/backup-$(date +%F)
docker cp cds-infra-default-cds-state-mongo:/data/backup-<date> \
  /host/backups/
```

## 路径 C：bug 受害者的修复路径

**症状**：2026-04-18 前做过 switch-to-mongo，收到 `persisted: true`，但
重启后 `/api/storage-mode` 显示 `mode: json` 又退回去了。

**根因**：生产用 systemd 管 CDS 进程。systemd unit 的
`ExecStart=/usr/bin/node dist/index.js` **直接 exec node**，绕过
`exec_cds.sh` 的 `load_env()` 函数——那个函数是纯 bash `set -a + source`，
只在 shell 链路生效。所以 `.cds.env` 里写的 `export CDS_MONGO_URI=...`
永远不会进入 node 的 `process.env`。

**修复 commit**：`d750fde` —— `src/index.ts` 启动一开始 `loadCdsEnvFile()`，
node **自己**解析 `.cds.env` 写入 process.env，不再依赖 shell。

**受害者操作**：

```bash
# 1. 升级到 d750fde+（node 自己 parse .cds.env）
cdscli self update --branch <含此 commit 的分支>

# 2. 重启后验证 /healthz 无认证诊断
curl -sf https://your-cds/healthz | python3 -m json.tool
# 期望看到: "state": { "ok": true, "detail": "branches=N, backend=mongo" }
#                                                              ^^^^^^^^^^^^
# 如果 backend=json，说明还没修好，继续排查：
#   curl /api/storage-mode → envFile.exists + hasMongoUri 是否 true

# 3. 如果 envFile.hasMongoUri=true 但 backend=json，说明 .cds.env 没被
#    node loader 读到——看 journalctl 里找 "[cds-env-loader]" 行
journalctl -u cds-master -n 50 | grep cds-env-loader
# 期望看到: [cds-env-loader] 从 /path/to/.cds.env 加载 N 个变量到 process.env
```

## 紧急回退

**场景 1**：Mongo 突然挂了，CDS 启动不了  
→ Mongo URI 配了但连不上会 throw exit（按 F 阶段行为，不再 silent fallback）
→ 编辑 `cds/.cds.env` 注释 `export CDS_STORAGE_MODE=mongo` 和
  `export CDS_MONGO_URI=...` 三行
→ `./exec_cds.sh restart`
→ 回到 JSON 模式（state.json 是上次切换前的快照）

**场景 2**：Mongo 还活着但想回 JSON  
→ Dashboard Settings → 存储模式 → "切回 JSON"，或 API:
```bash
curl -sf -H "X-AI-Access-Key: $KEY" -X POST \
  "$CDS/api/storage-mode/switch-to-json"
```
这会把当前 Mongo 数据导出到 state.json + 清 .cds.env 里的 Mongo 变量 + 运行时切 JSON。

**场景 3**：`cds-state-mongo` 容器挂了但 CDS 本身 OK  
→ `./exec_cds.sh restart` —— exec_cds.sh 的 `ensure_cds_mongo_running`
会自动 `docker start cds-state-mongo` 然后等 healthy 再启动 CDS

## 数据备份

Mongo 数据卷 `cds-state-mongo-data` 是 Docker 命名卷。定期 mongodump:

```bash
docker exec cds-state-mongo \
  mongodump --db=cds_state_db --out=/data/backup-$(date +%F)
docker cp cds-state-mongo:/data/backup-<date> /host/backups/
```

（老部署用 `cds-infra-default-cds-state-mongo` 作容器名——这是运行时
由 CDS API 创建的历史名称；init 路径创建的新容器叫 `cds-state-mongo`）

## 配合多实例部署

如果你 CDS 跑了多个实例（调度 + 多个执行器），**每个实例应该连同一个 Mongo**，
让 state 集中。参考 `design.cds-cluster-bootstrap.md`。

## 为什么推荐路径 A

- 零循环依赖：Mongo 容器由 exec_cds.sh 直接起，不经 CDS infra state
- 零随机端口：固定 27018，重启/重建容器都稳定
- 零 SSH 介入：新装一次走完，`./exec_cds.sh init` 交互 1 分钟搞定
- 零 state.json 依赖：node 自己 parse .cds.env，不管 shell 或 systemd 怎么启动
- 零数据丢失：`seedIfEmpty` 幂等；state.json 继续保留作为 switch-to-json 的回退目标
