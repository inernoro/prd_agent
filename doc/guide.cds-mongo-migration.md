# CDS state.json → MongoDB 迁移指南

> **类型**：操作指南 (How-to) | **日期**：2026-04-18 | **版本**：v1.0

---

## 何时用这篇

你是 CDS 运维，需要把某个 CDS 实例从 JSON 文件存储迁到 MongoDB。
**无论新装还是现有部署**，按本文做。

## 前置

- CDS 已升级到 commit `ebd3248+`（含 `.cds.env` 持久化代码）
- 服务器上有 Docker
- 你有 CDS AI_ACCESS_KEY 或 cookie 登录

## 迁移（自动路径，零 SSH）

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

## 配合多实例部署

如果你 CDS 跑了多个实例（调度 + 多个执行器），**每个实例应该连同一个 Mongo**，
让 state 集中。参考 `design.cds-cluster-bootstrap.md`。

## 为什么推荐这条路径

- 零 SSH：全走 CDS API，任何有 AI_ACCESS_KEY 的 agent 都能执行
- 零数据丢失：`seedIfEmpty` 是幂等的，重跑不会覆盖
- 完整回滚：state.json 永远保留一份最近快照（switch-to-json 会重新写）
- 持久化：.cds.env 写入让重启不丢 Mongo 模式
