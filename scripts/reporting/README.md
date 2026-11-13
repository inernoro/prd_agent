# 项目报告技能：连续证据与原刊物

目标入口是 `daily-report-summary` 的日报报纸和 `weekly-update-summary` 的项目周刊。月度模式生成同一项目的管理汇总，保留太阳刊徽；员工个人月报继续由本人表达和提交。此目录没有员工报告API或周报Agent页面改动。

## 实际生成链路

`edition.py collect` → 原技能六源采集器及连续台账 → `edition.py build` → 原日报/周刊模板 → `edition.py verify` → 原知识库 `publish.py`。

所有命令在仓库根执行。临时数据与展示产物放仓库外；默认台账位于Git common-dir的私有`report-skills/<project>/ledger.json`。跨期与本期重跑均合并台账，断源不会丢本期已存事实。

```bash
REPORT_WORK=$(mktemp -d /tmp/project-report.XXXXXX)
python3 scripts/reporting/edition.py collect \
  --start 2026-09-28 --end 2026-10-04 --cadence weekly \
  --mainline origin/main --git-head <固定主干SHA> \
  --base <项目知识库API根地址> --impersonate <报告账号> --project <项目ID> \
  --out "$REPORT_WORK/context.json"
python3 scripts/reporting/edition.py build \
  --context "$REPORT_WORK/context.json" --start 2026-09-28 --end 2026-10-04 \
  --cadence weekly --out "$REPORT_WORK/edition"
python3 scripts/reporting/edition.py verify --bundle "$REPORT_WORK/edition/bundle.json"
python3 scripts/reporting/edition.py publish --bundle "$REPORT_WORK/edition/bundle.json" --local
```

日报先运行技能的 `coverage_window.py`，把结果以`--coverage-window`传入collect。窗口携带上一条有效刊物的SHA、精确时间和台账；失败pending条目不能遮盖上一期有效检查点。可用`--evidence-ledger/--ledger-out`指定持久文件，`--pull-requests`输入原始PR对象，`--evidence-input`补充明确来源关联。跨月只改cadence和时间区间，不把周报篇数或提交数当成果数。

需要发布且用户已经授权时，去掉`--local`并传`--base/--impersonate`，复用原日报/周报知识库。任务禁止生产发布时仅生成本地文件或独立只读展示，不覆盖正式库。默认目标分别为日报知识库、周报知识库、项目月度汇总知识库；月度kind是`project-monthly-report`，不会调用员工个人月报接口。

## 一致性与来源

bundle保存输入ledger/context、事实report、MD、HTML及文件哈希、模板哈希与精确采集窗口。发布时重新计算事实并重渲染原模板，不能只改正文或hash绕过规则。正文逐字读回后才提交台账与SHA水位线，元数据再次读回确认。失败不宣布发布成功；若台账被服务端丢弃，回退检查点避免永久漏采。元数据`verified`表示刊物与规则输入一致，不表示真人已审核全部来源。

每项事实有稳定workItemId、完整版本、带时区时间、来源URL与原文摘录。Git/PR明确closing引用或人工核查的绑定才能建立业务身份，不按标题猜测。日报全文、正文hash和旧水位线保留；内容修订按更新时间观测，不能倒灌历史。HTML沿用原模板CSS与MAP报头，旧静态样例的业务数字不进入新刊。

阶段独立：合并不是功能完成，CI不是功能验收，预览不是正式上线，旧版本验证不能覆盖新修改，正式回滚不算新增成果。未关联事项的CI失败、发布失败或阻塞单列来源记录与闭环缺口。无新提交也须延续已知阻塞。

效率、工时与收益必须有数值、单位、方法、样本范围、周期及来源；无证据为不可用。只有相邻等长、单位/方法/样本一致的周期比较，不做收益或因果外推。SHA覆盖窗口与精确时间保留；不得把早晨采集写成覆盖至当天23:59:59。非Git来源统一Asia/Shanghai，Git原日期文本统计只在活动附录注明口径。

## 固定评测与失败案例

权威技能基线见 [skill-baseline/README.md](skill-baseline/README.md)。它保存真实旧日报HTML、项目周刊MD/HTML、原采集脚本、原模板以及完整来源和哈希。

- 严格同输入部分：旧/新采集函数读取同一批冻结原始API记录，比较完整版本、时间归桶、日报全文及水位线的丢失；不把它说成旧LLM准确率。
- 历史刊物部分：逐项保存旧正文问题、正例及待澄清项；缺少旧完整模型输入时，不虚构同提示重跑结果，不把旧版全判错。
- 当前七组来源片段：经真正 `build → verify → 原publisher --local` 产生原刊物，再对实际report.json检查跨日、返修、合并未发布、失败、外部阻塞和跨月。独立预标注尚未经过真人审核；没有旧月报时不造旧月报基线。

早期 `report_evidence/legacy-replay.json` 文件是明确的**合成负例**，只用于规则边界测试，不是旧技能实际输出，不用于宣称改进收益。真实基线与其分开，失败案例不删除。

```bash
python3 scripts/reporting/skill-baseline/replay.py \
  --out /tmp/skill-replay.json --work /tmp/skill-replay \
  --require-edition --local-publish
python3 scripts/tests/test_report_skill_core.py
python3 scripts/tests/test_report_skill_publication.py
python3 scripts/tests/test_skill_report_evaluation.py
python3 -m pytest .claude/skills/weekly-update-summary/tests -q
```

## 交接边界

| 维度 | 说明 |
|---|---|
| 入口 | 两个原项目报告技能、edition.py及原知识库发布器 |
| 数据 | 本地schemaVersion=1、固定来源快照、发布metadata台账；无产品数据库迁移 |
| 权限 | 复用原知识库授权；不提交员工月报、不部署生产、不自动建PR |
| 兼容 | 旧原文重发必须显式给legacy-unverified-reason并标未核查；不能当新合格报告 |
| 局限 | 旧正文自由语义仍需核查；任务身份、验收范围、版本包含关系或历史覆盖未知时保留缺口 |
| 回滚 | 回退技能脚本不会删除知识库已有刊物；保留已发布原文、检查点及台账来源，不改写历史 |
