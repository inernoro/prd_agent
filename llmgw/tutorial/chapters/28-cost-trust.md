# 第 28 章 费用可信度双向校验

## 你在做什么

这一章从 Gateway 请求记录出发查价格快照，再从供应商账单出发查 actual，最后让两条证据在同一个 requestId 或明确时间窗相遇。你还会验证 unknown 和跨币种边界。

## 为什么要做

单向看数字容易自我证明：只看 Gateway 会忽略供应商实际扣费，只看账单又不知道费用属于哪个业务。双向校验要求“从请求能找到账单，从账单也能回到请求”，并保留差额、币种和汇率凭证。

## 开始前检查

- [[第 20 章：配置 PromptPolicy|第 20 章]] chat 教程桩请求提供 unknown 样例，[[第 23 章：导入供应商账单并对账|第 23 章]]只包住该 chat 请求的窗口账单提供 `0.01 CNY` actual 汇总；连续路线没有价格快照，因此不假装已有 estimated。
- 严格的 estimated、同币种 reconciled、跨币种缺 FX 与有 FX 分支由项目验收人员使用仓库既有费用策略测试验证，不使用真实密钥。
- 不把时间窗汇总假装成逐请求对账。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 从[[第 20 章：配置 PromptPolicy|第 20 章]] chat 请求详情记下 chat requestId、实际模型 `stub-chat`、Provider 和费用状态。不要误用 vision requestId。由于[[第 7 章：配置第一个模型|第 7 章]]未填写价格，estimated 必须显示“未知”，不能显示 0。

**图 007 费用可信度分币种显示覆盖率，unknown 不写成 0**

![图 007 费用可信度分币种显示覆盖率，unknown 不写成 0](https://cds.miduo.org/api/reports/assets/09528dceb85219f3e0e4074df5fbf246f0270de2b484a3d21a80db18d946568c.png)

2. 打开“治理 → 预算与用量”，在“最近对账记录”找到[[第 23 章：导入供应商账单并对账|第 23 章]]流水。它应显示 `0.01 CNY` actual、Gateway 估算未知，并明确是时间窗汇总，没有单条 requestId。

**图 072 费用可信度条区分价格覆盖、unknown 与原币种金额**

![图 072 费用可信度条区分价格覆盖、unknown 与原币种金额](https://cds.miduo.org/api/reports/assets/d6875f1f274fb6106f00336d5889877e1911c7077c9b98980bf25bd69e19fb0e.png)

3. 页面上只确认两件已真实产生的事：unknown 没被算作 0，窗口 actual 没被伪装成逐请求费用。不要从这两条数据推导 reconciled。

**图 077 用量页按当前租户展示请求、token、价格覆盖和分币种金额**

![图 077 用量页按当前租户展示请求、token、价格覆盖和分币种金额](https://cds.miduo.org/api/reports/assets/52b6ba639eb5acd9d6e71aa922b8169892322096b315988b958019f6c2a964be.png)

4. 普通管理员到这里结束。项目验收人员在仓库根目录执行费用策略与价格证据测试：

**图 078 estimated、actual、unknown、reconciled 四种证据状态分开显示**

![图 078 estimated、actual、unknown、reconciled 四种证据状态分开显示](https://cds.miduo.org/api/reports/assets/f5ed7ebe9c9602be745412c4a6426955c52a945ae2ea277e945a74c05a6f1d1b.png)

```bash
dotnet test prd-api/PrdAgent.sln --no-restore \
  --filter "FullyQualifiedName~GatewayCostReconciliationPolicyTests|FullyQualifiedName~LlmCostEvidenceTests"
```

5. `LlmCostEvidenceTests` 验证 unknown 与 0 永远不同，并验证价格快照 hash；`GatewayCostReconciliationPolicyTests` 验证同币种 reconciled、USD/CNY 无 FX 时 `fx-unavailable`、提供审计 FX 后才计算差额。

**图 079 同币种逐请求对账显示 Gateway 估算、供应商实际和差额**

![图 079 同币种逐请求对账显示 Gateway 估算、供应商实际和差额](https://cds.miduo.org/api/reports/assets/a2346b81ada7aeb15dbc3d214e51a797e1a7a0b27ad757f45beb25c67b60e995.png)

6. 保存测试总数和通过结果。测试失败时不要在页面手工算差额，也不要为凑状态改写教程账单。

**图 080 CNY 与 USD 没有汇率凭证时明确不计算差额**

![图 080 CNY 与 USD 没有汇率凭证时明确不计算差额](https://cds.miduo.org/api/reports/assets/aeabfb4faf157ff001ec9be5c12796cfd580401071591d332ab5fe3cae22ced3.png)

7. 将页面证据与测试证据并排记录：前者证明当前租户真实展示，后者证明完整费用分支规则。两者用途不同，不能互相冒充。

**图 081 供应商只有时间窗账单时标为汇总，不伪装单条 requestId**

![图 081 供应商只有时间窗账单时标为汇总，不伪装单条 requestId](https://cds.miduo.org/api/reports/assets/976011a35fdab42f768b1625fd237185994acf4c7131f00f39633d46134c6689.png)

## 看到什么算成功

页面真实证明 unknown 不为 0、`0.01 CNY` 保持窗口汇总；费用策略测试全部通过，证明同币种差额、跨币种无 FX 禁算和有审计 FX 才可 reconciled。

## 失败怎么办

- 请求找不到供应商流水：本书使用时间窗汇总，本来就不建立单条 requestId 关联；按流水和窗口查找，不要人工编造逐请求关系。
- 窗口包含多个 requestId：保持汇总身份并停止逐条归因；需要逐请求证据时必须等真实供应商编号。
- unknown 被纳入 0 元总额：停止使用总额做预算或结算，修复价格覆盖与展示口径。
- 跨币种出现一个总数却没有 FX 来源：视为不可信，恢复原币种分栏。
- 差额由前端临时计算且无法审计：以服务端对账状态为准，不能让不同浏览器产生不同结论。

## 本章小结

费用可信不是“有一个数字”，而是请求、价格快照、供应商流水、币种和对账状态能互相证明。证据不足就诚实保留 unknown。

## 下一章

点击 [[第 29 章：运行治理与发布检查]]，了解哪些运行信息只属于内部治理，而不应占据普通用户首页。
