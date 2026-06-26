# CDS Agent 验收 smoke 断言漂移 已知债务台账

> **版本**：v1.0 | **日期**：2026-06-26 | **状态**：开放（需专项「修复或退役」，未排期）

## 一、问题

`scripts/smoke-cds-agent-*.sh` 里有一批 2026-05 的「Phase 3 / P4-1 验收包静态 smoke」，靠
`require_match`（`grep -Fq` 固定串）断言某些 doc / 脚本里**存在特定文案/信号**。这些断言随
被引文档的后续改写（含本仓库 2026-06 的文档全量重命名）**漂移**，导致 smoke 失败：

- `smoke-cds-agent-p4-1-remote-preflight.sh`：
  - line 37 断言 roadmap 含 `远端 preview 当前运行时代码已覆盖 P3-5d` —— 该串**从未在该 doc 历史里出现过**
    （`git log -S` 为空），doc 实际用的是「运行时代码无需重复部署 / 无运行时代码差异时不重复部署」等措辞。
  - line 42 断言 `scripts/smoke-cds-agent-workbench-visual.sh` 含 `provider/profile guidance` —— 也已漂移。
  - 即「改一条过、又卡下一条」的链式漂移。
- `smoke-cds-agent-phase3-acceptance.sh`：当前 HEAD **PASS**（Codex 旧评论里「缺 report md」已被后续提交修复）。

补充：Codex 在 PR #923 早期还标过「audit-cds-agent-goal.sh / smoke-cds-agent-shared-service-pool.sh
被删却仍被调用」「OfficialSkillTemplates 版本滞后 1.7.0」「DefectResolveSkillMinVersion=1.5.0」——
这些在 **当前 HEAD 已全部不成立**（脚本都在、版本都已是 1.8.0），属对旧 commit 的评审，无需处理。

## 二、为什么记债而不是现在逐条修

- 这批 smoke **未接入 CI**（`.github/` 无引用），是 2026-05 CDS Agent workbench 那轮的手工取证产物。
- 断言是「链式漂移」：逐条改 string 会一条接一条冒出来，属 blocked-state-circuit-breaker 警示的
  「在已腐化的脚本上反复打补丁、报告/脚本不计进展」的反模式。不应在功能 PR（知识星球）里夹带。

## 三、处置方案（待专项排期）

二选一，整组处理而非逐条打补丁：

1. **退役**：这批一次性验收取证 smoke 若已无人跑，直接归档/删除 + 清理 `collect-*`/Controller 里的调用。
2. **修复**：若仍要保留，把 `require_match` 的硬编码文案换成**稳定不漂移的结构化锚点**（如报告 JSON 的
   字段名、固定标题），并接入一条最小 CI job 防再次腐化。

## 四、关联

- `scripts/smoke-cds-agent-p4-1-remote-preflight.sh` / `smoke-cds-agent-phase3-acceptance.sh`
- `doc/design.cds.agent.commercial-architecture-and-roadmap.md`（被断言的 roadmap）
- `.claude/rules/blocked-state-circuit-breaker.md` —— 不在腐化脚本上 grinding
