# 实战 02：给逻辑模型连接多个上游 Offering

逻辑模型只是应用可见目录。真正能发请求，还需要至少一个启用的 Offering；为了故障切换，关键模型建议配置两个由不同 Provider 或不同 Endpoint 承载的 Offering。

## 配置原则

- 一个 Offering 只指向一个 Gateway 已拥有的普通模型或 Exchange。
- 同一逻辑模型的多个 Offering 应提供可替代的业务能力，不要把完全不同的产品混在一起。
- 协议、上游模型覆盖、并发与 RPM 属于 Offering，不属于视觉创作。
- `priority` 适合明确主备；`weighted` 适合多个稳定上游分担流量。

## 跟我做

1. 打开“路由 → 逻辑模型”，进入 `image2`。
2. 新增主 Offering，目标选择 OpenAI 直连模型，协议按模型配置，优先级填 10，权重填 100，并填写供应商允许的最大并发和每分钟速率。
3. 新增备用 Offering，目标选择 OpenRouter 或另一条兼容 Endpoint，优先级填 20。若真实上游模型名不同，在“上游模型覆盖”填写供应商精确 id。
4. 为 `nanobanana-2` 配置 Google 原生 Offering 和一条兼容代理 Offering。Google 原生请求使用 `generateContent`，代理可能使用 OpenAI Images 或 Exchange；不用要求两者 wire shape 相同。
5. 为 `nanobanana-2-lite` 至少配置一个启用 Offering。测试环境如果还没有可信备用上游，保留单 Offering 并明确记录，不要拿无效地址凑数量。
6. 回视觉创作刷新模型选择器。列表项应是三个逻辑模型，而不是一个池、多个 Provider 或真实上游 id。

## 为什么不同协议也能回退

视觉创作提交 prompt、尺寸和参考图等业务信息。Gateway 保存协议无关的图片请求，在每次尝试前分别构建 OpenAI JSON、OpenAI multipart、OpenRouter 多模态消息、Google `generateContent` 或 Exchange 请求。首个上游 429、超时或 5xx 时，下一次请求会重新构建，不会把前一个供应商的 body 原样转发。

## 看到什么算成功

- `image2` 和 `nanobanana-2` 各有至少两个启用 Offering，目标、协议、优先级和限额可区分。
- 视觉创作显示多个逻辑模型，列表不泄漏 Offering 数量、密钥或 Endpoint。
- `visual-agent.image.text2img::generation` 能看到这些模型，其他未授权 appCaller 默认看不到。
- 模型池没有为每个 Provider 复制一套离散组合。

## 常见失败

- 逻辑模型有记录但列表不显示：没有可用 Offering，或全部 Offering 已禁用、隔离。
- 保存 Offering 返回 404：目标模型或 Exchange 不属于当前租户，Gateway 会 fail-closed。
- Google 备用收到 OpenAI body：检查 Offering 协议和 canonical 图片请求是否贯通，不能通过改 EndpointPath 硬兼容。
- 选择模型后实际走默认池：请求没有携带逻辑模型 PublicId，回应用网络请求核对 expected model。
