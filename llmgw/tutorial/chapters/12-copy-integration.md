# 第 12 章 复制接入方式

## 你在做什么

你将从同一 Quickstart 获取 cURL、环境变量和 Agent Skill 三种接入说明，并查看 GW Native、OpenAI、Claude、Gemini 四种协议的真实路径。你不会手抄 Gateway 地址，也不会把 key 固化进代码。

## 为什么要做

团队普遍由 Agent 完成接入工作。可复制的 Skill 能告诉 Agent从哪里读环境变量、使用哪种协议和如何回查 requestId；cURL 适合最小验证，环境变量适合部署。四种协议共享同一租户身份，但请求形状不同，不能只换 URL 不换正文。

## 开始前检查

- 当前仍停留在[[第 11 章：点击安全测试|第 11 章]]的 vision 已生成配置；如果已经刷新或离开 Quickstart，先按[[第 10 章：一键生成第一把 key|第 10 章]]相同字段重新生成一把明确限定的 vision test key，再继续，不使用页面恢复后的默认身份。
- [[第 10 章：一键生成第一把 key|第 10 章]]已经安全保存 chat key 与 chat 接入片段；本章当前复制的是 vision 片段，两类片段不要混用。
- 当前仍为安全模式，示例包含 `X-Gateway-Dry-Run: quickstart`。
- 明确真实业务采用哪种 SDK 兼容协议；不知道时从 OpenAI 兼容开始验证。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 在 Quickstart 依次点击 GW Native、OpenAI、Claude、Gemini，观察“测试路径”随协议变化。

**图 062 Gateway 地址由当前网址自动生成，不让用户手工猜域名**

![图 062 Gateway 地址由当前网址自动生成，不让用户手工猜域名](https://cds.miduo.org/api/reports/assets/ef89c0849710b5f8536e5e0d837398a0859eb4a3cee6d881800a5226b7ebf1da.png)

2. 对每个协议查看 cURL 正文，确认不是同一 JSON 生搬硬套；vision 示例还应使用内嵌测试图片形状。

**图 066 同一页提供 GW Native、OpenAI、Claude、Gemini 四协议**

![图 066 同一页提供 GW Native、OpenAI、Claude、Gemini 四协议](https://cds.miduo.org/api/reports/assets/cc15dcc8a820b1f5167a710645aa3476740b268de0f9478bb717d917d2e0b40e.png)

3. 回到业务需要的协议，点击“cURL”标签并复制。先确认其中的 appCaller 是 `tutorial.gateway-book::vision`、key 由环境变量注入，再放到受控本地临时位置；不发到聊天群。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 066 同一页提供 GW Native、OpenAI、Claude、Gemini 四协议](https://cds.miduo.org/api/reports/assets/cc15dcc8a820b1f5167a710645aa3476740b268de0f9478bb717d917d2e0b40e.png)

4. 点击“环境变量”，复制到部署系统的 Secret 配置；key 值来自安全保管工具，不写入仓库文件。

**图 068 生成后可复制 curl、配置和 Agent 技能接入方式**

![图 068 生成后可复制 curl、配置和 Agent 技能接入方式](https://cds.miduo.org/api/reports/assets/e1a12b0d45aae1ecd284a51bcc7973294f2db418c35914f92ac91f1d12b6c2be.png)

5. 点击“Agent Skill”，复制给负责接入的 Agent。要求它保留 vision appCaller header、协议路径、dry-run 与 requestId 回查步骤；chat 客户端继续使用[[第 10 章：一键生成第一把 key|第 10 章]]保存的 chat 片段。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 097 学习中心先用三步讲清第一条请求，不要求先懂全部术语](https://cds.miduo.org/api/reports/assets/5b663dc659eb61f03554e6147a1f6b08de72fde553f14100520a9785236155e6.png)

6. 用复制结果再次核对 Gateway 地址：默认来自当前页面 URL 前缀或部署配置，不应仍是 `gateway.example.com`。

**图 097 学习中心先用三步讲清第一条请求，不要求先懂全部术语**

![图 097 学习中心先用三步讲清第一条请求，不要求先懂全部术语](https://cds.miduo.org/api/reports/assets/5b663dc659eb61f03554e6147a1f6b08de72fde553f14100520a9785236155e6.png)

7. 完成测试后仍保留 dry-run header。只有生产清单批准真实调用时才删除。

![图 068 生成后可复制 curl、配置和 Agent 技能接入方式](https://cds.miduo.org/api/reports/assets/e1a12b0d45aae1ecd284a51bcc7973294f2db418c35914f92ac91f1d12b6c2be.png)

## 看图核对

整页核对时，Gateway 地址应来自当前部署，协议标签、测试入口和“一键生成 appCaller 与 key”应在同一流程内。

![Quickstart 同屏提供自动 Gateway 地址、协议标签、生成和测试](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/3bo2a6hgv3a6zvtepm4a5thbdi.png)

移动端展开安全测试选项后，红框中的“固定安全模式”不能消失；底部仍能切换 cURL、环境变量和 Agent Skill。

![移动端红框标出固定安全模式并保留三种复制方式](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/rhcw2gbbvwdmlqvysdlxnh6qpm.png)

## 看到什么算成功

三种标签都能一键复制，四协议各有正确路径和请求形状。示例不要求用户输入 tenantId，也不暴露 Provider 通讯密钥。Agent 能从环境变量读取 Gateway 地址和 key，并知道用 requestId 在“请求记录”回查。

## 失败怎么办

- 示例地址是占位域名：停止接入，让部署管理员修正 Gateway 基址；不要让每个用户自行猜地址。
- 复制后 key 为空：说明页面已刷新或尚未生成 key，回“接入密钥”轮换或新建，不可绕过鉴权。
- SDK 返回协议错误：确认选择的标签与 SDK 相同，并完整使用该协议正文，不只替换路径。
- Agent 建议把 key 写进源码：拒绝该方案，改用 Secret 或环境变量，并检查 Git 历史是否已泄露。

## 本章小结

Quickstart 把可执行接入说明交给人和 Agent，Gateway 地址自动派生，密钥由安全环境注入。四协议是兼容入口，不是四套租户身份。

## 下一章

点击 [[第 13 章：找到第一条请求]]，用刚才的 requestId 找到第一条请求并读懂详情。
