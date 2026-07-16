# 第 20 章 配置 PromptPolicy

## 你在做什么

这一章给“教程咖啡店”的 `tutorial.gateway-book::chat` 配置一条 PromptPolicy，先预览，再保存新版本，然后用审计确认应用结果。vision 可按同样方法单独配置，其他请求类型首版不应用。

## 为什么要做

业务常需要统一语气、边界或输出格式。如果提示词散落在每个 Agent 中，很难知道谁改过、哪次请求用了哪一版。PromptPolicy 把规则绑定到 appCaller，并用版本、预览和回滚留下可追踪证据。

## 开始前检查

- `tutorial.gateway-book::chat` 已存在，显示给 OpenRouter 的 App 名称应为 `G-tutorial.gateway-book::chat`；`G-` 只是展示前缀，不写进 appCallerCode。
- 当前角色是 Owner 或 Admin。Developer 会看到由管理员配置的说明，但不能保存策略。
- 准备一句不含密钥、个人信息和租户标识的示例系统提示词。
- 牢记日志只能记录 policy id、version、hash，不能记录策略正文。

## 跟我做

> 每做完一个编号步骤，就核对紧接在步骤下方的圈选图。同一步有两张图时，第一张确认入口或全貌，第二张确认字段或结果。

1. 进入左侧“工作区”下的“appCaller”，找到 `tutorial.gateway-book::chat`，打开“提示词策略”。也可以在 Quickstart 创建结果中使用“打开提示词策略”。

**图 047 chat 和 vision appCaller 可以从这里进入提示词治理**

![图 047 chat 和 vision appCaller 可以从这里进入提示词治理](https://cds.miduo.org/api/reports/assets/aedadeaeec92436e8273c35cdfd488539e1981b9006ebb95eed097bbc7b77b01.png)

2. 在前缀或后缀中填写一条简单规则，例如“回答前先确认问题所属商品；无法确认时说明需要补充的信息”。保持用途只针对 chat。

**图 048 策略页先解释仅应用于 chat 和 vision，日志只记 id、版本和 hash**

![图 048 策略页先解释仅应用于 chat 和 vision，日志只记 id、版本和 hash](https://cds.miduo.org/api/reports/assets/0b0a3d401d2d5266c34a6479ee0cccbc645b15035be4f0674d922b0bb2af230b.png)

3. 点击预览，使用无敏感内容的样例系统提示词。对比合成前后，确认规则位置和长度符合预期。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 048 策略页先解释仅应用于 chat 和 vision，日志只记 id、版本和 hash](https://cds.miduo.org/api/reports/assets/0b0a3d401d2d5266c34a6479ee0cccbc645b15035be4f0674d922b0bb2af230b.png)

4. 预览正确后点击“保存新版本”。页面应生成新版本，而不是覆盖旧版本；先记下页面可见的 version 和 hash，policy id 要到后面的请求详情读取。

**图 049 前缀、后缀、变量和最大字符数在同一编辑区**

![图 049 前缀、后缀、变量和最大字符数在同一编辑区](https://cds.miduo.org/api/reports/assets/4d66a5774f555fe14080c1e944693a7abc72dcbd6eadefeac51d22edc32388e6.png)

5. Quickstart 安全测试会在应用策略前结束，不能证明策略生效。要取应用证据，使用一把尚未撤销、只允许该 chat appCaller 的测试 key，在终端先运行 `read -s LLMGW_API_KEY`，在无回显输入中粘贴 key 并回车；这样明文不会写入命令历史。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 049 前缀、后缀、变量和最大字符数在同一编辑区](https://cds.miduo.org/api/reports/assets/4d66a5774f555fe14080c1e944693a7abc72dcbd6eadefeac51d22edc32388e6.png)

6. 再复制执行下面这段。把第一行地址换成 Quickstart 页面显示的“Gateway 地址”；命令只调用[[第 6 章：配置第一个 Provider|第 6 章]]公开教程桩一次，不访问付费模型，也不会把 key 写进文件。

**图 050 先填写示例 system prompt，再点击预览，不必保存就能检查合并结果**

![图 050 先填写示例 system prompt，再点击预览，不必保存就能检查合并结果](https://cds.miduo.org/api/reports/assets/3e5cdcb1de2e6037f6b393e8567fc6b789c923e2a1ee660cb09a66c156866ac2.png)

```bash
export LLMGW_BASE_URL="https://map.ebcone.net"
curl -sS -D /tmp/llmgw-tutorial-policy.headers -o /tmp/llmgw-tutorial-policy.json \
  "$LLMGW_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $LLMGW_API_KEY" \
  -H "X-Gateway-Source: external" \
  -H "X-Gateway-App-Caller: tutorial.gateway-book::chat" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","model_policy":"auto","messages":[{"role":"user","content":"只回答：教程策略已检查"}],"max_tokens":16}'
rg -i '^x-request-id:' /tmp/llmgw-tutorial-policy.headers
unset LLMGW_API_KEY LLMGW_BASE_URL
```

7. 复制输出的 requestId，进入“请求记录”打开详情。只应看见 policy id、version、hash，不应出现策略正文。终端命令完成后已经清除了内存变量。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 050 先填写示例 system prompt，再点击预览，不必保存就能检查合并结果](https://cds.miduo.org/api/reports/assets/3e5cdcb1de2e6037f6b393e8567fc6b789c923e2a1ee660cb09a66c156866ac2.png)

8. 新建第二版做一个小修改，再选择旧版本执行回滚。回滚应产生新的当前版本，历史版本仍可追溯。

**图 051 预览返回合并结果、策略字符数、hash 和实际变量**

![图 051 预览返回合并结果、策略字符数、hash 和实际变量](https://cds.miduo.org/api/reports/assets/154ed01202892a18842007791a1e7b6f6e285da9e38057d451015f242635ea12.png)

9. 回到 appCaller 列表，打开 `tutorial.gateway-book::vision` 的“提示词策略”。填写只与图片理解有关的简单规则，例如“先描述看得见的内容；看不清时明确说明”，点击预览并确认合成位置，再点击“保存新版本”。记录页面显示的 vision version 和 hash，不把正文抄进日志。

**本步位置复核：在同一圈选画面完成本步后再继续。**

![图 052 每次保存创建新版本，历史版本可回滚但不会被改写](https://cds.miduo.org/api/reports/assets/1ab94eb9234a65228095b560693ae0f7268f0c137f93a559267b235a393a3e75.png)

10. 使用[[第 10 章：一键生成第一把 key|第 10 章]]仍有效的 vision test key 做一次应用验证。在终端运行 `read -s LLMGW_VISION_KEY`，无回显粘贴后执行下面命令。它只向[[第 6 章：配置第一个 Provider|第 6 章]]公开教程桩发送 MAP 的公开图标，不读取本地照片，也不调用付费模型。发布前已确认该图片地址返回 `image/png`：

**图 052 每次保存创建新版本，历史版本可回滚但不会被改写**

![图 052 每次保存创建新版本，历史版本可回滚但不会被改写](https://cds.miduo.org/api/reports/assets/1ab94eb9234a65228095b560693ae0f7268f0c137f93a559267b235a393a3e75.png)

```bash
export LLMGW_BASE_URL="https://map.ebcone.net"
curl -sS -D /tmp/llmgw-tutorial-vision-policy.headers -o /tmp/llmgw-tutorial-vision-policy.json \
  "$LLMGW_BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $LLMGW_VISION_KEY" \
  -H "X-Gateway-Source: external" \
  -H "X-Gateway-App-Caller: tutorial.gateway-book::vision" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","model_policy":"auto","messages":[{"role":"user","content":[{"type":"text","text":"只回答：教程视觉策略已检查"},{"type":"image_url","image_url":{"url":"https://map.ebcone.net/favicon.png"}}]}],"max_tokens":16}'
rg -i '^x-request-id:' /tmp/llmgw-tutorial-vision-policy.headers
unset LLMGW_VISION_KEY LLMGW_BASE_URL
```

11. 用输出的 vision requestId 打开请求详情，核对它使用 vision appCaller，并且只显示 vision policy id、刚保存的 version 与 hash。chat 和 vision 各自只有一次公开教程桩应用验证；不要把策略扩展到 image generation、speech 或其他请求类型。

![图 052 每次保存创建新版本，历史版本可回滚但不会被改写](https://cds.miduo.org/api/reports/assets/1ab94eb9234a65228095b560693ae0f7268f0c137f93a559267b235a393a3e75.png)

## 看图核对

Developer 在 Quickstart 生成配置后会看到下一步提示，但红框中的策略入口要求 Owner 或 Admin；Developer 不能绕过权限修改 PromptPolicy。

![红框说明只有 Owner 或 Admin 能配置 PromptPolicy](https://md-private-1251304948.cos.ap-guangzhou.myqcloud.com/data/cds/img/idlhugxghyv7nnvwtbmjl76hy4.png)

## 看到什么算成功

chat 与 vision 页面各自有当前版本和历史版本，预览结果符合预期；两条公开教程桩请求分别命中自己的 appCaller 和策略证据。请求详情或审计只显示 policy id、version、hash，没有策略正文；chat 回滚后还生成了可审计的新当前版本。

## 失败怎么办

- 页面没有保存按钮：当前角色可能是 Developer 或 Viewer，请由 Owner/Admin 操作，不要绕过权限。
- 预览结果太长或变量被拒绝：缩短规则，只使用页面允许的变量；不要把未知变量硬塞进去。
- 保存提示版本冲突：重新读取当前版本，比较他人修改后再保存，不能覆盖最新策略。
- 请求里没有策略证据：先确认这不是 Quickstart dry-run，再核对实际请求使用的 appCaller 和类型；只有 chat 或 vision 的非 dry-run 请求会应用策略。
- vision 请求返回 403：确认使用的是内容组 vision key，而不是[[第 16 章：轮换、切换和撤销 key|第 16 章]]轮换后的客服组 chat key；不要扩大 key 范围来绕过。
- 日志出现提示词正文：停止继续测试并报告安全问题，日志应只保留 id、version、hash。

## 本章小结

你完成了 PromptPolicy 的预览、版本化保存、请求应用、审计和回滚。策略首版只管 chat 与 vision，敏感正文不进入日志。

## 下一章

点击 [[第 21 章：看懂请求记录和会话]]，用 requestId 和会话信息定位完整调用路径。
