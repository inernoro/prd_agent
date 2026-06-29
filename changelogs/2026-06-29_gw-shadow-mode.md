| feat | prd-api | LLM 网关新增 shadow 影子比对模式：inproc 权威返回 + 后台对跨进程 http 网关做逐字段比对落 llmshadow_comparisons，灰度翻 http 前积累一致性证据。默认只比解析(免费,覆盖选A给B)，ShadowFullSamplePercent>0 才采样完整 send 比对。CreateClient 绑定 shadow 覆盖 chat 主链路；http 影子失败全隔离，caller 永远拿 inproc |
| test | prd-api | 新增 ShadowLlmGatewayTests(数据驱动)：caller 永远拿 inproc / 比对 critical+warning 分级正确 / http 抛异常不破坏 caller / resolve-only 不 2x 打模型 |
