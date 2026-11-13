# 产品实际报告链路的固定回放

这里不再用人工伪造的旧模板输出作质量基线。旧代码从固定 Git 版本 `0459c01b162ba17c0230f8ad8cdf26d02c199f03` 取回，核对 SHA256 后只机械更名类标识符，让完整原类与当前服务同时加载；方法体不改。

旧档直接反射原 `BuildUserPrompt`、`ParseGeneratedSections`、`BuildRuleBasedSections`。新档走产品真实使用的 `ReportEvidenceService.FromActivity`，再用相同的 `ReportEvidenceEngine.Build`、`ParseProposedOrder`、`BuildSections`。两档消费同一冻结活动与来源上下文，重跑时不会查询变化中的生产活动计数，也不会写生产数据库。

## 两类证据分开解释

- **真实历史模型记录**：2026-W41 原请求 messages、模型原响应、实际保存的完整四章报告。旧源重新构造的用户提示词与日志原文逐字一致；原响应解析后的四章内容也与当时保存的报告一致。此档回放捕获响应，不冒充本次重新调用模型。
- **上游失败回退与真实源投影**：对同一真实 W41 输入作受控失败，直接执行旧规则回退；另外将可查的 Git、验收与债务记录固定投影为跨日、重复返修、合并未发布、测试失败、外部阻塞和跨月输入。它们明确标记为来源投影或故障注入，不冒充历史生产请求。

真实 W46 四章旧报告另行完整保留，其中“按计划推进”“未发现明显阻塞风险”缺少任务或风险证据。现在按历史窗口重新查活动会得到变化后的数字，因此这份旧原文不与今天重查的输入冒充严格同输入对比。

## 复现

先构建当前产品 API，并在可访问旧版本 Git 对象的完整仓库中执行：

```bash
python3 scripts/reporting/replay_product_baseline.py \
  --dotnet dotnet --skip-product-build \
  --work ../work/report-product-replay \
  --out ../work/report-product-replay/comparison.json
python3 scripts/reporting/evaluate_product_reports.py \
  --replay ../work/report-product-replay/comparison.json \
  --out ../work/report-product-replay/evaluation.json
python3 scripts/tests/test_product_report_evaluation.py
```

没有预构建的 API 时省略 `--skip-product-build`。旧 Git 对象缺失时应先取回该固定提交；不得退回手写旧算法。`--product-repo` 仅用于将独立评测 worktree 指向同一次正在验收的当前 API。

## 如何看数字

运行待测引擎前预先固定的独立来源标签放在 `scripts/tests/fixtures/report_product_generation/gold.json`；完整冻结输入、原真实请求响应和旧完整报告也保存在同一夹具目录。`retained-old-output.json` 是实际执行旧源的结果，`retained-evaluation.json` 保留逐条失败位置与原文，后续不能删除失败案例来换取通过。

固定回放中，旧档遗漏 5、交付章节重复行 7、无证据断言 6、缺少直接来源引用 34；当前档四项均为 0。指标会重叠，不能相加为质量分。这证明本批输入的来源归属、阶段防错和完整正文行为；不等于模型线上改善率，也不声称已覆盖任意自然语言错误。这些标签不是已完成的真人评审；未声明的自由语义仍需人工核对。
