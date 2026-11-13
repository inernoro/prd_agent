---
name: daily-report-summary
description: 从固定主干水位线、日报原文、验收与发布来源生成项目日报报纸；按稳定事项连续跟踪交付、风险与下一步，并发布到日报知识库。触发词：生成日报、写日报、今日大事、daily report、/daily。
---

# 项目日报报纸

本技能生成「今日大事早知道」项目日报刊物。入口是本仓库脚本与知识库，采用 `reference/report-template-html.html` 的纸张版式和月亮刊徽。员工个人月报的评价、认可、建议及提交仍由本人处理；本技能不调用员工报告 API。

## 必须保持的不变量

- 一件事沿用同一事项 ID。明确的任务引用、已核查的来源绑定或上期台账才能建立关联；标题相似不能建立身份。多个提交、PR、日报引用不重复算成果。
- 功能完成、功能验证、正式上线分别核查版本、范围与直接来源。合并、CI通过、预览部署不能替代三个阶段。后续修改使旧验证待复验。
- 日报原文是线索；没有明确事项或阶段证据时保持未归属/未证实。原文修订用观测/更新时间留档，不将未来修订倒灌到早期报告。
- 未解决阻塞即使没有提交仍要连续展示。零提交不能成为停止采集验收、风险、发布或旧事项的理由。
- 缺数据不填0、不报无风险、不硬凑亮点。效率、工时、收益只采用含单位、方法、样本范围、周期及来源的测量。提交数和代码量仅作附录活动记录。
- 主干取远端默认分支并固定SHA。日报覆盖 `(上期lastCommit, 本期headSha]`，不是截到每天零点；断跑可续采，不重复处理已覆盖提交。
- 事项事实使用带时区原始时间、Asia/Shanghai报告边界；Git旧统计的提交日期文本仅作活动附录，两者口径明确区分。精确采集右端不能伪造为当天23:59:59。
- 新技能刊物只能从已核验bundle发布。正文、台账、日期、模板或水位线被手改后须重建；发布器读回正文和元数据后才标记成功。失败pending空壳不能成为下一期水位线。

## 1. 读上期水位线与台账

先读取仓库规则、项目身份与技能脚本；确定用户要求的目标日期`TODAY`。临时产物全部放仓库外。以下命令在仓库根运行：

```bash
REPORT_WORK=$(mktemp -d /tmp/project-daily.XXXXXX)
DEFAULT_BRANCH=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)
DEFAULT_BRANCH=${DEFAULT_BRANCH:-origin/main}
git fetch origin --quiet
python3 .claude/skills/daily-report-summary/reference/coverage_window.py \
  --base "$MAP_BASE" --impersonate "$REPORT_USER" --branch "$DEFAULT_BRANCH" \
  --target-date "$TODAY" > "$REPORT_WORK/window.json"
```

`MAP_BASE`是当前项目的知识库API根地址，`REPORT_USER`是授权的报告账号；复用现有环境配置，不把凭据写入报告。第一次没有历史时明确记录历史覆盖不完整。读不到水位线、SHA不可达/非祖先或历史不足时拒绝推进水位线，不无声退回当天。

窗口JSON同时携带`baseSha/headSha`、精确`coverTo`、上一期`deliveryEvidenceLedger`及`previousEntryId`。旧日报尚无台账时只保留已知水位线与缺口，不从旧正文直接制造完成事件。

## 2. 采集六源并更新连续台账

从window.json确定`COVER_START`（上期覆盖起点或首次运行目标日）和固定`HEAD_SHA`。先补全浅克隆，再使用同一入口采集：

```bash
python3 scripts/reporting/edition.py collect \
  --start "$COVER_START" --end "$TODAY" --cadence daily \
  --coverage-window "$REPORT_WORK/window.json" --mainline "$DEFAULT_BRANCH" \
  --base "$MAP_BASE" --impersonate "$REPORT_USER" --project "$PROJECT" \
  --out "$REPORT_WORK/context.json"
```

默认连续台账保存在Git common-dir的私有`report-skills/<project>/ledger.json`；也可显式传`--evidence-ledger/--ledger-out`。采集器同时合并本期已存台账、上期发布元数据和新来源，采集中断不能删掉已核实的本期事实。

需要补充原始PR对象时传`--pull-requests <JSON>`；只有明确单一closing引用才跨PR归到同一任务。需要已核查的验收/发布关联时用台账`artifactBindings`或`--evidence-input`，保留原始完整SHA、范围、环境、发生/观测时间和来源原文。不能靠标题、verdict或短SHA猜功能验收。

采集器保留Git、日报原文与水位线、CDS验收、缺陷、正式发布、团队/采用度的可用性和原记录。任一来源失败独立标缺口。正式回滚会使明确对应的新版本上线证据失效，恢复旧版本不计新成果。CI失败和未归属失败须可见，闭环未知不能写已解决。

## 3. 按原日报模板构建刊物

```bash
python3 scripts/reporting/edition.py build \
  --context "$REPORT_WORK/context.json" --start "$COVER_START" --end "$TODAY" \
  --cadence daily --out "$REPORT_WORK/edition"
python3 scripts/reporting/edition.py verify --bundle "$REPORT_WORK/edition/bundle.json"
```

输出`report.html/report.md/report.json/ledger.json/context.json/bundle.json`，同一事实驱动两种正文。HTML实际读取原日报模板CSS与MAP报头，采用月亮刊徽；静态样例中的旧业务数字不得进入新刊。内容顺序为管理结论、风险、连续进展、下一步、测量与缺口、来源索引及活动附录。

不根据提交数量决定亮点个数。没有新成果时可报告延续事项、失败、外部阻塞或采集缺口；确实没有这些内容时如实给出无新证据的说明，不虚构工作。

## 4. 展示与发布

先看实际生成HTML，核对来源锚点、窄屏布局、阶段及采集右端。原文与事件、版本或范围不一致时修正来源后重建bundle，不直接改正文来改状态。

仅本地预览/实现回归时：

```bash
python3 scripts/reporting/edition.py publish \
  --bundle "$REPORT_WORK/edition/bundle.json" --local
```

用户已授权发布日报时，复用原`reference/publish.py`知识库流程：

```bash
python3 scripts/reporting/edition.py publish \
  --bundle "$REPORT_WORK/edition/bundle.json" \
  --base "$MAP_BASE" --impersonate "$REPORT_USER"
```

默认目标为「日报知识库」，同日原地更新保留分享链接。`deliveryEvidenceLedger/deliveryEvidenceDigest`与SHA水位线一并写入且读回核验；未知写入结果不宣布成功、不推进检查点。历史原文重发如需绕过新bundle须明确`--legacy-unverified-reason`，元数据会标未核查，不能冒充新技能合格刊物。

本文不授权生产代码部署、员工月报代填/提交或向他人发送通知。任务禁止生产发布时使用本地模式或独立只读展示，不覆盖正式日报库。

## 回归与评测

参见`scripts/reporting/README.md`与`skill-baseline/README.md`。固定样本保留真正旧日报HTML和项目周刊原文，严格采集器同输入回放与历史刊物复核分栏；没有原模型输入的部分不宣称同提示重跑改善率，独立预标注不称已完成真人评审。
