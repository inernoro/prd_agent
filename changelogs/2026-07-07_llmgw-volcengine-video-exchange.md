| feat | prd-api | 新增火山方舟 Seedance 视频 exchange 转换器，支持 MAP OpenRouter 视频请求经 LLM Gateway 转为原生 task API |
| ops | scripts | 新增生产视频 exchange bootstrap 脚本，默认 dry-run，执行前备份 Mongo 并复用加密后的火山平台密钥 |
| ops | scripts | 扩展 LLM Gateway provider audit 和 readiness audit，识别 video-gen 模型绑定到 model_exchanges 的合法路径 |
| fix | scripts | 修复上游 readiness 对 exchange 的 apiKey 判定，避免要求 resolve 暴露明文密钥 |
| ops | scripts | 新增视频 exchange canary 脚本并精确归因火山 Ark 模型未开通错误 |
| test | prd-api | 增加视频网关客户端与火山视频转换器测试，覆盖提交、状态查询、签名视频下载和响应映射 |
