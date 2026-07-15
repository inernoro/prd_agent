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

1. 展开“安全测试选项”，读完固定安全模式、调用类型、通过标准和审计边界。
2. 点击“点击测试”。等待按钮显示“正在测试并写日志”，不要重复点击。
3. 查看结果：应说明 OpenAI 的图片理解、团队边界和密钥鉴权均通过，已写请求记录，未访问上游。
4. 确认结果带 requestId，并明确 `upstreamCalled=false`。
5. 先不要点击“打开 requestId 请求记录”。这个动作会离开 Quickstart，页面内存中的一次性 key 和已生成接入配置会随之清除；第 12 章还要使用当前 vision 配置。
6. 在个人核对清单分别标清 chat requestId 与 vision requestId，并记录各自协议、时间和“未访问上游”，不要记录 key。
7. 保持控制台标签不刷新、不跳转，只在教程标签进入第 12 章。两条请求的详情统一留到第 13 章核对。

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
