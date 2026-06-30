| fix | prd-api | LLM 网关跨进程测试 flake 修复：CrossProcessServing 测试每 cell 新建抛弃式 ServiceProvider 取 IHttpClientFactory，其 HttpMessageHandler 被 GC 终结导致随机空响应；改为进程级共享 static factory |
| fix | prd-api | 守 compute-then-send：http 模式 SendRawWithResolutionAsync 不再丢弃 resolution——调用方解析失败则短路返回、否则把 ExpectedModel 锁定为 resolution.ActualModel，serving 重解析锁回同一模型（防生图/视频「选 A 给 B」），ApiKey 仍不过线 |
| fix | prd-api | http 模式 CreateClient 流式补传 GatewayRequestContext：client-stream payload 带 Context、serving /gw/v1/client-stream 开 ILLMRequestContextAccessor 作用域，恢复 RequestId/SessionId/UserId 日志关联与归属 |
| fix | prd-api | blackhole 占位日志不再被覆盖：UpdateDone/UpdateError 过滤加 Status != "blackhole"，上游成功时不把「日志写入失败」故障改写成 succeeded/failed |
| fix | cds | 命名子域 master 兜底路由用已解析的 v3 previewSlug 而非 slugify(branch.name)，修 claude/* 分支命名 URL 在非转发路径解析不到 canonical 分支 |
| fix | cds | 视觉验收 harness 录像尺寸跟随实际视口（含手机端 viewport 覆盖），不再按桌面尺寸录像导致视频与截图不一致 |
