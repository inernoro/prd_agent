# 第 27 章 四协议保真验收

## 你在做什么

这一章分两级验收：普通管理员在 `Quickstart` 做 chat/vision 各四协议 dry-run；项目验收人员用仓库既有 `GatewayKeyGateContractTests` 检查流式、图片、工具和参数保真。页面本身没有流式或关闭安全模式的开关。

## 为什么要做

四个入口都返回 200，不代表业务含义一致。dry-run 只证明地址、鉴权、团队、appCaller、协议形状、日志和 requestId；它不会走真实模型解析或上游发送。保真验收必须再检查转换后的内容、流式事件和参数。

## 开始前检查

- Quickstart 不能选择列表中已有的 key。本章会为 chat 和 vision 各生成一把独立、范围正确的临时 test key，验收后可在“接入密钥”撤销。
- Quickstart 始终使用固定安全模式，不调用上游；不要寻找“切换假上游”或“开启流式”的页面开关，它们不存在。
- 不做批量付费测试。每类真实协议最多一次，且只有确有必要时才执行。
- vision 使用教程占位图片，不上传真实个人或业务图片。
- 完整协议合同只由能进入仓库、具备 .NET SDK 的验收人员在测试环境执行；普通租户不运行代码测试。

## 跟我做

1. 从左侧“开发者”进入 `Quickstart`，选择“文字对话”“客服组”“测试”，appCallerCode 填 `tutorial.gateway-book::chat`，Client code 填 `tutorial-protocol-chat`，然后点击“一键生成 appCaller 与 key”。没有当前页面新生成的 bundle 时测试按钮应保持禁用，不能跳过这一步。
2. 保存一次性 key 后，依次点击 GW Native、OpenAI、Claude、Gemini，确认 Gateway 地址由当前页面来源自动生成。对每种协议点击安全测试；响应必须有 requestId 和 `upstreamCalled=false`。
3. 比较四种请求体：同一句用户意图、同一 appCaller 和相同安全 header 应被保留，协议字段形状可以不同。
4. 点击“修改身份”，确认一次性密钥会从页面清除，然后选择“图片理解”“内容组”“测试”，appCallerCode 填 `tutorial.gateway-book::vision`，Client code 填 `tutorial-protocol-vision`，重新点击“一键生成 appCaller 与 key”。保存一次性 key 后，再对四个协议各点击一次测试。
5. 在请求记录打开八个 requestId，核对团队、ServiceKeyId、appCaller、协议和 `upstreamCalled=false`。详情页不展示 TenantId，因此不要把“看见 TenantId”列为页面通过条件；租户归属由当前会话和 key 的服务端解析保证。
6. 普通管理员到这里结束。验收人员在仓库根目录执行已有合同套件，它使用进程内假上游，不需要真实 key，也不会产生费用：

```bash
dotnet test prd-api/PrdAgent.sln --no-restore \
  --filter "FullyQualifiedName~GatewayKeyGateContractTests"
```

7. 套件中的 `QuickstartDryRun_UsesChatAndVisionAcrossFourProtocolsWithoutCallingUpstream` 验证八格 dry-run；OpenAI、Claude、Gemini 的 image、stream、tool 与参数用例验证真实协议形状。保存测试总数和通过结果。
8. 只有页面八格和合同套件都通过，才可写“协议保真通过”。本章不执行真实付费协议；若另有上线批准，仍遵守每类最多一次。
9. 保存八个 requestId 后，到“接入密钥”按 Client code 找到 `tutorial-protocol-chat` 和 `tutorial-protocol-vision`，分别点击“撤销”并确认。它们只是本章临时 bundle，不得长期留存；第 16 章轮换后的 chat key 和第 10 章 vision key不受影响。

## 看图核对

OpenAI vision 的红框结果必须写明请求记录已写入、未访问上游，并能打开 requestId 记录。

![红框标出 OpenAI vision dry-run 的完整通过条件](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/shlwkwyqya7xswmvni6yyhlduq.png)

Gemini vision 要出现同样的结果结构，证明不是只把协议标签换了名字。

![红框标出 Gemini vision dry-run 的完整通过条件](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/7d2vkbkxg2co7fuvj43ogdle24.png)

移动端的红框“固定安全模式”必须保留，避免窄屏让用户误以为测试会访问付费上游。

![移动端红框标出固定安全模式和审计边界](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/rhcw2gbbvwdmlqvysdlxnh6qpm.png)

## 看到什么算成功

chat 与 vision 共八次 dry-run 都返回独立 requestId、`upstreamCalled=false`；合同套件全部通过，证明内容、流式、vision、工具和允许参数语义。页面只核对团队、ServiceKeyId、appCaller 和协议，不虚构 TenantId 可见字段；两把临时协议验收 key 已撤销。

## 失败怎么办

- dry-run 返回成功但 `upstreamCalled` 不是 false：立即停止，这可能产生真实费用，不能算安全测试。
- 某协议 dry-run 失败：记录 requestId 和协议，不要改成真实调用重试；先检查 key、appCaller 后缀和 scope。
- 合同套件的流式用例失败：由项目验收人员按测试名称定位 SSE 或事件转换，普通用户不要在页面寻找不存在的流式开关。
- vision 合同失败：核对失败的 OpenAI、Claude 或 Gemini 图片用例；页面 dry-run 只证明请求形状，不单独证明上游收到图片。
- OpenRouter App 显示内部平台 code：检查上游展示头，应为 `G-{appCallerCode}`，不得泄露内部路由标识。

## 本章小结

安全测试与协议保真是两道门：普通用户完成八格零费用页面验证，项目验收人员完成进程内假上游合同套件。两者都通过，才可宣称本章完成。

## 下一章

点击 [[第 28 章：费用可信度双向校验]]，把请求价格快照和供应商 actual 从两边互相核对。
