# 缺陷自动化自治体系 · 设计

> **版本**：v1.0 | **日期**：2026-06-24 | **状态**：草案

## 一、管理摘要

- **解决什么问题**：我们的缺陷自动化（`DefectEscalationWorker` 定时催办 + `workflow.v1` 修复流水线）目前是一条「领单 → 修 → 提交 → 复测」的线性脚本。它会办事，但「判断」是隐性的、没有被建模的——它不知道自己什么时候该停下来问人。
- **方案概述**：把缺陷自动化从「会办事的脚本」收敛成一个有边界、能担责的**自治体系**。第一性原则是**自主边界先行**（全权自主 / 请示后做 / 禁止自动做三档），其上叠加**五层自治回路**（认知 / 规划 / 执行 / 记忆 / 监督），每一层都接到本仓库真实存在的代码和字段上，明确「现状有什么、缺口要建什么」。
- **业务价值**：自动修复变得可信、可担责——不确定时主动请示、触红线时拒绝执行、异常循环时自动熔断。信任来自「知道它什么时候会停」。
- **影响范围**：现状机制散落在 `DefectEscalationWorker`、`DefectAgentController`（workflow.v1）、`DefectAutomationRun` / `DefectResolutionTrace` / `DefectFixReport` 模型、`ai-defect-resolve` 技能。本设计在其上补两处缺口（规划层「值不值」加权、记忆层「情景召回」）并把监督三道阀统一收口。本文是 `design.defect-agent.md` 的子设计，只管「自治治理」，不重复缺陷管理主流程。

## 二、背景：它现在是「脚本」，不是「员工」

判定一个自动化系统是脚本还是数字员工，只看一句话：**它知道自己什么时候该停下来问人吗？**

我们的缺陷自动化协议（`spec.defect-agent.automation-protocol.md`）写得很诚实——「智能体只负责理解、判断、修复、提交」「一次只处理一个缺陷」，这是一条线性流水线。对照「自治」的标准逐层审计（均经代码核实）：

| 层 | 现状（真实代码） | 判定 |
|----|------------------|------|
| 认知（指令≠目标） | 缺陷单 face-value 领来就修，无目标还原、无「描述是否仍成立」核实 | 缺 |
| 规划（值不值） | 仅 200 行 / 10 分钟 / `forbiddenScopes` 二元闸门；`Trace.RiskLevel`、`FixReport.ConfidenceScore` 已存在但未接进日常领单/完成路径 | 半 |
| 执行（事实核查） | 有 `defect-automation-probe.mjs --safe` 自检 + §8.1 自测优先，但 probe 只验授权/协议，不核查「描述与代码现状是否相符」 | 半 |
| 记忆（情景召回） | `defect_resolution_traces` 是完整账本，但只用于更新中心按 commitSha 关联，不是可检索的经验库 | 缺 |
| 监督（事前护栏） | `workflow/block`+`stopRun`、`blocked-state-circuit-breaker`、`scope-check`、SKILL「绝对禁止」清单——本系统最强一层，但散落，且缺 fix-break-fix 循环熔断 | 半 |

结论：我们不缺安全机制，缺一个把它们**收敛成一个有边界、可声明的自治体系**的具象。本设计就是这个具象。

## 三、自主边界（体系的宪法，先行）

任何一条缺陷动手前，体系必须能回答三问，否则不许自动执行：

1. **什么能全权自主？** —— 不请示、直接做、做完留痕。
2. **什么必须请示人类？** —— 触线即停、等人确认。
3. **失误的兜底是什么？** —— 怎么回滚、怎么被发现、谁接管。

三档边界，全部接到真实闸门（已落地，本体系直接复用）：

| 档位 | 判定闸门（真实代码 SSOT） | 触发动作 |
|------|---------------------------|----------|
| **全权自主** | 轻量修复：`AutomationMaxDiffLines=200` + `AutomationMaxMinutesPerDefect=10` + 根因清晰 + 可自测（`DefectAgentController`） | 直接修 → `workflow/complete` 回写 commit/PR/trace |
| **请示后做** | 非轻量：超阈值 / 根因不清 / 影响面大 | 评论说明原因 → `workflow/block`（默认 `stopRun=true`）→ 缺陷切 `awaiting` 退出自动队列 |
| **禁止自动做** | `forbiddenScopes`：破坏性删除、数据库迁移、权限模型重写、跨服务协议改造、无法自测的用户关键路径 | 永不自动执行，一律升级人工 |

`DefectEscalationWorker`（每 5 分钟扫描，按严重度 blocker 2h / critical 4h / major 24h / minor 72h 催办）是边界的「兜底监工」：自动队列没动静的缺陷由它催办、升级团队 Leader，保证「请示后做 / 禁止自动做」的缺陷不会被无声丢弃。

## 四、五层自治回路（每层接真实代码）

边界定「能不能做」，五层回路定「做得对不对」。下表给每层的**自治机制 / 现状（已落地，真实文件字段）/ 缺口要建（具体）**：

| 层 | 自治机制 | 现状（已落地） | 缺口要建（具体） |
|----|----------|----------------|------------------|
| 认知 | 目标还原 + 现状核实 | `DefectPolishService` 润色描述、`StructuredData` 抽要素 | 领单后强制一步「意图还原 + 复现/定位确认」，写入 `Run.Items[].cognitionNote` |
| 规划 | 值不值加权 | 二元闸门 + `Trace.RiskLevel` + `FixReport.ConfidenceScore(0-100)` | 把 confidence 接进领单：`autoFixScore = 成功率 × 影响面 × 回滚代价`，低分自动降档「请示后做」 |
| 执行 | 事实核查 + 自测 | `probe --safe`、§8.1 自测优先 | 执行中「预判 vs 实况」严重不符即 `block` 重规划，落 `Run.Items[].factCheckMismatch` |
| 记忆 | 情景召回 | `defect_resolution_traces` 账本、`DefectMessage.Seq` 续传 | `start-next` 附带「相似历史 trace」（同模块/同症状/同根因）供复用处置策略 |
| 监督 | 事前三道阀 | `block`+`stopRun`、circuit-breaker、scope-check、SKILL 禁止清单 | 统一收口 + 新增 fix-break-fix 循环熔断 |

### 4.1 规划层：从「二元闸门」到「加权决策」（要建）

现状是「≤200 行就一律自动修」。本体系要求把已存在但闲置的 `ConfidenceScore` 接进领单决策：

- `start-next` 返回的 `agentTask` 增加三项输入：`successProb`（基于相似 trace 历史成功率）、`impactScope`（受影响模块/用户面）、`rollbackCost`（是否易回滚）。
- 智能体据此算 `autoFixScore`；低于警戒线时**主动降档**为「请示后做」，哪怕它形式上是轻量改动（≤200 行）。
- 判定口诀：行数小 ≠ 该自动修。算的是账，不是行数。

### 4.2 记忆层：从「账本」到「经验库」（要建）

`defect_resolution_traces` 现在只按 commitSha 给更新中心做关联。本体系要求它成为可召回的经验：

- 领单时按「模块 + 症状关键词 + 根因签名」检索相似 trace，附在 `agentTask.similarRecall`。
- 智能体复用上次的处置策略、踩过的坑、验收结论；相似缺陷不再每条都是新手。

### 4.3 监督层：三道事前护栏（统一收口 + 补熔断）

把散落机制收敛成一个明确的「动作前安全阀」清单：

1. **合规红线校验**：动作是否触 `forbiddenScopes` / `protected_paths` / 跨环境（正式 vs 测试库）。触线 → 不执行（复用 SKILL 禁止清单 + `scope-check`）。
2. **不确定性预警**：`autoFixScore` / `ConfidenceScore` 低于警戒线 → `workflow/block` 升级人类，而不是硬猜着改。
3. **紧急熔断**：监测异常反馈循环 → 自动终止 + 告警。两类：①**长任务兜圈**（`blocked-state-circuit-breaker`：撞外部 blocker ≥8 提交或 ≥2h 净零进展）；②**fix-break-fix**（要建：同一 `DefectId` 在最近 N 次 run 中反复领取 / 反复 `failed`，达阈值即锁定该缺陷为 `awaiting` 并告警，禁止再自动领取）。

## 五、自治决策回路（一条缺陷的完整流转）

把上面五层串成体系实际跑的一条回路，每步标注所属层与真实端点：

```
start-next 领单
  → [认知] 意图还原 + 复现/定位核实 ······· 不符 → block 升级
  → [记忆] 相似 trace 召回，复用处置策略
  → [规划] 算 autoFixScore（成功率×影响面×回滚代价）
            低分 → 降档「请示后做」→ block(stopRun=true)
  → [监督·阀1] 合规红线校验 ··············· 触线 → 拒绝执行
  → [执行] 修改 + 自测（本地/集成/CDS 预览/浏览器，§8.1）
            执行中预判与实况严重不符 → 回到规划层 / block
  → [监督·阀3] fix-break-fix 循环检测 ······ 命中 → 锁定 + 告警
  → workflow/complete 回写 commit/PR/trace（含 confidence 留痕）
  → [记忆] 处置结构化留痕，供未来召回
```

`DefectAutomationRun.Items[]`（含 `FailurePhase` / `FailureReason`）是这条回路的审计轨：每一步的停下、降档、熔断都落在 run item 上，可回溯。

## 六、数据模型增补（具体字段，草案）

在不破坏现有结构的前提下增补（均为可空、向后兼容）：

| 模型 | 新增字段 | 用途 | 所属层 |
|------|----------|------|--------|
| `DefectAutomationRun.Items[]` | `cognitionNote` | 意图还原 + 现状核实结论 | 认知 |
| `DefectAutomationRun.Items[]` | `autoFixScore` / `factCheckMismatch` | 加权决策结果 / 事实核查偏差 | 规划·执行 |
| `DefectResolutionTrace` | `rootCauseSignature` | 根因签名，供相似召回索引 | 记忆 |
| `DefectResolutionTrace` | `confidenceScore` | 把 `FixReport` 的 confidence 沉淀到日常 trace | 规划 |

`RiskLevel`（light/medium/heavy）已存在，直接纳入规划层加权，不新增。

## 七、协议增补（workflow.v1 → 自治钩子，草案）

只加钩子，不改既有契约语义：

- `start-next` 响应 `agentTask` 增补 `similarRecall`（相似 trace 摘要数组）+ `decisionInputs`（successProb / impactScope / rollbackCost）。
- `complete` 入参增补 `confidenceScore`，写入 trace。
- `block` 入参增补 `loopGuardHit`（fix-break-fix 命中标记），命中时强制 `stopRun=true` 且不再自动领取该缺陷。

## 八、对外申明（让用户预知边界）

缺陷自动化面板、每日任务提示词、`ai-defect-resolve` SKILL 开头必须申明体系的价值观，让用户预先知道它会在什么时候停：

> 缺陷自动化是一个有边界、能担责的自治体系，不是闷头狂改的脚本——它在不确定时主动请示、在触及红线时拒绝执行、在异常循环时自动熔断。

这呼应 `expectation-management.md`：让用户任何时刻都知道「它会做什么、不会做什么、什么时候回来找我」。

## 九、关联文档

- `spec.defect-agent.automation-protocol.md` —— 机械契约（端点/状态机/幂等），本体系是它之上的决策治理层
- `design.defect-agent.md` —— 缺陷管理主设计（本文是其自治治理子设计）
- `design.defect-agent.share-skill-architecture.md` —— `FixReport.ConfidenceScore` 的来源路径
- 技能 `.claude/skills/ai-defect-resolve/SKILL.md`（v1.8.0 起）—— 本体系的**执行落地**：把自主三档边界 + 五层自治回路写成智能体每条缺陷必跑的自检（complete/block 前门禁）。设计是架构，技能是操作手册，二者双向引用
- 技能 `.claude/skills/issues-autofix/SKILL.md`（v2.0.0 起）—— **同源无人值守 Agent**，共用本体系的五层自治模型（§0.5），按 GitHub issue 场景做等价落地（认知/规划补齐，监督层复用其既有跳过/边界/兜底）
- 规则：`blocked-state-circuit-breaker.md`（紧急熔断）、`closed-loop-acceptance.md` / `e2e-verification.md`（现状核实与闭环）、`snapshot-fallback.md`（旧描述未必成立）、`expectation-management.md`（对外申明）、`no-rootless-tree.md`（缺什么暴露什么，不假装能造）

## 十、风险与已知边界

- 规划层加权依赖历史成功率，冷启动期（trace 样本少）`successProb` 不可信——此期应保守降档、偏向「请示后做」，并在 `debt.*` 记录待样本积累后回调阈值。
- 相似召回的「根因签名」算法未定，首版可先用模块 + 症状关键词的粗匹配，避免无根之木式的「假装有语义检索」。
- 本设计为草案，落地需拆 `plan.*` 分批实现（先认知/监督熔断，再规划加权，最后记忆召回）；未实现部分不得在面板/提示词里申明为已具备。
