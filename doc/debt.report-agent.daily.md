# debt.report-agent.daily

| 字段 | 内容 |
|---|---|
| 模块 | 日报技能（`daily-report-summary` + `reference/publish.py`） |
| 状态 | open（功能已可用，2026-05-31；以下为已知边界与后续优化） |
| 关联 | `.claude/skills/daily-report-summary/`、`create-visual-test-to-kb`、文档空间「日报知识库」 |
| 提出 | 用户 2026-05-31：日报技能 + 视觉验收联动，提示词精简、逻辑沉淀进技能 |

---

## 已知边界

### 1. committer date 在 fast-forward / rebase 合并下的口径漂移

本仓库 PR 全部走 **merge commit**，merge 的 committer date 即「落地主干」时间，按 `--first-parent <main>` + `%cd` 日期文本过滤当天提交，口径准确。

但若仓库改用 **fast-forward / rebase 合并**：被合并的提交保留更早的 committer date，可能让「当天 ff 落地」的提交按更早日期归档——表现为当天显示零活动而实际已发版，且与 merge 穿透统计不一致。

**后续修法**：遇到 ff/rebase 流程，改用 GitHub PR 元数据的落地 SHA 日期判定归属（参照 `weekly-update-summary` 纪律 3），不要只信 commit 的 committer date。

### 2. 视觉取证依赖预览环境 + 浏览器登录凭据

Phase 4.5 取证走 `create-visual-test-to-kb` 的 Playwright harness，依赖：预览环境就绪 + `MAP_AI_USER` / `MAP_ACCEPT_PASS` 浏览器登录凭据。无凭据 / 环境未就绪时跳过取证，报告显式注明「本期无截图」，不伪造证据。

**后续修法**：把日报取证凭据纳入 CDS 远端环境注入清单，让取证默认可用。

### 3. 同日重复发布产生多条同名条目

`publish.py` 按库 find-or-create，但条目不做同日去重（`metadata.dailyDate` 已落，未据此拦截）。同一天重复跑会生成多条标题相同的条目。

**后续修法**：发布前按 `metadata.dailyDate` 查重，命中则更新已有条目而非新建（幂等）。

## 后续优化（非阻塞）

- 「按来源 / 标签订阅」与已读状态，向「个人早报」演进。
- 自动化定时：用户 2026-05-31 暂不做 cron；如需，走 Claude Code on the web 的定时触发（在环境侧配置，不入仓库），技能逻辑不变。
