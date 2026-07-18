# 第 12 章 复制接入方式

## 你在做什么

你将从同一 Quickstart 获取客户端配置、cURL、环境变量和 Agent Skill，并查看 GW Native、OpenAI、Claude、Gemini 四种协议的真实路径。随后分别用 Cherry Studio 和 OpenClaw 的三步入口完成一次客户端接入。你不会手抄 Gateway 地址，也不会把 key 固化进代码。

## 为什么要做

团队普遍由 Agent 完成接入工作。可复制的 Skill 能告诉 Agent 从哪里读环境变量、使用哪种协议和如何回查 requestId；cURL 适合最小验证，环境变量适合部署。Cherry Studio 不支持通用配置导入，因此页面把必须填写的四项拆成独立复制；OpenClaw 使用官方增量配置命令，不覆盖已有 Provider。四种协议共享同一租户身份，但请求形状不同，不能只换 URL 不换正文。

## 开始前检查

- 当前仍停留在[[第 11 章：点击安全测试|第 11 章]]的 vision 已生成配置；如果已经刷新或离开 Quickstart，先按[[第 10 章：一键生成第一把 key|第 10 章]]相同字段重新生成一把明确限定的 vision test key，再继续，不使用页面恢复后的默认身份。
- [[第 10 章：一键生成第一把 key|第 10 章]]已经安全保存 chat key 与 chat 接入片段；本章当前复制的是 vision 片段，两类片段不要混用。
- 当前仍为安全模式，示例包含 `X-Gateway-Dry-Run: quickstart`。
- 当前 Gateway 地址若刚被修改，真实模式会自动失效；在新地址路由预检成功前，cURL 和 Agent Skill 都必须继续保留 dry-run。
- 明确真实业务采用哪种 SDK 兼容协议；不知道时从 OpenAI 兼容开始验证。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 在 Quickstart 依次点击 GW Native、OpenAI、Claude、Gemini，观察“测试路径”随协议变化。

**图 062 Gateway 地址由当前网址自动生成，不让用户手工猜域名**

![图 062 Gateway 地址由当前网址自动生成，不让用户手工猜域名](https://cds.miduo.org/api/reports/assets/ef89c0849710b5f8536e5e0d837398a0859eb4a3cee6d881800a5226b7ebf1da.png)

2. 对每个协议查看 cURL 正文，确认不是同一 JSON 生搬硬套；vision 示例还应使用内嵌测试图片形状。GW Native 片段先生成一个 `REQUEST_ID`，请求头和正文必须引用同一个值，避免一条调用出现两个审计标识。

**图 066 同一页提供 GW Native、OpenAI、Claude、Gemini 四协议**

![图 066 同一页提供 GW Native、OpenAI、Claude、Gemini 四协议](https://cds.miduo.org/api/reports/assets/cc15dcc8a820b1f5167a710645aa3476740b268de0f9478bb717d917d2e0b40e.png)

3. 回到业务需要的协议，点击“cURL”标签并复制。先确认其中的 appCaller 是 `tutorial.gateway-book::vision`、key 由环境变量注入，再放到受控本地临时位置；不发到聊天群。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 066 同一页提供 GW Native、OpenAI、Claude、Gemini 四协议](https://cds.miduo.org/api/reports/assets/cc15dcc8a820b1f5167a710645aa3476740b268de0f9478bb717d917d2e0b40e.png)

4. 点击“环境变量”，复制到部署系统的 Secret 配置；key 值来自安全保管工具，不写入仓库文件。“API 与 Agent”客户端标签显示同一组快速环境配置。

**图 068 生成后可复制 curl、配置和 Agent 技能接入方式**

![图 068 生成后可复制 curl、配置和 Agent 技能接入方式](https://cds.miduo.org/api/reports/assets/e1a12b0d45aae1ecd284a51bcc7973294f2db418c35914f92ac91f1d12b6c2be.png)

5. 点击“Agent Skill”，复制给负责接入的 Agent。要求它保留 vision appCaller header、协议路径、dry-run 与 requestId 回查步骤；chat 客户端继续使用[[第 10 章：一键生成第一把 key|第 10 章]]保存的 chat 片段。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 097 学习中心先用三步讲清第一条请求，不要求先懂全部术语](https://cds.miduo.org/api/reports/assets/5b663dc659eb61f03554e6147a1f6b08de72fde553f14100520a9785236155e6.png)

6. 用复制结果再次核对 Gateway 地址：默认来自当前页面 URL 前缀或部署配置，不应仍是 `gateway.example.com`。

**图 097 学习中心先用三步讲清第一条请求，不要求先懂全部术语**

![图 097 学习中心先用三步讲清第一条请求，不要求先懂全部术语](https://cds.miduo.org/api/reports/assets/5b663dc659eb61f03554e6147a1f6b08de72fde553f14100520a9785236155e6.png)

7. 完成测试后仍保留 dry-run header。只有当前 Gateway 地址的路由预检成功并由用户明确切换“真实模型”后，页面才会生成不带 dry-run 的真实片段；地址变化或预检失效时，片段自动退回安全模式。“真实路由与排障”位于客户端配置之后且默认折叠，首次复制配置不需要先理解模型池或 Provider。

![图 068 生成后可复制 curl、配置和 Agent 技能接入方式](https://cds.miduo.org/api/reports/assets/e1a12b0d45aae1ecd284a51bcc7973294f2db418c35914f92ac91f1d12b6c2be.png)

8. 完成当前片段保存后，点击“修改身份”，选择“Cherry Studio”，再点击“生成 Cherry Studio 配置”。页面自动生成专属 appCaller 和 scoped key。

![Quickstart 同屏提供自动 Gateway 地址、协议标签、生成和测试](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/3bo2a6hgv3a6zvtepm4a5thbdi.png)

9. 按页面三步做：在 Cherry Studio 添加 OpenAI 类型的 LLM Gateway 服务商；逐项复制 API 地址、API Key、模型 `auto` 和服务商名称；启用服务商并点击“检查”。Cherry Studio 会自己拼接 `/v1/chat/completions`，API 地址只填页面给出的根域名。

![图 068 生成后可复制 curl、配置和 Agent 技能接入方式](https://cds.miduo.org/api/reports/assets/e1a12b0d45aae1ecd284a51bcc7973294f2db418c35914f92ac91f1d12b6c2be.png)

10. 在 Cherry Studio 新建对话，选择 LLM Gateway / auto，只发送一次“只回复 `LLMGW_OK`”。回 Gateway 请求记录，用时间、service key 前缀和 appCaller `cherry-studio.desktop::chat` 定位这次调用。客户端不能自报 tenantId；租户必须来自服务端解析的 key。

![图 070 Logs 首屏直接给 requestId 搜索、高频筛选和高密度请求表格](https://cds.miduo.org/api/reports/assets/2c0565db3416c7b60a2bd11f212b1fa2a201a3df4b0a5d0e0c657b1046907709.jpg)

11. 回 Quickstart 清除当前一次性明文，选择“OpenClaw”，点击“生成 OpenClaw 配置”。复制页面给出的三行命令块并粘贴到已安装 OpenClaw 的终端。第一行增量合并 `llmgw` Provider，第二行设为默认模型，第三行校验配置；不会替换其他 Provider。

![Quickstart 同屏提供自动 Gateway 地址、协议标签、生成和测试](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/3bo2a6hgv3a6zvtepm4a5thbdi.png)

12. 按终端提示重启 OpenClaw Gateway，运行 `openclaw chat`，只发送一次“只回复 `LLMGW_OK`”。再用 appCaller `openclaw.gateway::chat` 到请求记录核对实际模型、状态、耗时与费用可信度。

![图 070 Logs 首屏直接给 requestId 搜索、高频筛选和高密度请求表格](https://cds.miduo.org/api/reports/assets/2c0565db3416c7b60a2bd11f212b1fa2a201a3df4b0a5d0e0c657b1046907709.jpg)

13. 两个客户端都只使用各自刚生成的 key。不要把 Cherry Studio key 复制到 OpenClaw，也不要让两个客户端共用同一个 clientCode；这样撤销、限速、审计和费用才能分别定位。

![图 068 生成后可复制 curl、配置和 Agent 技能接入方式](https://cds.miduo.org/api/reports/assets/e1a12b0d45aae1ecd284a51bcc7973294f2db418c35914f92ac91f1d12b6c2be.png)

## 看图核对

整页核对时，Gateway 地址应来自当前部署，协议标签、测试入口和“一键生成 appCaller 与 key”应在同一流程内。

![Quickstart 同屏提供自动 Gateway 地址、协议标签、生成和测试](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/3bo2a6hgv3a6zvtepm4a5thbdi.png)

移动端展开安全测试选项后，红框中的“固定安全模式”不能消失；底部仍能切换 cURL、环境变量和 Agent Skill。

![移动端红框标出固定安全模式并保留三种复制方式](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/rhcw2gbbvwdmlqvysdlxnh6qpm.png)

## 看到什么算成功

四种标签都能复制，四协议各有正确路径和请求形状。Cherry Studio 能在三段连续说明中完成四项复制、检查和首条消息；OpenClaw 的增量命令通过官方 `config validate`。示例不要求用户输入 tenantId，也不暴露 Provider 通讯密钥。Agent 能从环境变量读取 Gateway 地址和 key，并知道用 requestId 在“请求记录”回查；GW Native 的 header 与 body 使用同一个 requestId，未通过当前地址路由预检时无法复制出真实调用片段。

## 失败怎么办

- 示例地址是占位域名：停止接入，让部署管理员修正 Gateway 基址；不要让每个用户自行猜地址。
- 复制后 key 为空：说明页面已刷新或尚未生成 key，回“接入密钥”轮换或新建，不可绕过鉴权。
- SDK 返回协议错误：确认选择的标签与 SDK 相同，并完整使用该协议正文，不只替换路径。
- Agent 建议把 key 写进源码：拒绝该方案，改用 Secret 或环境变量，并检查 Git 历史是否已泄露。
- Cherry Studio 点击“管理”看不到模型：本接入不依赖 `/v1/models` 自动发现，手动添加模型 `auto` 后再点击“检查”。
- OpenClaw 提示配置无效：先确认版本满足官方最低 Node 要求，再重新复制完整命令块；不要直接覆盖整个 `models.providers`。

## 本章小结

Quickstart 把可执行接入说明交给人和 Agent，Gateway 地址自动派生，密钥由安全环境注入。四协议是兼容入口，不是四套租户身份。

## 下一章

点击 [[第 13 章：找到第一条请求]]，用刚才的 requestId 找到第一条请求并读懂详情。
