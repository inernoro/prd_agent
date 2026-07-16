# 第 10 章 一键生成第一把 key

## 你在做什么

你将在 Quickstart 中一次创建 `tutorial.gateway-book::chat` 并签发“客服组”的 test key。页面只显示一次完整 `gwk_` 明文，你会立即把它放进安全保管工具，而不是仓库或截图。

## 为什么要做

外部应用没有租户 key 就不能调用 Gateway。每把 key 同时限定租户、团队、client、环境、appCaller、协议与 scope，因此它既是入口凭据，也是审计身份。MAP 等内部平台即使能调用，也使用部署级内部身份，不代表外部应用可以无 key 使用。

## 开始前检查

- Quickstart 中选择“文字对话”“客服组”“测试”，code 为 `tutorial.gateway-book::chat`，Client code 为教程专用短名。
- Gateway 地址由当前部署自动给出；除非管理员明确要求，不展开“使用其他 Gateway 地址”。
- 密码保管工具已打开，屏幕不会被录制或共享。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 点击左侧“开发者”下的“Quickstart”，逐项核对本章开始前检查。

**图 053 从左侧导航点击“接入密钥”，不用猜页面地址**

![图 053 从左侧导航点击“接入密钥”，不用猜页面地址](https://cds.miduo.org/api/reports/assets/788a31e18916627f67f8583f450323e2f279f7e0b743d59cd024e4342b9b71da.png)

2. 四协议先选“OpenAI”。这只影响当前示例和测试，生成的 Quickstart key 会限定页面列出的四种协议，而不是通配所有协议。

**图 054 接入密钥列表按接入方、环境、appCaller、协议、速率和有效期展示**

![图 054 接入密钥列表按接入方、环境、appCaller、协议、速率和有效期展示](https://cds.miduo.org/api/reports/assets/6dc1f580e61d83fd7e0f70131b4b18e229a7c2235852814bfead14493c65a6aa.png)

3. 点击“一键生成 appCaller 与 key”。等待页面依次显示“正在创建 appCaller”和“正在签发团队密钥”。页面会说明新 key 默认限制 60 次/分钟；这是防止误接入失控的安全默认值，不是租户总额度。

**图 055 test 与 production 使用不同 key，任一方可独立撤销**

![图 055 test 与 production 使用不同 key，任一方可独立撤销](https://cds.miduo.org/api/reports/assets/238d20abfe7ff8a19a887d906f8fc51a728dacadf19fab9f79799c271a1d0410.png)

4. 出现“一次性密钥”后，点击“复制密钥”，立刻保存到受控密码工具，名称写清“教程咖啡店/客服组/test/chat”。

**图 056 列表只显示 key 前缀，不回显完整明文**

![图 056 列表只显示 key 前缀，不回显完整明文](https://cds.miduo.org/api/reports/assets/e88bbb93bc29143203df11d7983b5c4cbab76d8565bd9e549cf4aa0ca4b07ada.png)

5. 先打开“cURL”标签，复制 appCaller 为 `tutorial.gateway-book::chat`、key 由 `$LLMGW_API_KEY` 注入且带 `X-Gateway-Dry-Run: quickstart` 的完整安全 cURL，保存到受控本地临时位置。第 16 和 31 章会直接执行并修改这份 cURL；只复制环境变量或 Agent Skill 不足以代替它。

**图 057 点击“新建密钥”打开签发表单**

![图 057 点击“新建密钥”打开签发表单](https://cds.miduo.org/api/reports/assets/d3aaf92d5ec3e467f9b488c04b1c3aae10a89a8c09381e8787becbe0b32793a7.png)

6. 再按需要复制“环境变量”和“Agent Skill”。不要提交到 Git，也不要放进知识库正文。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 058 密钥表单要求接入方、环境、用途、appCaller、协议、scope 和限流](https://cds.miduo.org/api/reports/assets/ce500ea7ce5e615dee224bfd087be9b5a63673f54cbd755f9dba2d3720ea8cd0.png)

7. 记录页面返回的 key 前缀或 key id，但不记录完整明文。

**图 058 密钥表单要求接入方、环境、用途、appCaller、协议、scope 和限流**

![图 058 密钥表单要求接入方、环境、用途、appCaller、协议、scope 和限流](https://cds.miduo.org/api/reports/assets/ce500ea7ce5e615dee224bfd087be9b5a63673f54cbd755f9dba2d3720ea8cd0.png)

8. 不要刷新页面。先在当前页点击“点击测试”，确认 chat 返回 requestId 且明确写着未访问上游；第 11 章会教你完整读懂这次测试。

**图 059 单把 key 的每分钟上限可比 appCaller 更严格**

![图 059 单把 key 的每分钟上限可比 appCaller 更严格](https://cds.miduo.org/api/reports/assets/2b88455d6623093368e0937c06f2234fc41c15e840ee1f643acfb450a137e76e.png)

9. chat 测试通过后点击“修改身份”。在确认框中确认清除当前页面的一次性明文；已签发的 chat key 仍有效，身份字段才会解除锁定。

**图 064 一键生成 appCaller 与 key，缺 key 不能跳过身份直接测试**

![图 064 一键生成 appCaller 与 key，缺 key 不能跳过身份直接测试](https://cds.miduo.org/api/reports/assets/fa5352db762895c9cb2fc2ff2bb5ec9f102f1e3242cd7a73968445a1ddb8c7eb.png)

10. 调用类型改为“图片理解”，团队选择“内容组”，确认 code 自动变为 `tutorial.gateway-book::vision`，环境仍为“测试”，再点击“一键生成 appCaller 与 key”。把 vision key 保存为另一条 Secret，不覆盖 chat key。

**图 065 生成结果只在当前时刻展示完整 key，并提示立即保存**

![图 065 生成结果只在当前时刻展示完整 key，并提示立即保存](https://cds.miduo.org/api/reports/assets/6dc1b657df8a373550e7064b1b4b904e41a954ff39ae624d06f7f67878d9648b.png)

11. 保持 vision 配置停留在页面，不要刷新；第 11 章先完成 vision 安全测试，再用 chat requestId 学会回查。

![图 065 生成结果只在当前时刻展示完整 key，并提示立即保存](https://cds.miduo.org/api/reports/assets/6dc1b657df8a373550e7064b1b4b904e41a954ff39ae624d06f7f67878d9648b.png)

## 看图核对

Developer 的密钥页面会明确告诉你：只能创建限定 appCaller、协议和 scope 的团队密钥，不能创建通配密钥。

![红框说明 Developer 只能创建明确限定的团队密钥](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/bjbi5orhawg4eldqlymwyaxyka.png)

Viewer 打开 Quickstart 时可以学习三步接入和复制方式，但红框说明其不能签发密钥或执行安全直测。

![红框说明 Viewer 的 Quickstart 保持只读](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/pocxlvuedir4vkcuil3gpy7ymm.png)

## 看到什么算成功

chat 已完成一次安全测试，vision 停留在“接入配置已生成”并等待测试。左侧“接入密钥”列表出现两条不同工作负载身份：test/chat 属于客服组，test/vision 属于内容组；两者只显示前缀，不回显完整 key，并各自显示 60 次/分钟。若业务需要不同速率，按第 16 章轮换为新 key，不修改或复用另一接入方的 key。

## 失败怎么办

- appCaller 创建失败：核对团队、后缀和当前角色，修正后再试；不要直接改请求里的 tenantId。
- 提示 appCaller 已就绪但密钥签发失败：先去“接入密钥”确认是否已生成，避免重复签发，再按错误处理。
- 明文尚未保存就刷新：原密钥无法找回；到“接入密钥”轮换或撤销，并签发一把新的，不要要求后台回显。
- 无法把 chat 切成 vision：生成配置后身份字段会锁定，必须先完成 chat 测试，再点击真实按钮“修改身份”并确认；不要刷新或猜隐藏字段。
- 页面显示通配风险：停止创建，确保 appCaller、协议和 scope 都是明确列表；Developer 不能创建通配 key。

## 本章小结

两把 test key 分别把 chat 和 vision 限制到客服组与内容组。切换调用类型必须经过“修改身份”，完整明文只在创建时处理，列表和日志只保留可审计标识。

## 下一章

不要刷新当前页面。点击 [[第 11 章：点击安全测试]]，完成测试并取得第一条 requestId。
