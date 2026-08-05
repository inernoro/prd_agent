| feat | acceptance-skill | 每日验收报告新增强制首屏「给你的一页结论」：五行大白话答完产品能不能用 / 验收测完了吗 / 昨天上了什么 / 需要你决定什么，答案用固定枚举开头，归档脚本逐条校验不达标拒收 |
| feat | acceptance-skill | 产品失败与验收失败在首屏强制分开：验收链路或硬门禁失败而产品未失败时必须写「这次没测出来」，不得说成产品坏了；已有 P0/P1 或核心用例失败也不得粉饰成「可以正常使用」 |
| feat | acceptance-skill | 首屏禁用未解释的验收行话（门禁/断言/契约测试/Verdict/SHA/smoke/ready/verify-open 等），判据是「术语后是否紧跟括号解释」，别处解释过不算 |
| feat | acceptance-skill | 交互 HTML 报告新增简版/完整版切换：含首屏结论的报告默认渲染简版（只留结论、昨日工作总结、缺陷清单、问题卡与证据截图），点被收起章节的证据链接时自动展开完整版；模板契约标记与结构 class 逐字节不变 |
| feat | acceptance-skill | 最终回复与 Slack 的「直观汇报模板」下沉进技能，自动化 prompt 不再自带汇报格式，消除 prompt 与技能的双份维护 |
| docs | doc | rule.acceptance.map-enterprise 新增 §7.0、standard-v2 新增 §6.0，定义首屏判据与拒收条件，并同步官方技能规则快照与分发包 |
| test | acceptance-skill | test_archive_report_verdict_contract 增 9 项断言覆盖首屏契约（含模板落地、脚本失败不得写成产品坏了、无法确认不得写成可用、完整性自相矛盾、行话未解释、决策行须给建议）；归档 gate 增简版视图与模板契约断言 |
| ci | ci | 新增 Acceptance Report Gate job：验收规则 SSOT、归档 gate、每日结论契约三个守卫此前无任何 workflow 引用，只有手动跑才会红；连同被守的规则、模板、快照一起登记进 path filter |
| fix | doc-tooling | doc-readability 棘轮守卫断言 ci-status 汇总闸时写死 `cds-build, docs-readability]` 字面量，往 needs 末尾追加任何新 job 都会让这条无关断言变红（形状 4a）；改为解析 ci-status 的 needs 列表判成员，并补「解析到了」与「判据不是恒真」两条防空跑断言 |
| fix | acceptance-skill | 自审发现：判断报告有没有首屏用的是子串命中，正文只要「提到」这五个字就会切简版，而没有任何章节留得住，读者看到一页空白（实测 12 个正文节点被收起 10 个）；改为与 _section_table 同口径的 `^## 标题$` 判据，并在 JS 侧兜底：一段都没留住就退回完整版并隐藏切换按钮 |
| fix | acceptance-skill | 自审发现：行话解释判据固定取两个字符再 lstrip，「门禁  （解释）」多打一个空格会被冤判成未解释；改为判「下一个非空白字符是不是左括号」 |
