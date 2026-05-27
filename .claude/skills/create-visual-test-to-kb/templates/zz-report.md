# {项目} · {YYYY-MM-DD HH:mm} · {验收目标}

<!-- ZZ 照做风模板。规则(用户定死,见 standard-v2.md §6.3):
     1 全是大标题(## 步骤N),没有小标题  2 一句话讲清一步,不用两句
     3 讲流程不讲思想  4 同岗位照着做一定能复现  5 一条分支走完再讲下一条(写「续上一步」承接)
     6 每步尽量配图  7 切换页面必截图  8 变化处必画框(harness box/stepClick 已自动)  9 文字在上图片在下({{IMG:}} 占位)
     正文第一行必须是这行 H1(防 --- ,见 §2.1)。机读字段在文末注释。archive_report.py 自动注入标题+meta+把 {{IMG:name}} 换成截图。 -->

> Verdict: **{通过 / 有条件通过 / 不通过}**
> {一句话结论:这功能能不能用、还差什么}

| 项目 | 目标 | 分支 | commit | 预览 | 验收人 | 日期 | 缺陷 P0/P1/P2/P3 |
|---|---|---|---|---|---|---|---|
| {project} | {target} | {branch} | {sha} | {url} | {reviewer} | {date} | {0/0/0/0} |

## 步骤 1 · 登录后从首页点「{导航名}」进入

{一句话:点哪、到哪。}

{{IMG:01-nav}}

## 步骤 2 · {这一步做什么}

{一句话。框已由 harness 自动画在要点的地方。}

{{IMG:02-action}}

## 步骤 3 · {验证变化}

{一句话:看到什么变化 = 成功。变化处已画框。}

{{IMG:03-result}}

## 验收用例一览

| # | 操作 | 预期 | 实际 | 状态 | 证据 |
|---|---|---|---|---|---|
| 1 | {点了什么} | {该出现什么} | {真出现了什么} | pass | 图1 |
| 2 | {点了什么} | {该出现什么} | {真出现了什么} | pass | 图2 |
| 3 | {点了什么} | {该出现什么} | {真出现了什么} | pass | 图3 |

## 缺陷清单

P0/P1/P2:{无 / 逐条一句话:现象 + 为什么必须修}
P3:{优化建议,一句话一条}

## 结论

{对照 Verdict 规则一句话定论。无 open P0/P1 + 用例全 pass = 通过。}

<!-- acceptance-meta
type: acceptance-report
standard: MAP-Acceptance-v2
report_id: acc-{PROJECT}-{YYYYMMDDHHMM}-{SLUG}
verdict: {pass | conditional | fail}
tier: {L0 | L1 | L2}
target_ref: {PR# / commit / 路由 / 功能名}
preview_url: {cdscli 产出}
branch: {分支}
commit: {短 sha}
-->
