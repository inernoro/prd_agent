| fix | prd-api | 额度判定排除限流误报：429 / "Rate limit exceeded" / "requests per minute" 等节流不再被当成额度用尽（LLM_QUOTA_EXCEEDED 误触发额度告警）；额度只认 key/credit/quota/balance/billing 明确信号 |
| fix | prd-admin | 视觉分镜台并发竞态修复：每轮「生成分镜」自增 genRef 作废上一轮在途关键帧 SSE 与图生视频轮询（stale-response guard），旧回调不再画到新分镜板同 sceneIndex；创建关键帧任务无 runId 时复位 spinner 为 error；同镜正在转视频时禁止重复触发「动起来」 |
| fix | prd-admin | 视觉分镜台图生视频改走 visual-agent 自有端点（/api/visual-agent/video-gen/runs，appKey=visual-agent），避免 visual-agent-only 账号撞 video-agent 403、并用本应用配额/appKey（遵循 app-identity 规则） |
| fix | prd-admin | 图生视频轮询：客户端窗口 6→11 分钟以覆盖后端 worker 10 分钟终态期，避免 6-10 分钟才完成的视频被误判「生成超时」；提交失败/超时回填补 genRef 守卫，旧板任务不再误标新板场景 |
| fix | prd-api | OpenRouter 图片回退收窄：images/generations 失败回退 chat/completions 仅在非鉴权(401/403)/额度(402)/限流(429)时触发，避免真实上游错误被改协议重试覆盖+徒增流量 |
| fix | prd-admin | 视觉分镜台卡片渲染按 vidStatus 优先：重绘关键帧时清空旧视频状态，且 vidStatus 为 running/error 时不再显示上一版成片——重生视频能正常显示进度/失败 UI，用户可核对新关键帧 |
| fix | prd-api | 图生视频 worker 按 run.AppKey 选 caller：visual-agent 分镜台创建的 run 归属 visual-agent 视频配额/模型池与日志归因（新增 AppCallerRegistry.VisualAgent.VideoGen.Generate），不再一律记到 video-agent |
