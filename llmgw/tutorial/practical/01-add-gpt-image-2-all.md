# 实战 01：为视觉创作新增 GPT Image 2 与 Nano Banana 2

这篇实战把三款真实图片模型从 Provider 配置到可被 Gateway 调度。示例复用 OpenRouter Provider，模型标识分别为 `openai/gpt-image-2`、`google/gemini-3.1-flash-image` 和 `google/gemini-3.1-flash-lite-image`。它们在视觉创作中显示为 GPT Image 2、Nano Banana 2 和 Nano Banana 2 Lite。上游模型标识必须以供应商当前文档为准，不能填写旧 preview 名或便于阅读的昵称。

## 什么时候用

- 视觉创作的模型选择器只有测试桩或只有一款模型。
- 模型池里有同名成员，但对应 Provider 不存在、已停用或不是 Gateway 权威配置。
- 新供应商已经交付 Base URL、通讯密钥和准确模型标识。

如果池里已经存在同一 Provider 下的相同上游标识，直接复用。孤立旧成员不能代替 Provider 和模型记录，不要继续创建第二个同名孤立池。

## 开始前检查

1. 你是当前租户的 Owner 或 Admin。
2. 供应商明确支持对应模型，并提供 OpenAI 兼容请求入口。
3. 你已拿到供应商 Base URL、测试通讯密钥和模型标识。不要把密钥放进聊天、截图或教程。
4. 测试环境使用单独的低额度 key，不与正式环境共用。

## 第一步：创建或复用 Provider

1. 进入“路由 → Provider”。
2. 如果已有启用、地址正确且由 Gateway 管理的同一供应商，直接复用；否则点击“添加 Provider”。
3. 名称填写能辨认供应商与环境的名称，例如“OpenRouter 图片生成测试”。
4. 接口类型选择“OpenAI 兼容”。API 地址填写供应商交付的 Base URL；OpenRouter 使用 `https://openrouter.ai/api`。
5. 通讯密钥填写测试 key，供应方标识填写稳定短名，例如 `openrouter`。
6. 点击“保存并继续添加模型”，确认列表只显示“已配置”，不回显密钥正文。

![Provider 表单把名称、协议、地址和通讯密钥放在同一个受控区域](https://cds.miduo.org/api/reports/assets/ba08e39934a1e467d916f734bd8e475d7aa2d05ece442e40787fcca05215f299.png)

如果暂时没有真实供应商 key，到此停止。不要用 Gateway 接入 key、MAP 密码或其他系统凭据代替图片供应商 key。

## 第二步：新增图片模型

1. 进入“路由 → 模型”，点击“添加模型”。
2. Provider 选择刚才创建或复用的图片供应商。
3. 依次创建三条模型记录，显示名称和上游标识使用下表。

| 显示名称 | 上游模型标识 | 建议用途 |
|---|---|---|
| OpenAI GPT Image 2 | `openai/gpt-image-2` | 复杂指令与文字排版 |
| Google Nano Banana 2 | `google/gemini-3.1-flash-image` | 通用高质量图片生成 |
| Google Nano Banana 2 Lite | `google/gemini-3.1-flash-lite-image` | 低成本快速试稿 |

4. 不使用 `google/gemini-3.1-flash-image-preview` 等旧 preview 标识；供应商后续更名时以当前官方模型页为准。
5. 调用协议选择“继承 Provider”。
6. 在“模型用途”中只勾选“图片生成”，不要同时标记“图片理解”或“对话”。
7. 模型专属通讯密钥通常留空，让模型继承 Provider key。
8. 已知可信价格时按供应商口径填写“每次调用”及币种；不知道时留空，让费用保持 unknown，不能填写 0。
9. 点击“保存并同步默认池”。

![模型表单先选 Provider，再填写上游标识、协议和用途](https://cds.miduo.org/api/reports/assets/436cd26991bb4f6a5cf4d975d4b01f536cbe48e9bad862c73cad46bf46e31529.png)

## 第三步：确认进入 generation 池

保存成功后，提示应包含“已加入 1 个匹配的默认池”或说明没有匹配用途的默认池被改动。

- 已加入默认池：进入“路由 → 模型池”，打开“图片生成”默认池，确认三条上游标识各出现一次。
- 没有匹配默认池：不要创建同名池覆盖历史配置。先确认用途为“图片生成”，再确认 generation 程序池类型存在，然后在池内使用“追加模型”或“添加/更新”。

![模型池成员逐项展示模型标识、健康、优先级和协议](https://cds.miduo.org/api/reports/assets/2016514decea89d72156a671c2e6eb283c4e1863ee99cbea009d6d400fa9017a.png)

## 看到什么算成功

- Provider 已启用，密钥状态为“已配置”，页面不显示密钥正文。
- 三条模型记录均已启用，用途只包含“图片生成”。
- generation 池内三条成员各只有一个，且引用刚才选择的 Provider。
- 不做真实生图时，以上只证明配置完整；真实可用性要到实战 04 验证。

## 常见失败

- “先去添加 Provider”：当前没有启用且由 Gateway 管理的 Provider。
- 保存后没有进入默认池：模型用途选错，或 generation 默认池尚未初始化。
- 池里有同名模型但 Provider 不存在：这是孤立历史成员，应创建权威 Provider 和模型后重新加入正确池。
- 请求返回 `unknown_parameter`：记录 requestId，检查实际模型、调用协议和发送参数，不要只按显示名称判断适配器。
- 页面仍只有一个模型：继续完成实战 02；模型已登记不等于视觉创作调用方已经绑定。

## 模型标识来源

- OpenRouter GPT Image 2：<https://openrouter.ai/openai/gpt-image-2>
- OpenRouter Nano Banana 2：<https://openrouter.ai/google/gemini-3.1-flash-image/api>
- Google 图片生成模型说明：<https://ai.google.dev/gemini-api/docs/image-generation>

## 回滚

先停用新模型，再从专用池移除该成员。只有确认没有 appCaller 和请求引用后，才考虑删除模型或 Provider；删除前必须由负责人确认。恢复视觉创作原来的池绑定即可回到变更前状态。
