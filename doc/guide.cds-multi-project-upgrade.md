# CDS 多项目升级迁移 · 指南

> **类型**：操作指南 (How-to) | **日期**：2026-04-18 | **版本**：v1.0

本文面向运维/管理员，介绍从多项目扩展（Project/AgentKey/GlobalAgentKey/
scoped customEnv/cleanup-orphans/factory-reset-scoped）一系列改动升级
到新版 CDS 时的**安全步骤 + 验证清单 + 回滚路径**。

适用于从 2026-04-14 ~ 2026-04-18 累计变更升级的生产部署。测试环境
（如 noroenrn.com）不必严格遵循，但正式环境（cds.miduo.org）**建议
全部走一遍**。

---

## 1. 变更摘要

本轮升级包含的破坏性兼容点：

| 变更 | 影响 | 是否强制迁移 | 回滚代价 |
|------|------|------------|---------|
| `customEnv` 扁平 → `{_global, <projectId>}` 嵌套 | 状态文件形状变化 | 是（但首次 load 幂等自动包起） | 低（改回扁平只需要读取 `_global` 字段写出） |
| `state.globalAgentKeys` 新数组字段 | 新增字段 | 否（缺省即空） | 无 |
| `Project.agentKeys` 新数组字段 | 新增字段 | 否（缺省即空） | 无 |
| `BuildProfile.projectId` / `InfraService.projectId` 等 | Part 3 已迁移过 | 否（本轮无变更） | — |
| `/api/cleanup` + `/api/factory-reset` 新增 `?project=<id>` | 新参数默认行为不变 | 否 | 无 |

**关键点**：所有迁移都是**读时修正**——不会改写 state.json 的既有字段，
只在下次 save 时把新结构持久化。这意味着：**升级后第一次 save 之前**
任何时候都可以回滚到旧版本，state.json 依然兼容。

---

## 2. 升级前：备份 state.json

**一条命令搞定**：

```bash
# 假设 CDS 装在 /opt/cds 目录；按实际调整
STATE_FILE="/opt/cds/.cds/state.json"
BACKUP_DIR="/opt/cds/.cds/upgrade-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
cp "$STATE_FILE" "$BACKUP_DIR/state.json.bak"
# 同时抓最近的 .bak.* 滚动备份，防万一
cp "$STATE_FILE".bak.* "$BACKUP_DIR/" 2>/dev/null || true
echo "[OK] state.json 已备份到 $BACKUP_DIR"
```

**出错兜底**：CDS `JsonStateBackingStore` 自带 `.bak.*` 滚动备份（最多 10
份），如果备份脚本失败也还能从它那里恢复。备份仍然建议做，因为滚动
备份只在 save 时轮换，第一次启动就出问题时可能盖住唯一好备份。

---

## 3. 升级步骤

### 3.1 停服务

```bash
sudo systemctl stop cds   # 或 ./exec_cds.sh stop
```

### 3.2 拉代码 + 构建

```bash
cd /opt/cds
git fetch origin
git checkout main           # 或具体 tag
git pull
pnpm install --frozen-lockfile
pnpm build                   # 或 exec_cds.sh build
```

### 3.3 冷启

```bash
sudo systemctl start cds    # 或 ./exec_cds.sh start
# 等 30 秒让它初始化
sleep 30
```

**首次启动日志关键字**（`/opt/cds/cds.log`）：

- `[state] loading state.json from …` — backing store 成功加载
- `[state] migrated legacy customEnv into _global scope` — 扁平 customEnv
  升级到嵌套（**旧数据独有**；嵌套数据看不到这条）
- `[projects] legacy default project ensured` — Project 默认实体就位
- 无 `Error`、无 `unhandledRejection`

如果看到任何 `Error:`，**立即停服并跳到第 5 节回滚**。

---

## 4. 升级后：自检清单

### 4.1 健康检查（30 秒内应全绿）

```bash
CDS_HOST="cds.miduo.org"          # 换成你的域名
curl -sf "https://$CDS_HOST/healthz" | python3 -m json.tool
# 期望: { "ok": true, "checks": { "state": {"ok": true}, "docker": {"ok": true} } }
```

### 4.2 API 冒烟（无需登录的路径）

```bash
# 项目列表：至少有 legacy default，并且每个项目返回新字段
curl -sf "https://$CDS_HOST/api/projects" | python3 -m json.tool | \
  grep -E '"(branchCount|runningBranchCount|runningServiceCount|lastDeployedAt)"'
# 期望: 上述 4 个字段全部可见
```

### 4.3 登录后 UI 抽查

用浏览器打开 `https://$CDS_HOST/`：

- [ ] 项目列表页能看到所有原项目卡片
- [ ] 每个卡片有 `N 分支 / M 运行中 / 最近部署` 三枚 chip
- [ ] 右上角设置齿轮有 `🔑 Agent 全局通行证` 入口
- [ ] 点进任意项目，分支列表页能看到分支
- [ ] 点"环境变量"看到全局变量，数量与升级前一致
- [ ] 如果该项目之前有专属环境变量，切换到"📦 此项目"tab 能看到

### 4.4 scoped customEnv 正确性

验证升级后全局变量还在：

```bash
# 需要先获取 cookie 或有效 key，简化演示直接用 AI_ACCESS_KEY
curl -sf -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  "https://$CDS_HOST/api/env?scope=_global" | python3 -m json.tool
# 期望: { "env": { 升级前的所有 KEY=value }, "scope": "_global" }
```

验证某个具体项目的合并视图（替换 `<projectId>`）：

```bash
curl -sf -H "X-AI-Access-Key: $AI_ACCESS_KEY" \
  "https://$CDS_HOST/api/env?scope=<projectId>" | python3 -m json.tool
# 升级前无项目级覆盖 → 应该返回空 {}；这是正常的
```

### 4.5 端到端部署

随便跑一个分支部署（老 legacy 项目或任一新项目都行），确认：

- 部署成功（无 docker/env 错误）
- 容器里拿到的环境变量 = `_global` + 项目级覆盖（通过
  `docker exec <container> env | sort` 抽查）
- 分支卡片 `running` 状态，项目卡片的"运行中"计数 +1

---

## 5. 回滚路径

如果任何一步不对，**立即停 CDS + 恢复 state.json**：

```bash
sudo systemctl stop cds

# 用升级前的备份覆盖当前 state.json
cp /opt/cds/.cds/upgrade-backup-<timestamp>/state.json.bak /opt/cds/.cds/state.json

# 切回上一个 git tag
cd /opt/cds
git checkout <上一次已知可用的 tag 或 commit SHA>
pnpm install --frozen-lockfile
pnpm build

sudo systemctl start cds
```

**为什么可以无损回滚**：
- 新版 CDS 读到扁平 customEnv 会迁移到嵌套后使用；但**只有在 save 时
  才会持久化**，所以启动后立即停服 + 恢复备份不会留下新字段
- 新增字段（globalAgentKeys, agentKeys, ProjectStats 等）在老版本里
  就是被忽略的多余字段，不会触发错误
- 唯一不可逆的事情：如果用户在升级后已经用新 UI 签发了全局 key /
  项目 key，这些 key 的 hash 会写入 state.json。回滚后老版本读不到
  这些字段，等价于所有新签发的 key 全部失效（但老 AI_ACCESS_KEY 继续
  有效）。建议在升级后 24 小时内不要大量签发 key，以便保持回滚可能性

---

## 6. 已知风险

| 风险 | 概率 | 缓解 |
|------|------|------|
| `/api/env?scope=<projectId>` 返回空，运维以为数据丢了 | 中 | 实际上首次升级所有项目的 scope bucket 都是空，因为旧数据都在 `_global`。引导运维按需把项目特有变量"下沉"到项目 scope |
| 升级后立即用 Agent 通过全局 key 批量创建项目 → 状态激增 | 低 | 本次 CDS 没变脏数据结构，但建议监控 `state.json` 大小 |
| docker network `cds-proj-<id>` 与宿主机冲突 | 极低 | `POST /api/projects` 自动做 docker network inspect 预检 |
| 并发 save 打架（双写） | 极低 | state 本来就是单进程独占；升级不引入并发 |

---

## 7. 升级后可做的清理（选做）

```bash
# 压缩一周以上的 state.json.bak.* 滚动备份
find /opt/cds/.cds -name "state.json.bak.*" -mtime +7 -exec gzip {} \;

# 清理升级前的 upgrade-backup-*（保留最近 1 份）
ls -dt /opt/cds/.cds/upgrade-backup-* | tail -n +2 | xargs -r rm -rf
```

---

## 8. 关联文档

- [CDS 多项目设计](design.cds-multi-project.md)
- [CDS 环境变量配置指南](guide.cds-env.md)
- [CDS AI Auth 指南](guide.cds-ai-auth.md)
