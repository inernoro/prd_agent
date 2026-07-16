# 第 16 章 轮换、切换和撤销 key

## 你在做什么

你将为现有 test key 签发一把后继 key，让新旧 key 短时间并行，先把客户端切到新 key并观察日志，再撤销旧 key。整个过程不原地覆盖明文。

## 为什么要做

密钥不会被系统重新显示，轮换只能创建新身份并安全切换。如果先撤旧 key，客户端可能立即中断；如果新旧长期并存，泄露面又会扩大。页面的轮换阶段和 ServiceKeyId 观测帮助你在“不中断”和“及时收口”之间取得可证明的平衡。

## 开始前检查

- 选择[[第 10 章：一键生成第一把 key|第 10 章]]客服组的有效 chat test key，不操作 vision key 或生产共享 key。
- [[第 10 章：一键生成第一把 key|第 10 章]]已复制一份只引用 `$LLMGW_API_KEY`、appCaller 为 `tutorial.gateway-book::chat` 的 cURL 或 Agent Skill。它就是本章的最小测试客户端，不需要另外部署应用。
- 已安排短切换窗口，明确旧 key id、新 key保管位置和回滚负责人。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 打开“接入密钥”，在客服组 chat test key 行点击“轮换”。页面会带入原 key 的明确范围。

**图 056 列表只显示 key 前缀，不回显完整明文**

![图 056 列表只显示 key 前缀，不回显完整明文](https://cds.miduo.org/api/reports/assets/e88bbb93bc29143203df11d7983b5c4cbab76d8565bd9e549cf4aa0ca4b07ada.png)

2. 核对 Client code、环境、团队、appCaller、协议、scope、CIDR 和限流与旧 key 一致。轮换表单不会自动复制旧过期时间，必须重新选择组织批准的到期日后再创建。

**图 057 点击“新建密钥”打开签发表单**

![图 057 点击“新建密钥”打开签发表单](https://cds.miduo.org/api/reports/assets/d3aaf92d5ec3e467f9b488c04b1c3aae10a89a8c09381e8787becbe0b32793a7.png)

3. 一次性保存新 key。此时旧 key 仍有效，列表应进入等待客户端切换的轮换阶段。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 057 点击“新建密钥”打开签发表单](https://cds.miduo.org/api/reports/assets/d3aaf92d5ec3e467f9b488c04b1c3aae10a89a8c09381e8787becbe0b32793a7.png)

4. 在终端运行 `read -s LLMGW_API_KEY`，从密码工具粘贴新 key 并回车，再执行[[第 10 章：一键生成第一把 key|第 10 章]]保存的 chat 安全 cURL。这就是把最小测试客户端切到新 key；记录 requestId 后运行 `unset LLMGW_API_KEY`。

**图 058 密钥表单要求接入方、环境、用途、appCaller、协议、scope 和限流**

![图 058 密钥表单要求接入方、环境、用途、appCaller、协议、scope 和限流](https://cds.miduo.org/api/reports/assets/ce500ea7ce5e615dee224bfd087be9b5a63673f54cbd755f9dba2d3720ea8cd0.png)

5. 在请求记录中确认新请求的 ServiceKeyId 是新 key，而不是旧 key。

**图 059 单把 key 的每分钟上限可比 appCaller 更严格**

![图 059 单把 key 的每分钟上限可比 appCaller 更严格](https://cds.miduo.org/api/reports/assets/2b88455d6623093368e0937c06f2234fc41c15e840ee1f643acfb450a137e76e.png)

6. 回到密钥列表，对轮换项点击“确认已切换”。再观察约定次数，确保没有旧 key 新请求。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 059 单把 key 的每分钟上限可比 appCaller 更严格](https://cds.miduo.org/api/reports/assets/2b88455d6623093368e0937c06f2234fc41c15e840ee1f643acfb450a137e76e.png)

7. 点击“撤销旧钥并完成”。验证旧 key 时不要把明文写进命令：在终端先输入 `read -s LLMGW_API_KEY` 并回车，再在不回显的输入位置从密码工具粘贴旧 key并回车。运行[[第 10 章：一键生成第一把 key|第 10 章]]已经引用 `$LLMGW_API_KEY` 的 chat 安全 cURL，应返回 401；随后输入 `unset LLMGW_API_KEY`。历史中只会留下这三条固定命令，不会留下完整 key。

**图 065 生成结果只在当前时刻展示完整 key，并提示立即保存**

![图 065 生成结果只在当前时刻展示完整 key，并提示立即保存](https://cds.miduo.org/api/reports/assets/6dc1b657df8a373550e7064b1b4b904e41a954ff39ae624d06f7f67878d9648b.png)

8. 用同样的隐藏输入方法把新 key 临时放入 `LLMGW_API_KEY`，运行同一条带 dry-run 的 cURL，确认仍通过；完成后再次输入 `unset LLMGW_API_KEY`。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 065 生成结果只在当前时刻展示完整 key，并提示立即保存](https://cds.miduo.org/api/reports/assets/6dc1b657df8a373550e7064b1b4b904e41a954ff39ae624d06f7f67878d9648b.png)

## 看到什么算成功

列表清楚显示新旧 key 的关系和轮换阶段。客户端切换后，新日志只出现新 ServiceKeyId；旧 key 已撤销且无法调用，新 key 保持有效。审计中有创建、确认切换和撤销记录，但不含任何完整 key。

## 失败怎么办

- 新 key 测试失败：不要撤旧 key，回滚客户端 Secret 到旧 key，按 401/403 信息核对新 key 范围。
- 日志仍出现旧 ServiceKeyId：说明至少一个实例未切换，查找对应 client 和环境，完成切换后再确认。
- 误点撤销导致中断：立即使用已安全保存的新 key 恢复；如果没有有效后继 key，由管理员签发明确范围的新 key。
- 轮换长期停在等待阶段：不要放任双钥永久有效；根据请求日志找到负责人，设定截止时间并收口。
- 新 key 没有到期日：不要继续切换；撤销这把尚未分发的新 key，重新轮换并明确设置到期日。
- 终端直接显示了完整 key：立即停止，不要只依赖清理历史；按泄露处理轮换该 key，并改用 `read -s` 的隐藏输入。

## 本章小结

安全轮换是“新建、切换、观察、撤旧”的顺序，不是覆盖旧值。ServiceKeyId 提供了客观切换证据，401 负面验证证明旧入口真正关闭。

## 下一章

点击 [[第 17 章：给模型池增加成员]]，学习只增加兼容成员并保持既有配置不变。
