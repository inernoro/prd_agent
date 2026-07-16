# 第 11 章 点击安全测试

## 你在做什么

你将先用页面中保留的 vision key 对 OpenAI 兼容入口执行零费用 dry-run，再回看第 10 章 chat 测试的 requestId。请求会走真实地址、鉴权、团队边界和协议解析，写入请求记录，但必须在模型解析和上游发送前结束。

## 为什么要做

复制一堆配置并不能给用户安全感。安全测试能立即证明 Gateway 地址可达、key 有效、appCaller 与团队匹配、协议形状被识别，并给出可追踪的 requestId。只有明确返回 `upstreamCalled=false` 才算通过，HTTP 200 本身不够。

## 开始前检查

- 当前 Quickstart 仍显示 vision 的一次性 key 和“接入配置已生成”；chat key 已安全保存，chat requestId 已记在个人核对清单。
- 协议选择“OpenAI”，调用类型为“图片理解”。
- “展开安全测试选项”中写明固定发送 `X-Gateway-Dry-Run: quickstart`，本页没有关闭开关。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 展开“安全测试选项”，读完固定安全模式、调用类型、通过标准和审计边界。

**图 060 从左侧导航点击“Quickstart”，不用猜页面地址**

![图 060 从左侧导航点击“Quickstart”，不用猜页面地址](https://cds.miduo.org/api/reports/assets/c453d2ff0528b069d5190357623162da65608352ec05f73576031b8801178cbb.png)

**图 061 Quickstart 从自动 Gateway 地址开始，三步完成首个可审计请求**

![图 061 Quickstart 从自动 Gateway 地址开始，三步完成首个可审计请求](https://cds.miduo.org/api/reports/assets/645624ce183b542039cb6bd3b810ca7a13144fe0a2021122ce87fe559518fc59.png)

2. 点击“点击测试”。等待按钮显示“正在测试并写日志”，不要重复点击。

**图 062 Gateway 地址由当前网址自动生成，不让用户手工猜域名**

![图 062 Gateway 地址由当前网址自动生成，不让用户手工猜域名](https://cds.miduo.org/api/reports/assets/ef89c0849710b5f8536e5e0d837398a0859eb4a3cee6d881800a5226b7ebf1da.png)

3. 查看结果：应说明 OpenAI 的图片理解、团队边界和密钥鉴权均通过，已写请求记录，未访问上游。

**图 063 先选文字对话或图片理解，appCaller 后缀自动同步**

![图 063 先选文字对话或图片理解，appCaller 后缀自动同步](https://cds.miduo.org/api/reports/assets/089d63fa6894e6bef38fb7f9c7ab336258891278174aaf6027cf50973e9607a7.png)

4. 确认结果带 requestId，并明确 `upstreamCalled=false`。

**图 064 一键生成 appCaller 与 key，缺 key 不能跳过身份直接测试**

![图 064 一键生成 appCaller 与 key，缺 key 不能跳过身份直接测试](https://cds.miduo.org/api/reports/assets/fa5352db762895c9cb2fc2ff2bb5ec9f102f1e3242cd7a73968445a1ddb8c7eb.png)

5. 先不要点击“打开 requestId 请求记录”。这个动作会离开 Quickstart，页面内存中的一次性 key 和已生成接入配置会随之清除；第 12 章还要使用当前 vision 配置。

**图 065 生成结果只在当前时刻展示完整 key，并提示立即保存**

![图 065 生成结果只在当前时刻展示完整 key，并提示立即保存](https://cds.miduo.org/api/reports/assets/6dc1b657df8a373550e7064b1b4b904e41a954ff39ae624d06f7f67878d9648b.png)

6. 在个人核对清单分别标清 chat requestId 与 vision requestId，并记录各自协议、时间和“未访问上游”，不要记录 key。

**图 066 同一页提供 GW Native、OpenAI、Claude、Gemini 四协议**

![图 066 同一页提供 GW Native、OpenAI、Claude、Gemini 四协议](https://cds.miduo.org/api/reports/assets/cc15dcc8a820b1f5167a710645aa3476740b268de0f9478bb717d917d2e0b40e.png)

7. 保持控制台标签不刷新、不跳转，只在教程标签进入第 12 章。两条请求的详情统一留到第 13 章核对。

**图 067 点击测试固定使用安全 dry-run，结果必须带 requestId 且未访问上游**

![图 067 点击测试固定使用安全 dry-run，结果必须带 requestId 且未访问上游](https://cds.miduo.org/api/reports/assets/27a28b5293ff82a1ad6e82c6bd75abc592a3e7e6e6e4ecf89592f7318d8db2f1.png)

## 看图核对

OpenAI vision 通过时，红框结果必须同时写明团队边界和密钥鉴权通过、请求记录已写入、未访问上游，并提供 requestId 入口。

![红框标出 OpenAI vision 安全测试通过结果](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/shlwkwyqya7xswmvni6yyhlduq.png)

切换到 Gemini 后仍要看到同样四个通过条件；只看到 HTTP 成功不够。

![红框标出 Gemini vision 安全测试通过结果](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/7d2vkbkxg2co7fuvj43ogdle24.png)

## 看到什么算成功

vision 测试结果为成功，包含 requestId 和“未访问上游”说明。个人核对清单已把 chat 与 vision 两个 requestId 分开标记；Quickstart 仍停留在 vision 的已生成配置，没有因提前跳转而丢失。费用保持 unknown，不显示为 0。

## 失败怎么办

- 返回 401：key 错误、过期或已撤销；确认页面仍持有本次 key，否则签发或轮换新 key。
- 返回 403：团队、appCaller、协议、scope 或来源范围不匹配；逐项对照 key 列表，不要扩大成通配权限。
- 返回 404 或 409：appCaller 未创建，或同一身份已归其他团队；在 appCaller 注册表核对归属。
- 没有明确 `upstreamCalled=false`：即使 HTTP 成功也不计通过，停止测试并让管理员检查 dry-run 处理链。

## 本章小结

安全直测验证了接入链路，却没有消费付费上游。requestId 是从用户现象回到服务端证据的主线，后续排错都先复制它。

## 下一章

点击 [[第 12 章：复制接入方式]]，学习复制 cURL、环境变量和 Agent Skill，并认识四种协议的差异。
