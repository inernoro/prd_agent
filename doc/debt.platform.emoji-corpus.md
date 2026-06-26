# 历史 emoji 语料清理 已知债务台账

> **版本**：v1.0 | **日期**：2026-06-26 | **状态**：开放（独立清理任务，未排期）

## 一、问题

CLAUDE.md / AGENTS.md §0 禁止任何 emoji。但仓库**存量语料**里仍有大量历史遗留 emoji，主要分布：

- `.claude/skills/**/SKILL.md` 及其 `reference/*.md`：用 emoji 作状态/分级标记（对勾、叉号、警告三角、灯泡、红/绿圆点、实心星、空心方框 等）。
- `doc/**/*.md`：约 2600+ 处既有 emoji（含语义状态标记），散在 130+ 文件。

下游放大点：`scripts/bundle-official-skills.mjs` 把官方白名单技能的 SKILL.md 正文打包进
`prd-api/src/PrdAgent.Api/OfficialSkills/official-skills.generated.json`，该 JSON 由 API 下发给
海鲜市场/下载用户 —— 于是源文件里的 emoji 会**原样出现在对外产物**里。Codex/Bugbot 因此反复
（多个 PR）标这条 P2。

## 二、为什么记债而不是现在改

- 体量大：跨 130+ doc 文件 + 数十个 skill 文件，**多数 emoji 是语义状态标记**（对勾=通过 / 叉号=未做 /
  警告三角=警告），删改需逐一替换为等义文案（「通过 / 未做 / 警告」），不是机械删字符。
- 风险/收益：在一个功能 PR（如知识星球）里铺开全量替换，diff 巨大且易误伤，违反 scope 收敛与
  blocked-state-circuit-breaker（不在功能分支里夹带大范围无关 churn）。

## 三、清理方案（待专项排期）

1. 先治**对外产物**：de-emoji 官方白名单技能（INCLUDE 列表）的 SKILL.md + reference，重跑
   `bundle-official-skills.mjs`，确认 `official-skills.generated.json` 零 emoji。这步范围小、收益高
   （直接消除对外暴露 + 止住 Codex 复发）。
2. 再治 `doc/` 存量：分批按目录替换 emoji 状态标记为文案，配一个 CI 守卫（新增 emoji 即 fail）防回潮。
3. 守卫落地后，本债务关闭。

## 四、关联

- `CLAUDE.md` / `AGENTS.md` §0 —— 禁 emoji 总则
- `scripts/bundle-official-skills.mjs` —— 把 SKILL.md 打包进对外 JSON 的放大点
- PR #923 review：Codex 多次标 `official-skills.generated.json` 残留 emoji（task-handoff 示例等）
