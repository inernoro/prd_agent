# 实战 05：三分钟完成第一次接入

这篇实战面向已经知道 API Key、Base URL 和模型名含义的用户。目标不是先学完整个 Gateway，而是在三分钟内拿到一份可复制配置，并由系统自动证明密钥、团队、appCaller 和协议边界正确。

## 三分钟路径

### 第一分钟：选择客户端

1. 进入“开发者 → Quickstart”。
2. 选择“API 与 Agent”“Cherry Studio”或“OpenClaw”。
3. 核对摘要中的团队、appCaller 和协议。默认值正确时不要展开高级选项。

### 第二分钟：生成并自动验证

1. 点击“生成并验证”。
2. 系统依次创建限定 appCaller、签发团队 key，并自动发送一次安全 dry-run。
3. 只有页面返回 requestId 且明确“未访问上游”才算通过。这个步骤不调用付费模型。
4. 立即复制一次性 key 或完整客户端配置；刷新后不能找回明文。

### 第三分钟：粘贴并连接

- API 与 Agent：复制环境变量或 cURL，把 key 放入 Secret 管理，不写进源码。
- Cherry Studio：复制页面给出的 Base URL、API Key 和模型配置。
- OpenClaw：复制 provider 配置，并把 key 改为环境变量引用。

首次接入不需要理解 Provider、Offering、模型池、价格对账和故障切换。需要指定模型时提交逻辑模型 PublicId；没有指定时才使用默认池。

## 为什么自动测试不能省

只生成 key 无法证明它能用。Quickstart 的自动测试会在上游发送前结束，但仍经过地址、认证、租户、团队、appCaller、协议和日志链路。这样既能拿到 requestId，又不会因第一次试错产生模型费用。

## 看到什么算成功

- 页面显示一次性 key 和当前客户端的完整配置。
- 自动验证结果为通过，并提供可打开请求记录的 requestId。
- 请求记录中的 Provider 为安全 dry-run，模型为未调用或等义文案。
- 整个流程没有要求用户先创建 Provider、手工拼 appCaller 或理解模型池。

## 常见失败

- 没有活动团队：请 Owner 或 Admin 先创建团队；不要把 key 做成无团队通配凭据。
- 当前角色只能阅读：Viewer 和 Billing 不能签发 key；使用 Owner、Admin 或所属团队 Developer。
- 自动验证没有明确 `upstreamCalled=false`：不要把结果算作安全通过，也不要立刻改用真实模型；先用 requestId 排查。
- Base URL 无法连接：保持自动给出的当前部署地址，除非管理员明确提供另一套 Gateway。
- 费用显示未计价：安全 dry-run 本来没有上游费用；真实请求仍未计价时，检查上游是否返回逐请求 cost，或由管理员配置模型价格。

## 接入后再学什么

接入成功后，按需要阅读[[第 14 章：理解 key、appCaller 和模型池|第 14 章]]、[[第 21 章：看懂请求记录和会话|第 21 章]]和[[第 22 章：看懂用量、预算和费用|第 22 章]]。不要把全部治理概念塞回第一次接入路径。
