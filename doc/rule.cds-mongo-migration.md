# CDS state.json → MongoDB 迁移与回滚规范

> **版本**：v0.1 | **日期**：2026-04-12 | **类型**：rule | **状态**：草案
>
> 本文档是 CDS v4 数据迁移的**操作规范**。涉及 P3 阶段（详见 `doc/plan.cds-multi-project-phases.md` P3 节）的所有代码必须遵守本规则，违反规则直接拒绝合并。
>
> **文档导航**：
>
> - 主设计稿：`doc/design.cds-multi-project.md`
> - 数据字典：`doc/spec.cds-project-model.md`
> - 交付计划：`doc/plan.cds-multi-project-phases.md`

---

## 1. 背景

CDS v3.2 使用单个 `state.json` 文件承载所有业务数据（branches / profiles / infra / routing）。v4 需要迁移到 MongoDB 以支持多项目、并发写入、以及后续的 workspace / user 层。

迁移是**整个 v4 改造中风险最大**的一步：

- 数据量不大但字段耦合复杂
- 没有"迁移错了可以原地修"的机会——错一次可能丢失所有分支状态
- 单点故障：state.json 挂了只影响一个 CDS 实例；MongoDB 挂了影响全量数据
- 运行时迁移：CDS 一边跑业务一边切存储，窗口难以关停

因此本文档定义硬性规则和三阶段渐进式策略。

---

## 2. 硬规则（违反即拒绝合并）

### R1：迁移前必须先做冷备份

切换到 P3a 前，必须手工或脚本完成：

```
cp state.json state.json.premigration-YYYYMMDD.bak
cp -r state.json.bak state.json.bak.premigration-YYYYMMDD/
```

并确认冷备份文件存在、字节数与原文件一致。CI 或 init 脚本可以提供 check，但最终责任在执行人。

### R2：迁移脚本必须支持 `--dry-run` 模式

`cds/scripts/migrate-state-to-mongo.ts` 必须至少支持两种模式：

- `--dry-run`：只读 state.json，模拟写入 mongo 的操作（打印 insert 语句），不实际修改数据库
- `--execute`：真实写入，必须和 `--dry-run` 同一份代码路径，只在最后一刻分叉

**禁止**：只有 execute 模式、或 dry-run 走不同代码路径。

### R3：迁移不能在高峰期执行

P3c 的"封存 state.json"动作必须在停机窗口执行。即使 P3a / P3b 的双写阶段，也建议选择夜间或周末低峰期启动，便于监控一致性告警。

### R4：双写期间必须持续一致性校验

P3a / P3b 阶段每日运行 `cds/scripts/verify-state-consistency.ts`，对比 state.json 和 mongo 的全量数据：

- 集合记录数
- 每条记录的关键字段（id / name / status / updatedAt）
- 任何不一致都必须产生**人可见**的告警（log 不够，需要发邮件或 Slack）

连续 3 天无告警才能从 P3a 推进到 P3b；连续 3 天无告警才能从 P3b 推进到 P3c。

### R5：任何时刻回退到 JSON 模式不需要代码变更

回滚机制必须做成环境变量开关：

```
CDS_STORAGE_MODE=json       # 纯 JSON
CDS_STORAGE_MODE=dual       # 双写
CDS_STORAGE_MODE=mongo      # 纯 mongo
```

改 `.cds.env` + 重启 CDS 即可切换。**禁止**：回滚需要 revert 代码、需要手工 drop 集合、需要执行 SQL 脚本。

### R6：禁止删除 state.json 直到 mongo 稳定 2 周

P3c 阶段把 state.json 重命名为 `state.json.legacy-YYYYMMDD`，但**禁止物理删除**。至少保留 2 周，确认期间无回滚需求后才移入归档目录（或压缩存档）。

物理 `rm` 需要 workspace owner 级别的书面批准（PR 描述里明确）。

### R7：迁移脚本的每一步都必须幂等

迁移脚本的任何一次执行失败，应能用同样参数重跑并得到同样结果。具体要求：

- 使用 `upsert`（`$setOnInsert` + `$set`）而非 `insert`
- 按稳定主键（UUID / 原 id）写入，避免生成不稳定的新 ID
- 不做"删除再插入"，改为 upsert + soft delete

---

## 3. 三阶段流程

### 3.1 P3a：双写阶段

#### 入场条件

- [ ] P2 完成，users / sessions 集合在 mongo 稳定运行 ≥ 3 天
- [ ] state.json 冷备份已完成（R1）
- [ ] 8 个业务集合已在 mongo 初始化（空集合即可）
- [ ] `verify-state-consistency.ts` 已实现且能本地运行
- [ ] `migrate-state-to-mongo.ts` 已在 `--dry-run` 模式跑过一次真实 state.json

#### 执行步骤

1. 停 CDS（或在停机窗口）
2. 跑 `migrate-state-to-mongo.ts --execute` 把现有 state.json 全量导入 mongo（mongo 里先有数据）
3. 跑 `verify-state-consistency.ts` 确认两边一致（基线对齐）
4. 设 `CDS_STORAGE_MODE=dual`
5. 启动 CDS
6. 跑一遍冒烟测试：创建分支、启停、改配置、删除
7. 再次跑 `verify-state-consistency.ts`，确认双写一致

#### 验证方法

- 每日 cron 跑 `verify-state-consistency.ts --mode=compare`
- 一致性告警接入邮件 / Slack
- 观察 log 中的 `[dual-write]` 前缀，确认每次写操作都写了两边

#### 回滚步骤

1. 设 `CDS_STORAGE_MODE=json`
2. 重启 CDS
3. mongo 里的业务数据保留（或 drop 后下次重做 P3a）

#### 出场条件

- [ ] 连续 3 天一致性校验无告警
- [ ] 所有 Service 层的写操作都已覆盖（grep 确认无漏掉的 stateStore 直接调用）
- [ ] CDS 总体 QPS / 错误率与 P3a 前持平

### 3.2 P3b：mongo 读阶段

#### 入场条件

- [ ] P3a 出场条件全部满足
- [ ] `json-storage.ts` 和 `mongo-storage.ts` 实现的 read 方法接口兼容（同一组测试用例两边都通过）

#### 执行步骤

1. 新增 `CDS_STORAGE_READ_FROM=mongo` 环境变量（默认 `json`）
2. 改 `dual-write-storage.ts`：写仍双写，读按 `CDS_STORAGE_READ_FROM` 分发
3. 设 `CDS_STORAGE_READ_FROM=mongo`
4. 重启 CDS
5. 跑冒烟测试 + 观察 log
6. 每日跑一致性校验

#### 验证方法

- 读操作的响应时间应与 P3a 基本一致（mongo 索引命中）
- 所有分支状态、profile override 等 UI 展示正常
- 停止 state.json 的读引用，确认没有路径仍然读 state.json（除了 dual-write 的写路径）

#### 回滚步骤

1. 设 `CDS_STORAGE_READ_FROM=json`
2. 重启 CDS
3. 无需改数据

#### 出场条件

- [ ] 连续 3 天读 mongo 无告警
- [ ] 连续 3 天一致性校验（双写仍在跑）无告警
- [ ] 已确定停机窗口用于 P3c

### 3.3 P3c：封存 state.json 阶段

#### 入场条件

- [ ] P3b 出场条件全部满足
- [ ] 停机窗口已排期（至少 30 分钟）
- [ ] 冷备份再次确认（R1 流程重跑一次）

#### 执行步骤

1. 停 CDS
2. 跑 `verify-state-consistency.ts` 最后一次基线确认
3. 跑 `cds/scripts/seal-state-json.ts`：
   - 重命名 `state.json` → `state.json.legacy-YYYYMMDD`
   - 重命名 `state.json.bak/` → `state.json.bak.legacy-YYYYMMDD/`
   - 写一个 `state.json.SEALED` 标记文件（内容含日期、执行人、执行命令）
4. 设 `CDS_STORAGE_MODE=mongo`
5. 启动 CDS
6. 跑冒烟测试
7. 监控 24 小时

#### 验证方法

- CDS 不再访问 state.json（可以通过 `lsof` / audit log 确认）
- 所有业务动作只进 mongo
- 一致性校验脚本需改为 mongo-only 模式（不再对比两边）

#### 回滚步骤

1. 停 CDS
2. 跑 `cds/scripts/mongo-to-state.ts`（反向迁移脚本，将 mongo 数据导出到新的 state.json）
3. 重命名 `state.json.legacy-YYYYMMDD` → `state.json.legacy-rollback.bak`
4. 使用步骤 2 产出的新 state.json
5. 设 `CDS_STORAGE_MODE=json`
6. 启动 CDS

**重要**：P3c 之后的回滚比前两阶段复杂得多，属于事故处理。应在回滚前先通过告警频率判断是否有其他修复路径。

#### 出场条件

- [ ] 24 小时内无 P0/P1 事故
- [ ] CDS 总体稳定（错误率、QPS、延迟）
- [ ] 2 周后 legacy 文件可归档

---

## 4. 一致性校验脚本（设计要点）

`cds/scripts/verify-state-consistency.ts` 应当：

1. **读两端数据**：从 state.json 和 mongo 分别拉取 8 个业务集合的全量数据
2. **按 ID 对齐**：对每个集合的每条记录按主键对齐，生成 `(source, mongoDoc, jsonDoc)` 三元组
3. **逐字段对比**：关键字段（id / name / status / updatedAt / profileOverrides / subdomainAliases）逐个比较
4. **告警输出**：任何差异产生一条人类可读的 diff（形如 `branches.abc123.status: json=running, mongo=stopped`）
5. **模式开关**：
   - `--mode=baseline`：初次对齐前生成基线快照
   - `--mode=compare`：对比模式，产出 diff report
   - `--mode=mongo-only`：P3c 之后只校验 mongo 内部约束（外键、unique）
6. **退出码**：有差异退出 1，无差异退出 0，便于 cron 检测

一致性校验**不应修改任何数据**。禁止"发现差异后自动修复"——那是另一个脚本的职责。

---

## 5. 故障应急手册

### 5.1 mongo 写入失败

**症状**：CDS log 出现 `MongoError: connection timeout` 或 `duplicate key`。

**处理**：

1. P3a 阶段：双写中 mongo 写失败，state.json 写成功。此时应继续（state.json 是权威），但必须记录差异，P3b 前必须同步
2. P3b 阶段：读 mongo 失败会导致业务异常。立即设 `CDS_STORAGE_READ_FROM=json` 回退到 P3a 读
3. P3c 阶段：mongo 是唯一权威，写失败 = 服务不可用。必须立即修复 mongo 或执行 P3c 回滚

### 5.2 双写不一致

**症状**：`verify-state-consistency.ts` 报告差异。

**处理**：

1. **立即停止推进**：P3a → P3b 的切换必须延期，直到根因明确
2. **定位时序**：看差异的字段和时间戳，通常是竞态条件或错过更新
3. **修复策略**：
   - 优先修复 dual-write-storage 代码（比如某条 API 路径漏了双写）
   - 修复后用脚本把 state.json 为准的数据 sync 到 mongo（或反向，按业务判断）
4. **重跑一致性校验**直到 3 天无差异才能继续推进

### 5.3 读取数据损坏

**症状**：API 返回损坏数据，UI 显示异常。

**处理**：

1. 立即设 `CDS_STORAGE_READ_FROM=json`（如果在 P3b）
2. 确认 state.json 数据完整（如不完整，从冷备份恢复）
3. 按时间戳和 log 定位损坏源头（是 mongo 写入 bug 还是外部操作）
4. 修复源头后按 5.2 流程重新一致性校验

### 5.4 CDS_STORAGE_MODE 环境变量使用指引

| 场景 | 设置 | 行为 |
|---|---|---|
| P3a 正常推进 | `CDS_STORAGE_MODE=dual` | 双写，读 json |
| P3a 回滚 | `CDS_STORAGE_MODE=json` | 纯 json，mongo 数据保留 |
| P3b 正常推进 | `CDS_STORAGE_MODE=dual` + `CDS_STORAGE_READ_FROM=mongo` | 双写，读 mongo |
| P3b 读回滚 | `CDS_STORAGE_READ_FROM=json` | 双写，读 json（退回 P3a 状态） |
| P3c 正常运行 | `CDS_STORAGE_MODE=mongo` | 纯 mongo |
| P3c 紧急回滚 | 走 3.3 节的回滚流程 | 需要反向迁移脚本 |

---

## 6. 审计日志

每次迁移操作（进入 P3a / P3b / P3c、任何回滚、任何一致性告警处理）都必须写入 `doc/report.cds-mongo-migration-YYYYMMDD.md`，内容至少包含：

- 执行人
- 时间窗口（开始 / 结束）
- 环境变量前后值
- 冒烟测试结果
- 一致性校验输出
- 观察到的异常（若有）
- 下一步计划

这份审计日志是事故定位和责任追溯的关键资料。**P3 期间每天都应该有一条新记录**，没有变化也要写"今日无变化 + 一致性校验通过"。

---

## 7. 违反规则的处理

以下行为视为违反本规则，PR 必须被拒绝：

- 迁移脚本没有 `--dry-run` 模式
- 迁移脚本不幂等（重跑产出不同结果）
- 双写期间没有一致性校验自动跑
- 物理删除 state.json（除非距 P3c 完成 ≥ 2 周且有明确批准）
- 回滚需要 revert 代码
- 迁移脚本里有"如果失败就跳过"这类静默容错

评审人对上述 6 点有一票否决权。

---

## 8. 关联文档

- `doc/design.cds-multi-project.md` — 主设计稿，了解迁移在整个 v4 里的位置
- `doc/spec.cds-project-model.md` — 迁移目标的 schema
- `doc/plan.cds-multi-project-phases.md` — P3 的交付清单和验收标准
- `doc/design.cds-data-migration.md` — CDS 更早版本的数据迁移思路（参考）
- `.claude/rules/no-auto-index.md` — 应用启动时不自动建索引（与本规则配套）
