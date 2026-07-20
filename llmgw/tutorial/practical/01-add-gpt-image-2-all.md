# 实战 01：建立视觉创作逻辑模型目录

这篇实战把视觉创作的模型选择与上游配置拆开。视觉创作只看到稳定的逻辑模型，例如 `image2`、`nanobanana-2` 和 `nanobanana-2-lite`；Provider 名称、真实模型标识、Endpoint、协议和通讯密钥全部留在 Gateway。

## 先理解三层名称

| 层级 | 示例 | 谁使用 |
|---|---|---|
| 逻辑模型 PublicId | `image2` | 视觉创作和其他应用 |
| Offering | OpenAI 直连、OpenRouter、Google 直连 | Gateway 路由器 |
| 上游模型标识 | 供应商文档中的真实 model id | Gateway wire adapter |

PublicId 由本租户维护，应该稳定。上游标识可能升级或下线，只修改 Offering，不要求视觉创作发版。

## 开始前检查

- 当前角色是 Owner 或 Admin。
- 测试和正式环境使用不同的上游通讯密钥。
- 上游模型标识从供应商当前官方文档复制，不用逻辑模型名猜测。
- 不把 MAP 登录密码、Gateway 接入 key 或其他系统凭据当作 Provider key。

## 跟我做

1. 进入“路由 → Provider”和“路由 → 模型”，创建或复用真实上游。每条上游记录必须有准确协议、Base URL、真实模型标识和图片生成能力；密钥保存后只能显示已配置状态。
2. 进入“路由 → 逻辑模型”，新增 `image2`，类型选“图片生成”，能力包含图片生成，并把 `visual-agent.image.text2img::generation` 加入可用 appCaller。
3. 同样新增 `nanobanana-2` 和 `nanobanana-2-lite`。显示名可以面向用户，PublicId 保存后不要随供应商版本变化频繁改名。
4. 暂时不要把三个逻辑模型塞进同一个模型池。模型池只处理没有显式选择时的默认；视觉创作会直接读取逻辑模型目录。

## 推荐的测试目录

| PublicId | 显示名 | 适合绑定的上游示例 |
|---|---|---|
| `image2` | GPT Image 2 | OpenAI 直连和 OpenRouter 的同能力供给 |
| `nanobanana-2` | Nano Banana 2 | Google Gemini 3.1 Flash Image 和兼容代理 |
| `nanobanana-2-lite` | Nano Banana 2 Lite | Google Gemini 3.1 Flash Lite Image 和兼容代理 |

Google 官方图片生成指南把 Gemini 3.1 Flash Image 称为 Nano Banana 2，把 Gemini 3.1 Flash Lite Image 称为 Nano Banana 2 Lite。模型 id 仍以保存当天的官方文档为准。OpenRouter 的模型目录和 Provider 路由会持续变化，也只能作为 Offering 来源，不能成为应用的长期模型目录。

## 看到什么算成功

- 逻辑模型页有三条启用记录，PublicId 不含 Provider 或 Endpoint 信息。
- 每条记录的 appCaller 可见范围明确，普通无权限 appCaller 不会看到它们。
- 视觉创作尚未依赖任何新模型池组合。
- 上游密钥未出现在列表、日志、截图或教程中。

## 常见失败

- PublicId 保存冲突：同一租户内 PublicId 唯一，复用已有记录，不创建大小写不同的重复项。
- 视觉创作看不到记录：检查模型类型、启用状态、appCaller 可见范围，以及下一篇实战中的 Offering。
- 上游模型 id 找不到：这是 Provider 或模型配置问题，不要通过改 PublicId 掩盖。
- 想为每款模型复制一个池：停止复制。逻辑模型是应用目录，Offering 才是多上游列表。

## 官方参考

- [OpenRouter Provider Routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [OpenAI Image Generation](https://platform.openai.com/docs/guides/image-generation)
- [Google Gemini Image Generation](https://ai.google.dev/gemini-api/docs/image-generation)
