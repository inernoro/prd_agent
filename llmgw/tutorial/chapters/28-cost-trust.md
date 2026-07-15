# 第 28 章 费用可信度双向校验

## 你在做什么

这一章从 Gateway 请求记录出发查价格快照，再从供应商账单出发查 actual，最后让两条证据在同一个 requestId 或明确时间窗相遇。你还会验证 unknown 和跨币种边界。

## 为什么要做

单向看数字容易自我证明：只看 Gateway 会忽略供应商实际扣费，只看账单又不知道费用属于哪个业务。双向校验要求“从请求能找到账单，从账单也能回到请求”，并保留差额、币种和汇率凭证。

## 开始前检查

- 第 20 章 chat 教程桩请求提供 unknown 样例，第 23 章只包住该 chat 请求的窗口账单提供 `0.01 CNY` actual 汇总；连续路线没有价格快照，因此不假装已有 estimated。
- 严格的 estimated、同币种 reconciled、跨币种缺 FX 与有 FX 分支由项目验收人员使用仓库既有费用策略测试验证，不使用真实密钥。
- 不把时间窗汇总假装成逐请求对账。

## 跟我做

1. 从第 20 章 chat 请求详情记下 chat requestId、实际模型 `stub-chat`、Provider 和费用状态。不要误用 vision requestId。由于第 7 章未填写价格，estimated 必须显示“未知”，不能显示 0。
2. 打开“治理 → 预算与用量”，在“最近对账记录”找到第 23 章流水。它应显示 `0.01 CNY` actual、Gateway 估算未知，并明确是时间窗汇总，没有单条 requestId。
3. 页面上只确认两件已真实产生的事：unknown 没被算作 0，窗口 actual 没被伪装成逐请求费用。不要从这两条数据推导 reconciled。
4. 普通管理员到这里结束。项目验收人员在仓库根目录执行费用策略与价格证据测试：

```bash
dotnet test prd-api/PrdAgent.sln --no-restore \
  --filter "FullyQualifiedName~GatewayCostReconciliationPolicyTests|FullyQualifiedName~LlmCostEvidenceTests"
```

5. `LlmCostEvidenceTests` 验证 unknown 与 0 永远不同，并验证价格快照 hash；`GatewayCostReconciliationPolicyTests` 验证同币种 reconciled、USD/CNY 无 FX 时 `fx-unavailable`、提供审计 FX 后才计算差额。
6. 保存测试总数和通过结果。测试失败时不要在页面手工算差额，也不要为凑状态改写教程账单。
7. 将页面证据与测试证据并排记录：前者证明当前租户真实展示，后者证明完整费用分支规则。两者用途不同，不能互相冒充。

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
