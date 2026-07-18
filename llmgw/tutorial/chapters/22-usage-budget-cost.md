# 第 22 章 看懂用量、预算和费用

## 你在做什么

这一章打开“预算与用量”，分别阅读 estimated、actual、unknown、reconciled 四种状态，并观察“教程咖啡店”最近 30 天的使用情况。

## 为什么要做

请求成功不代表费用已经可信。模型价格可以先算出估算值，供应商账单后来提供实际值，两者对上后才是已对账；缺价格时只能标记未知。把这些状态混成一个数字，会让预算和结算都失真。

## 开始前检查

- 当前租户为“教程咖啡店”，时间范围覆盖前面产生的测试记录。
- 知道 dry-run 不访问上游，不能期待它产生真实供应商费用。
- 已理解 USD 和 CNY 是两种原币种；没有可审计汇率凭证时不能相加。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 从左侧“治理”进入“预算与用量”，先看“费用四状态”看板，而不是先看总金额。

**图 013 业务预算和业务速率在 appCaller 管理**

![图 013 业务预算和业务速率在 appCaller 管理](https://cds.miduo.org/api/reports/assets/e376a42cfffd63bc374a801573d108cee7e968e2dad7c0f15d01e1cde9555d66.png)

2. 读 estimated：它表示根据请求当时价格快照算出的估算记录。价格快照缺失时不能补成 0。

**图 044 月预算与单次预算预占共同组成费用硬边界**

![图 044 月预算与单次预算预占共同组成费用硬边界](https://cds.miduo.org/api/reports/assets/bb6699362bfa7bd67bfe49070ceb7e18c3180e814602edb094e7f802a13d675d.png)

3. 读 actual：它表示供应商账单提供的实际金额，仍需确认能否定位到请求或时间窗。

**图 045 每分钟限流是业务级速率硬边界**

![图 045 每分钟限流是业务级速率硬边界](https://cds.miduo.org/api/reports/assets/14dc23eb9d2bb4c218fc6539c741417553ac38f268003e2610c6fce896619464.png)

4. 读 unknown：它表示当前证据不足。记下缺价格请求数量，返回模型页补齐价格来源后，只影响有明确规则的后续或重算流程。

**图 076 从左侧导航点击“预算与用量”，不用猜页面地址**

![图 076 从左侧导航点击“预算与用量”，不用猜页面地址](https://cds.miduo.org/api/reports/assets/a79a708ecbfb5419d36910399d922d7de2fb7691da9e6b104baa1bab8bc38010.png)

5. 读 reconciled：它表示估算与实际已经按同币种或有审计汇率的规则比较，并留下状态与差额证据。

**图 077 用量页按当前租户展示请求、token、价格覆盖和分币种金额**

![图 077 用量页按当前租户展示请求、token、价格覆盖和分币种金额](https://cds.miduo.org/api/reports/assets/52b6ba639eb5acd9d6e71aa922b8169892322096b315988b958019f6c2a964be.png)

6. 点击“打开请求记录”，再按 `tutorial.gateway-book::chat`、团队权限范围和时间筛选。费用页自身展示最近 30 天当前租户汇总，不要把请求记录筛选误认为改写了汇总。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 078 estimated、actual、unknown、reconciled 四种证据状态分开显示](https://cds.miduo.org/api/reports/assets/f5ed7ebe9c9602be745412c4a6426955c52a945ae2ea277e945a74c05a6f1d1b.png)

7. 在本页“租户硬限制”查看总月预算、并发预占和当前分钟计数，再回到 appCaller 对照细分限制。预算是治理边界，不应通过删除日志或把 unknown 写成 0 来“降低使用量”。

**图 078 estimated、actual、unknown、reconciled 四种证据状态分开显示**

![图 078 estimated、actual、unknown、reconciled 四种证据状态分开显示](https://cds.miduo.org/api/reports/assets/f5ed7ebe9c9602be745412c4a6426955c52a945ae2ea277e945a74c05a6f1d1b.png)

### 用三次点击完成租户额度巡检

1. 在“团队与成员”的租户管理地图确认你管的是当前租户，不是另一个同名业务。

**图 079 同币种逐请求对账显示 Gateway 估算、供应商实际和差额**

![图 079 同币种逐请求对账显示 Gateway 估算、供应商实际和差额](https://cds.miduo.org/api/reports/assets/a2346b81ada7aeb15dbc3d214e51a797e1a7a0b27ad757f45beb25c67b60e995.png)

2. 在“预算与用量”检查租户总月预算、单次原子预占和总 RPM；再到“appCaller”检查每项生产业务的细分边界。租户总限制不会替你补全业务负责人和用途治理。

**图 080 CNY 与 USD 没有汇率凭证时明确不计算差额**

![图 080 CNY 与 USD 没有汇率凭证时明确不计算差额](https://cds.miduo.org/api/reports/assets/aeabfb4faf157ff001ec9be5c12796cfd580401071591d332ab5fe3cae22ced3.png)

3. 在“接入密钥”检查每个正式接入方是否使用独立 key、是否有合适的每分钟上限。测试 key 和正式 key 不共用同一条记录。

**图 081 供应商只有时间窗账单时标为汇总，不伪装单条 requestId**

![图 081 供应商只有时间窗账单时标为汇总，不伪装单条 requestId](https://cds.miduo.org/api/reports/assets/976011a35fdab42f768b1625fd237185994acf4c7131f00f39633d46134c6689.png)

4. 最后回到本页看租户汇总：请求数是否突然升高、unknown 是否增多、同币种 actual 与 estimated 是否能对上。

![图 077 用量页按当前租户展示请求、token、价格覆盖和分币种金额](https://cds.miduo.org/api/reports/assets/52b6ba639eb5acd9d6e71aa922b8169892322096b315988b958019f6c2a964be.png)

租户总预算/RPM、appCaller 预算/RPM 与 key RPM 都在请求入口执行；任一层触顶都会拒绝。响应头分别返回租户层和 appCaller 层额度，便于客户端判断是哪一层收紧。

## 看图核对

红框中的四张卡必须分开显示可估算、供应商实际、结果未知和已对账，先看证据阶段，再看上方金额。

![红框标出 exact、estimated、unknown、reconciled 四种费用状态](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/d7ihg2wgzlftfvtmtvuiwsh64y.png)

跨币种账单没有汇率凭证时，红框内的“对账差额”和“汇算凭证”都应写明不计算，而不是给出虚假合计。

![红框说明 CNY 与 USD 无汇率时不计算合计和差额](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/s2h2d3ynvhmwwuoozu5batpowa.png)

## 看到什么算成功

四种状态各自有记录数或明确空状态；unknown 用文字表达而不是 0 元；不同币种分别展示。筛选后只出现当前租户数据，能从用量记录回到 requestId。

## 失败怎么办

- 所有卡片为空：扩大到正确时间范围，确认前面请求属于当前租户；安全测试可能没有费用，但仍应有请求记录。
- unknown 显示为 0：不要用这个数字结算，回请求详情和模型价格检查证据，并报告展示问题。
- CNY 与 USD 被合成一个总额：停止使用该总额；没有审计 FX 时必须分币种展示。
- 预算突然超限：先按 appCaller、key 和团队拆分，再检查是否有重试风暴；不要直接提高预算掩盖异常。
- Billing 角色看不到路由配置：这是最小权限设计，费用查看不需要获得模型池写权限。
- 所有 appCaller 都有限额但仍不清楚租户最多花多少：由 Owner 或 Admin 在本页设置独立的租户总月预算；不要用各 appCaller 预算之和替代它。

## 本章小结

你已经能先判断“金额是否可信”，再读金额本身。estimated、actual、unknown、reconciled 是证据阶段，不是四种可随意互换的名字。

## 下一章

点击 [[第 23 章：导入供应商账单并对账]]，把实际费用与请求或时间窗连接起来。
