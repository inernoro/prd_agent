# 知识库检索固定评测

40 条固定问题、12 篇合成文档，不含生产数据。题目覆盖 12 条同义表达、8 条跨文档、8 条无答案、8 条无权限和 4 条字面控制题。固定文档标识用于评测，导入临时库后由执行器维护真实 entryId 到固定标识的映射，禁止为提高分数修改题目。

这些文件是可复跑验收的输入与工具。每次执行的原始观察、截图和报告放 `work/`，并按验收知识治理归档 CDS `/reports`；不要把单次结果提交进 `doc/` 或当作长期规范。真实报告应记录目标提交、模型标识、部署作用域、临时库标识和清理回执。

## 先跑基线

```bash
python3 -m unittest discover -s scripts/acceptance/knowledge-retrieval -p 'test_*.py' -v
python3 scripts/acceptance/knowledge-retrieval/literal_baseline.py --output work/kb-baseline-observations.jsonl
python3 scripts/acceptance/knowledge-retrieval/evaluate.py --mode offline-diagnostic --observations work/kb-baseline-observations.jsonl --output work/kb-baseline-report.json
```

最后一条退出码 `2` 表示回答及原文打开证据尚缺，属于预期的阻塞状态，不是测试失败。基线脚本复现现有 `kb_search` 的大小写不敏感字面匹配、owner/public 过滤和更新时间排序；它不连 Mongo、不调用模型、不打开网页。其 recall 和耗时只用于诊断算法，不代表真实部署的召回率、网络耗时或用户端到端效果。中文合成语料不覆盖 Unicode 大小写差异。

## 真实运行的观察契约

每题保存一行 JSON。`queryId` 必须来自固定题集，每题只能出现一次。结果及上下文中的实际条目 ID 先映射到固定标识，引用 URL 则须保持真实路径：因此评分前应同时使用映射后的临时语料副本，将 `entryId`、`storeId` 一起替换为真实值，并对问题期望字段做同一映射。不要修改问题正文或标准事实。

```json
{
  "queryId": "KB-001",
  "retrievedEntryIds": ["travel-policy"],
  "contextEntryIds": ["travel-policy"],
  "latencyMs": 125.6,
  "answerStatus": "answered",
  "answerSupported": true,
  "answerEvidence": "review/KB-001.json",
  "citations": [{
    "entryId": "travel-policy",
    "url": "/document-store?store=evaluation-store&entry=travel-policy",
    "quote": "员工出差住宿每晚报销上限为六百元。",
    "opens": true,
    "supports": true,
    "openEvidence": "screenshots/KB-001-source.png",
    "supportEvidence": "review/KB-001-citation.json"
  }]
}
```

- `retrievedEntryIds` 是检索原始顺序，重复项占用前五名位置，不能先去重或过滤坏结果。
- `contextEntryIds` 是实际送入回答模型的条目清单，必须来自服务端观测。检索结果没有泄漏不能替代上下文检查。
- `latencyMs` 测量检索开始至结果准备完成，包含查询 embedding、数据库读取及排序；端到端回答时间另记，不可混用。
- `answerStatus` 只能为 `answered` 或 `abstained`；未运行可写 `not_run`，相应回答指标将阻塞。
- `answerSupported` 由复核人员对完整答案逐项判断。`answerEvidence` 留下复核记录，不能用模型自评替代。
- 每条引用必须通过同一个普通登录用户点击打开，正文包含精确引文且支持对应结论，分别记录打开和语义复核证据。`kb://`、只返回 200 或只看到知识库列表不能判有效引用。
- `opens` 或 `supports` 未复核时写 `null`，不能写 `true`。证据路径是运行归档内相对路径，归档时必须核对文件存在；脚本不访问浏览器或验证归档文件本身。
- `abstained` 应返回空引用数组。无答案、无权限问题不得从常识编出答案。

```bash
python3 scripts/acceptance/knowledge-retrieval/evaluate.py --corpus work/runtime-corpus.json --questions work/runtime-questions.json --observations work/real-observations.jsonl --output work/real-report.json
```

退出码 `0` 仅说明指标证据完整；指标没有预设的质量阈值，不意味着产品验收通过。退出码 `1` 为权限泄漏，`2` 为证据阻塞。模型凭据缺失时保留原始失败回执，并运行无 observations 的命令产出四项均阻塞的报告，不能用 Stub 结果宣称真实语义效果。

## 指标口径

| 指标 | 分子与分母 |
|---|---|
| recall@5 | 逐题计算前五条唯一命中数 / 应命中文档数，再对 24 条有答案题宏平均；跨文档题必须全部命中才得到 1 |
| 引用正确率 | 能打开、来自授权原文、精确引文存在且支持结论的引用数 / 实际引用总数；缺复核则阻塞 |
| 无依据作答率 | 无支持证据的回答数 / 实际给出答案数；没有有效引用、无答案题仍作答、权限泄漏均计无依据 |
| 检索延迟 | 全部 40 题检索耗时的 p50、p95、最大值；不排除慢题，缺题或非法耗时则阻塞 |

任一未知条目、无权限条目进入结果、上下文或引用即权限失败。缺题、没有回答、没有引用时不把分母空集算作 0% 或 100%。报告提供输入 SHA256，前后两次比较必须冻结同一题集和语料。

## 真实用户闭环与更新删除

用隔离测试账号导入 `corpus.json` 中可读文档到自有临时库；另一个测试账号导入两篇私有文档，禁止将私有文档导入公开库。正常登录页面，从已有通用对话入口自然语言提问，再点击回答引用进入原文，并记录检索结果与回答上下文。API 或伪登录只算诊断验证。

另留生命周期证据：修改一条已索引文档的事实后立即查询旧事实与新事实；删除文档后立即再查；撤销库可见性后用原账号再查。每一步记录写入确认时间、首次新结果时间、旧块是否进入上下文以及配置承诺的时限。旧索引应在新检索中被排除，不能靠重建生产全库实现。若新事实需要显式索引，报告必须区分“旧内容立即失效”和“新内容完成索引后可搜”，明确各自时限；没有实际执行不得写通过。

## 本轮选择的真实入口

正常登录 → 左侧「知识库」创建本人临时库并上传文档 →「百宝箱」→「通用对话智能体」。先明确要求为指定的一篇文档建立检索索引，再用自然语言提问并打开答案中的原文链接。索引由既有对话 Worker 执行，浏览器断开不自动重复调用模型。不要指令模型遍历生产全库索引。

- `kb_search` 的 `semantic` 模式查询已入库文档，缺索引或模型不兼容会明确失败；`literal` 保留原字面算法供基线和标题定位。
- `kb_index` 是写工具，仅本人拥有的明确单篇文档可执行，基础设施只读策略不允许调用。索引与查询复用统一网关已绑定的调用方，不另配供应商密钥。
- 每轮汇总所有搜索事件的检索顺序与耗时，同时将搜索和 `kb_read` 事件里的 `retrievalEvidence.contextEntryIds` 合并为实际送入模型的条目清单。不能只拿搜索列表代替整个回答上下文；官方 SDK 返回的 MCP 文本数组必须先解包，并按 `toolUseId` 关联工具名。
- 更新或删除已提交后，下一次检索回读原文并排除失效块。新正文需要明确重新索引该篇文档；目前没有自动刷新时限，不得把排旧测试写成自动更新验收成功。
- 原文引用使用已有阅读器 `/document-store?store=...&entry=...`。必须在正常登录态实际点击，核对标题、正文和引用句；HTTP 200 的应用壳、`kb://` 标识、只读接口成功都不能替代此证据。
- 回答支持关系须逐题裁定，尤其是跨文档问题。没有答案时应明确拒答，无权限文档必须真实存在于另一位临时用户的私库与索引中，不能用“根本没入库”代替隔离测试。完成后核对两位用户的临时数据清理回执。

单篇大于六十四块或检索作用域超过五千个历史块时明确拒绝，不自动分批遍历全库。模型绑定变化须显式重新索引所选文档；默认相似度阈值尚未校准，不能作为达标证据。
