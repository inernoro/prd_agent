# 技能日报、周报与月度事实的固定样本

这里验证的是 `daily-report-summary` 和 `weekly-update-summary` 技能，不是周报 Agent、员工报告 API 或后台页面。

## 三种证据分别解释

1. **真实旧采集器回放**：`archive/old-collect-week-context.py` 是 Git `3035365def7b30a28309b89a21756717fda846dd` 的完整原文件，方法体未改。测试仅把 `_curl` / `_cdscli` 换为固定响应，运行原 `collect_daily_reports`、`collect_acceptance` 与标准技能 `--deeplinks` 路径。日报元数据/完整正文来自同条目的真实只读抓取；验收元数据来自已保留的真实快照。传输层分页封套由测试构造，不能称为当年请求的原始完整 HTTP 日志。旧新函数接收同一冻结记录，这一层可严格比较字段保留与日期口径。
2. **真实历史正文复核**：保留三个旧周报 Markdown、一份旧周报 HTML、三份旧日报完整 HTML，以及原模板。Git 产物有固定提交和 SHA256；日报是本次只读抓取的历史存量正文，不能声称从未编辑。没有取到当时 LLM 的完整输入和响应，因此不伪造“旧生成器”，不把历史正文复核称为同输入模型改善率。
3. **固定真实来源重建**：七组片段覆盖跨日、重复返修、合并未发布、旧验证不覆盖后续修复、失败验收、外部阻塞与跨月。来源台账是明确标记的归属投影，保留 Git/验收/债务原文、版本和时间；预标注在运行当前引擎之前固定，尚未经真人审核。月报没有旧原文时写“未取得”，不能填一个旧分数 0 来制造提升。

## 复现

```bash
python3 scripts/reporting/skill-baseline/replay.py \
  --out /tmp/report-skill-baseline/comparison.json \
  --work /tmp/report-skill-baseline/editions \
  --require-edition
python3 scripts/tests/test_skill_report_evaluation.py
```

当前技能的正式构建入口为 `scripts/reporting/edition.py build --ledger … --context … --start … --end … --cadence daily|weekly|monthly --out …`。回放会实际调用该入口，在仓库外保存每组 JSON/Markdown/HTML，而不是把独立事实页面冒充完整技能报告。`--require-edition` 是交付检查必须项；缺入口则失败。诊断时可不带该开关先单独检查事实规则，但这种输出不算完整技能交付。

## 如何看结果

- `collectorReplay`：同一固定响应进入真实旧/新采集器，检查完整版本是否丢失、UTC 创建日期是否被当作北京时间、日报正文与 SHA 水位线是否保留。创建日期只证明观测日，不证明实际测试执行日期。
- `historicalArtifactReview`：原文片段及声明的已知遗漏。`historical-review.json` 保留正确反例：旧 W38 已经明确旧验收不覆盖后续修改，旧日报也披露过缺少实拍，旧 W40 明确区分正式发布并记录过失败。这些不能被评测故意判错。
- `currentSourceCases`：当前事实与预标注逐项比较，失败记录必须保留。其计分只覆盖声明的阶段、去重、来源和无证据指标，不是任意自然语言自动评分，也不是全项目交付完整率。

旧 W40 的“近乎停摆”从提交量外推团队节奏，缺少工作与计划测量；验收深链留在 `/tmp`，已交付底稿无法直接核查；知识库目录同步的已知未复验项没有持续跟踪。这些是明确范围内的历史问题。“均已修复”与未实操声明并存只列阶段表述待澄清，不自动判修复事实为假。附录、风险与计划对同一事项的必要引用不计为重复成果。

旧 W40 记载正式发布尝试 3 / 成功 1 / 失败 2，今天保留期之外的空台账不能推翻它；同样，也不能把聚合发布次数强行绑定到某个功能说它已上线。所有历史不足都保留在样本限制中。

## 来源与读取边界

`archive-manifest.json` 记录每份完整原文的来源、获取方式、时间和哈希。历史日报原域名 `main-prd-agent.miduo.org` 的 Python 默认 User-Agent 返回 Cloudflare 1010，使用普通浏览器 User-Agent 后可正常只读取得；环境给定的另一个生产部署上同 token 返回 404，未用它否定旧报告存在。回放默认不请求在线服务，不修改知识库，不填写或提交员工个人月报。
